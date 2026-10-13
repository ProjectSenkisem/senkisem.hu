// ============================================================
// server.js — SENKISEM (webshop → támogatói modell)
// ============================================================
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { Resend } = require('resend');
const rateLimit = require('express-rate-limit');

// Import modules
const {
  determineEmailTemplate,
  generateEmail
} = require('./emailTemplates');

const {
  generateDownloadLinks,
  validateDownloadToken,
  markTokenAsUsed,
  getProductFilePath,
  getProductFileName
} = require('./downloadLinkService');

const { generateInvoicePDF } = require('./pdfInvoiceGenerator');

// ============================================
// ENV VALIDÁCIÓ
// ============================================
const requiredEnvVars = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'DOMAIN',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL'
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`❌ Hiányzó környezeti változók:\n${missingVars.join('\n')}`);
  process.exit(1);
}

console.log('✅ Környezeti változók rendben\n');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

// Reverse proxy mögött (Render, Railway, nginx...) a rate limit-hez kell a valódi IP
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 1);

// ============================================
// KONFIG
// ============================================
const CONFIG = {
  SHEETS: {
    ORDERS: '1ysbyF0uCl1W03aGArpFYDIU6leFFRJb0R1AaadVarGk',
  },
  // Új munkalapok UGYANABBAN a táblázatban (automatikusan létrejönnek)
  TABS: {
    SUPPORT: 'Támogatók',
    IDENT: 'Azonosítók',
  },
  SHIPPING: {
    FOXPOST_COST: 899,
    HOME_DELIVERY_COST: 2590,
  },
  EMAIL: {
    FROM: process.env.RESEND_FROM_EMAIL,
    BCC: 'bellerzoltanezra@gmail.com',
  },
  DOMAIN: process.env.DOMAIN
};

const SUPPORT_HEADERS = ['Sorszám', 'Dátum', 'Session ID', 'Összeg', 'Pénznem', 'Nyelv', 'Email', 'Státusz'];
const IDENT_HEADERS = [
  'Dátum', 'Azonosító ref', 'Név', 'Anonim', 'Email', 'Nyelv', 'Hírlevél',
  'Hozzájárulás verzió', 'Hozzájárulás ideje', 'Belépések', 'Utolsó belépés', 'Státusz'
];

// ============================================
// TERMÉKEK + TÁMOGATÁSI BEÁLLÍTÁSOK BETÖLTÉSE
// ============================================
let products = [];
let SUPPORT_CFG = {
  min: { huf: 1000, usd: 3 },
  max: { huf: 500000, usd: 1500 },
};
let SHOP_ENABLED = false;

try {
  const data = fs.readFileSync(path.join(__dirname, 'product.json'), 'utf8');
  const raw = JSON.parse(data);
  products = raw.products || raw;
  if (raw.support) {
    SUPPORT_CFG = {
      min: Object.assign({}, SUPPORT_CFG.min, raw.support.min),
      max: Object.assign({}, SUPPORT_CFG.max, raw.support.max),
    };
  }
  SHOP_ENABLED = process.env.SHOP_ENABLED
    ? process.env.SHOP_ENABLED === 'true'
    : !!(raw.shop && raw.shop.enabled);
  console.log(`✅ ${products.length} termék betöltve (webshop: ${SHOP_ENABLED ? 'BE' : 'KI'})`);
} catch (err) {
  console.error('❌ product.json hiba:', err.message);
}

// ============================================
// GOOGLE KLIENS
// ============================================
function getGoogleAuth() {
  return new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheet(sheetId) {
  const doc = new GoogleSpreadsheet(sheetId, getGoogleAuth());
  await doc.loadInfo();

  const sheet = doc.sheetsByTitle['2026'];

  if (!sheet) {
    throw new Error('❌ 2026-os munkalap nem található!');
  }

  return sheet;
}

// Tetszőleges munkalap lekérése; ha nincs, létrehozza a fejlécekkel
async function getTab(title, headers) {
  const doc = new GoogleSpreadsheet(CONFIG.SHEETS.ORDERS, getGoogleAuth());
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[title];
  if (!sheet) {
    sheet = await doc.addSheet({ title, headerValues: headers });
    console.log(`✅ Új munkalap létrehozva: ${title}`);
  }
  return sheet;
}

// Egyszerű sorosító zár: az "olvasd ki a sorszámot, majd írj" műveletek ne fussanak párhuzamosan
let _queue = Promise.resolve();
function withLock(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.catch(() => {});
  return run;
}

// Google Sheets képlet-injektálás ellen (=, +, -, @ kezdetű szövegek)
function cell(v) {
  v = String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim();
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

// ============================================
// SZÁMLASZÁM GENERÁLÁS
// ============================================
async function generateNextInvoiceNumber() {
  try {
    const sheet = await getSheet(CONFIG.SHEETS.ORDERS);
    const rows = await sheet.getRows();

    const invoiceNumbers = rows
      .map(row => row.get('Számla Szám'))
      .filter(num => num && num.startsWith('E-SEN-2026-'))
      .map(num => parseInt(num.replace('E-SEN-2026-', '')))
      .filter(num => !isNaN(num));

    const maxNumber = invoiceNumbers.length > 0 ? Math.max(...invoiceNumbers) : 0;
    const nextNumber = maxNumber + 1;
    const invoiceNumber = `E-SEN-2026-${String(nextNumber).padStart(3, '0')}`;

    console.log(`✅ Számlaszám generálva: ${invoiceNumber}`);
    return invoiceNumber;

  } catch (error) {
    console.error('❌ Számlaszám generálási hiba:', error);
    return `E-SEN-2026-${String(Date.now()).slice(-3)}`;
  }
}

// ============================================
// SZÁLLÍTÁSI KÖLTSÉG SZÁMÍTÁS
// ============================================
function calculateShippingCost(cart, shippingMethod) {
  const ebookIds = [2, 4, 300];
  const isAllDigital = cart.every(item => ebookIds.includes(item.id));

  if (isAllDigital || shippingMethod === 'digital') {
    return 0;
  }

  if (shippingMethod === 'pickup') {
    return CONFIG.SHIPPING.FOXPOST_COST;
  }

  if (shippingMethod === 'home') {
    return CONFIG.SHIPPING.HOME_DELIVERY_COST;
  }

  return 0;
}

// ============================================
// EMAIL KÜLDÉS BCC-VEL
// ============================================
async function sendOrderEmail(orderData, totalAmount, invoiceNumber, downloadLinks = null) {
  try {
    const { customerData, cart } = orderData;

    const templateType = determineEmailTemplate(cart);
    console.log(`📧 Email sablon használata: ${templateType}`);

    console.log('📄 PDF számla generálása...');
    const pdfBuffer = await generateInvoicePDF(orderData, totalAmount, invoiceNumber);
    console.log('✅ PDF számla generálva');

    const { subject, html } = generateEmail(templateType, orderData, totalAmount, downloadLinks);

    const result = await resend.emails.send({
      from: `Senkisem.hu <${CONFIG.EMAIL.FROM}>`,
      to: customerData.email,
      bcc: CONFIG.EMAIL.BCC,
      subject: subject,
      html: html,
      attachments: [
        {
          filename: `Szamla_${invoiceNumber}.pdf`,
          content: pdfBuffer,
        }
      ]
    });

    console.log('✅ Email sikeresen elküldve:', customerData.email);
    console.log(`📬 BCC másolat elküldve: ${CONFIG.EMAIL.BCC}`);
    return result;

  } catch (error) {
    console.error('❌ Email küldési hiba:', error);
    throw error;
  }
}

// ============================================
// RENDELÉS MENTÉSE SHEETS-BE (EMAIL NÉLKÜL!)
// orderData JSON mentése a Sheets-be a Stripe metadata helyett
// ============================================
async function saveOrderToSheets(orderData, sessionId) {
  try {
    const sheet = await getSheet(CONFIG.SHEETS.ORDERS);

    const { cart, customerData } = orderData;

    // Számlaszám generálása
    const invoiceNumber = await generateNextInvoiceNumber();

    // Összegek számítása
    const productTotal = cart.reduce((sum, item) => {
      const price = typeof item.price === 'string' ?
        parseInt(item.price.replace(/\D/g, '')) : item.price;
      const quantity = item.quantity || 1;
      return sum + (price * quantity);
    }, 0);

    const shippingCost = calculateShippingCost(cart, customerData.shippingMethod);
    const totalAmount = productTotal + shippingCost;

    // Terméknevek
    const productNames = cart.map(item => {
      const quantity = item.quantity || 1;
      return quantity > 1 ? `${item.name} (${quantity} db)` : item.name;
    }).join(', ');

    const sizes = cart.map(item => item.size || '-').join(', ');

    const isEbook = cart.every(item => item.id === 2 || item.id === 4 || item.id === 300);
    const productType = isEbook ? 'E-könyv' : 'Fizikai';

    let shippingMethodText = '-';
    if (customerData.shippingMethod === 'pickup') {
      shippingMethodText = 'Foxpost csomagpont';
    } else if (customerData.shippingMethod === 'home') {
      shippingMethodText = 'Házhozszállítás';
    } else if (customerData.shippingMethod === 'digital') {
      shippingMethodText = 'Digitális';
    }

    let deliveryAddress = '-';
    if (customerData.shippingMethod === 'home') {
      const addr = customerData.deliveryAddress || customerData.address;
      const city = customerData.deliveryCity || customerData.city;
      const zip = customerData.deliveryZip || customerData.zip;
      const country = customerData.deliveryCountry || customerData.country || 'Magyarország';
      deliveryAddress = `${zip} ${city}, ${addr}, ${country}`;
    }

    let pickupPointName = '-';
    if (customerData.shippingMethod === 'pickup' && customerData.pickupPoint) {
      pickupPointName = `${customerData.pickupPoint.name} (${customerData.pickupPoint.zip} ${customerData.pickupPoint.city})`;
    }

    await sheet.addRow({
      'Dátum': new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }),
      'Név': customerData.fullName || '-',
      'Email': customerData.email || '-',
      'Cím': customerData.address || '-',
      'Város': customerData.city || '-',
      'Ország': customerData.country || 'Magyarország',
      'Irányítószám': customerData.zip || '-',
      'Termékek': productNames,
      'Méretek': sizes,
      'Összeg': `${productTotal.toLocaleString('hu-HU')} Ft`,
      'Típus': productType,
      'Szállítási mód': shippingMethodText,
      'Szállítási cím': deliveryAddress,
      'Csomagpont név': pickupPointName,
      'Szállítási díj': `${shippingCost.toLocaleString('hu-HU')} Ft`,
      'Végösszeg': `${totalAmount.toLocaleString('hu-HU')} Ft`,
      'Foxpost követés': '-',
      'Rendelés ID': sessionId || '-',
      'Státusz': 'Fizetésre vár',
      'Szállítási megjegyzés': customerData.deliveryNote || '-',
      'Telefonszám': customerData.phone || '-',
      'Számla Szám': invoiceNumber,
      'Order Data JSON': JSON.stringify({ cart, customerData }),
    });

    console.log('✅ Rendelés mentve Sheets-be (Email NÉLKÜL)');
    console.log(`   - Session ID: ${sessionId}`);
    console.log(`   - Számlaszám: ${invoiceNumber}`);
    console.log(`   - Státusz: Fizetésre vár`);

  } catch (error) {
    console.error('❌ Sheets mentési hiba:', error.message);
    throw error;
  }
}

// ============================================
// TÁMOGATÓK NYILVÁNTARTÁSA (Sheets, idempotens)
// ============================================
let supporterCache = { count: null, at: 0 };

async function recordSupporter(session) {
  return withLock(async () => {
    const sheet = await getTab(CONFIG.TABS.SUPPORT, SUPPORT_HEADERS);
    const rows = await sheet.getRows();

    const existing = rows.find(r => r.get('Session ID') === session.id);
    if (existing) return parseInt(existing.get('Sorszám'), 10) || null;

    const maxN = rows.reduce((m, r) => Math.max(m, parseInt(r.get('Sorszám'), 10) || 0), 0);
    const n = maxN + 1;

    await sheet.addRow({
      'Sorszám': n,
      'Dátum': new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }),
      'Session ID': session.id,
      'Összeg': (session.amount_total || 0) / 100,
      'Pénznem': String(session.currency || '').toUpperCase(),
      'Nyelv': (session.metadata && session.metadata.lang) || '-',
      'Email': cell((session.customer_details && session.customer_details.email) || '-'),
      'Státusz': 'Fizetve ✅',
    });

    supporterCache = { count: n, at: Date.now() };
    console.log(`💛 Új támogató: #${n} (${session.id})`);
    return n;
  });
}

async function getSupporterCount() {
  if (supporterCache.count !== null && Date.now() - supporterCache.at < 60 * 1000) {
    return supporterCache.count;
  }
  const sheet = await getTab(CONFIG.TABS.SUPPORT, SUPPORT_HEADERS);
  const rows = await sheet.getRows();
  const count = rows.reduce((m, r) => Math.max(m, parseInt(r.get('Sorszám'), 10) || 0), 0);
  supporterCache = { count, at: Date.now() };
  return count;
}

// ============================================
// AZONOSÍTÓ (IDENTIFIER) RENDSZER — szerveroldal
// Az azonosító és a jelszó jellegű adat SOHA nem kerül a szerverre.
// Csak egy véletlen "rid" fogantyú érkezik, amit HMAC-oljuk. Ebből belépni nem lehet.
// ============================================
const IDENT_CONSENT_VERSION_MAX = 40;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IDENT_PEPPER = process.env.IDENT_PEPPER || process.env.STRIPE_WEBHOOK_SECRET;

function identRef(rid) {
  return crypto.createHmac('sha256', IDENT_PEPPER).update(String(rid)).digest('hex').slice(0, 20);
}
const RID_RE = /^[a-f0-9]{32}$/;

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());

// ⚠️ FONTOS: Webhook endpoint-hoz RAW body kell!
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '25mb' }));

// Rate limiting
const downloadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: 'Túl sok letöltési kísérlet.',
  standardHeaders: true,
  legacyHeaders: false,
});

const supportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { error: 'too-many-requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const identRegisterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  message: { error: 'too-many-requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const identPingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  message: { error: 'too-many-requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// ROUTES — TÁMOGATÁS
// ============================================

// 1) Stripe Checkout indítása (egyszeri támogatás)
app.post('/api/support/checkout', supportLimiter, async (req, res) => {
  try {
    const { amount, currency, lang } = req.body || {};
    const cur = String(currency || '').toLowerCase();
    const l = lang === 'hu' ? 'hu' : 'en';

    if (!['huf', 'usd'].includes(cur)) {
      return res.status(400).json({ error: 'bad-currency' });
    }

    const a = Number(amount);
    if (!Number.isInteger(a)) {
      return res.status(400).json({ error: 'bad-amount' });
    }

    const min = SUPPORT_CFG.min[cur];
    const max = SUPPORT_CFG.max[cur];
    if (a < min || a > max) {
      return res.status(400).json({ error: 'amount-range', min, max });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      submit_type: 'donate',
      line_items: [{
        price_data: {
          currency: cur,
          product_data: { name: l === 'hu' ? 'Senkisem támogatás' : 'Support Senkisem' },
          unit_amount: Math.round(a * 100),   // forint és dollár is: fő egység × 100
        },
        quantity: 1,
      }],
      success_url: `${process.env.DOMAIN}/support.html?s={CHECKOUT_SESSION_ID}&lang=${l}`,
      cancel_url: `${process.env.DOMAIN}/support.html?c=1&lang=${l}`,
      locale: l,
      metadata: { type: 'support', lang: l, source: 'senkisem.hu' },
    });

    res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Támogatás-session hiba:', error.message);
    res.status(500).json({ error: 'checkout-failed' });
  }
});

// 2) Fizetés ellenőrzése a Stripe-ból (a ?s= paramétert soha nem hisszük el)
app.get('/api/support/session', supportLimiter, async (req, res) => {
  try {
    const s = String(req.query.s || '');
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(s)) {
      return res.json({ paid: false });
    }

    const session = await stripe.checkout.sessions.retrieve(s);
    const ok = session
      && session.metadata && session.metadata.type === 'support'
      && session.payment_status === 'paid';

    if (!ok) return res.json({ paid: false });

    let n = null;
    try {
      n = await recordSupporter(session);   // idempotens: a webhook is ugyanezt hívja
    } catch (e) {
      console.error('⚠️ Támogató rögzítési hiba:', e.message);
    }

    res.json({
      paid: true,
      created: new Date(session.created * 1000).toISOString(),
      n: n || undefined,
    });

  } catch (error) {
    console.error('❌ Támogatás-ellenőrzési hiba:', error.message);
    res.status(500).json({ paid: false });
  }
});

// 3) Valós támogatói szám (a háttérben lévő pontokhoz)
app.get('/api/support/stats', supportLimiter, async (req, res) => {
  try {
    const supporters = await getSupporterCount();
    res.json({ supporters });
  } catch (error) {
    console.error('❌ Statisztika hiba:', error.message);
    res.status(503).json({});
  }
});

// ============================================
// ROUTES — AZONOSÍTÓ (belépés-napló, GDPR-hozzájárulások)
// ============================================
app.post('/api/ident/register', identRegisterLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const c = b.consent || {};
    const rid = String(b.rid || '');

    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'bad-email' });
    if (!RID_RE.test(rid)) return res.status(400).json({ error: 'bad-rid' });
    if (!(c.terms === true && c.local === true && c.age === true)) {
      return res.status(400).json({ error: 'consent-required' });
    }

    const anonymous = b.anonymous === true;
    const name = anonymous ? 'Anonim' : (cell(String(b.name || '').slice(0, 60)) || '-');
    const lang = b.lang === 'hu' ? 'hu' : 'en';
    const ver = String(b.consentVersion || '').slice(0, IDENT_CONSENT_VERSION_MAX);
    const now = new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' });

    await withLock(async () => {
      const sheet = await getTab(CONFIG.TABS.IDENT, IDENT_HEADERS);
      await sheet.addRow({
        'Dátum': now,
        'Azonosító ref': identRef(rid),
        'Név': name,
        'Anonim': anonymous ? 'igen' : 'nem',
        'Email': cell(email),
        'Nyelv': lang,
        'Hírlevél': b.newsletter === true ? 'igen' : 'nem',
        'Hozzájárulás verzió': cell(ver),
        'Hozzájárulás ideje': now,
        'Belépések': 0,
        'Utolsó belépés': '-',
        'Státusz': 'Aktív',
      });
    });

    console.log('🆔 Új azonosító regisztrálva');
    res.json({ ok: true });

  } catch (error) {
    console.error('❌ Azonosító regisztrációs hiba:', error.message);
    res.status(500).json({ error: 'register-failed' });
  }
});

// Belépés-napló: a kliens csak explicit belépéskor (nem minden oldalbetöltéskor) jelez
app.post('/api/ident/login', identPingLimiter, async (req, res) => {
  try {
    const rid = String((req.body || {}).rid || '');
    if (!RID_RE.test(rid)) return res.json({ ok: true });
    const ref = identRef(rid);

    await withLock(async () => {
      const sheet = await getTab(CONFIG.TABS.IDENT, IDENT_HEADERS);
      const rows = await sheet.getRows();
      const row = rows.find(r => r.get('Azonosító ref') === ref);
      if (!row) return;
      row.set('Belépések', (parseInt(row.get('Belépések'), 10) || 0) + 1);
      row.set('Utolsó belépés', new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }));
      await row.save();
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('⚠️ Belépés-napló hiba:', error.message);
    res.json({ ok: true });   // a belépést ez soha nem akadályozza
  }
});

// Törlési jog (GDPR 17. cikk): a fiók törlésekor a Sheets-sor is törlődik
app.post('/api/ident/erase', identPingLimiter, async (req, res) => {
  try {
    const rid = String((req.body || {}).rid || '');
    if (!RID_RE.test(rid)) return res.json({ ok: true });
    const ref = identRef(rid);

    await withLock(async () => {
      const sheet = await getTab(CONFIG.TABS.IDENT, IDENT_HEADERS);
      const rows = await sheet.getRows();
      const row = rows.find(r => r.get('Azonosító ref') === ref);
      if (row) await row.delete();
    });

    console.log('🗑️ Azonosító-sor törölve');
    res.json({ ok: true });
  } catch (error) {
    console.error('❌ Azonosító törlési hiba:', error.message);
    res.status(500).json({ error: 'erase-failed' });
  }
});

// ============================================
// ROUTES — WEBSHOP (megmaradt; alapból ZÁRVA: SHOP_ENABLED=true vagy product.json shop.enabled)
// ============================================

// Stripe session létrehozása + SHEETS MENTÉS (EMAIL NÉLKÜL)
app.post('/create-payment-session', async (req, res) => {
  if (!SHOP_ENABLED) {
    return res.status(403).json({ error: 'shop-closed' });
  }

  const { cart, customerData } = req.body;

  try {
    const ebookIds = [2, 4, 300];
    const isEbook = cart.every(item => ebookIds.includes(item.id));

    // Line items
    const lineItems = cart.map(item => {
      const product = products.find(p => p.id === parseInt(item.id));
      if (!product) throw new Error(`Termék nem található: ${item.id}`);
      if (product.inStock === false) throw new Error(`Nincs készleten: ${item.id}`);

      const quantity = item.quantity || 1;

      return {
        price_data: {
          currency: 'huf',
          product_data: {
            name: product.name,
            metadata: { productId: product.id }
          },
          unit_amount: Math.round(product.price * 100),
        },
        quantity: quantity,
      };
    });

    // Szállítási díj
    if (!isEbook) {
      if (customerData.shippingMethod === 'pickup') {
        lineItems.push({
          price_data: {
            currency: 'huf',
            product_data: { name: 'Foxpost Csomagpont' },
            unit_amount: CONFIG.SHIPPING.FOXPOST_COST * 100,
          },
          quantity: 1,
        });
      } else if (customerData.shippingMethod === 'home') {
        lineItems.push({
          price_data: {
            currency: 'huf',
            product_data: { name: 'Házhozszállítás' },
            unit_amount: CONFIG.SHIPPING.HOME_DELIVERY_COST * 100,
          },
          quantity: 1,
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: lineItems,
      success_url: isEbook
        ? `${process.env.DOMAIN}/success2.html?session_id={CHECKOUT_SESSION_ID}`
        : `${process.env.DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.DOMAIN}/cancel.html`,
      metadata: {
        source: 'senkisem.hu'
      },
      customer_email: customerData.email,
    });

    await saveOrderToSheets({ cart, customerData }, session.id);

    res.json({ payment_url: session.url });

  } catch (error) {
    console.error('❌ Session létrehozási hiba:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ⚠️ WEBHOOK
//   - metadata.type === 'support'  → támogató rögzítése
//   - egyébként                    → régi webshop-folyamat (email + számla)
// ============================================
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook signature hiba:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // ---- TÁMOGATÁS ----
    if (session.metadata && session.metadata.type === 'support') {
      try {
        if (session.payment_status === 'paid') {
          await recordSupporter(session);
        }
      } catch (error) {
        console.error('❌ Támogatás webhook hiba:', error.message);
        return res.status(500).json({ received: false });   // a Stripe újrapróbálja
      }
      return res.json({ received: true });
    }

    // ---- RÉGI WEBSHOP-FOLYAMAT ----
    console.log('\n🎉 ========================================');
    console.log('✅ SIKERES FIZETÉS ÉRKEZETT!');
    console.log('🎉 ========================================');
    console.log(`   Session ID: ${session.id}`);
    console.log(`   Email: ${session.customer_email}`);
    console.log(`   Összeg: ${session.amount_total / 100} Ft`);

    try {
      const sheet = await getSheet(CONFIG.SHEETS.ORDERS);
      const rows = await sheet.getRows();

      const orderRow = rows.find(row => row.get('Rendelés ID') === session.id);

      if (!orderRow) {
        console.error('❌ Rendelés nem található a Sheets-ben:', session.id);
        return res.json({ received: true });
      }

      orderRow.set('Státusz', 'Fizetve ✅');
      await orderRow.save();
      console.log('✅ Státusz frissítve: Fizetve ✅');

      const orderDataJSON = orderRow.get('Order Data JSON');

      if (!orderDataJSON) {
        console.error('❌ Nincs Order Data JSON a Sheets-ben a rendeléshez:', session.id);
        return res.json({ received: true });
      }

      const orderData = JSON.parse(orderDataJSON);
      const { cart, customerData } = orderData;

      const invoiceNumber = orderRow.get('Számla Szám');

      const productTotal = cart.reduce((sum, item) => {
        const price = typeof item.price === 'string' ?
          parseInt(item.price.replace(/\D/g, '')) : item.price;
        const quantity = item.quantity || 1;
        return sum + (price * quantity);
      }, 0);

      const shippingCost = calculateShippingCost(cart, customerData.shippingMethod);
      const totalAmount = productTotal + shippingCost;

      let downloadLinks = null;
      const hasDigitalProducts = cart.some(item => [2, 4, 300].includes(item.id));

      if (hasDigitalProducts) {
        console.log('📥 Letöltési linkek generálása...');
        downloadLinks = await generateDownloadLinks(
          cart,
          customerData.email,
          invoiceNumber,
          CONFIG.DOMAIN
        );
        console.log('✅ Letöltési linkek generálva');
      }

      console.log('📧 Email küldése...');
      await sendOrderEmail(orderData, totalAmount, invoiceNumber, downloadLinks);
      console.log('✅ Email sikeresen elküldve:', customerData.email);
      console.log(`📬 BCC másolat elküldve: ${CONFIG.EMAIL.BCC}`);

      console.log('🎉 RENDELÉS TELJES FELDOLGOZÁSA KÉSZ!\n');

    } catch (error) {
      console.error('❌ Webhook feldolgozási hiba:', error);
      // Ne dobjunk hibát - a Stripe újra próbálkozik
    }
  }

  res.json({ received: true });
});

// ============================================
// LETÖLTÉSI ÚTVONAL
// ============================================
app.get('/download/:token', downloadLimiter, async (req, res) => {
  const { token } = req.params;
  const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  console.log(`📥 Letöltési kísérlet - Token: ${token.substring(0, 8)}... IP: ${ipAddress}`);

  try {
    const validation = await validateDownloadToken(token, ipAddress);

    if (!validation.valid) {
      console.log(`❌ Letöltés megtagadva - Ok: ${validation.reason}`);
      return res.redirect(`/download-error.html?reason=${validation.reason}`);
    }

    const filePath = getProductFilePath(validation.productId);

    if (!filePath || !fs.existsSync(filePath)) {
      console.error(`❌ Fájl nem található: ${filePath}`);
      return res.redirect('/download-error.html?reason=server-error');
    }

    await markTokenAsUsed(validation.tokenRow, ipAddress);

    const fileName = getProductFileName(validation.productId);

    console.log(`✅ Fájl küldése: ${fileName}`);
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error('❌ Fájl küldési hiba:', err);
        if (!res.headersSent) {
          res.redirect('/download-error.html?reason=server-error');
        }
      } else {
        console.log(`✅ Letöltés kész: ${fileName}`);
      }
    });

  } catch (error) {
    console.error('❌ Letöltési hiba:', error);
    res.redirect('/download-error.html?reason=server-error');
  }
});

// ============================================
// ID: SENKISEM KITÖLTÉS — email küldés (clothing.html)
// ============================================
app.post('/api/id-modal-email', async (req, res) => {
  const { type, subject, html, uploadedFiles, customerEmail } = req.body;

  try {

    // ── ADMIN EMAIL ──
    if (type === 'admin') {
      const attachments = (uploadedFiles || []).map((f) => ({
        filename: f.name || 'kep.jpg',
        content:  Buffer.from(f.base64, 'base64'),
      }));

      await resend.emails.send({
        from:        `Senkisem <${process.env.RESEND_FROM_EMAIL}>`,
        to:          ['bellerzoltanezra@gmail.com'],
        subject:     subject,
        html:        html,
        attachments,
      });

      console.log('✅ [ID Modal] Admin email elküldve');
    }

    // ── VISSZAIGAZOLÓ EMAIL (vevőnek) ──
    if (type === 'confirmation' && customerEmail) {
      await resend.emails.send({
        from:    `Senkisem <${process.env.RESEND_FROM_EMAIL}>`,
        to:      [customerEmail],
        subject: subject,
        html:    html,
      });

      console.log('✅ [ID Modal] Visszaigazoló email elküldve:', customerEmail);
    }

    res.json({ success: true });

  } catch (error) {
    console.error('❌ [ID Modal] Email küldési hiba:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    webhook_enabled: true,
    email_on_payment_only: true,
    bcc_enabled: true,
    bcc_address: CONFIG.EMAIL.BCC,
    shop_enabled: SHOP_ENABLED,
    support_enabled: true,
    ident_enabled: true
  });
});

// ============================================
// BELÉPÉS-KAPU (GATE) — minden HTML oldalba beinjektáljuk a /gate.js-t,
// kivéve az index.html-t. Így a meglévő oldalakat nem kell átírni.
// ============================================
const PUBLIC_DIR = path.join(__dirname, 'public');
const GATE_EXEMPT = new Set(
  (process.env.GATE_EXEMPT || '/,/index.html').split(',').map(s => s.trim()).filter(Boolean)
);
// A <style> addig rejti az oldalt, amíg a gate.js nem engedi tovább (nincs "villanás")
const GATE_SNIPPET = '<style id="sn-lock">html{visibility:hidden!important}</style><script src="/gate.js"></script>';

app.use(async (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  let p;
  try { p = decodeURIComponent(req.path); } catch (e) { return next(); }
  if (p.endsWith('/')) p += 'index.html';
  if (!p.toLowerCase().endsWith('.html')) return next();

  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return next();   // path traversal ellen

  let html;
  try {
    html = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    return next();
  }

  const exempt = GATE_EXEMPT.has(p) || (p === '/index.html' && GATE_EXEMPT.has('/'));
  if (!exempt) {
    html = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, m => m + GATE_SNIPPET)
      : GATE_SNIPPET + html;
  }

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(html);
});

app.use(express.static(PUBLIC_DIR, { index: false }));

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ============================================
// SZERVER INDÍTÁS
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   🚀 SENKISEM.HU SZERVER — TÁMOGATÓI MODELL           ║
╠═══════════════════════════════════════════════════════╣
║   Port: ${PORT}
║   Támogatás:  ✅ /api/support/*  (HUF / USD)
║   Azonosító:  ✅ /api/ident/*    (+ gate.js injektálás)
║   Webshop:    ${SHOP_ENABLED ? '✅ BE ' : '⛔ KI '}(SHOP_ENABLED)
║   Webhook:    ✅ AKTÍV
║   Sheets:     2026 · ${CONFIG.TABS.SUPPORT} · ${CONFIG.TABS.IDENT}
╚═══════════════════════════════════════════════════════╝
  `);
});
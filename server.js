// ============================================================
// server.js — SENKISEM (webshop → támogatói modell)
// + egységes ID-Senkisem azonosítók (foglaltság-ellenőrzéssel)
// + kapcsolati űrlap (e-mail továbbítás, cím nélkül)
// + közösségi feed (támogatói szalag)
// + HETI SORSOLÁS (szombat 00:00, Europe/Budapest) — ugyanabban a táblázatban
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
    CONTACT: 'Üzenetek',
    DRAW_ENTRIES: 'Sorsolás beküldések',
    DRAW_RESULTS: 'Sorsolás eredmények',
  },
  SHIPPING: {
    FOXPOST_COST: 899,
    HOME_DELIVERY_COST: 2590,
  },
  EMAIL: {
    FROM: process.env.RESEND_FROM_EMAIL,
    BCC: 'hello@senkisem.com',
    CONTACT_TO: process.env.CONTACT_TO || 'hello@senkisem.com',   // kapcsolati űrlap címzettje
  },
  // Támogatók rangsorolásához: 1 USD hány forint (csak a "heti legnagyobb" összehasonlításhoz)
  FX_HUF_PER_USD: Number(process.env.SUPPORT_FX_HUF_PER_USD) || 330,
  DOMAIN: process.env.DOMAIN
};

const SUPPORT_HEADERS = ['Sorszám', 'Dátum', 'Session ID', 'Összeg', 'Pénznem', 'Nyelv', 'Email', 'Státusz', 'Időbélyeg'];
const IDENT_HEADERS = [
  'Dátum', 'Azonosító ref', 'Név', 'Anonim', 'Email', 'Nyelv', 'Hírlevél',
  'Hozzájárulás verzió', 'Hozzájárulás ideje', 'Belépések', 'Utolsó belépés', 'Státusz',
  'Azonosító'   // ÚJ: a nyilvános azonosító (ID-Senkisem XXXXXX vagy a választott név)
];
const CONTACT_HEADERS = ['Ref', 'Dátum', 'Név / ID', 'Regisztrált azonosító', 'Tárgy', 'Nyelv', 'Üzenet', 'Státusz'];
const DRAW_ENTRY_HEADERS = [
  'Ref', 'Dátum', 'Időbélyeg', 'Kör', 'Kör sorszám', 'Azonosító / név', 'Email', 'Regisztrált',
  'Beküldés', 'Link', 'Kép fájl', 'Kép hash', 'Nyelv', 'IP (hash)', 'Státusz'
];
const DRAW_RESULT_HEADERS = [
  'Kör', 'Kör sorszám', 'Húzás ideje', 'Beküldések', 'Személyek', 'Nyertesek száma',
  'Nyertes ref', 'Nyertes azonosító', 'Nyertes e-mail', 'Értesítve', 'Megjegyzés'
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

// Meglévő munkalap fejlécének kiegészítése új oszlopokkal (egyszer fut le folyamatonként)
const _headersChecked = new Set();
async function ensureHeaders(sheet, headers) {
  if (_headersChecked.has(sheet.title)) return;
  try {
    let have = [];
    try {
      await sheet.loadHeaderRow();
      have = (sheet.headerValues || []).filter(Boolean);
    } catch (e) {
      have = [];   // üres fejlécsor
    }
    const missing = headers.filter(h => !have.includes(h));
    if (missing.length) {
      const all = have.concat(missing);
      if (sheet.columnCount < all.length) {
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: all.length });
      }
      await sheet.setHeaderRow(all);
      console.log(`✅ Új oszlop(ok) a(z) ${sheet.title} munkalapon: ${missing.join(', ')}`);
    }
    _headersChecked.add(sheet.title);
  } catch (e) {
    console.error(`⚠️ Fejléc-ellenőrzés hiba (${sheet.title}):`, e.message);
  }
}

// Tetszőleges munkalap lekérése; ha nincs, létrehozza a fejlécekkel
async function getTab(title, headers) {
  const doc = new GoogleSpreadsheet(CONFIG.SHEETS.ORDERS, getGoogleAuth());
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[title];
  if (!sheet) {
    sheet = await doc.addSheet({ title, headerValues: headers });
    _headersChecked.add(title);
    console.log(`✅ Új munkalap létrehozva: ${title}`);
  } else {
    await ensureHeaders(sheet, headers);
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

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
      from: `Senkisem.com <${CONFIG.EMAIL.FROM}>`,
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
// AZONOSÍTÓ (ID-SENKISEM) — egységes formátum + foglaltság
// Formátum: "ID-Senkisem XXXXXX" (6 karakter, kötelezően van benne szám ÉS betű)
// Az ábécéből kimaradnak az összetéveszthető karakterek (0, O, 1, I).
// ============================================
const ID_PREFIX = 'ID-Senkisem';
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 32 elem → egyenletes eloszlás bájtból
const IDENT_CONSENT_VERSION_MAX = 40;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IDENT_PEPPER = process.env.IDENT_PEPPER || process.env.STRIPE_WEBHOOK_SECRET;
const RID_RE = /^[a-f0-9]{32}$/;

function idSuffixOk(s) { return /[A-Z]/.test(s) && /[2-9]/.test(s); }

function randomIdSuffix() {
  for (;;) {
    let s = '';
    for (let i = 0; i < 6; i++) s += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
    if (idSuffixOk(s)) return s;
  }
}

// Determinisztikus változat (pl. egy támogatás Session ID-jából): ugyanabból mindig ugyanaz
function derivedIdSuffix(seed) {
  for (let n = 0; ; n++) {
    const h = crypto.createHmac('sha256', IDENT_PEPPER).update(seed + '|' + n).digest();
    let s = '';
    for (let i = 0; i < 6; i++) s += ID_ALPHABET[h[i] % ID_ALPHABET.length];
    if (idSuffixOk(s)) return s;
  }
}

// "id senkisem a7k29x" / "ID-Senkisem-A7K29X" → "ID-Senkisem A7K29X" (különben null)
function canonicalId(input) {
  const m = /^id[-\s_]?senkisem[-\s_]?([a-z0-9]{6})$/i.exec(String(input || '').trim());
  return m ? `${ID_PREFIX} ${m[1].toUpperCase()}` : null;
}

// Összehasonlítási kulcs: kis/nagybetű, ékezet, szóköz, elválasztók nem számítanak
// ("Réka", "reka", "R.É.K.A" ugyanaz → nem adható ki kétszer)
function identKey(s) {
  return String(s == null ? '' : s)
    .replace(/^'/, '')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s._\-]+/g, '');
}

const RESERVED_HANDLES = new Set(['senkisem', 'senki', 'nobody', 'anonim', 'anonymous', 'admin', 'administrator', 'moderator', 'support', 'hello', 'team', 'staff']);
const HANDLE_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*[\p{L}\p{N}]$/u;

// null = rendben, különben hibakód
function validateHandle(name) {
  const n = String(name || '').trim();
  if (n.length < 3 || n.length > 24 || !HANDLE_RE.test(n)) return 'bad-name';
  const k = identKey(n);
  if (k.startsWith('idsenkisem') || RESERVED_HANDLES.has(k)) return 'name-reserved';
  return null;
}

// Az eddig foglalt azonosítók kulcsai (új "Azonosító" oszlop + a régi, névvel regisztráltak "Név" oszlopa)
function takenSet(rows) {
  const taken = new Set();
  rows.forEach(r => {
    const a = identKey(r.get('Azonosító'));
    if (a) taken.add(a);
    const n = String(r.get('Név') || '');
    if (n && n !== 'Anonim' && n !== '-') taken.add(identKey(n));
  });
  return taken;
}

// Azonosító → regisztrált sor (a kapcsolati űrlaphoz: tudjunk válaszolni)
async function findIdentity(handle) {
  const key = identKey(canonicalId(handle) || handle);
  if (!key) return null;
  const sheet = await getTab(CONFIG.TABS.IDENT, IDENT_HEADERS);
  const rows = await sheet.getRows();
  const row = rows.find(r => identKey(r.get('Azonosító')) === key);
  if (!row) return null;
  const email = String(row.get('Email') || '').replace(/^'/, '');
  return { email: EMAIL_RE.test(email) ? email : null };
}

// Szerver által kiadott, még nem használt ID-k (belső hivatkozásokhoz: pl. ID: Senkisem kitöltés, olvasó példány)
const issuedIds = new Set();

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
      'Időbélyeg': new Date().toISOString(),
    });

    supporterCache = { count: n, at: Date.now() };
    feedCache = { at: 0, data: null };
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

// ---- Közösségi feed: heti legnagyobb + 2 legfrissebb támogató (e-mail/név SOHA nem kerül ki) ----
let feedCache = { at: 0, data: null };

// A régi sorok "2026. 10. 13. 14:05:33" formátumú dátumát próbáljuk visszafejteni (Budapest ≈ UTC+1/+2)
function parseHuDate(s) {
  const m = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s || ''));
  if (!m) return 0;
  const [Y, Mo, D, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const se = m[6] ? Number(m[6]) : 0;
  const offset = (Mo >= 4 && Mo <= 10) ? 2 : 1;
  return Date.UTC(Y, Mo - 1, D, h, mi, se) - offset * 3600000;
}

function parseAmount(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[\s\u00a0]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

async function getFeed() {
  if (feedCache.data && Date.now() - feedCache.at < 45 * 1000) return feedCache.data;

  const sheet = await getTab(CONFIG.TABS.SUPPORT, SUPPORT_HEADERS);
  const rows = await sheet.getRows();

  const paid = rows
    .filter(r => /Fizetve/.test(String(r.get('Státusz') || '')))
    .map(r => {
      const iso = Date.parse(String(r.get('Időbélyeg') || ''));
      const at = Number.isFinite(iso) ? iso : parseHuDate(r.get('Dátum'));
      const cur = String(r.get('Pénznem') || '').toUpperCase();
      const amount = parseAmount(r.get('Összeg'));
      return {
        sid: String(r.get('Session ID') || ''),
        at, cur, amount,
        usd: cur === 'HUF' ? amount / CONFIG.FX_HUF_PER_USD : amount,
      };
    })
    .filter(p => p.sid && p.at && p.amount > 0);

  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const week = paid.filter(p => p.at >= weekAgo);

  let top = null;
  week.forEach(p => { if (!top || p.usd > top.usd || (p.usd === top.usd && p.at > top.at)) top = p; });

  const label = sid => `${ID_PREFIX} ${derivedIdSuffix('sup|' + sid)}`;
  const recent = paid.slice().sort((a, b) => b.at - a.at).slice(0, 2)
    .map(p => ({ id: label(p.sid), at: new Date(p.at).toISOString() }));

  const data = {
    supporters: await getSupporterCount().catch(() => 0),
    week: week.length,
    top: top ? { id: label(top.sid), amount: top.amount, currency: top.cur } : null,
    recent,
  };
  feedCache = { at: Date.now(), data };
  return data;
}

// ============================================
// HETI SORSOLÁS — segédek (szombat 00:00, Europe/Budapest)
// A beküldések és az eredmények ugyanabba a táblázatba kerülnek, mint minden más
// (CONFIG.TABS.DRAW_ENTRIES / DRAW_RESULTS munkalapok, automatikusan létrejönnek).
// ============================================
const DRAW_TZ = 'Europe/Budapest';
// Az első sorsolás: 2026-10-24 (szombat) 00:00 CEST = 2026-10-23 22:00 UTC
const DRAW_FIRST = Date.UTC(2026, 9, 23, 22, 0, 0);
const DRAW_WEEK = 7 * 24 * 3600 * 1000;
const DRAW_WINNERS = Math.max(1, Number(process.env.DRAW_WINNERS) || 1);
const DRAW_MAX_PER_PERSON = 3;
const DRAW_UPLOAD_DIR = process.env.DRAW_UPLOAD_DIR || path.join(__dirname, 'draw-uploads');
const DRAW_HOSTS = (process.env.DRAW_HOSTS ||
  'instagram.com,tiktok.com,youtube.com,youtu.be,facebook.com,fb.com,fb.watch,x.com,twitter.com,threads.net,threads.com,reddit.com,bsky.app,snapchat.com,pinterest.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const _drawDtf = new Intl.DateTimeFormat('en-US', {
  timeZone: DRAW_TZ, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});
const _WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function _bp(ms) { const o = {}; _drawDtf.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; }); return o; }
function _off(ms) {
  const p = _bp(ms);
  return Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function _mid(y, m, d) { const g = Date.UTC(y, m - 1, d); const u = g - _off(g); return g - _off(u); }

// a következő szombat 00:00 (budapesti idő) — szigorúan a megadott időpont UTÁN (nyári/téli váltás-biztos)
function satAfter(ms) {
  const p = _bp(ms);
  const add = (6 - _WD[p.weekday] + 7) % 7;
  let c = _mid(+p.year, +p.month, +p.day + add);
  if (c <= ms) c = _mid(+p.year, +p.month, +p.day + add + 7);
  return c;
}
function drawNext(ms) { return ms < DRAW_FIRST ? DRAW_FIRST : satAfter(ms); }
function drawKey(ms) { const p = _bp(ms); return `${p.year}-${p.month}-${p.day}`; }       // pl. 2026-10-24
function drawRoundNo(ms) { return Math.max(1, Math.round((ms - DRAW_FIRST) / DRAW_WEEK) + 1); }

const drawCache = { count: { key: '', at: 0, n: 0 }, last: { at: 0, data: null } };
const drawRef = () => 'S-' + crypto.randomBytes(3).toString('hex').toUpperCase();
const unq = v => String(v == null ? '' : v).replace(/^'/, '');

function drawHostOk(host) {
  host = String(host || '').toLowerCase().replace(/^www\./, '');
  return DRAW_HOSTS.some(d => host === d || host.endsWith('.' + d));
}
function normLink(u) {
  try {
    const x = new URL(u);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'igsh', 'igshid', 'si', 'fbclid', 's', 't']
      .forEach(k => x.searchParams.delete(k));
    return x.hostname.replace(/^www\.|^m\./, '').toLowerCase() + x.pathname.replace(/\/+$/, '') + (x.search || '');
  } catch (e) { return ''; }
}
function publicLabel(name) {
  const c = canonicalId(name);
  if (c) return c;
  const s = String(name || '').trim();
  return s ? s.slice(0, 2) + '•••' : '';
}
function personKeyOf(name, email) {
  const m = unq(email).toLowerCase();
  return m ? 'm:' + m : 'n:' + identKey(name);
}
function ipHash(req) {
  return crypto.createHmac('sha256', IDENT_PEPPER).update(String(req.ip || '')).digest('hex').slice(0, 16);
}

async function drawEntryCount(key) {
  const c = drawCache.count;
  if (c.key === key && Date.now() - c.at < 20 * 1000) return c.n;
  const sheet = await getTab(CONFIG.TABS.DRAW_ENTRIES, DRAW_ENTRY_HEADERS);
  const rows = await sheet.getRows();
  const n = rows.filter(r => r.get('Kör') === key && /^(Érvényes|NYERTES)$/.test(String(r.get('Státusz') || ''))).length;
  drawCache.count = { key, at: Date.now(), n };
  return n;
}

async function drawLast() {
  const c = drawCache.last;
  if (c.data && Date.now() - c.at < 60 * 1000) return c.data;
  const sheet = await getTab(CONFIG.TABS.DRAW_RESULTS, DRAW_RESULT_HEADERS);
  const rows = await sheet.getRows();
  let best = null;
  rows.forEach(r => {
    const at = Date.parse(String(r.get('Húzás ideje') || ''));
    if (Number.isFinite(at) && (!best || at > best.at)) best = { at, r };
  });
  let data = null;
  if (best) {
    const labels = String(best.r.get('Nyertes azonosító') || '').split(' | ').map(publicLabel).filter(Boolean);
    data = {
      round: parseInt(best.r.get('Kör sorszám'), 10) || null,
      at: best.at,
      entries: parseInt(best.r.get('Beküldések'), 10) || 0,
      label: labels.join(', ')
    };
  }
  drawCache.last = { at: Date.now(), data };
  return data;
}

// A húzás: kriptográfiai véletlennel, egy beküldés = egy esély, egy személy egy körben legfeljebb egyszer nyerhet
async function runDrawForRound(key, drawMs) {
  let winners = [], total = 0, people = 0, resRow = null;

  const did = await withLock(async () => {
    const resTab = await getTab(CONFIG.TABS.DRAW_RESULTS, DRAW_RESULT_HEADERS);
    const resRows = await resTab.getRows();
    if (resRows.some(r => r.get('Kör') === key)) return false;          // ezt a kört már lehúztuk

    const entTab = await getTab(CONFIG.TABS.DRAW_ENTRIES, DRAW_ENTRY_HEADERS);
    const rows = (await entTab.getRows()).filter(r => r.get('Kör') === key && r.get('Státusz') === 'Érvényes');
    total = rows.length;
    people = new Set(rows.map(r => personKeyOf(r.get('Azonosító / név'), r.get('Email')))).size;

    const pool = rows.slice(), picked = [], used = new Set();
    while (picked.length < DRAW_WINNERS && pool.length) {
      const r = pool.splice(crypto.randomInt(pool.length), 1)[0];
      const pk = personKeyOf(r.get('Azonosító / név'), r.get('Email'));
      if (used.has(pk)) continue;
      used.add(pk); picked.push(r);
    }

    winners = picked.map(r => ({
      ref: r.get('Ref'),
      name: r.get('Azonosító / név'),
      email: unq(r.get('Email')),
      lang: r.get('Nyelv') === 'hu' ? 'hu' : 'en',
      link: r.get('Link'),
      img: r.get('Kép fájl')
    }));

    // ELŐSZÖR az eredményt rögzítjük (így összeomlás esetén sem húzunk újra más nyertest)
    resRow = await resTab.addRow({
      'Kör': key,
      'Kör sorszám': drawRoundNo(drawMs),
      'Húzás ideje': new Date().toISOString(),
      'Beküldések': total,
      'Személyek': people,
      'Nyertesek száma': winners.length,
      'Nyertes ref': winners.map(w => w.ref).join(' | '),
      'Nyertes azonosító': winners.map(w => cell(w.name)).join(' | '),
      'Nyertes e-mail': winners.map(w => cell(w.email)).join(' | '),
      'Értesítve': winners.length ? 'folyamatban' : '-',
      'Megjegyzés': winners.length ? '' : 'Nem volt beküldés ebben a körben.'
    });
    for (const r of picked) { r.set('Státusz', 'NYERTES'); await r.save(); }
    return true;
  });

  if (!did) return;
  drawCache.count = { key: '', at: 0, n: 0 };
  drawCache.last = { at: 0, data: null };
  console.log(`🎉 Sorsolás lefutott: kör ${key}, ${total} beküldés, ${winners.length} nyertes`);

  // értesítések a záron kívül
  let status = '-';
  try {
    for (const w of winners) {
      const hu = w.lang === 'hu';
      const body = hu
        ? `<p>Szia!</p><p>Gratulálunk, <b>te nyerted</b> a Senkisem heti sorsolását (${escHtml(key)}). A beküldésed hivatkozása: <b>${escHtml(w.ref)}</b>.</p>
<p>Válaszolj erre az e-mailre 14 napon belül, és megbeszéljük a nyereményt.</p><p>— Senkisem</p>`
        : `<p>Hi!</p><p>Congratulations, <b>you won</b> the Senkisem weekly draw (${escHtml(key)}). Your entry reference: <b>${escHtml(w.ref)}</b>.</p>
<p>Reply to this e-mail within 14 days and we will arrange the prize.</p><p>— Senkisem</p>`;
      const sent = await resend.emails.send({
        from: `Senkisem <${CONFIG.EMAIL.FROM}>`,
        to: w.email,
        bcc: CONFIG.EMAIL.BCC,
        replyTo: CONFIG.EMAIL.CONTACT_TO,
        subject: hu ? 'Nyertél a Senkisem szombati sorsolásán 🎉' : 'You won the Senkisem Saturday draw 🎉',
        html: body
      });
      if (sent && sent.error) throw new Error(sent.error.message || 'resend-error');
    }
    if (winners.length) status = 'igen';
  } catch (e) {
    status = 'HIBA: ' + e.message;
    console.error('❌ Nyertes-értesítés hiba:', e.message);
  }

  try {
    const lines = winners.length
      ? winners.map(w => `<li><b>${escHtml(w.name)}</b> · ${escHtml(w.ref)} · ${escHtml(w.email)} · ${w.link ? `<a href="${escHtml(w.link)}">${escHtml(w.link)}</a>` : escHtml(w.img || 'kép')}</li>`).join('')
      : '<li>Nem volt beküldés.</li>';
    await resend.emails.send({
      from: `Senkisem Sorsolás <${CONFIG.EMAIL.FROM}>`,
      to: CONFIG.EMAIL.CONTACT_TO,
      subject: `[Sorsolás] Kör ${key} lezárult — ${winners.length} nyertes, ${total} beküldés`,
      html: `<p>Kör: <b>${escHtml(key)}</b> (№ ${drawRoundNo(drawMs)})<br>Beküldés: ${total} · személy: ${people}<br>Nyertes-értesítés: ${escHtml(status)}</p><ul>${lines}</ul>`
    });
  } catch (e) { console.error('⚠️ Sorsolás admin összegző e-mail hiba:', e.message); }

  if (resRow && winners.length) {
    try { resRow.set('Értesítve', status); await resRow.save(); } catch (e) { console.error('⚠️ Értesítés-állapot mentése:', e.message); }
  }
}

let _drawDone = '';
async function drawTick() {
  try {
    const now = Date.now();
    if (now < DRAW_FIRST) return;
    const due = [];
    for (let t = DRAW_FIRST; t <= now; t = satAfter(t)) due.push([drawKey(t), t]);
    const lastKey = due[due.length - 1][0];
    if (_drawDone === lastKey) return;
    for (const [k, t] of due.slice(-12)) await runDrawForRound(k, t);   // kiesett hetek pótlása is
    _drawDone = lastKey;
  } catch (e) {
    console.error('❌ Sorsolás-ütemező hiba:', e.message);   // a következő tickben újrapróbálja
  }
}

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

const feedLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
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

const contactLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 4,
  message: { error: 'too-many-requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const contactDayLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 15,
  message: { error: 'too-many-requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const drawLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  message: { error: 'too-many-requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const drawDayLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 40,
  message: { error: 'too-many-requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const drawStatusLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
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
      metadata: { type: 'support', lang: l, source: 'senkisem.com' },
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
// ROUTES — KÖZÖSSÉG (community.html: támogatói szalag)
// Csak anonimizált adat: ID-Senkisem címke, összeg (csak a heti legnagyobbnál), idő.
// ============================================
app.get('/api/community/feed', feedLimiter, async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=30');
    res.json(await getFeed());
  } catch (error) {
    console.error('❌ Közösségi feed hiba:', error.message);
    res.status(503).json({});
  }
});

// ============================================
// ROUTES — HETI SORSOLÁS (community.html)
// ============================================

// Státusz: szerveridő + beküldésszám + legutóbbi nyertes (személyes adat nélkül)
app.get('/api/draw/status', drawStatusLimiter, async (req, res) => {
  const now = Date.now();
  const next = drawNext(now);
  let entries = null, last = null;
  try { entries = await drawEntryCount(drawKey(next)); } catch (e) { console.error('⚠️ Sorsolás-státusz (beküldések):', e.message); }
  try { last = await drawLast(); } catch (e) { console.error('⚠️ Sorsolás-státusz (utolsó):', e.message); }
  res.set('Cache-Control', 'no-store');
  res.json({ now, next, round: drawRoundNo(next), entries, last });
});

// Beküldés: minden beküldés bekerül a "Sorsolás beküldések" munkalapra
app.post('/api/draw/enter', drawLimiter, drawDayLimiter, async (req, res) => {
  try {
    const b = req.body || {};

    // botcsapda: kitöltött rejtett mező vagy emberileg lehetetlenül gyors → "siker", de nem mentünk semmit
    if (String(b.hp || '').trim() || (Number(b.t) || 0) < 3000) {
      const nx = drawNext(Date.now());
      return res.json({ ok: true, ref: drawRef(), next: nx, round: drawRoundNo(nx), count: 1, limit: DRAW_MAX_PER_PERSON });
    }

    if (b.consent !== true) return res.status(400).json({ error: 'consent-required' });

    const name = String(b.name || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (name.length < 2) return res.status(400).json({ error: 'bad-name' });
    const handle = canonicalId(name) || name;
    const lang = b.lang === 'hu' ? 'hu' : 'en';

    const email = String(b.email || '').trim().toLowerCase();
    if (email && (!EMAIL_RE.test(email) || email.length > 254)) return res.status(400).json({ error: 'need-email' });

    // regisztrált azonosító? akkor a regisztrált e-mail is megfelel
    let found = null;
    try { found = await findIdentity(handle); } catch (e) { console.error('⚠️ Azonosító-keresés hiba:', e.message); }
    const useEmail = email || (found && found.email) || '';
    if (!useEmail) return res.status(400).json({ error: 'need-email' });

    // link vagy kép
    let link = '', imgBuf = null, imgHash = '';
    const img = b.image && typeof b.image === 'object' ? b.image : null;
    if (img && img.base64) {
      imgBuf = Buffer.from(String(img.base64), 'base64');
      const jpeg = imgBuf.length > 3 && imgBuf[0] === 0xff && imgBuf[1] === 0xd8 && imgBuf[2] === 0xff;
      if (imgBuf.length < 2048 || imgBuf.length > 6 * 1024 * 1024 || !jpeg) return res.status(400).json({ error: 'bad-image' });
      imgHash = crypto.createHash('sha256').update(imgBuf).digest('hex').slice(0, 24);
    } else {
      link = String(b.link || '').trim();
      let u;
      try { u = new URL(link); } catch (e) { return res.status(400).json({ error: 'bad-link' }); }
      if (u.protocol !== 'https:' || link.length > 300 || u.username || u.password || u.pathname.length < 2 || !drawHostOk(u.hostname)) {
        return res.status(400).json({ error: 'bad-link' });
      }
    }

    const ref = drawRef();
    const ihash = ipHash(req);
    let outcome = null;

    // a lock alatt ellenőrzünk ÉS írunk (és a húzás is ugyanezt a zárat használja → nincs versenyhelyzet)
    await withLock(async () => {
      const nowMs = Date.now();
      const next = drawNext(nowMs);
      const key = drawKey(next);
      const sheet = await getTab(CONFIG.TABS.DRAW_ENTRIES, DRAW_ENTRY_HEADERS);
      const rows = (await sheet.getRows()).filter(r => r.get('Kör') === key && r.get('Státusz') !== 'Érvénytelen');

      const myName = identKey(handle), myMail = useEmail.toLowerCase();
      const mine = rows.filter(r => identKey(r.get('Azonosító / név')) === myName || unq(r.get('Email')).toLowerCase() === myMail).length;
      if (mine >= DRAW_MAX_PER_PERSON) { outcome = { status: 400, body: { error: 'limit' } }; return; }

      if (link) {
        const n = normLink(link);
        if (n && rows.some(r => r.get('Link') && normLink(r.get('Link')) === n)) { outcome = { status: 409, body: { error: 'duplicate' } }; return; }
      } else if (rows.some(r => r.get('Kép hash') === imgHash)) {
        outcome = { status: 409, body: { error: 'duplicate' } }; return;
      }

      let fileName = '';
      if (imgBuf) {
        try {
          await fs.promises.mkdir(DRAW_UPLOAD_DIR, { recursive: true });
          fileName = `${ref}.jpg`;
          await fs.promises.writeFile(path.join(DRAW_UPLOAD_DIR, fileName), imgBuf);
        } catch (e) { console.error('⚠️ Kép mentési hiba:', e.message); fileName = '(csak e-mailben)'; }
      }

      await sheet.addRow({
        'Ref': ref,
        'Dátum': new Date(nowMs).toLocaleString('hu-HU', { timeZone: DRAW_TZ }),
        'Időbélyeg': new Date(nowMs).toISOString(),
        'Kör': key,
        'Kör sorszám': drawRoundNo(next),
        'Azonosító / név': cell(handle),
        'Email': cell(useEmail),
        'Regisztrált': found ? 'igen' : 'nem',
        'Beküldés': imgBuf ? 'kép' : 'link',
        'Link': cell(link),
        'Kép fájl': fileName,
        'Kép hash': imgHash,
        'Nyelv': lang,
        'IP (hash)': ihash,
        'Státusz': 'Érvényes'
      });

      drawCache.count = { key: '', at: 0, n: 0 };
      outcome = { status: 200, body: { ok: true, ref, next, round: drawRoundNo(next), count: mine + 1, limit: DRAW_MAX_PER_PERSON }, key };
    });

    if (outcome.status !== 200) return res.status(outcome.status).json(outcome.body);

    // admin értesítő (nem blokkoló; a képet mellékletként is elküldjük, mert a szerver lemeze ideiglenes lehet)
    (async () => {
      const mail = {
        from: `Senkisem Sorsolás <${CONFIG.EMAIL.FROM}>`,
        to: CONFIG.EMAIL.CONTACT_TO,
        subject: `[Sorsolás] Új beküldés ${ref} · kör ${outcome.key}`,
        html: `<p><b>${escHtml(ref)}</b> · kör ${escHtml(outcome.key)} (№ ${outcome.body.round})</p>
<p>Azonosító / név: <b>${escHtml(handle)}</b> (${found ? 'regisztrált' : 'nem regisztrált'})<br>
Beküldés: ${imgBuf ? 'kép (melléklet)' : `<a href="${escHtml(link)}">${escHtml(link)}</a>`}</p>`
      };
      if (imgBuf) mail.attachments = [{ filename: `${ref}.jpg`, content: imgBuf }];
      const sent = await resend.emails.send(mail);
      if (sent && sent.error) throw new Error(sent.error.message || 'resend-error');
    })().catch(e => console.error('⚠️ Sorsolás admin e-mail hiba:', e.message));

    console.log(`🎟️ Sorsolás-beküldés: ${ref} (kör ${outcome.key})`);
    res.json(outcome.body);

  } catch (error) {
    console.error('❌ Sorsolás-beküldési hiba:', error.message);
    res.status(500).json({ error: 'enter-failed' });
  }
});

// ============================================
// ROUTES — KAPCSOLAT (űrlap → hello@senkisem.com; a cím sosem kerül a kliensre)
// ============================================
const CONTACT_SUBJECTS = {
  pay: 'Támogatás / fizetés',
  id: 'ID-Senkisem / belépés',
  concept: 'A koncepcióm',
  book: 'Könyvek / olvasó',
  tech: 'Technikai hiba',
  other: 'Egyéb',
};

function contactRef() {
  return 'K-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

app.post('/api/contact', contactLimiter, contactDayLimiter, async (req, res) => {
  try {
    const b = req.body || {};

    // Botcsapdák: kitöltött rejtett mező, vagy emberileg lehetetlenül gyors beküldés → "sikeres" válasz, de nem megy el semmi
    const elapsed = Number(b.t) || 0;
    if (String(b.hp || '').trim() || elapsed < 1500) {
      return res.json({ ok: true, ref: contactRef() });
    }

    const name = String(b.name || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const subjectKey = String(b.subject || '');
    const message = String(b.message || '')
      .replace(/\r\n/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .trim()
      .slice(0, 2000);
    const lang = b.lang === 'hu' ? 'hu' : 'en';

    if (name.length < 2) return res.status(400).json({ error: 'bad-name' });
    if (!CONTACT_SUBJECTS[subjectKey]) return res.status(400).json({ error: 'bad-subject' });
    if (message.length < 10) return res.status(400).json({ error: 'bad-message' });

    const ref = contactRef();
    const subjectLabel = CONTACT_SUBJECTS[subjectKey];

    // Ha a megadott név/ID regisztrált, a válasz-cím a regisztrált e-mail lesz (a feladó nem látja, mi sem mutatjuk ki)
    let found = null;
    try { found = await findIdentity(name); } catch (e) { console.error('⚠️ Azonosító-keresés hiba:', e.message); }

    const now = new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' });
    const html = `<!DOCTYPE html><html lang="hu"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Tahoma,sans-serif;">
<div style="max-width:620px;margin:0 auto;background:#fff;">
<div style="background:#000;padding:26px 24px;text-align:center;">
<h1 style="color:#fff;font-size:20px;letter-spacing:2px;margin:0;text-transform:uppercase;">Kapcsolat — új üzenet</h1>
<p style="color:rgba(255,255,255,.55);font-size:12px;margin:6px 0 0;">${escHtml(ref)} · ${escHtml(now)}</p></div>
<div style="padding:28px;">
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;color:#222;">
<tr><td style="padding:6px 0;color:#777;width:34%;">Név / ID</td><td style="padding:6px 0;font-weight:600;">${escHtml(name)}</td></tr>
<tr><td style="padding:6px 0;color:#777;">Regisztrált azonosító</td><td style="padding:6px 0;">${found ? (found.email ? 'igen — a válasz-cím be van állítva (Reply-To)' : 'igen, de nincs érvényes e-mail') : 'nem található → nem tudunk válaszolni'}</td></tr>
<tr><td style="padding:6px 0;color:#777;">Tárgy</td><td style="padding:6px 0;font-weight:600;">${escHtml(subjectLabel)}</td></tr>
<tr><td style="padding:6px 0;color:#777;">Nyelv</td><td style="padding:6px 0;">${escHtml(lang)}</td></tr>
</table>
<h2 style="font-size:15px;margin:24px 0 10px;border-bottom:1px solid #eee;padding-bottom:8px;">Üzenet</h2>
<div style="font-size:14px;line-height:1.7;color:#111;white-space:pre-wrap;word-wrap:break-word;">${escHtml(message)}</div>
<p style="font-size:11px;color:#999;margin-top:28px;">Az azonosító létezése nem jelent hitelesítést: bárki beírhat egy nyilvános ID-t. Fizetési / személyes ügyekben kérdezz vissza.</p>
</div></div></body></html>`;

    const mail = {
      from: `Senkisem Kapcsolat <${CONFIG.EMAIL.FROM}>`,
      to: CONFIG.EMAIL.CONTACT_TO,
      subject: `[Kapcsolat] ${subjectLabel} — ${ref}`,
      html,
    };
    if (found && found.email) mail.replyTo = found.email;

    const sent = await resend.emails.send(mail);
    if (sent && sent.error) throw new Error(sent.error.message || 'resend-error');

    // Naplózás (nem blokkoló)
    withLock(async () => {
      const sheet = await getTab(CONFIG.TABS.CONTACT, CONTACT_HEADERS);
      await sheet.addRow({
        'Ref': ref,
        'Dátum': now,
        'Név / ID': cell(name),
        'Regisztrált azonosító': found ? 'igen' : 'nem',
        'Tárgy': subjectLabel,
        'Nyelv': lang,
        'Üzenet': cell(message),
        'Státusz': 'Új',
      });
    }).catch(e => console.error('⚠️ Üzenet-napló hiba:', e.message));

    console.log(`✉️ Kapcsolati üzenet elküldve: ${ref}`);
    res.json({ ok: true, ref });

  } catch (error) {
    console.error('❌ Kapcsolati üzenet hiba:', error.message);
    res.status(502).json({ error: 'send-failed' });
  }
});

// ============================================
// ROUTES — AZONOSÍTÓ (belépés-napló, GDPR-hozzájárulások)
// ============================================

// Foglaltság-ellenőrzés (gépelés közben hívható). Alternatívát SOHA nem javasol.
app.get('/api/ident/check', identPingLimiter, async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    const bad = validateHandle(name);
    if (bad) return res.json({ available: false, reason: bad });

    const sheet = await getTab(CONFIG.TABS.IDENT, IDENT_HEADERS);
    const rows = await sheet.getRows();
    const taken = takenSet(rows).has(identKey(name));
    res.json(taken ? { available: false, reason: 'name-taken' } : { available: true });
  } catch (error) {
    console.error('❌ Azonosító-ellenőrzési hiba:', error.message);
    res.status(500).json({ error: 'check-failed' });
  }
});

// Új, egyedi ID-Senkisem kiadása belső hivatkozásokhoz (kitöltési ref, olvasó-példány stb.)
app.get('/api/ident/new-id', identPingLimiter, async (req, res) => {
  try {
    let taken = new Set();
    try {
      const sheet = await getTab(CONFIG.TABS.IDENT, IDENT_HEADERS);
      taken = takenSet(await sheet.getRows());
    } catch (e) { /* a memóriabeli lista akkor is véd */ }

    let id;
    do { id = `${ID_PREFIX} ${randomIdSuffix()}`; }
    while (taken.has(identKey(id)) || issuedIds.has(identKey(id)));

    if (issuedIds.size > 20000) issuedIds.clear();
    issuedIds.add(identKey(id));
    res.json({ id });
  } catch (error) {
    console.error('❌ ID-kiadási hiba:', error.message);
    res.status(500).json({ error: 'id-failed' });
  }
});

// Regisztráció. A belépési adatok (jelszó jellegű) SOHA nem kerülnek a szerverre — ez változatlan.
// Új: a szerver adja ki a nyilvános azonosítót, és visszaadja: { ok:true, id }.
//   - anonim (vagy név nélküli) → "ID-Senkisem XXXXXX"
//   - választott név/felhasználónév → foglaltság-ellenőrzés; foglalt esetén 409 {error:'name-taken'} (alternatíva nélkül)
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
    const rawName = String(b.name || '').replace(/\s+/g, ' ').trim();
    const wantsName = !anonymous && rawName.length > 0;

    if (wantsName) {
      const bad = validateHandle(rawName);
      if (bad) return res.status(400).json({ error: bad });
    }

    const lang = b.lang === 'hu' ? 'hu' : 'en';
    const ver = String(b.consentVersion || '').slice(0, IDENT_CONSENT_VERSION_MAX);
    const now = new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' });

    let handle = '';
    let conflict = false;

    // a lock alatt ellenőrzünk ÉS írunk: két egyidejű kérés sem kaphatja ugyanazt
    await withLock(async () => {
      const sheet = await getTab(CONFIG.TABS.IDENT, IDENT_HEADERS);
      const rows = await sheet.getRows();
      const taken = takenSet(rows);

      if (wantsName) {
        if (taken.has(identKey(rawName))) { conflict = true; return; }
        handle = rawName;
      } else {
        let g;
        do { g = `${ID_PREFIX} ${randomIdSuffix()}`; }
        while (taken.has(identKey(g)) || issuedIds.has(identKey(g)));
        handle = g;
      }

      await sheet.addRow({
        'Dátum': now,
        'Azonosító ref': identRef(rid),
        'Név': wantsName ? cell(handle) : 'Anonim',
        'Anonim': wantsName ? 'nem' : 'igen',
        'Email': cell(email),
        'Nyelv': lang,
        'Hírlevél': b.newsletter === true ? 'igen' : 'nem',
        'Hozzájárulás verzió': cell(ver),
        'Hozzájárulás ideje': now,
        'Belépések': 0,
        'Utolsó belépés': '-',
        'Státusz': 'Aktív',
        'Azonosító': cell(handle),
      });
    });

    if (conflict) return res.status(409).json({ error: 'name-taken' });

    console.log('🆔 Új azonosító regisztrálva');
    res.json({ ok: true, id: handle, generated: !wantsName });

  } catch (error) {
    console.error('❌ Azonosító regisztrációs hiba:', error.message);
    res.status(500).json({ error: 'register-failed' });
  }
});

function identRef(rid) {
  return crypto.createHmac('sha256', IDENT_PEPPER).update(String(rid)).digest('hex').slice(0, 20);
}

// Belépés-napló: a kliens csak explicit belépéskor (nem minden oldalbetöltéskor) jelez
app.post('/api/ident/login', identPingLimiter, async (req, res) => {
  try {
    const rid = String((req.body || {}).rid || '');
    if (!RID_RE.test(rid)) return res.json({ ok: true });
    const ref = identRef(rid);
    let publicId = '';

    await withLock(async () => {
      const sheet = await getTab(CONFIG.TABS.IDENT, IDENT_HEADERS);
      const rows = await sheet.getRows();
      const row = rows.find(r => r.get('Azonosító ref') === ref);
      if (!row) return;
      publicId = String(row.get('Azonosító') || '');
      row.set('Belépések', (parseInt(row.get('Belépések'), 10) || 0) + 1);
      row.set('Utolsó belépés', new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }));
      await row.save();
    });

    res.json({ ok: true, id: publicId });
  } catch (error) {
    console.error('⚠️ Belépés-napló hiba:', error.message);
    res.json({ ok: true });   // a belépést ez soha nem akadályozza
  }
});

// Törlési jog (GDPR 17. cikk): a fiók törlésekor a Sheets-sor is törlődik
// (az azonosító ilyenkor újra szabaddá válik)
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
      success_url: `${process.env.DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.DOMAIN}/cancel.html`,
      metadata: {
        source: 'senkisem.com'
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
// (az admin értesítő a bellerzoltanezra@gmail.com címre megy)
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
    ident_enabled: true,
    contact_enabled: true,
    community_enabled: true,
    draw_enabled: true
  });
});

// ============================================
// BELÉPÉS-KAPU (GATE) — minden HTML oldalba beinjektáljuk a /gate.js-t,
// kivéve a felsoroltakat. Így a meglévő oldalakat nem kell átírni.
// A contact.html kivétel: a belépési gonddal küzdők is elérjék az ügyintézést.
// (Visszaállítás: GATE_EXEMPT=/,/index.html)
// ============================================
const PUBLIC_DIR = path.join(__dirname, 'public');
const GATE_EXEMPT = new Set(
  (process.env.GATE_EXEMPT || '/,/index.html,/contact.html').split(',').map(s => s.trim()).filter(Boolean)
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
║      SENKISEM.COM SZERVER — TÁMOGATÓI MODELL           ║
╠═══════════════════════════════════════════════════════╣
║   Port: ${PORT}
║   Támogatás:  ✅ /api/support/*  (HUF / USD)
║   Azonosító:  ✅ /api/ident/*    (ID-Senkisem + foglaltság)
║   Kapcsolat:  ✅ /api/contact    (→ ${CONFIG.EMAIL.CONTACT_TO})
║   Közösség:   ✅ /api/community/feed
║   Sorsolás:   ✅ /api/draw/*     (hetente, szombat 00:00)
║   Webshop:    ${SHOP_ENABLED ? '✅ BE ' : '⛔ KI '}(SHOP_ENABLED)
║   Webhook:    ✅ AKTÍV
║   Sheets:     2026 · ${CONFIG.TABS.SUPPORT} · ${CONFIG.TABS.IDENT} · ${CONFIG.TABS.CONTACT}
║               ${CONFIG.TABS.DRAW_ENTRIES} · ${CONFIG.TABS.DRAW_RESULTS}
╚═══════════════════════════════════════════════════════╝
  `);

  // Heti sorsolás ütemező: 30 mp-enként ellenőrzi, esedékes-e egy húzás
  setTimeout(drawTick, 20 * 1000);
  setInterval(drawTick, 30 * 1000);
  console.log(`🎟️ Következő sorsolás: ${new Date(drawNext(Date.now())).toISOString()} (kör ${drawKey(drawNext(Date.now()))})`);
});

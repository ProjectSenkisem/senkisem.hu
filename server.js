require('dotenv').config();
const express = require('express');
const fs = require('fs');
const cors = require('cors');
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

// ============================================
// KONFIG
// ============================================
const CONFIG = {
  SHEETS: {
    ORDERS: '1ysbyF0uCl1W03aGArpFYDIU6leFFRJb0R1AaadVarGk',
  },
  SHIPPING: {
    FOXPOST_COST: 899,
    HOME_DELIVERY_COST: 2590,
  },
  EMAIL: {
    FROM: process.env.RESEND_FROM_EMAIL,
    BCC: 'bellerzoltanezra@gmail.com', // ⚠️ ÚJ: Rejtett másolat mindig ide megy
  },
  DOMAIN: process.env.DOMAIN
};

// ============================================
// TERMÉKEK BETÖLTÉSE
// ============================================
let products = [];
try {
  const data = fs.readFileSync(path.join(__dirname, 'product.json'), 'utf8');
  products = JSON.parse(data).products || JSON.parse(data);
  console.log(`✅ ${products.length} termék betöltve`);
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
// ⚠️ MÓDOSÍTVA: EMAIL KÜLDÉS BCC-VEL
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
    
    // ⚠️ ÚJ: BCC hozzáadva
    const result = await resend.emails.send({
      from: `Senkisem.hu <${CONFIG.EMAIL.FROM}>`,
      to: customerData.email, // Vevő email címe
      bcc: CONFIG.EMAIL.BCC, // ⚠️ REJTETT MÁSOLAT IDE MEGY!
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
// RENDELÉS MENTÉSE (EMAIL NÉLKÜL!)
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
    
    // ✅ RENDELÉS MENTÉSE SHEETS-BE
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
      'Számla Szám': invoiceNumber
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
// MIDDLEWARE
// ============================================
app.use(cors());

// ⚠️ FONTOS: Webhook endpoint-hoz RAW body kell!
app.use('/webhook/stripe', express.raw({type: 'application/json'}));

app.use(express.json());

// Rate limiting
const downloadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: 'Túl sok letöltési kísérlet.',
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// ROUTES
// ============================================

// Stripe session létrehozása + SHEETS MENTÉS (EMAIL NÉLKÜL)
app.post('/create-payment-session', async (req, res) => {
  const { cart, customerData } = req.body;

  try {
    const ebookIds = [2, 4, 300];
    const isEbook = cart.every(item => ebookIds.includes(item.id));

    // Line items
    const lineItems = cart.map(item => {
      const product = products.find(p => p.id === parseInt(item.id));
      if (!product) throw new Error(`Termék nem található: ${item.id}`);
      
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

    // ⚠️ FONTOS: Rendelés adatait JSON string-ként metadata-ba mentjük
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: lineItems,
      success_url: isEbook 
        ? `${process.env.DOMAIN}/success2.html?session_id={CHECKOUT_SESSION_ID}`
        : `${process.env.DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.DOMAIN}/cancel.html`,
      metadata: {
        orderData: JSON.stringify({ cart, customerData })
      },
      customer_email: customerData.email,
    });

    // ✅ Rendelés mentése AZONNAL (email nélkül)
    await saveOrderToSheets({ cart, customerData }, session.id);

    res.json({ payment_url: session.url });

  } catch (error) {
    console.error('❌ Session létrehozási hiba:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// ⚠️ WEBHOOK - ITT TÖRTÉNIK AZ EMAIL KÜLDÉS!
// ============================================
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Webhook signature ellenőrzése
    event = stripe.webhooks.constructEvent(
      req.body, 
      sig, 
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook signature hiba:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ SIKERES FIZETÉS ESEMÉNY
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    console.log('\n🎉 ========================================');
    console.log('✅ SIKERES FIZETÉS ÉRKEZETT!');
    console.log('🎉 ========================================');
    console.log(`   Session ID: ${session.id}`);
    console.log(`   Email: ${session.customer_email}`);
    console.log(`   Összeg: ${session.amount_total / 100} Ft`);

    try {
      // 1️⃣ STÁTUSZ FRISSÍTÉSE SHEETS-BEN
      const sheet = await getSheet(CONFIG.SHEETS.ORDERS);
      const rows = await sheet.getRows();
      
      const orderRow = rows.find(row => row.get('Rendelés ID') === session.id);
      
      if (!orderRow) {
        console.error('❌ Rendelés nem található a Sheets-ben:', session.id);
        return res.json({ received: true });
      }

      // Státusz frissítése
      orderRow.set('Státusz', 'Fizetve ✅');
      await orderRow.save();
      console.log('✅ Státusz frissítve: Fizetve ✅');

      // 2️⃣ RENDELÉS ADATOK VISSZAOLVASÁSA
      const orderDataJSON = session.metadata.orderData;
      
      if (!orderDataJSON) {
        console.error('❌ Nincs orderData a session metadata-ban!');
        return res.json({ received: true });
      }

      const orderData = JSON.parse(orderDataJSON);
      const { cart, customerData } = orderData;
      
      // 3️⃣ SZÁMLA SZÁM ÉS ÖSSZEG KISZÁMÍTÁSA
      const invoiceNumber = orderRow.get('Számla Szám');
      
      const productTotal = cart.reduce((sum, item) => {
        const price = typeof item.price === 'string' ? 
          parseInt(item.price.replace(/\D/g, '')) : item.price;
        const quantity = item.quantity || 1;
        return sum + (price * quantity);
      }, 0);
      
      const shippingCost = calculateShippingCost(cart, customerData.shippingMethod);
      const totalAmount = productTotal + shippingCost;

      // 4️⃣ LETÖLTÉSI LINKEK GENERÁLÁSA (ha digitális)
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

      // 5️⃣ EMAIL KÜLDÉSE (PDF SZÁMLÁVAL, LETÖLTÉSI LINKEKKEL ÉS BCC-VEL!)
      console.log('📧 Email küldése...');
      await sendOrderEmail(orderData, totalAmount, invoiceNumber, downloadLinks);
      console.log('✅ Email sikeresen elküldve:', customerData.email);
      console.log(`📬 BCC másolat elküldve: ${CONFIG.EMAIL.BCC}`);
      
      console.log('🎉 ========================================');
      console.log('✅ RENDELÉS TELJES FELDOLGOZÁSA KÉSZ!');
      console.log('🎉 ========================================\n');

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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    webhook_enabled: true,
    email_on_payment_only: true,
    bcc_enabled: true,
    bcc_address: CONFIG.EMAIL.BCC
  });
});

// ============================================
// STATIKUS FÁJLOK
// ============================================
app.use(express.static(path.join(__dirname, 'dist')));

app.get('/download-error.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'download-error.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ============================================
// SZERVER INDÍTÁS
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   🚀 SENKISEM.HU SZERVER - WEBHOOK + BCC VERSION     ║
╠═══════════════════════════════════════════════════════╣
║   Port: ${PORT}                                       ║
║   Webhook: ✅ AKTÍV                                  ║
║   Email: ✅ Csak sikeres fizetés után!               ║
║   BCC: ✅ ${CONFIG.EMAIL.BCC}        ║
╠═══════════════════════════════════════════════════════╣
║   🔄 FOLYAMAT:                                       ║
║   1. Rendelés → Sheets mentés (Fizetésre vár)       ║
║   2. Stripe fizetés                                  ║
║   3. Webhook → Státusz frissítés (Fizetve ✅)       ║
║   4. Webhook → Email kiküldése:                      ║
║      - TO: Vevő email címe                           ║
║      - BCC: bellerzoltanezra@gmail.com (rejtett)     ║
║      - Csatolmány: PDF számla + letöltési linkek    ║
╚═══════════════════════════════════════════════════════╝
  `);
});
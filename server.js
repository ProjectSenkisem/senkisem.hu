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

// Import new modules
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
    FOXPOST_COST: 899, // 899 Ft
    HOME_DELIVERY_COST: 2590, // 2590 Ft
  },
  EMAIL: {
    FROM: process.env.RESEND_FROM_EMAIL,
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
// GOOGLE KLIENS LÉTREHOZÁS
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
  
  console.log(`✅ Munkalap betöltve: ${sheet.title}`);
  return sheet;
}

// ============================================
// KÖVETKEZŐ SZÁMLA SZÁM GENERÁLÁS
// ============================================
async function generateNextInvoiceNumber() {
  try {
    const sheet = await getSheet(CONFIG.SHEETS.ORDERS);
    const rows = await sheet.getRows();
    
    // Meglévő számlaszámok keresése
    const invoiceNumbers = rows
      .map(row => row.get('Számla Szám'))
      .filter(num => num && num.startsWith('E-SEN-2026-'))
      .map(num => parseInt(num.replace('E-SEN-2026-', '')))
      .filter(num => !isNaN(num));
    
    // Legmagasabb szám megkeresése
    const maxNumber = invoiceNumbers.length > 0 ? Math.max(...invoiceNumbers) : 0;
    
    // Következő szám generálása
    const nextNumber = maxNumber + 1;
    const invoiceNumber = `E-SEN-2026-${String(nextNumber).padStart(3, '0')}`;
    
    console.log(`✅ Számlaszám generálva: ${invoiceNumber}`);
    return invoiceNumber;
    
  } catch (error) {
    console.error('❌ Számlaszám generálási hiba:', error);
    // Fallback timestamp-alapú számra
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
// RENDELÉS EMAIL KÜLDÉS PDF SZÁMLÁVAL
// ============================================
async function sendOrderEmail(orderData, totalAmount, invoiceNumber, downloadLinks = null) {
  try {
    const { customerData, cart } = orderData;
    
    // Email sablon típus meghatározása
    const templateType = determineEmailTemplate(cart);
    console.log(`📧 Email sablon használata: ${templateType}`);
    
    // PDF számla generálása
    console.log('📄 PDF számla generálása...');
    const pdfBuffer = await generateInvoicePDF(orderData, totalAmount, invoiceNumber);
    console.log('✅ PDF számla generálva');
    
    // Email tartalom generálása
    const { subject, html } = generateEmail(templateType, orderData, totalAmount, downloadLinks);
    
    // Email küldése PDF melléklettel
    const result = await resend.emails.send({
      from: `Senkisem.hu <${CONFIG.EMAIL.FROM}>`,
      to: customerData.email,
      subject: subject,
      html: html,
      attachments: [
        {
          filename: `Szamla_${invoiceNumber}.pdf`,
          content: pdfBuffer,
        }
      ]
    });
    
    console.log('✅ Email sikeresen elküldve:', result.id);
    return result;
    
  } catch (error) {
    console.error('❌ Email küldési hiba:', error);
    throw error;
  }
}

// ============================================
// RENDELÉS MENTÉSE SHEETS-BE + EMAIL KÜLDÉS
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
    
    // Terméknevek és méretek
    const productNames = cart.map(item => {
      const quantity = item.quantity || 1;
      return quantity > 1 ? `${item.name} (${quantity} db)` : item.name;
    }).join(', ');
    
    const sizes = cart.map(item => item.size || '-').join(', ');
    
    // Termék típus
    const isEbook = cart.every(item => item.id === 2 || item.id === 4 || item.id === 300);
    const productType = isEbook ? 'E-könyv' : 'Fizikai';
    
    // Szállítási mód szövegesen
    let shippingMethodText = '-';
    if (customerData.shippingMethod === 'pickup') {
      shippingMethodText = 'Foxpost csomagpont';
    } else if (customerData.shippingMethod === 'home') {
      shippingMethodText = 'Házhozszállítás';
    } else if (customerData.shippingMethod === 'digital') {
      shippingMethodText = 'Digitális';
    }
    
    // Szállítási cím (csak házhozszállításnál)
    let deliveryAddress = '-';
    if (customerData.shippingMethod === 'home') {
      const addr = customerData.deliveryAddress || customerData.address;
      const city = customerData.deliveryCity || customerData.city;
      const zip = customerData.deliveryZip || customerData.zip;
      const country = customerData.deliveryCountry || customerData.country || 'Magyarország';
      deliveryAddress = `${zip} ${city}, ${addr}, ${country}`;
    }
    
    // Csomagpont neve (csak Foxpost esetén)
    let pickupPointName = '-';
    if (customerData.shippingMethod === 'pickup' && customerData.pickupPoint) {
      pickupPointName = `${customerData.pickupPoint.name} (${customerData.pickupPoint.zip} ${customerData.pickupPoint.city})`;
    }
    
    // ✅ SOR HOZZÁADÁSA GOOGLE SHEETS-HEZ
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
    
    console.log('✅ Sheets mentés OK - Rendelés ID:', sessionId, 'Számla:', invoiceNumber);
    
    // ✅ LETÖLTÉSI LINKEK GENERÁLÁSA (ha digitális termék)
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
    
    // ✅ VISSZAIGAZOLÓ EMAIL KÜLDÉSE PDF-fel ÉS LETÖLTÉSI LINKEKKEL
    try {
      await sendOrderEmail(orderData, totalAmount, invoiceNumber, downloadLinks);
      console.log('✅ Visszaigazoló email elküldve:', customerData.email);
    } catch (emailError) {
      console.error('⚠️ Email küldés sikertelen (de a rendelés mentve):', emailError.message);
      // Ne dobjon hibát - a rendelés már mentve van a sheets-be
    }
    
  } catch (error) {
    console.error('⚠️ Sheets mentési hiba:', error.message);
    throw error;
  }
}

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use('/webhook/stripe', express.raw({type: 'application/json'}));
app.use(express.json());

// Rate limiting letöltési végpontra
const downloadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 perc
  max: 5, // 5 kérés percenként IP-nként
  message: 'Túl sok letöltési kísérlet. Kérjük, próbálja újra később.',
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================
// ROUTES
// ============================================

// Stripe fizetési session létrehozása + AZONNALI SHEETS MENTÉS + EMAIL
app.post('/create-payment-session', async (req, res) => {
  const { cart, customerData } = req.body;

  try {
    const ebookIds = [2, 4, 300];
    const isEbook = cart.every(item => ebookIds.includes(item.id));

    // ✅ STRIPE LINE ITEMS ÖSSZEÁLLÍTÁSA
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

    // Szállítási díj hozzáadása fizikai termékekhez
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

    // ✅ STRIPE SESSION LÉTREHOZÁSA
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: lineItems,
      success_url: isEbook 
        ? `${process.env.DOMAIN}/success2.html?session_id={CHECKOUT_SESSION_ID}`
        : `${process.env.DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.DOMAIN}/cancel.html`,
      metadata: {
        customerName: customerData.fullName,
        customerEmail: customerData.email,
        shippingMethod: customerData.shippingMethod || 'digital',
      },
      customer_email: customerData.email,
    });

    // ✅ AZONNALI MENTÉS GOOGLE SHEETS-BE + EMAIL KÜLDÉS PDF-fel ÉS LETÖLTÉSI LINKEKKEL
    await saveOrderToSheets(
      { cart, customerData }, 
      session.id
    );

    // ✅ Válasz a frontendnek
    res.json({ payment_url: session.url });

  } catch (error) {
    console.error('❌ Session/Sheets/Email hiba:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LETÖLTÉSI ÚTVONAL
// ============================================
app.get('/download/:token', downloadLimiter, async (req, res) => {
  const { token } = req.params;
  const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  console.log(`📥 Letöltési kísérlet - Token: ${token.substring(0, 8)}... IP: ${ipAddress}`);
  
  try {
    // Token validálás
    const validation = await validateDownloadToken(token, ipAddress);
    
    if (!validation.valid) {
      console.log(`❌ Letöltés megtagadva - Ok: ${validation.reason}`);
      return res.redirect(`/download-error.html?reason=${validation.reason}`);
    }
    
    // Termékfájl elérési út lekérése
    const filePath = getProductFilePath(validation.productId);
    
    if (!filePath || !fs.existsSync(filePath)) {
      console.error(`❌ Fájl nem található: ${filePath}`);
      return res.redirect('/download-error.html?reason=server-error');
    }
    
    // Token megjelölése használtként
    await markTokenAsUsed(validation.tokenRow, ipAddress);
    
    // Letöltési fájlnév lekérése
    const fileName = getProductFileName(validation.productId);
    
    // Fájl küldése
    console.log(`✅ Fájl küldése: ${fileName}`);
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error('❌ Fájl küldési hiba:', err);
        if (!res.headersSent) {
          res.redirect('/download-error.html?reason=server-error');
        }
      } else {
        console.log(`✅ Letöltés kész: ${fileName} - ${validation.email}`);
      }
    });
    
  } catch (error) {
    console.error('❌ Letöltési hiba:', error);
    res.redirect('/download-error.html?reason=server-error');
  }
});

// ============================================
// WEBHOOK (státusz frissítés fizetés után)
// ============================================
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook signature hiba:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('✅ Fizetés befejezve:', session.id);

    try {
      // Státusz frissítés Sheets-ben
      const sheet = await getSheet(CONFIG.SHEETS.ORDERS);
      const rows = await sheet.getRows();
      
      const orderRow = rows.find(row => row.get('Rendelés ID') === session.id);
      
      if (orderRow) {
        orderRow.set('Státusz', 'Fizetve');
        await orderRow.save();
        console.log('✅ Státusz frissítve: Fizetve');
      }
    } catch (error) {
      console.error('⚠️ Webhook státusz frissítési hiba:', error.message);
    }
  }

  res.json({ received: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    currency: 'HUF',
    shipping: {
      foxpost: '899 Ft',
      home: '2590 Ft'
    },
    email_enabled: true,
    pdf_invoice_enabled: true,
    download_links_enabled: true,
    templates: ['digitalProduct1', 'digitalProduct2', 'digitalBundle', 'physicalProduct']
  });
});

// ============================================
// STATIKUS FÁJLOK
// ============================================
app.use(express.static(path.join(__dirname, 'dist')));

// download-error.html kiszolgálása a gyökérkönyvtárból
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
║   🚀 SENKISEM.HU SZERVER - REFACTORED V2.0           ║
╠═══════════════════════════════════════════════════════╣
║   Port: ${PORT}                                       ║
║   Pénznem: HUF (Ft)                                   ║
║   Szállítás: Foxpost 899 Ft | Házhozszállítás 2590 Ft║
╠═══════════════════════════════════════════════════════╣
║   ✅ Stripe + Webhook                                ║
║   ✅ Google Sheets (Rendelések + Letöltési linkek)  ║
║   ✅ Professzionális Email sablonok (4 típus)       ║
║   ✅ Újratervezett PDF számla (PDFKit)              ║
║   ✅ Letöltési link rendszer (UUID + 7 napos lejárat)║
║   ✅ IP naplózás + Egyszeri használat biztonsága    ║
║   ✅ Rate limiting (5 kérés/perc letöltésekre)      ║
╠═══════════════════════════════════════════════════════╣
║   📧 Sablon A: Digitális termék 1 (ID 2)            ║
║   📧 Sablon B: Digitális termék 2 (ID 4)            ║
║   📧 Sablon C: Digitális csomag (ID 300)            ║
║   📧 Sablon D: Fizikai termékek                      ║
╚═══════════════════════════════════════════════════════╝
  `);
});
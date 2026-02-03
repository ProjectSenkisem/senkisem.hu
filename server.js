require('dotenv').config();
const express = require('express');
const fs = require('fs');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');

// ============================================
// ENV VALIDÁCIÓ
// ============================================
const requiredEnvVars = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'DOMAIN'
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error(`❌ Hiányzó env változók:\n${missingVars.join('\n')}`);
  process.exit(1);
}

console.log('✅ Környezeti változók rendben\n');

const app = express();

// ============================================
// KONFIG
// ============================================
const CONFIG = {
  SHEETS: {
    ORDERS: '1ysbyF0uCl1W03aGArpFYDIU6leFFRJb0R1AaadVarGk',
  },
  FOXPOST: {
    API_URL:  'https://webapi.foxpost.hu/api',
    USERNAME: process.env.FOXPOST_USERNAME,
    PASSWORD: process.env.FOXPOST_PASSWORD,
    API_KEY:  process.env.FOXPOST_API_KEY,
  },
  SHIPPING: {
    FOXPOST_COST: 899,    // Ft
    HOME_COST:    2590,   // Ft
  }
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
  process.exit(1);
}

// ============================================
// GOOGLE KLIENS LÉTREHOZÁS
// ============================================
function getGoogleAuth() {
  return new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:   process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheet(sheetId) {
  console.log(`ℹ️  Sheet megnyitása: ${sheetId}`);
  const doc = new GoogleSpreadsheet(sheetId, getGoogleAuth());
  await doc.loadInfo();

  console.log(`🔍 Elérhető sheetek: ${Object.keys(doc.sheetsByTitle).join(', ')}`);

  const sheet = doc.sheetsByTitle['2026'];
  if (!sheet) {
    throw new Error(`❌ "2026" sheet nem található! Elérhető: ${Object.keys(doc.sheetsByTitle).join(', ')}`);
  }
  console.log('✅ "2026" sheet megnyitva');
  return sheet;
}

// ============================================
// FOXPOST CSOMAG CREAR
// ============================================
async function createFoxpostParcel(orderData) {
  const { customerData, cart } = orderData;
  const physicalProducts = cart.filter(item => item.id !== 2 && item.id !== 4 && item.id !== 300);

  if (physicalProducts.length === 0 || customerData.shippingMethod !== 'pickup') {
    return null;
  }

  try {
    const auth = Buffer.from(`${CONFIG.FOXPOST.USERNAME}:${CONFIG.FOXPOST.PASSWORD}`).toString('base64');

    const { data } = await axios.post(
      `${CONFIG.FOXPOST.API_URL}/parcel?isWeb=false`,
      [{
        recipientName:  customerData.fullName,
        recipientPhone: customerData.phone || '+36301234567',
        recipientEmail: customerData.email,
        destination:    customerData.pickupPoint?.operator_id || customerData.pickupPoint?.place_id,
        size:           'M',
        cod:            0,
        comment:        `Senkisem - ${physicalProducts.map(p => p.name).join(', ')}`,
        refCode:        `SNK-${Date.now()}`
      }],
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Api-key':       CONFIG.FOXPOST.API_KEY,
          'Content-Type':  'application/json'
        }
      }
    );

    if (data?.[0]?.clFoxId) {
      console.log('✅ Foxpost csomag créálva:', data[0].clFoxId);
      return { trackingId: data[0].clFoxId };
    }
    return null;
  } catch (error) {
    console.error('⚠️ Foxpost hiba:', error.message);
    return null;
  }
}

// ============================================
// RENDELÉS MENTÉSE SHEETS — mind a 21 mező
// ============================================
async function saveOrder(orderData) {
  console.log('ℹ️  Rendelés mentése kezdődik...');

  try {
    const sheet = await getSheet(CONFIG.SHEETS.ORDERS);

    const totalAmount = orderData.items.reduce((sum, i) => sum + i.price, 0); // Ft-ban
    const isEbook = orderData.items.every(i => i.id === 2 || i.id === 4 || i.id === 300);

    // Shipping logic
    let shippingMethod  = '-';
    let shippingAddress = '-';
    let shippingCost    = 0;
    let pickupPointName = '-';
    let foxpostTracking = '-';

    if (isEbook) {
      shippingMethod  = 'Digitális letöltés';
      shippingAddress = 'E-mail küldés';
    } else if (orderData.shippingMethod === 'pickup') {
      shippingMethod  = 'Foxpost Csomagpont';
      shippingAddress = orderData.shippingAddress || '-';
      shippingCost    = CONFIG.SHIPPING.FOXPOST_COST;
      pickupPointName = orderData.pickupPointName || '-';
      foxpostTracking = orderData.foxpostTrackingId || '-';
    } else {
      shippingMethod  = 'Házhozszállítás';
      shippingAddress = orderData.shippingAddress || '-';
      shippingCost    = CONFIG.SHIPPING.HOME_COST;
    }

    // Build the row — ALL 21 columns, '-' fallback everywhere
    const rowData = {
      'Dátum':                 new Date().toLocaleString('hu-HU'),
      'Név':                   orderData.customerName    || '-',
      'Email':                 orderData.customerEmail   || '-',
      'Cím':                   orderData.customerAddress || '-',
      'Város':                 orderData.customerCity    || '-',
      'Ország':                orderData.customerCountry || '-',
      'Irányítószám':          orderData.customerZip     || '-',
      'Termékek':              orderData.items.map(i => i.name).join(', ') || '-',
      'Méretek':               orderData.items.map(i => i.size || 'N/A').join(', ') || '-',
      'Összeg':                `${totalAmount.toLocaleString('hu-HU')} Ft`,
      'Típus':                 isEbook ? 'E-könyv' : 'Fizikai termék',
      'Szállítási mód':        shippingMethod,
      'Szállítási cím':        shippingAddress,
      'Csomagpont név':        pickupPointName,
      'Szállítási díj':        `${shippingCost.toLocaleString('hu-HU')} Ft`,
      'Végösszeg':             `${(totalAmount + shippingCost).toLocaleString('hu-HU')} Ft`,
      'Foxpost követés':       foxpostTracking,
      'Rendelés ID':           orderData.sessionId || '-',
      'Státusz':               'Fizetés Teljesítve',
      'Szállítási megjegyzés': orderData.deliveryNote || '-',
      'Telefonszám':           orderData.phone || '-'
    };

    console.log('🔍 Mentendő sor:', JSON.stringify(rowData, null, 2));

    await sheet.addRow(rowData);

    console.log('✅ Sheets mentés OK –', orderData.sessionId);
  } catch (error) {
    console.error('❌ Sheets mentés hiba:', error.message);
    throw error;
  }
}

// ============================================
// WEBHOOK — MUST BE BEFORE express.json()!
// ============================================
app.post('/webhook/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Webhook signature hiba:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type !== 'checkout.session.completed') {
    return res.json({ received: true });
  }

  const session = event.data.object;
  console.log('✅ Fizetés OK:', session.id);
  console.log('🔍 Session metadata:', JSON.stringify(session.metadata, null, 2));

  try {
    // 1. Line items lekérdezés
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
    console.log('🔍 Raw line items:', JSON.stringify(lineItems.data, null, 2));

    // Parse — size a price.metadata.size-ból
    const items = lineItems.data.map(item => ({
      id:       parseInt(item.price.metadata?.productId || 0),
      name:     item.description,
      price:    item.amount_total / 100,   // centet vissza Ft-ba (Stripe 100x)
      quantity: item.quantity,
      size:     item.price.metadata?.size || '-'
    }));

    console.log('🔍 Parsed items:', JSON.stringify(items, null, 2));

    // 2. Szállítás szétválasztása
    const shippingItem = items.find(i =>
      i.name.includes('Foxpost') ||
      i.name.includes('Házhozszállítás') ||
      i.name.includes('Home Delivery')
    );
    const productItems = items.filter(i =>
      !i.name.includes('Foxpost') &&
      !i.name.includes('Házhozszállítás') &&
      !i.name.includes('Home Delivery')
    );

    console.log('🔍 Product items:', JSON.stringify(productItems, null, 2));
    console.log('🔍 Shipping item:', JSON.stringify(shippingItem, null, 2));

    // 3. Rendelés adatok — minden field metadata-ból, fallback '-'
    const orderData = {
      sessionId:          session.id,
      customerName:       session.metadata.customerName    || '-',
      customerEmail:      session.customer_email           || '-',
      customerAddress:    session.metadata.customerAddress || '-',
      customerCity:       session.metadata.customerCity    || '-',
      customerZip:        session.metadata.customerZip     || '-',
      customerCountry:    session.metadata.customerCountry || '-',
      phone:              session.metadata.phone           || '-',
      items:              productItems,
      shippingCost:       shippingItem?.price || 0,
      shippingMethod:     session.metadata.shippingMethod  || '-',
      shippingAddress:    session.metadata.deliveryAddress || '-',
      pickupPointName:    session.metadata.pickupPointName || '-',
      foxpostTrackingId:  session.metadata.foxpostTrackingId || '-',
      deliveryNote:       session.metadata.deliveryNote    || '-'
    };

    console.log('🔍 Order data:', JSON.stringify(orderData, null, 2));

    // 4. Sheets mentés
    await saveOrder(orderData);

    console.log('✅ Rendelés feldolgozva:', session.id);

  } catch (error) {
    console.error('❌ Webhook hiba:', error.message, error.stack);
    // Still return 200 — Stripe ne retryoljon
  }

  res.json({ received: true });
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use(express.json());

// ============================================
// ROUTES
// ============================================

// Stripe session létrehozás
app.post('/create-payment-session', async (req, res) => {
  console.log('ℹ️  Payment session kérés érkezett');
  console.log('🔍 Request body:', JSON.stringify(req.body, null, 2));

  const { cart, customerData } = req.body;

  if (!Array.isArray(cart) || cart.length === 0) {
    console.warn('⚠️ Cart üres');
    return res.status(400).json({ error: 'Cart is empty' });
  }

  if (!customerData) {
    console.warn('⚠️ Customer data hiányzik');
    return res.status(400).json({ error: 'Missing customer data' });
  }

  try {
    const isOnlyEbook = cart.every(item =>
      parseInt(item.id) === 2 ||
      parseInt(item.id) === 4 ||
      parseInt(item.id) === 300
    );

    console.log('🔍 isOnlyEbook:', isOnlyEbook);

    // Foxpost csomag (ha fizikai + pickup)
    let foxpostResult = null;
    if (!isOnlyEbook && customerData.shippingMethod === 'pickup') {
      foxpostResult = await createFoxpostParcel({ cart, customerData });
    }

    // Stripe line items
    const lineItems = cart.map(item => {
      const product = products.find(p => p.id === parseInt(item.id));
      if (!product) throw new Error(`Termék nem található: ${item.id}`);

      return {
        price_data: {
          currency: 'huf',
          product_data: {
            name: product.name,
            metadata: {
              productId: product.id.toString(),
              size:      item.size || 'N/A'
            }
          },
          unit_amount: Math.round(product.price * 100), // Stripe 100x-os
        },
        quantity: item.quantity || 1,
      };
    });

    // Szállítás line item
    if (!isOnlyEbook) {
      if (customerData.shippingMethod === 'pickup') {
        lineItems.push({
          price_data: {
            currency: 'huf',
            product_data: { name: 'Foxpost Csomagpont' },
            unit_amount: CONFIG.SHIPPING.FOXPOST_COST * 100,
          },
          quantity: 1,
        });
      } else {
        lineItems.push({
          price_data: {
            currency: 'huf',
            product_data: { name: 'Házhozszállítás' },
            unit_amount: CONFIG.SHIPPING.HOME_COST * 100,
          },
          quantity: 1,
        });
      }
    }

    console.log('🔍 Final line items:', JSON.stringify(lineItems, null, 2));

    // Success URL
    const successUrl = isOnlyEbook
      ? `${process.env.DOMAIN}/success2.html?session_id={CHECKOUT_SESSION_ID}`
      : `${process.env.DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`;

    // Stripe session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: lineItems,
      success_url: successUrl,
      cancel_url:  `${process.env.DOMAIN}/cancel.html`,
      metadata: {
        customerName:       customerData.fullName        || '',
        customerEmail:      customerData.email           || '',
        customerAddress:    customerData.address         || '',
        customerCity:       customerData.city            || '',
        customerZip:        customerData.zip             || '',
        customerCountry:    customerData.country         || '',
        phone:              customerData.phone           || '',
        shippingMethod:     customerData.shippingMethod  || 'digital',
        deliveryAddress:    !isOnlyEbook
          ? `${customerData.deliveryZip || customerData.zip || ''} ${customerData.deliveryCity || customerData.city || ''}, ${customerData.deliveryAddress || customerData.address || ''}, ${customerData.deliveryCountry || customerData.country || ''}`
          : 'E-mail küldés',
        pickupPointName:    customerData.pickupPointName || '',
        foxpostTrackingId:  foxpostResult?.trackingId    || '',
        deliveryNote:       customerData.deliveryNote    || '',
        orderType:          isOnlyEbook ? 'ebook' : 'physical'
      },
      customer_email: customerData.email,
    });

    console.log('✅ Stripe session OK:', session.id);
    res.json({ payment_url: session.url });

  } catch (error) {
    console.error('❌ Session hiba:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Foxpost csomagpontok
app.get('/foxpost/pickup-points', async (req, res) => {
  try {
    const { data } = await axios.get('https://cdn.foxpost.hu/foxplus.json');
    res.json(data.filter(p => p.country === 'HU' && p.name && p.address));
  } catch (error) {
    res.status(500).json({ error: 'Lekérdezési hiba' });
  }
});

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ============================================
// STATIKUS FÁJLOK
// ============================================
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/img',    express.static(path.join(__dirname, 'public/img')));
app.use(express.static(path.join(__dirname, 'dist')));

// SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ============================================
// SZERVER INDÍTÁS
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║   🚀 SENKISEM SZERVER INDULT (HU / HUF)         ║
╠═══════════════════════════════════════════════════╣
║   Port:     ${PORT}                               ║
║   URL:      http://localhost:${PORT}              ║
╠═══════════════════════════════════════════════════╣
║   ✅ Stripe + Webhook                            ║
║   ✅ Google Sheets → 2026                        ║
║   ✅ Foxpost integráció                          ║
║   ✅ Mind a 21 oszlop kitöltve                   ║
╚═══════════════════════════════════════════════════╝
  `);
});
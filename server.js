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
    API_URL: 'https://webapi.foxpost.hu/api',
    USERNAME: process.env.FOXPOST_USERNAME,
    PASSWORD: process.env.FOXPOST_PASSWORD,
    API_KEY: process.env.FOXPOST_API_KEY,
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
  return doc.sheetsByIndex[0];
}

// ============================================
// FOXPOST
// ============================================
async function createFoxpostParcel(orderData) {
  const { customerData, cart } = orderData;
  const physicalProducts = cart.filter(item => item.id !== 2 && item.id !== 4);
  
  if (physicalProducts.length === 0 || customerData.shippingMethod !== 'pickup') {
    return null;
  }

  try {
    const auth = Buffer.from(`${CONFIG.FOXPOST.USERNAME}:${CONFIG.FOXPOST.PASSWORD}`).toString('base64');
    
    const { data } = await axios.post(
      `${CONFIG.FOXPOST.API_URL}/parcel?isWeb=false`,
      [{
        recipientName: customerData.fullName,
        recipientPhone: customerData.phone || '+36301234567',
        recipientEmail: customerData.email,
        destination: customerData.pickupPoint?.operator_id || customerData.pickupPoint?.place_id,
        size: 'M',
        cod: 0,
        comment: `Senkisem - ${physicalProducts.map(p => p.name).join(', ')}`,
        refCode: `SNK-${Date.now()}`
      }],
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Api-key': CONFIG.FOXPOST.API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    if (data?.[0]?.clFoxId) {
      console.log('✅ Foxpost csomag:', data[0].clFoxId);
      return { trackingId: data[0].clFoxId };
    }
    return null;
  } catch (error) {
    console.error('⚠️ Foxpost hiba:', error.message);
    return null;
  }
}

// ============================================
// RENDELÉS MENTÉSE SHEETS
// ============================================
async function saveOrder(orderData) {
  try {
    const sheet = await getSheet(CONFIG.SHEETS.ORDERS);
    
    const totalAmount = orderData.items.reduce((sum, i) => sum + i.price, 0);
    const isEbook = orderData.items.some(i => i.id === 2 || i.id === 4);
    
    await sheet.addRow({
      'Dátum': new Date().toLocaleString('hu-HU'),
      'Név': orderData.customerName,
      'Email': orderData.customerEmail,
      'Telefonszám': orderData.phone || 'N/A',
      'Cím': orderData.customerAddress,
      'Város': orderData.customerCity,
      'Irányítószám': orderData.customerZip,
      'Termékek': orderData.items.map(i => i.name).join(', '),
      'Összeg': `${totalAmount.toLocaleString('hu-HU')} Ft`,
      'Típus': isEbook ? 'E-könyv' : 'Fizikai',
      'Szállítási mód': orderData.shippingMethod,
      'Szállítási díj': `${orderData.shippingCost} Ft`,
      'Végösszeg': `${(totalAmount + orderData.shippingCost).toLocaleString('hu-HU')} Ft`,
      'Rendelés ID': orderData.sessionId,
      'Státusz': 'Fizetve'
    });
    
    console.log('✅ Sheets mentés OK');
  } catch (error) {
    console.error('⚠️ Sheets hiba:', error.message);
  }
}

// ============================================
// WEBHOOK
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

  try {
    // 1. Termékek lekérése
    const lineItems = await stripe.checkout.sessions.listLineItems(session.id);
    const items = lineItems.data.map(item => ({
      id: parseInt(item.price.metadata?.productId || 0),
      name: item.description,
      price: item.amount_total / 100,
      quantity: item.quantity
    }));

    // Szállítás szétválasztása
    const shippingItem = items.find(i => 
      i.name.includes('Foxpost') || i.name.includes('Házhozszállítás')
    );
    const productItems = items.filter(i => 
      !i.name.includes('Foxpost') && !i.name.includes('Házhozszállítás')
    );

    // 2. Rendelés adatok
    const orderData = {
      sessionId: session.id,
      customerName: session.metadata.customerName || 'Ismeretlen',
      customerEmail: session.customer_email,
      customerAddress: session.metadata.customerAddress || '',
      customerCity: session.metadata.customerCity || '',
      customerZip: session.metadata.customerZip || '',
      phone: session.metadata.phone || '',
      items: productItems,
      shippingCost: shippingItem?.price || 0,
      shippingMethod: session.metadata.shippingMethod || 'Digitális',
    };

    // 3. Sheets mentés
    await saveOrder(orderData);

    console.log('✅ Rendelés feldolgozva:', session.id);
    
  } catch (error) {
    console.error('❌ Webhook hiba:', error);
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
  const { cart, customerData } = req.body;

  try {
    const isEbook = cart.every(item => item.id === 2 || item.id === 4);

    // Foxpost (ha fizikai)
    let foxpostResult = null;
    if (!isEbook && customerData.shippingMethod === 'pickup') {
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
            metadata: { productId: product.id }
          },
          unit_amount: product.price * 100,
        },
        quantity: 1,
      };
    });

    // Szállítás
    if (!isEbook) {
      if (customerData.shippingMethod === 'pickup') {
        lineItems.push({
          price_data: {
            currency: 'huf',
            product_data: { name: 'Foxpost Csomagpont' },
            unit_amount: 899 * 100,
          },
          quantity: 1,
        });
      } else if (customerData.shippingMethod === 'home') {
        lineItems.push({
          price_data: {
            currency: 'huf',
            product_data: { name: 'Házhozszállítás' },
            unit_amount: 2590 * 100,
          },
          quantity: 1,
        });
      }
    }

    // Stripe session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: lineItems,
      success_url: `${process.env.DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.DOMAIN}/cancel.html`,
      metadata: {
        customerName: customerData.fullName,
        customerEmail: customerData.email,
        customerAddress: customerData.address || '',
        customerCity: customerData.city || '',
        customerZip: customerData.zip || '',
        phone: customerData.phone || '',
        shippingMethod: customerData.shippingMethod || 'digital',
        foxpostTrackingId: foxpostResult?.trackingId || '',
      },
      customer_email: customerData.email,
    });

    res.json({ payment_url: session.url });

  } catch (error) {
    console.error('❌ Session hiba:', error);
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
app.use(express.static(path.join(__dirname, 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ============================================
// SZERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║   🚀 SENKISEM SZERVER INDULT         ║
╠═══════════════════════════════════════╣
║   Port: ${PORT}                       ║
║   URL:  http://localhost:${PORT}      ║
╠═══════════════════════════════════════╣
║   ✅ Stripe + Webhook                ║
║   ✅ Google Sheets                   ║
║   ✅ Foxpost integráció              ║
╚═══════════════════════════════════════╝
  `);
});
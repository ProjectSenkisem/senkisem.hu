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
  
  // Név alapján keresés (biztonságosabb)
  const sheet = doc.sheetsByTitle['2026'];
  
  if (!sheet) {
    throw new Error('❌ 2026-os munkalap nem található!');
  }
  
  console.log(`✅ Munkalap betöltve: ${sheet.title}`);
  return sheet;
}

// ============================================
// FOXPOST CSOMAG LÉTREHOZÁS
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
      return data[0].clFoxId;
    }
    return null;
  } catch (error) {
    console.error('⚠️ Foxpost hiba:', error.message);
    return null;
  }
}

// ============================================
// RENDELÉS MENTÉSE SHEETS-BE (2026 MEZŐK)
// ============================================
async function saveOrderToSheets(orderData, sessionId, foxpostTrackingId = null) {
  try {
    const sheet = await getSheet(CONFIG.SHEETS.ORDERS);
    
    const { cart, customerData } = orderData;
    
    // Összegek számítása
    const productTotal = cart.reduce((sum, item) => {
      const price = typeof item.price === 'string' ? 
        parseInt(item.price.replace(/\D/g, '')) : item.price;
      const quantity = item.quantity || 1;
      return sum + (price * quantity);
    }, 0);
    
    const shippingCost = calculateShippingCost(cart, customerData.shippingMethod);
    const totalAmount = productTotal + shippingCost;
    
    // Terméknevek és méretek összegyűjtése
    const productNames = cart.map(item => {
      const quantity = item.quantity || 1;
      return quantity > 1 ? `${item.name} (${quantity} db)` : item.name;
    }).join(', ');
    
    const sizes = cart.map(item => item.size || '-').join(', ');
    
    // Típus meghatározása
    const isEbook = cart.every(item => item.id === 2 || item.id === 4);
    const productType = isEbook ? 'E-könyv' : 'Fizikai';
    
    // Szállítási mód szövegesen
    let shippingMethodText = '-';
    if (customerData.shippingMethod === 'pickup') {
      shippingMethodText = 'Foxpost csomagpont';
    } else if (customerData.shippingMethod === 'home') {
      shippingMethodText = 'Házhozszállítás';
    } else if (isEbook) {
      shippingMethodText = 'Digitális';
    }
    
    // Szállítási cím (csak házhozszállításnál)
    let deliveryAddress = '-';
    if (customerData.shippingMethod === 'home') {
      const addr = customerData.deliveryAddress || customerData.address;
      const city = customerData.deliveryCity || customerData.city;
      const zip = customerData.deliveryZip || customerData.zip;
      deliveryAddress = `${zip} ${city}, ${addr}`;
    }
    
    // Csomagpont neve (csak Foxpost esetén)
    let pickupPointName = '-';
    if (customerData.shippingMethod === 'pickup' && customerData.pickupPoint) {
      pickupPointName = `${customerData.pickupPoint.name} (${customerData.pickupPoint.zip} ${customerData.pickupPoint.city})`;
    }
    
    // Excel sor hozzáadása - MINDEN MEZŐ A 2026-OS STRUKTÚRA SZERINT
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
      'Foxpost követés': foxpostTrackingId || '-',
      'Rendelés ID': sessionId || '-',
      'Státusz': 'Fizetésre vár',
      'Szállítási megjegyzés': customerData.deliveryNote || '-',
      'Telefonszám': customerData.phone || '-'
    });
    
    console.log('✅ Sheets mentés OK - Rendelés ID:', sessionId);
  } catch (error) {
    console.error('⚠️ Sheets mentés hiba:', error.message);
    throw error;
  }
}

// ============================================
// SZÁLLÍTÁSI KÖLTSÉG SZÁMÍTÁS
// ============================================
function calculateShippingCost(cart, shippingMethod) {
  const ebookId = 2;
  const digitalBookId = 4;
  const isAllDigital = cart.every(item => item.id === ebookId || item.id === digitalBookId);
  
  if (isAllDigital) {
    return 0;
  }
  
  if (shippingMethod === 'pickup') {
    return 899;
  } else if (shippingMethod === 'home') {
    return 2590;
  }
  
  return 0;
}

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.use('/webhook/stripe', express.raw({type: 'application/json'}));
app.use(express.json());

// ============================================
// ROUTES
// ============================================

// Stripe session létrehozás + AZONNALI SHEETS MENTÉS
app.post('/create-payment-session', async (req, res) => {
  const { cart, customerData } = req.body;

  try {
    const isEbook = cart.every(item => item.id === 2 || item.id === 4);

    // 1. FOXPOST CSOMAG LÉTREHOZÁS (ha szükséges)
    let foxpostTrackingId = null;
    if (!isEbook && customerData.shippingMethod === 'pickup') {
      foxpostTrackingId = await createFoxpostParcel({ cart, customerData });
    }

    // 2. STRIPE LINE ITEMS ÖSSZEÁLLÍTÁS
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
          unit_amount: product.price * 100,
        },
        quantity: quantity,
      };
    });

    // Szállítási díj hozzáadása
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

    // 3. STRIPE SESSION LÉTREHOZÁS
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: lineItems,
      success_url: `${process.env.DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.DOMAIN}/cancel.html`,
      metadata: {
        customerName: customerData.fullName,
        customerEmail: customerData.email,
        shippingMethod: customerData.shippingMethod || 'digital',
        foxpostTrackingId: foxpostTrackingId || '',
      },
      customer_email: customerData.email,
    });

    // 4. AZONNAL MENTÉS GOOGLE SHEETS-BE (még fizetés előtt)
    await saveOrderToSheets(
      { cart, customerData }, 
      session.id, 
      foxpostTrackingId
    );

    // 5. Válasz a frontendnek
    res.json({ payment_url: session.url });

  } catch (error) {
    console.error('❌ Session/Sheets hiba:', error);
    res.status(500).json({ error: error.message });
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
      console.error('⚠️ Webhook státusz frissítés hiba:', error.message);
    }
  }

  res.json({ received: true });
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
║   ✅ Google Sheets (2026 mezők)      ║
║   ✅ Foxpost integráció              ║
║   ✅ AZONNALI mentés checkout után   ║
╚═══════════════════════════════════════╝
  `);
});
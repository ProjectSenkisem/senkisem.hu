/**
 * Letöltési Link Szolgáltatás
 * 
 * Kezeli:
 * - UUID token generálás
 * - Google Sheets tárolás (Download_Links fül)
 * - Token validálás
 * - Letöltés követés
 * - Biztonsági funkciók (IP naplózás, egyszeri használat, lejárat)
 */

const { v4: uuidv4 } = require('uuid');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const DOWNLOAD_LINKS_SHEET_ID = '1ysbyF0uCl1W03aGArpFYDIU6leFFRJb0R1AaadVarGk';
const DOWNLOAD_LINKS_TAB_NAME = 'Download_Links';
const LINK_EXPIRY_DAYS = 7;

/**
 * Google Auth lekérése
 */
function getGoogleAuth() {
  return new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

/**
 * Download_Links munkalap lekérése vagy létrehozása
 */
async function getDownloadLinksSheet() {
  try {
    const doc = new GoogleSpreadsheet(DOWNLOAD_LINKS_SHEET_ID, getGoogleAuth());
    await doc.loadInfo();
    
    let sheet = doc.sheetsByTitle[DOWNLOAD_LINKS_TAB_NAME];
    
    // Munkalap létrehozása, ha nem létezik
    if (!sheet) {
      console.log('📋 Download_Links munkalap létrehozása...');
      sheet = await doc.addSheet({
        title: DOWNLOAD_LINKS_TAB_NAME,
        headerValues: [
          'Token',
          'Email',
          'Product_IDs',
          'Created',
          'Used',
          'Expiry',
          'IP_Address',
          'Download_Date',
          'Invoice_Number'
        ]
      });
      console.log('✅ Download_Links munkalap létrehozva');
    }
    
    return sheet;
  } catch (error) {
    console.error('❌ Download_Links munkalap hiba:', error);
    throw error;
  }
}

/**
 * Letöltési token generálása és mentése Google Sheets-be
 */
async function generateDownloadToken(email, productId, invoiceNumber) {
  try {
    const token = uuidv4();
    const created = new Date().toISOString();
    const expiry = new Date(Date.now() + LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    
    const sheet = await getDownloadLinksSheet();
    
    await sheet.addRow({
      'Token': token,
      'Email': email,
      'Product_IDs': String(productId),
      'Created': created,
      'Used': 'FALSE',
      'Expiry': expiry,
      'IP_Address': '',
      'Download_Date': '',
      'Invoice_Number': invoiceNumber
    });
    
    console.log(`✅ Token generálva [Product ${productId}]:`, token.substring(0, 8) + '...');
    
    return token;
    
  } catch (error) {
    console.error('❌ Token generálási hiba:', error);
    throw error;
  }
}

/**
 * Letöltési linkek generálása rendeléshez
 */
async function generateDownloadLinks(cart, email, invoiceNumber, domain) {
  try {
    console.log('🔗 Letöltési linkek generálása kezdődik...');
    console.log('   - Email:', email);
    console.log('   - Számla:', invoiceNumber);
    console.log('   - Domain:', domain);
    
    const links = {};
    
    // Ellenőrizd, mely termékekhez kell letöltési link
    const hasProduct2 = cart.some(item => item.id === 2);
    const hasProduct4 = cart.some(item => item.id === 4);
    const hasBundle = cart.some(item => item.id === 300);
    
    console.log('   - Termékek:', {
      hasProduct2,
      hasProduct4,
      hasBundle
    });
    
    // Token generálás Product 2-höz
    if (hasProduct2 || hasBundle) {
      console.log('   📥 Product 2 token generálása...');
      const token2 = await generateDownloadToken(email, 2, invoiceNumber);
      links.product2 = `${domain}/download/${token2}`;
      console.log('   ✅ Product 2 link:', links.product2.substring(0, 60) + '...');
    }
    
    // Token generálás Product 4-hez
    if (hasProduct4 || hasBundle) {
      console.log('   📥 Product 4 token generálása...');
      const token4 = await generateDownloadToken(email, 4, invoiceNumber);
      links.product4 = `${domain}/download/${token4}`;
      console.log('   ✅ Product 4 link:', links.product4.substring(0, 60) + '...');
    }
    
    console.log('✅ Letöltési linkek kész:', Object.keys(links));
    console.log('   Teljes objektum:', JSON.stringify(links, null, 2));
    
    return links;
    
  } catch (error) {
    console.error('❌ Letöltési link generálási hiba:', error);
    throw error;
  }
}

/**
 * Letöltési token validálása
 */
async function validateDownloadToken(token, ipAddress) {
  try {
    const sheet = await getDownloadLinksSheet();
    const rows = await sheet.getRows();
    
    // Token keresése
    const tokenRow = rows.find(row => row.get('Token') === token);
    
    if (!tokenRow) {
      return {
        valid: false,
        reason: 'invalid',
        message: 'Letöltési link nem található. Kérjük, ellenőrizd az emailedben a helyes linket.'
      };
    }
    
    // Ellenőrizd, hogy már használták-e
    if (tokenRow.get('Used') === 'TRUE') {
      return {
        valid: false,
        reason: 'already-used',
        message: 'Ezt a letöltési linket már felhasználták. Minden link csak egyszer használható.',
        usedDate: tokenRow.get('Download_Date')
      };
    }
    
    // Lejárat ellenőrzése
    const expiry = new Date(tokenRow.get('Expiry'));
    const now = new Date();
    
    if (now > expiry) {
      return {
        valid: false,
        reason: 'expired',
        message: `Ez a letöltési link ${expiry.toLocaleDateString('hu-HU')}-án/-én lejárt. Kérjük, lépj kapcsolatba az ügyfélszolgálattal.`,
        expiryDate: expiry.toISOString()
      };
    }
    
    // Érvényes token
    return {
      valid: true,
      productId: parseInt(tokenRow.get('Product_IDs')),
      email: tokenRow.get('Email'),
      tokenRow: tokenRow,
      ipAddress: ipAddress
    };
    
  } catch (error) {
    console.error('❌ Token validálási hiba:', error);
    return {
      valid: false,
      reason: 'server-error',
      message: 'Szerver hiba a validálás során. Kérjük, próbáld újra vagy lépj kapcsolatba az ügyfélszolgálattal.'
    };
  }
}

/**
 * Token megjelölése használtként
 */
async function markTokenAsUsed(tokenRow, ipAddress) {
  try {
    tokenRow.set('Used', 'TRUE');
    tokenRow.set('IP_Address', ipAddress);
    tokenRow.set('Download_Date', new Date().toISOString());
    
    await tokenRow.save();
    
    console.log('✅ Token használtként megjelölve');
    
  } catch (error) {
    console.error('❌ Token frissítési hiba:', error);
    throw error;
  }
}

/**
 * Termék fájl elérési útjának lekérése
 */
function getProductFilePath(productId) {
  const fileMap = {
    2: './ebooks/product_2.pdf',
    4: './ebooks/product_4.pdf'
  };
  
  return fileMap[productId] || null;
}

/**
 * Termék fájlnév lekérése letöltéshez
 */
function getProductFileName(productId) {
  const nameMap = {
    2: 'Senkisem - Jegyzetek egy Idegentől.pdf',
    4: 'Senkisem - Szintetikus Ember.pdf'
  };
  
  return nameMap[productId] || 'ebook.pdf';
}

module.exports = {
  generateDownloadToken,
  generateDownloadLinks,
  validateDownloadToken,
  markTokenAsUsed,
  getProductFilePath,
  getProductFileName,
  LINK_EXPIRY_DAYS
};
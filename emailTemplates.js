/**
 * Email Sablonok Modul
 * 
 * 4 különböző email sablon tartalmazza:
 * - Sablon A: Digitális Termék 1 (Jegyzetek Egy Idegentől - ID 2)
 * - Sablon B: Digitális Termék 2 (Szintetikus Ember - ID 4)
 * - Sablon C: Digitális Csomag (Mindkét e-könyv - ID 300 vagy mindkét ID 2 + ID 4)
 * - Sablon D: Fizikai Termékek
 */

const CONFIG = {
  BRAND_NAME: 'Senkisem',
  TAGLINE: 'Nem egy Brand; Üzenet.',
  SUPPORT_EMAIL: process.env.RESEND_FROM_EMAIL || 'info@senkisem.hu',
  CURRENT_YEAR: new Date().getFullYear()
};

/**
 * Alap email struktúra fejléccel és lábléccel
 */
function getEmailWrapper(content) {
  return `
<!DOCTYPE html>
<html lang="hu">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${CONFIG.BRAND_NAME}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background-color: #f5f5f5;
    }
    .email-container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
    }
    .header {
      background-color: #000000;
      padding: 40px 20px;
      text-align: center;
    }
    .header-logo {
      color: #ffffff;
      font-size: 32px;
      font-weight: 700;
      letter-spacing: 2px;
      margin: 0;
      text-transform: uppercase;
    }
    .footer {
      background-color: #1a1a1a;
      padding: 40px 20px;
      text-align: center;
      color: #ffffff;
    }
    .footer-brand {
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 1px;
      margin-bottom: 10px;
    }
    .footer-tagline {
      font-size: 14px;
      color: #999999;
      font-style: italic;
      margin-top: 5px;
    }
    .footer-copyright {
      font-size: 12px;
      color: #666666;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="email-container">
    <!-- Header -->
    <div class="header">
      <h1 class="header-logo">${CONFIG.BRAND_NAME}</h1>
    </div>
    
    <!-- Content -->
    ${content}
    
    <!-- Footer -->
    <div class="footer">
      <div class="footer-brand">${CONFIG.BRAND_NAME}</div>
      <div class="footer-tagline">${CONFIG.TAGLINE}</div>
      <div class="footer-copyright">© ${CONFIG.CURRENT_YEAR} ${CONFIG.BRAND_NAME} | Minden jog fenntartva</div>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Termék táblázat sorok generálása
 */
function generateProductRows(cart) {
  return cart.map(item => {
    const quantity = item.quantity || 1;
    const price = typeof item.price === 'string' ? 
      parseInt(item.price.replace(/\D/g, '')) : item.price;
    const itemTotal = price * quantity;
    
    return `
      <tr>
        <td style="padding: 15px; border-bottom: 1px solid #e5e5e5; color: #333;">${item.name}</td>
        <td style="padding: 15px; border-bottom: 1px solid #e5e5e5; text-align: center; color: #333;">${quantity}</td>
        <td style="padding: 15px; border-bottom: 1px solid #e5e5e5; text-align: right; color: #333; font-weight: 600;">${itemTotal.toLocaleString('hu-HU')} Ft</td>
      </tr>
    `;
  }).join('');
}

/**
 * Letöltés gomb komponens
 */
function getDownloadButton(downloadUrl, buttonText = 'E-könyv Letöltése') {
  // Biztonsági ellenőrzés - ha nincs URL, ne jelenítsen meg gombot
  if (!downloadUrl || downloadUrl === '#' || downloadUrl === 'undefined') {
    console.warn('⚠️ Hiányzó letöltési URL a gombhoz:', buttonText);
    return `
      <div style="background-color: #ffebee; border-left: 4px solid #f44336; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #c62828; font-size: 14px;">
          ⚠️ Hiba történt a letöltési link generálása során. Kérjük, lépj kapcsolatba az ügyfélszolgálattal.
        </p>
      </div>
    `;
  }
  
  return `
    <div style="text-align: center; margin: 30px 0;">
      <a href="${downloadUrl}" 
         style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                color: #ffffff; text-decoration: none; padding: 18px 50px; border-radius: 8px; 
                font-size: 18px; font-weight: 600; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
                transition: transform 0.2s;">
        📥 ${buttonText}
      </a>
    </div>
  `;
}

/**
 * SABLON A: Digitális Termék 1 - Jegyzetek Egy Idegentől (ID 2)
 */
function templateDigitalProduct1(orderData, totalAmount, downloadLinks) {
  const { customerData, cart } = orderData;
  const productRows = generateProductRows(cart);
  
  // ✅ Letöltési link kinyerése (objektumból vagy stringből)
  const downloadLink = typeof downloadLinks === 'string' 
    ? downloadLinks 
    : (downloadLinks?.product2 || '#');
  
  console.log('📧 [Sablon A] Letöltési link:', downloadLink?.substring(0, 50) + '...');
  
  const content = `
    <div style="padding: 40px 30px;">
      <!-- Üdvözlés -->
      <h2 style="color: #000000; font-size: 24px; margin-bottom: 10px;">Szia ${customerData.fullName}! 👋</h2>
      <p style="color: #666666; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
        Köszönjük a vásárlást! Az <strong>"Jegyzetek Egy Idegentől"</strong> e-könyved letöltésre kész.
      </p>
      
      <!-- Letöltés Gomb -->
      ${getDownloadButton(downloadLink, '"Jegyzetek Egy Idegentől" Letöltése')}
      
      <!-- Figyelmeztetés -->
      <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          ⚠️ <strong>Fontos:</strong> Ez a letöltési link <strong>7 nap</strong> múlva lejár és csak <strong>egyszer</strong> használható. 
          Kérjük, töltsd le az e-könyvedet most és mentsd el az eszközödre.
        </p>
      </div>
      
      <!-- Rendelés Összesítő -->
      <div style="background-color: #f9f9f9; border-radius: 8px; padding: 25px; margin: 30px 0;">
        <h3 style="color: #000000; font-size: 18px; margin-top: 0; margin-bottom: 20px;">Rendelés Összesítő</h3>
        
        <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 6px; overflow: hidden;">
          <thead>
            <tr style="background-color: #000000;">
              <th style="padding: 15px; text-align: left; color: #ffffff; font-size: 14px;">Termék</th>
              <th style="padding: 15px; text-align: center; color: #ffffff; font-size: 14px;">Db</th>
              <th style="padding: 15px; text-align: right; color: #ffffff; font-size: 14px;">Ár</th>
            </tr>
          </thead>
          <tbody>
            ${productRows}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2" style="padding: 20px 15px; text-align: right; font-weight: 600; color: #000000; font-size: 16px;">Összesen:</td>
              <td style="padding: 20px 15px; text-align: right; font-weight: 700; color: #667eea; font-size: 18px;">${totalAmount.toLocaleString('hu-HU')} Ft</td>
            </tr>
          </tfoot>
        </table>
      </div>
      
      <!-- Hozzáférési Infó -->
      <div style="background-color: #e8f5e9; border-left: 4px solid #4caf50; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #1b5e20; font-size: 14px;">
          ✅ Az e-könyved <strong>azonnal letölthető</strong>. Bármely eszközön olvashatod (telefon, tablet, számítógép, e-olvasó).
        </p>
      </div>
      
      <!-- Számla Infó -->
      <div style="background-color: #f0f4ff; border-left: 4px solid #667eea; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #1a237e; font-size: 14px;">
          📄 A hivatalos számlád PDF fájlként csatolva van ehhez az emailhez.
        </p>
      </div>
      
      <!-- Támogatás -->
      <p style="color: #666666; font-size: 14px; line-height: 1.6; margin-top: 30px;">
        Segítségre van szükséged? Írj nekünk: <a href="mailto:info@senkisem.hu" style="color: #667eea; text-decoration: none; font-weight: 600;">${CONFIG.SUPPORT_EMAIL}</a>
      </p>
      
      <p style="color: #333333; font-size: 15px; margin-top: 30px;">
        Üdvözlettel,<br>
        <strong>A ${CONFIG.BRAND_NAME} Csapata</strong>
      </p>
    </div>
  `;
  
  return getEmailWrapper(content);
}

/**
 * SABLON B: Digitális Termék 2 - Szintetikus Ember (ID 4)
 */
function templateDigitalProduct2(orderData, totalAmount, downloadLinks) {
  const { customerData, cart } = orderData;
  const productRows = generateProductRows(cart);
  
  // ✅ Letöltési link kinyerése (objektumból vagy stringből)
  const downloadLink = typeof downloadLinks === 'string' 
    ? downloadLinks 
    : (downloadLinks?.product4 || '#');
  
  console.log('📧 [Sablon B] Letöltési link:', downloadLink?.substring(0, 50) + '...');
  
  const content = `
    <div style="padding: 40px 30px;">
      <!-- Üdvözlés -->
      <h2 style="color: #000000; font-size: 24px; margin-bottom: 10px;">Szia ${customerData.fullName}! 👋</h2>
      <p style="color: #666666; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
        Köszönjük a vásárlást! A <strong>"Szintetikus Ember"</strong> e-könyved letöltésre kész.
      </p>
      
      <!-- Letöltés Gomb -->
      ${getDownloadButton(downloadLink, '"Szintetikus Ember" Letöltése')}
      
      <!-- Figyelmeztetés -->
      <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          ⚠️ <strong>Fontos:</strong> Ez a letöltési link <strong>7 nap</strong> múlva lejár és csak <strong>egyszer</strong> használható. 
          Kérjük, töltsd le az e-könyvedet most és mentsd el az eszközödre.
        </p>
      </div>
      
      <!-- Rendelés Összesítő -->
      <div style="background-color: #f9f9f9; border-radius: 8px; padding: 25px; margin: 30px 0;">
        <h3 style="color: #000000; font-size: 18px; margin-top: 0; margin-bottom: 20px;">Rendelés Összesítő</h3>
        
        <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 6px; overflow: hidden;">
          <thead>
            <tr style="background-color: #000000;">
              <th style="padding: 15px; text-align: left; color: #ffffff; font-size: 14px;">Termék</th>
              <th style="padding: 15px; text-align: center; color: #ffffff; font-size: 14px;">Db</th>
              <th style="padding: 15px; text-align: right; color: #ffffff; font-size: 14px;">Ár</th>
            </tr>
          </thead>
          <tbody>
            ${productRows}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2" style="padding: 20px 15px; text-align: right; font-weight: 600; color: #000000; font-size: 16px;">Összesen:</td>
              <td style="padding: 20px 15px; text-align: right; font-weight: 700; color: #667eea; font-size: 18px;">${totalAmount.toLocaleString('hu-HU')} Ft</td>
            </tr>
          </tfoot>
        </table>
      </div>
      
      <!-- Hozzáférési Infó -->
      <div style="background-color: #e8f5e9; border-left: 4px solid #4caf50; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #1b5e20; font-size: 14px;">
          ✅ Az e-könyved <strong>azonnal letölthető</strong>. Bármely eszközön olvashatod (telefon, tablet, számítógép, e-olvasó).
        </p>
      </div>
      
      <!-- Számla Infó -->
      <div style="background-color: #f0f4ff; border-left: 4px solid #667eea; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #1a237e; font-size: 14px;">
          📄 A hivatalos számlád PDF fájlként csatolva van ehhez az emailhez.
        </p>
      </div>
      
      <!-- Támogatás -->
      <p style="color: #666666; font-size: 14px; line-height: 1.6; margin-top: 30px;">
        Segítségre van szükséged? Írj nekünk: <a href="mailto:info@senkisem.hu" style="color: #667eea; text-decoration: none; font-weight: 600;">${CONFIG.SUPPORT_EMAIL}</a>
      </p>
      
      <p style="color: #333333; font-size: 15px; margin-top: 30px;">
        Üdvözlettel,<br>
        <strong>A ${CONFIG.BRAND_NAME} Csapata</strong>
      </p>
    </div>
  `;
  
  return getEmailWrapper(content);
}

/**
 * SABLON C: Digitális Csomag - Mindkét E-könyv (ID 300 vagy mindkét ID 2 + ID 4)
 */
function templateDigitalBundle(orderData, totalAmount, downloadLinks) {
  const { customerData, cart } = orderData;
  const productRows = generateProductRows(cart);
  
  // ✅ Biztonsági ellenőrzések
  if (!downloadLinks || typeof downloadLinks !== 'object') {
    console.error('❌ [Sablon C] Hiányzó vagy hibás downloadLinks objektum:', downloadLinks);
    downloadLinks = { product2: '#', product4: '#' };
  }
  
  const link2 = downloadLinks.product2 || '#';
  const link4 = downloadLinks.product4 || '#';
  
  console.log('📧 [Sablon C] Link 2:', link2?.substring(0, 50) + '...');
  console.log('📧 [Sablon C] Link 4:', link4?.substring(0, 50) + '...');
  
  const content = `
    <div style="padding: 40px 30px;">
      <!-- Üdvözlés -->
      <h2 style="color: #000000; font-size: 24px; margin-bottom: 10px;">Szia ${customerData.fullName}! 👋</h2>
      <p style="color: #666666; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
        Köszönjük a vásárlást! A teljes e-könyv gyűjteményed letöltésre kész.
      </p>
      
      <!-- Letöltés Gombok -->
      <div style="background-color: #f9f9f9; border-radius: 8px; padding: 30px; margin: 25px 0;">
        <h3 style="color: #000000; font-size: 18px; margin-top: 0; margin-bottom: 25px; text-align: center;">
          📚 E-könyveid Letöltése
        </h3>
        
        ${getDownloadButton(link2, '"Jegyzetek Egy Idegentől" Letöltése')}
        
        <div style="text-align: center; margin: 20px 0; color: #999999; font-size: 14px;">
          ━━━━━━━━━━━━━━━━
        </div>
        
        ${getDownloadButton(link4, '"Szintetikus Ember" Letöltése')}
      </div>
      
      <!-- Figyelmeztetés -->
      <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          ⚠️ <strong>Fontos:</strong> Minden letöltési link <strong>7 nap</strong> múlva lejár és csak <strong>egyszer</strong> használható. 
          Kérjük, töltsd le mindkét e-könyvet most és mentsd el őket az eszközödre.
        </p>
      </div>
      
      <!-- Rendelés Összesítő -->
      <div style="background-color: #f9f9f9; border-radius: 8px; padding: 25px; margin: 30px 0;">
        <h3 style="color: #000000; font-size: 18px; margin-top: 0; margin-bottom: 20px;">Rendelés Összesítő</h3>
        
        <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 6px; overflow: hidden;">
          <thead>
            <tr style="background-color: #000000;">
              <th style="padding: 15px; text-align: left; color: #ffffff; font-size: 14px;">Termék</th>
              <th style="padding: 15px; text-align: center; color: #ffffff; font-size: 14px;">Db</th>
              <th style="padding: 15px; text-align: right; color: #ffffff; font-size: 14px;">Ár</th>
            </tr>
          </thead>
          <tbody>
            ${productRows}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2" style="padding: 20px 15px; text-align: right; font-weight: 600; color: #000000; font-size: 16px;">Összesen:</td>
              <td style="padding: 20px 15px; text-align: right; font-weight: 700; color: #667eea; font-size: 18px;">${totalAmount.toLocaleString('hu-HU')} Ft</td>
            </tr>
          </tfoot>
        </table>
      </div>
      
      <!-- Hozzáférési Infó -->
      <div style="background-color: #e8f5e9; border-left: 4px solid #4caf50; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #1b5e20; font-size: 14px;">
          ✅ Az e-könyveid <strong>azonnal letölthetők</strong>. Bármely eszközön olvashatod őket (telefon, tablet, számítógép, e-olvasó).
        </p>
      </div>
      
      <!-- Számla Infó -->
      <div style="background-color: #f0f4ff; border-left: 4px solid #667eea; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #1a237e; font-size: 14px;">
          📄 A hivatalos számlád PDF fájlként csatolva van ehhez az emailhez.
        </p>
      </div>
      
      <!-- Támogatás -->
      <p style="color: #666666; font-size: 14px; line-height: 1.6; margin-top: 30px;">
        Segítségre van szükséged? Írj nekünk: <a href="mailto:${CONFIG.SUPPORT_EMAIL}" style="color: #667eea; text-decoration: none; font-weight: 600;">${CONFIG.SUPPORT_EMAIL}</a>
      </p>
      
      <p style="color: #333333; font-size: 15px; margin-top: 30px;">
        Üdvözlettel,<br>
        <strong>A ${CONFIG.BRAND_NAME} Csapata</strong>
      </p>
    </div>
  `;
  
  return getEmailWrapper(content);
}

/**
 * SABLON D: Fizikai Termékek
 */
function templatePhysicalProduct(orderData, totalAmount) {
  const { customerData, cart } = orderData;
  const productRows = generateProductRows(cart);
  
  const content = `
    <div style="padding: 40px 30px;">
      <!-- Üdvözlés -->
      <h2 style="color: #000000; font-size: 24px; margin-bottom: 10px;">Szia ${customerData.fullName}! 👋</h2>
      <p style="color: #666666; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
        Köszönjük a rendelésed! Sikeresen megkaptuk a vásárlásod és a fizetésed.
      </p>
      
      <!-- Rendelés Feldolgozási Infó -->
      <div style="background-color: #e3f2fd; border-left: 4px solid #2196f3; padding: 20px; margin: 25px 0; border-radius: 4px;">
        <h3 style="margin: 0 0 15px 0; color: #0d47a1; font-size: 16px;">📦 Rendelés Státusz: Feldolgozás alatt</h3>
        <p style="margin: 5px 0; color: #1565c0; font-size: 14px;">
          ✓ A rendelésed szállításra való előkészítés alatt áll
        </p>
        <p style="margin: 5px 0; color: #1565c0; font-size: 14px;">
          ✓ Átlagos szállítási idő: <strong>7-10 munkanap</strong>
        </p>
        <p style="margin: 5px 0; color: #1565c0; font-size: 14px;">
          ✓ A szállítás akár <strong>14-28 napot</strong> is igénybe vehet a helyszíntől függően
        </p>
      </div>
      
      <!-- Szállítási Cím -->
      <div style="background-color: #f9f9f9; border-radius: 8px; padding: 20px; margin: 25px 0;">
        <h3 style="color: #000000; font-size: 16px; margin-top: 0; margin-bottom: 15px;">📍 Szállítási Cím</h3>
        <p style="margin: 5px 0; color: #333333; font-size: 14px;">
          ${customerData.fullName}<br>
          ${customerData.address}<br>
          ${customerData.zip} ${customerData.city}<br>
          ${customerData.country || 'Magyarország'}
        </p>
        ${customerData.phone ? `<p style="margin: 15px 0 5px 0; color: #666666; font-size: 13px;">Telefon: ${customerData.phone}</p>` : ''}
      </div>
      
      <!-- Rendelés Összesítő -->
      <div style="background-color: #f9f9f9; border-radius: 8px; padding: 25px; margin: 30px 0;">
        <h3 style="color: #000000; font-size: 18px; margin-top: 0; margin-bottom: 20px;">Rendelés Összesítő</h3>
        
        <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 6px; overflow: hidden;">
          <thead>
            <tr style="background-color: #000000;">
              <th style="padding: 15px; text-align: left; color: #ffffff; font-size: 14px;">Termék</th>
              <th style="padding: 15px; text-align: center; color: #ffffff; font-size: 14px;">Db</th>
              <th style="padding: 15px; text-align: right; color: #ffffff; font-size: 14px;">Ár</th>
            </tr>
          </thead>
          <tbody>
            ${productRows}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2" style="padding: 20px 15px; text-align: right; font-weight: 600; color: #000000; font-size: 16px;">Összesen:</td>
              <td style="padding: 20px 15px; text-align: right; font-weight: 700; color: #667eea; font-size: 18px;">${totalAmount.toLocaleString('hu-HU')} Ft</td>
            </tr>
          </tfoot>
        </table>
      </div>
      
      <!-- Nyomkövetési Infó -->
      <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #856404; font-size: 14px;">
          📬 Külön emailt fogsz kapni a <strong>nyomkövetési információkkal</strong>, amint a rendelésed feladásra került.
        </p>
      </div>
      
      <!-- Számla Infó -->
      <div style="background-color: #f0f4ff; border-left: 4px solid #667eea; padding: 15px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0; color: #1a237e; font-size: 14px;">
          📄 A hivatalos számlád PDF fájlként csatolva van ehhez az emailhez.
        </p>
      </div>
      
      <!-- Támogatás -->
      <p style="color: #666666; font-size: 14px; line-height: 1.6; margin-top: 30px;">
        Segítségre van szükséged? Írj nekünk: <a href="mailto:${CONFIG.SUPPORT_EMAIL}" style="color: #667eea; text-decoration: none; font-weight: 600;">${CONFIG.SUPPORT_EMAIL}</a>
      </p>
      
      <p style="color: #333333; font-size: 15px; margin-top: 30px;">
        Üdvözlettel,<br>
        <strong>A ${CONFIG.BRAND_NAME} Csapata</strong>
      </p>
    </div>
  `;
  
  return getEmailWrapper(content);
}

/**
 * Meghatározza, melyik sablont kell használni a kosár tartalma alapján
 */
function determineEmailTemplate(cart) {
  const hasProduct2 = cart.some(item => item.id === 2);
  const hasProduct4 = cart.some(item => item.id === 4);
  const hasBundle = cart.some(item => item.id === 300);
  const hasPhysical = cart.some(item => ![2, 4, 300].includes(item.id));
  
  // Prioritási sorrend:
  if (hasPhysical) return 'physicalProduct';
  if (hasBundle || (hasProduct2 && hasProduct4)) return 'digitalBundle';
  if (hasProduct2) return 'digitalProduct1';
  if (hasProduct4) return 'digitalProduct2';
  
  return 'physicalProduct'; // fallback
}

/**
 * Email generálása sablon típus alapján
 */
function generateEmail(templateType, orderData, totalAmount, downloadLinks = null) {
  console.log('📧 Email generálás:', {
    templateType,
    downloadLinks: downloadLinks ? Object.keys(downloadLinks) : 'null'
  });
  
  switch (templateType) {
    case 'digitalProduct1':
      return {
        subject: '✅ Az E-könyved Készen Áll - Senkisem.hu',
        html: templateDigitalProduct1(orderData, totalAmount, downloadLinks)
      };
    
    case 'digitalProduct2':
      return {
        subject: '✅ Az E-könyved Készen Áll - Senkisem.hu',
        html: templateDigitalProduct2(orderData, totalAmount, downloadLinks)
      };
    
    case 'digitalBundle':
      return {
        subject: '✅ Az E-könyveid Készen Állnak - Senkisem.hu',
        html: templateDigitalBundle(orderData, totalAmount, downloadLinks)
      };
    
    case 'physicalProduct':
      return {
        subject: '✅ Rendelés Megerősítve - Senkisem.hu',
        html: templatePhysicalProduct(orderData, totalAmount)
      };
    
    default:
      throw new Error(`Ismeretlen sablon típus: ${templateType}`);
  }
}

module.exports = {
  determineEmailTemplate,
  generateEmail,
  templateDigitalProduct1,
  templateDigitalProduct2,
  templateDigitalBundle,
  templatePhysicalProduct
};
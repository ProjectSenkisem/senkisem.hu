/**
 * PDF Számla Generátor
 * 
 * Professzionális, modern számlákat generál:
 * - Letisztult fekete/fehér dizájn
 * - Professzionális elrendezés
 * - Eladó és vevő információs dobozok
 * - Termék táblázat megfelelő formázással
 * - ÁFA számítások (AAM - adómentes)
 * - Branding elemek
 */

const PDFDocument = require('pdfkit');

const INVOICE_CONFIG = {
  SELLER: {
    NAME: 'SENKISEM EV',
    REGISTRATION: '60502292',
    ADDRESS: '3600 Ózd Bolyki Tamás utca 15. A épület 1. emelet 5-6. ajtó',
    TAX_NUMBER: '91113654-1-25'
  },
  BRAND: {
    NAME: 'Senkisem',
    TAGLINE: 'Nem egy Brand; Üzenet.'
  },
  COLORS: {
    BLACK: '#000000',
    DARK_GRAY: '#333333',
    MEDIUM_GRAY: '#666666',
    LIGHT_GRAY: '#999999',
    BORDER: '#E5E5E5',
    ACCENT: '#667eea',
    TABLE_HEADER_BG: '#F5F5F5'
  }
};

/**
 * Professzionális PDF számla generálása
 */
async function generateInvoicePDF(orderData, totalAmount, invoiceNumber) {
  return new Promise((resolve, reject) => {
    try {
      const { customerData, cart } = orderData;
      const doc = new PDFDocument({ 
        size: 'A4', 
        margin: 50,
        info: {
          Title: `Számla ${invoiceNumber}`,
          Author: INVOICE_CONFIG.BRAND.NAME,
          Subject: 'Számla',
          Creator: INVOICE_CONFIG.BRAND.NAME
        }
      });
      
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      
      // ============================================
      // FEJLÉC SZEKCIÓ
      // ============================================
      
      // Brand név (bal)
      doc.fontSize(28)
         .font('Helvetica-Bold')
         .fillColor(INVOICE_CONFIG.COLORS.BLACK)
         .text(INVOICE_CONFIG.BRAND.NAME, 50, 50);
      
      // Brand tagline
      doc.fontSize(9)
         .font('Helvetica-Oblique')
         .fillColor(INVOICE_CONFIG.COLORS.LIGHT_GRAY)
         .text(INVOICE_CONFIG.BRAND.TAGLINE, 50, 80);
      
      // Számla cím (jobb)
      doc.fontSize(32)
         .font('Helvetica-Bold')
         .fillColor(INVOICE_CONFIG.COLORS.BLACK)
         .text('SZÁMLA', 400, 50, { align: 'right' });
      
      // Felső határ vonal
      doc.moveTo(50, 110)
         .lineTo(545, 110)
         .strokeColor(INVOICE_CONFIG.COLORS.BLACK)
         .lineWidth(2)
         .stroke();
      
      // ============================================
      // SZÁMLA RÉSZLETEK DOBOZ (Jobb felső)
      // ============================================
      
      let yPos = 130;
      
      // Számlaszám
      doc.fontSize(10)
         .font('Helvetica-Bold')
         .fillColor(INVOICE_CONFIG.COLORS.DARK_GRAY)
         .text('Számlaszám:', 350, yPos);
      
      doc.fontSize(11)
         .font('Helvetica')
         .fillColor(INVOICE_CONFIG.COLORS.BLACK)
         .text(invoiceNumber, 350, yPos + 15);
      
      yPos += 45;
      
      // Kiállítás dátuma
      doc.fontSize(10)
         .font('Helvetica-Bold')
         .fillColor(INVOICE_CONFIG.COLORS.DARK_GRAY)
         .text('Kiállítás dátuma:', 350, yPos);
      
      const issueDate = new Date().toLocaleDateString('hu-HU', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      
      doc.fontSize(10)
         .font('Helvetica')
         .fillColor(INVOICE_CONFIG.COLORS.BLACK)
         .text(issueDate, 350, yPos + 15);
      
      yPos += 45;
      
      // Fizetési mód
      doc.fontSize(10)
         .font('Helvetica-Bold')
         .fillColor(INVOICE_CONFIG.COLORS.DARK_GRAY)
         .text('Fizetési mód:', 350, yPos);
      
      doc.fontSize(10)
         .font('Helvetica')
         .fillColor(INVOICE_CONFIG.COLORS.BLACK)
         .text('Bankkártya', 350, yPos + 15);
      
      // ============================================
      // ELADÓ INFORMÁCIÓS DOBOZ (Bal)
      // ============================================
      
      yPos = 130;
      
      // Eladó doboz háttér
      doc.rect(50, yPos - 5, 280, 100)
         .fillColor('#FAFAFA')
         .fill();
      
      // Eladó cím
      doc.fontSize(11)
         .font('Helvetica-Bold')
         .fillColor(INVOICE_CONFIG.COLORS.BLACK)
         .text('ELADÓ', 60, yPos);
      
      yPos += 20;
      
      // Eladó részletek
      doc.fontSize(9)
         .font('Helvetica')
         .fillColor(INVOICE_CONFIG.COLORS.DARK_GRAY)
         .text(INVOICE_CONFIG.SELLER.NAME, 60, yPos);
      
      yPos += 13;
      doc.text(`Nyilvántartási szám: ${INVOICE_CONFIG.SELLER.REGISTRATION}`, 60, yPos);
      
      yPos += 13;
      doc.text(INVOICE_CONFIG.SELLER.ADDRESS, 60, yPos, { width: 260 });
      
      yPos += 26;
      doc.text(`Adószám: ${INVOICE_CONFIG.SELLER.TAX_NUMBER}`, 60, yPos);
      
      // ============================================
      // VEVŐ INFORMÁCIÓS DOBOZ
      // ============================================
      
      yPos = 250;
      
      // Vevő doboz háttér
      doc.rect(50, yPos - 5, 495, 80)
         .fillColor('#FAFAFA')
         .fill();
      
      // Vevő cím
      doc.fontSize(11)
         .font('Helvetica-Bold')
         .fillColor(INVOICE_CONFIG.COLORS.BLACK)
         .text('VEVŐ', 60, yPos);
      
      yPos += 20;
      
      // Vevő részletek
      doc.fontSize(9)
         .font('Helvetica')
         .fillColor(INVOICE_CONFIG.COLORS.DARK_GRAY)
         .text(customerData.fullName || 'N/A', 60, yPos);
      
      yPos += 13;
      const buyerAddress = `${customerData.address || ''}, ${customerData.zip || ''} ${customerData.city || ''}, ${customerData.country || 'Magyarország'}`.trim();
      doc.text(buyerAddress, 60, yPos, { width: 475 });
      
      if (customerData.email) {
        yPos += 13;
        doc.text(`Email: ${customerData.email}`, 60, yPos);
      }
      
      if (customerData.phone) {
        yPos += 13;
        doc.text(`Telefon: ${customerData.phone}`, 60, yPos);
      }
      
      // ============================================
      // TERMÉKEK TÁBLÁZAT
      // ============================================
      
      yPos = 360;
      
      // Táblázat fejléc háttér
      doc.rect(50, yPos, 495, 25)
         .fillColor(INVOICE_CONFIG.COLORS.BLACK)
         .fill();
      
      // Táblázat fejlécek
      doc.fontSize(9)
         .font('Helvetica-Bold')
         .fillColor('#FFFFFF')
         .text('TÉTEL', 60, yPos + 8)
         .text('DB', 320, yPos + 8, { width: 40, align: 'center' })
         .text('EGYSÉGÁR', 370, yPos + 8, { width: 70, align: 'right' })
         .text('ÁFA', 450, yPos + 8, { width: 40, align: 'center' })
         .text('ÖSSZESEN', 495, yPos + 8, { width: 50, align: 'right' });
      
      yPos += 25;
      
      // Táblázat sorok
      doc.fontSize(9)
         .font('Helvetica')
         .fillColor(INVOICE_CONFIG.COLORS.DARK_GRAY);
      
      let rowIndex = 0;
      cart.forEach((item) => {
        const quantity = item.quantity || 1;
        const price = typeof item.price === 'string' ? 
          parseInt(item.price.replace(/\D/g, '')) : item.price;
        const itemTotal = price * quantity;
        
        // Váltakozó sor háttér
        if (rowIndex % 2 === 0) {
          doc.rect(50, yPos, 495, 22)
             .fillColor('#FAFAFA')
             .fill();
        }
        
        // Sor adatok
        doc.fillColor(INVOICE_CONFIG.COLORS.DARK_GRAY)
           .text(item.name, 60, yPos + 6, { width: 250 })
           .text(`${quantity}`, 320, yPos + 6, { width: 40, align: 'center' })
           .text(`${price.toLocaleString('hu-HU')} Ft`, 370, yPos + 6, { width: 70, align: 'right' })
           .text('AAM', 450, yPos + 6, { width: 40, align: 'center' })
           .text(`${itemTotal.toLocaleString('hu-HU')} Ft`, 495, yPos + 6, { width: 50, align: 'right' });
        
        // Sor határ
        doc.moveTo(50, yPos + 22)
           .lineTo(545, yPos + 22)
           .strokeColor(INVOICE_CONFIG.COLORS.BORDER)
           .lineWidth(0.5)
           .stroke();
        
        yPos += 22;
        rowIndex++;
      });
      
      // ============================================
      // ÖSSZEGEK SZEKCIÓ
      // ============================================
      
      yPos += 20;
      
      // Részösszeg
      doc.fontSize(10)
         .font('Helvetica')
         .fillColor(INVOICE_CONFIG.COLORS.DARK_GRAY)
         .text('Részösszeg:', 370, yPos, { width: 100, align: 'right' })
         .text(`${totalAmount.toLocaleString('hu-HU')} Ft`, 480, yPos, { width: 65, align: 'right' });
      
      yPos += 20;
      
      // ÁFA (AAM - mentes)
      doc.text('ÁFA (AAM - mentes):', 370, yPos, { width: 100, align: 'right' })
         .text('0 Ft', 480, yPos, { width: 65, align: 'right' });
      
      yPos += 30;
      
      // Végösszeg - kiemelt doboz
      doc.rect(350, yPos - 5, 195, 35)
         .fillColor('#F5F5F5')
         .fill();
      
      doc.fontSize(12)
         .font('Helvetica-Bold')
         .fillColor(INVOICE_CONFIG.COLORS.BLACK)
         .text('VÉGÖSSZEG:', 370, yPos + 6, { width: 100, align: 'right' });
      
      doc.fontSize(14)
         .fillColor(INVOICE_CONFIG.COLORS.ACCENT)
         .text(`${totalAmount.toLocaleString('hu-HU')} Ft`, 480, yPos + 6, { width: 65, align: 'right' });
      
      // ============================================
      // LÁBLÉC
      // ============================================
      
      const footerY = 750;
      
      // Lábléc határ
      doc.moveTo(50, footerY)
         .lineTo(545, footerY)
         .strokeColor(INVOICE_CONFIG.COLORS.BORDER)
         .lineWidth(1)
         .stroke();
      
      // Lábléc szöveg
      doc.fontSize(8)
         .font('Helvetica')
         .fillColor(INVOICE_CONFIG.COLORS.MEDIUM_GRAY)
         .text(
           `Köszönjük a vásárlást | ${INVOICE_CONFIG.BRAND.NAME}.hu`,
           50,
           footerY + 15,
           { align: 'center', width: 495 }
         );
      
      doc.fontSize(7)
         .fillColor(INVOICE_CONFIG.COLORS.LIGHT_GRAY)
         .text(
           'Ez egy elektronikusan generált számla, amely aláírás nélkül is érvényes.',
           50,
           footerY + 30,
           { align: 'center', width: 495 }
         );
      
      // PDF véglegesítése
      doc.end();
      
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  generateInvoicePDF
};
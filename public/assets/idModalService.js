// ─────────────────────────────────────────────
//  idModalService.js — PROXY VERZIÓ (CORS-mentes)
//  A Resend API-t NEM közvetlenül hívja,
//  hanem a saját szerveren keresztül: /api/id-modal-email
// ─────────────────────────────────────────────

const ID_MODAL_API = '/api/id-modal-email';

// ─────────────────────────────────────────────
//  SEGÉDFÜGGVÉNY: File → base64
// ─────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve({
      base64: reader.result.split(',')[1],
      name:   file.name || 'kep.jpg',
    });
    reader.onerror = () => reject(new Error('Fájl olvasási hiba: ' + file.name));
    reader.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────
//  HTML ÉPÍTŐK — pontosan ugyanazok mint előtte
//  (a szerver ezeket kapja JSON-ban és elküldi)
// ─────────────────────────────────────────────

function buildAnswerTableHTML(answers) {
  const LABELS = {
    q1:          'Ki vagy, ha nem látszol?',
    q2:          'Ha eltűnne az arcod, mi maradna?',
    q3:          'Volt már, hogy idegen voltál magadnak?',
    q4:          'Mi zavar jobban?',
    q5:          'Inkább lennél…',
    q6:          'Ez a darab inkább…',
    q7:          'Miről dolgozzunk?',
    uploadCount: 'Feltöltött képek száma',
    q9:          'Melyik torzítás?',
    q10:         'Inkább…',
    q13:         'Kiválasztott termék',
    size:        'Kiválasztott méret',
    q14:         'Ez számodra…',
    q15:         'Ha megkérdezik: "ez te vagy?"',
    q16:         'Inkább az vagy…',
  };

  const rows = Object.entries(LABELS)
    .map(([key, label]) => {
      const val = answers[key];
      if (!val && val !== 0) return '';
      return `
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #e5e5e5;color:#555;font-size:13px;width:45%;vertical-align:top;">
            ${label}
          </td>
          <td style="padding:10px 14px;border-bottom:1px solid #e5e5e5;color:#111;font-size:13px;font-weight:600;vertical-align:top;">
            ${val}
          </td>
        </tr>`;
    })
    .filter(Boolean)
    .join('');

  if (!rows) return '<p style="color:#999;font-size:13px;">Nem érkezett válasz.</p>';

  return `
    <table role="presentation" style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;">
      <thead>
        <tr style="background:#000;">
          <th style="padding:12px 14px;text-align:left;color:#fff;font-size:12px;letter-spacing:.06em;text-transform:uppercase;">Kérdés</th>
          <th style="padding:12px 14px;text-align:left;color:#fff;font-size:12px;letter-spacing:.06em;text-transform:uppercase;">Válasz</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildAdminEmailHTML(answers, uploadedFilesCount, isCheckout) {
  const now     = new Date().toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' });
  const product = answers.q13 || '—';
  const size    = answers.size || '—';
  const intent  = isCheckout ? '🛒 MEG AKARJA VENNI' : '⏳ KÉSŐBB SZERETNÉ';
  const email   = answers.contactEmail || '—';

  return `
<!DOCTYPE html>
<html lang="hu">
<head>
  <meta charset="UTF-8">
  <style>
    body{margin:0;padding:0;font-family:'Segoe UI',Tahoma,sans-serif;background:#f5f5f5;}
    .wrap{max-width:640px;margin:0 auto;background:#fff;}
    .hdr{background:#000;padding:32px 24px;text-align:center;}
    .hdr h1{color:#fff;font-size:22px;letter-spacing:2px;margin:0;text-transform:uppercase;}
    .hdr p{color:rgba(255,255,255,.55);font-size:12px;letter-spacing:.14em;text-transform:uppercase;margin:6px 0 0;}
    .body{padding:32px 28px;}
    .badge{display:inline-block;padding:6px 14px;border-radius:3px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:24px;}
    .badge.checkout{background:#e8f5e9;color:#1b5e20;border:1px solid #a5d6a7;}
    .badge.later{background:#fff8e1;color:#6d4c00;border:1px solid #ffe082;}
    h2{font-size:16px;color:#000;margin:28px 0 12px;border-bottom:1px solid #eee;padding-bottom:8px;}
    .meta{background:#f9f9f9;border-radius:6px;padding:16px 18px;margin-bottom:24px;font-size:13px;color:#333;line-height:1.7;}
    .meta strong{color:#000;}
    .ftr{background:#111;padding:28px 24px;text-align:center;color:#fff;font-size:12px;letter-spacing:.1em;text-transform:uppercase;}
  </style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>ID: Senkisem — Új Kitöltés</h1>
    <p>${now}</p>
  </div>
  <div class="body">
    <span class="badge ${isCheckout ? 'checkout' : 'later'}">${intent}</span>

    <div class="meta">
      <strong>Termék:</strong> ${product}<br>
      <strong>Méret:</strong>  ${size}<br>
      ${email !== '—' ? `<strong>Email:</strong> ${email}<br>` : ''}
      <strong>Feltöltött kép:</strong> ${uploadedFilesCount} db
    </div>

    <h2>Összes válasz</h2>
    ${buildAnswerTableHTML(answers)}

    ${uploadedFilesCount > 0 ? `
    <h2 style="margin-top:32px;">Csatolt képek</h2>
    <p style="font-size:13px;color:#666;">
      ${uploadedFilesCount} db kép csatolva az email mellé (lásd: attachments).
    </p>` : ''}
  </div>
  <div class="ftr">Senkisem &nbsp;|&nbsp; ID Kitöltés Értesítő</div>
</div>
</body>
</html>`;
}

function buildConfirmationEmailHTML(customerEmail) {
  return `
<!DOCTYPE html>
<html lang="hu">
<head>
  <meta charset="UTF-8">
  <style>
    body{margin:0;padding:0;font-family:'Segoe UI',Tahoma,sans-serif;background:#f5f5f5;}
    .wrap{max-width:600px;margin:0 auto;background:#fff;}
    .hdr{background:#000;padding:40px 24px;text-align:center;}
    .hdr h1{color:#fff;font-size:28px;letter-spacing:3px;margin:0;text-transform:uppercase;}
    .hdr p{color:rgba(255,255,255,.45);font-size:11px;letter-spacing:.18em;text-transform:uppercase;margin:8px 0 0;}
    .body{padding:40px 32px;}
    .icon{font-size:40px;text-align:center;margin-bottom:20px;}
    h2{color:#000;font-size:20px;line-height:1.3;margin:0 0 16px;}
    p{color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;}
    .box{background:#f9f9f9;border-left:3px solid #000;padding:16px 20px;border-radius:0 4px 4px 0;margin:28px 0;}
    .box p{margin:0;font-size:13px;color:#333;}
    .ftr{background:#111;padding:32px 24px;text-align:center;}
    .ftr span{color:rgba(255,255,255,.4);font-size:11px;letter-spacing:.12em;text-transform:uppercase;}
  </style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>Senkisem</h1>
    <p>Nem egy Brand; Üzenet.</p>
  </div>
  <div class="body">
    <div class="icon">✅</div>
    <h2>Megkaptuk az adataidat!</h2>
    <p>
      Köszönjük, hogy kitöltötted az ID: Senkisem kérdőívet.<br>
      Hamarosan felvesszük veled a kapcsolatot az egyedi torzított identitásoddal.
    </p>
    <div class="box">
      <p>⏱ Válaszidő: <strong>48–72 óra</strong><br>
      A kész designt erre az email-re küldjük el: <strong>${customerEmail}</strong></p>
    </div>
    <p style="font-size:13px;color:#999;">
      Ha bármilyen kérdésed van, írj nekünk:<br>
      <a href="mailto:info@senkisem.hu" style="color:#000;font-weight:600;text-decoration:none;">info@senkisem.hu</a>
    </p>
    <p style="margin-top:32px;font-size:14px;color:#333;">
      Üdvözlettel,<br>
      <strong>A Senkisem Csapata</strong>
    </p>
  </div>
  <div class="ftr">
    <span>© ${new Date().getFullYear()} Senkisem | Minden jog fenntartva</span>
  </div>
</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────
//  FŐ FÜGGVÉNYEK
// ─────────────────────────────────────────────

/**
 * Admin értesítő küldése
 * @param {object}   answers       – modal összes válasza
 * @param {File[]}   uploadedFiles – a feltöltött képek tömbje (File objektumok)
 * @param {boolean}  isCheckout    – igaz, ha "Meg akarom kapni" gombra kattintott
 */
async function sendIdModalAdminEmail(answers, uploadedFiles, isCheckout) {
  // File objektumok → base64 (böngészőben)
  const files = [];
  for (let i = 0; i < uploadedFiles.length; i++) {
    try {
      const converted = await fileToBase64(uploadedFiles[i]);
      files.push(converted); // { base64, name }
    } catch (e) {
      console.warn('⚠️ Kép konvertálási hiba:', e.message);
    }
  }

  // HTML előállítása itt (kliens oldalon), hogy pontosan ugyanolyan legyen mint volt
  const adminHtml = buildAdminEmailHTML(answers, files.length, isCheckout);

  const product = answers.q13 || 'Nem választott';
  const size    = answers.size || '—';
  const intent  = isCheckout ? 'MEG AKARJA VENNI' : 'KÉSŐBB';
  const subject = `[ID: Senkisem] Új kitöltés — ${product} ${size} — ${intent}`;

  const res = await fetch(ID_MODAL_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type:          'admin',
      subject,
      html:          adminHtml,
      uploadedFiles: files,      // [{ base64, name }, ...]
      isCheckout,
      answers,                   // szerver loghoz / fallback-hez
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`[ID Modal] Admin email API hiba (${res.status}): ${errText}`);
  }

  console.log('[ID Modal] Admin email sikeresen elküldve.');
  return res.json();
}

/**
 * Visszaigazoló email küldése a felhasználónak ("Később" esetén)
 * @param {string} customerEmail – a felhasználó által megadott email
 */
async function sendIdModalConfirmationEmail(customerEmail) {
  const confirmHtml = buildConfirmationEmailHTML(customerEmail);

  const res = await fetch(ID_MODAL_API, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type:          'confirmation',
      subject:       '✅ Megkaptuk — Hamarosan jelentkezünk | Senkisem',
      html:          confirmHtml,
      customerEmail,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`[ID Modal] Visszaigazoló email API hiba (${res.status}): ${errText}`);
  }

  console.log('[ID Modal] Visszaigazoló email sikeresen elküldve:', customerEmail);
  return res.json();
}

// ─────────────────────────────────────────────
//  EXPORTS
// ─────────────────────────────────────────────
window.idModalService = {
  sendAdminEmail:        sendIdModalAdminEmail,
  sendConfirmationEmail: sendIdModalConfirmationEmail,
};
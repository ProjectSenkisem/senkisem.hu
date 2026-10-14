/* ============================================================
   SENKISEM · gate.js — szerver által kiadott nyilvános azonosító
   - A nyilvános azonosítót a regisztrációs végpont adja vissza.
   - A belépési kulcs helyben marad; belépés: azonosító + e-mail.
   ============================================================ */
(function () {
'use strict';
var AK = 'senkisem.acct.v1', SK = 'senkisem.session.v1', CV = 'ident-2026-10';
var LOCK = document.getElementById('sn-lock');
var TERMS = '/assets/%C3%81SZF.pdf';

function unlock() {
  if (LOCK && LOCK.parentNode) LOCK.parentNode.removeChild(LOCK);
  document.documentElement.style.overflow = '';
}
function jget(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
var storageOk = (function () { try { localStorage.setItem('__sn', '1'); localStorage.removeItem('__sn'); return true; } catch (e) { return false; } })();
var cryptoOk = !!(window.crypto && crypto.subtle && crypto.getRandomValues);

var qs = new URLSearchParams(location.search), LANG;
(function () {
  var q = qs.get('lang'), s = null;
  try { s = localStorage.getItem('senkisem.lang'); } catch (e) {}
  LANG = (q === 'hu' || q === 'en') ? q : (s === 'hu' ? 'hu' : 'en');
})();

/* ---------- szövegek ---------- */
var T = {
en: {
  h: 'Your ID', sub: 'Your public ID is stored with your registration. Your login key stays in this browser.', tl: 'Log in', tr: 'Create ID',
  idl: 'ID', mail: 'E-mail', name: 'Name (optional)', anon: 'I would rather stay anonymous',
  c1: 'I accept the <a href="' + TERMS + '" target="_blank" rel="noopener">Terms</a> and the <a href="' + TERMS + '" target="_blank" rel="noopener">Privacy Policy</a>.',
  c2: 'I understand my login key is stored only in this browser and cannot be restored. If I lose it, I will need to create a new ID.',
  c3: 'I am 16 or older.', c4: 'Also tell me about new releases. (Optional.)',
  go: 'Log in', mk: 'Create my ID', back: '← Back to the homepage',
  yours: 'This is your ID', warn: 'Save this ID. It is recorded with your registration and can be used to contact you through the community form.',
  copy: 'Copy', copied: 'Copied', dlf: 'Download .txt', saved: 'I saved it somewhere safe.', cont: 'Continue',
  eBad: 'No matching login key was found in this browser. Create a new ID in this browser if you no longer have the original login key.',
  eMail: 'Enter a valid e-mail.', eCons: 'Tick the required boxes first.', eId: 'Enter your ID (ID-Senkisem XXXXXX).',
  eNet: 'Could not reach the server. Try again in a minute.', busy: 'One moment…',
  noStore: 'Your browser blocks local storage (private mode?). The ID needs it. Open the site in a normal window.',
  noCrypto: 'This browser cannot do secure local login. Use a current browser over HTTPS.',
  me: 'ID', out: 'Log out', del: 'Delete this ID', cancel: 'Cancel',
  delQ: 'Delete this ID from this browser and from our records? This cannot be undone.'
},
hu: {
  h: 'Az azonosítód', sub: 'A nyilvános azonosítót a regisztrációddal együtt tároljuk. A belépési kulcsod csak ebben a böngészőben marad.', tl: 'Belépés', tr: 'Azonosító létrehozása',
  idl: 'Azonosító', mail: 'E-mail', name: 'Név (nem kötelező)', anon: 'Inkább anonim maradnék',
  c1: 'Elfogadom az <a href="' + TERMS + '" target="_blank" rel="noopener">ÁSZF-et</a> és az <a href="' + TERMS + '" target="_blank" rel="noopener">Adatkezelési tájékoztatót</a>.',
  c2: 'Tudomásul veszem, hogy a belépési kulcsom csak ebben a böngészőben tárolódik, és nem állítható vissza. Ha elveszítem, új azonosítót kell létrehoznom.',
  c3: 'Elmúltam 16 éves.', c4: 'Értesítsetek az új kiadásokról is. (Nem kötelező.)',
  go: 'Belépés', mk: 'Létrehozom az azonosítómat', back: '← Vissza a főoldalra',
  yours: 'Ez az azonosítód', warn: 'Mentsd el ezt az azonosítót. A regisztrációddal együtt tároljuk, és a közösségi űrlapon kapcsolatfelvételre használható.',
  copy: 'Másolás', copied: 'Másolva', dlf: '.txt letöltése', saved: 'Elmentettem valahová biztonságosan.', cont: 'Tovább',
  eBad: 'Ebben a böngészőben nem található a belépési kulcs. Ha már nincs meg az eredeti kulcs, hozz létre új azonosítót ebben a böngészőben.',
  eMail: 'Adj meg érvényes e-mail-címet.', eCons: 'Előbb pipáld be a kötelező jelölőnégyzeteket.', eId: 'Add meg az azonosítódat (ID-Senkisem XXXXXX).',
  eNet: 'A szerver nem érhető el. Próbáld újra egy perc múlva.', busy: 'Egy pillanat…',
  noStore: 'A böngésződ blokkolja a helyi tárolást (privát mód?). Az azonosítóhoz ez kell. Nyisd meg az oldalt normál ablakban.',
  noCrypto: 'Ez a böngésző nem tud biztonságos helyi belépést. Használj friss böngészőt, HTTPS-en.',
  me: 'ID', out: 'Kijelentkezés', del: 'Azonosító törlése', cancel: 'Mégse',
  delQ: 'Törlöd ezt az azonosítót a böngészőből és a nyilvántartásunkból? Ez nem vonható vissza.'
}};
function t(k) { return T[LANG][k]; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

/* ---------- kripto ---------- */
var enc = new TextEncoder();
function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
function rnd(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
function derive(idn, mail, salt) {
  return crypto.subtle.importKey('raw', enc.encode(idn + '|' + mail), 'PBKDF2', false, ['deriveBits']).then(function (key) {
    return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 200000 }, key, 256);
  }).then(hex);
}
var AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function validId(v) {
  var s = String(v || '').trim();
  var m = /^ID[-\s:]?SENKISEM[-\s:]*([A-Z0-9]{6})$/i.exec(s);
  if (m) return /[A-Z]/i.test(m[1]) && /[0-9]/.test(m[1]) ? 'ID-Senkisem ' + m[1].toUpperCase() : '';
  return s.length > 0 && s.length <= 60 ? s : '';
}
function normMail(v) { return String(v).trim().toLowerCase(); }
var MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function post(path, body) {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json().catch(function () { return {}; }); });
}
function pickAcct(a) { var l = jget(AK, []); for (var i = 0; i < l.length; i++) if (l[i].a === a) return l[i]; return null; }

/* ---------- már be van lépve? ---------- */
var ses = storageOk ? jget(SK, null) : null, acct = ses ? pickAcct(ses.a) : null;
window.SenkisemAuth = {
  user: function () { var a = storageOk && jget(SK, null) ? pickAcct(jget(SK, null).a) : null; return a ? { id: a.id || a.a, name: a.anon ? null : a.name, anonymous: !!a.anon } : null; },
  ns: function () { var s = jget(SK, null); return s ? s.a : null; },
  logout: function () { try { localStorage.removeItem(SK); } catch (e) {} location.reload(); }
};
if (acct) {
  unlock();
  onReady(function () { chip(acct); });
  return;
}

/* ---------- kapu felület ---------- */
document.documentElement.style.overflow = 'hidden';
var root, mode = 'login', done = null, busy = false;

function css() {
  var l = document.createElement('link'); l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Space+Mono&display=swap';
  document.head.appendChild(l);
  var s = document.createElement('style');
  s.textContent =
  '#sn-gate,#sn-dlg{visibility:visible!important;position:fixed;inset:0;z-index:2147483000;background:#000;color:#fff;overflow-y:auto;font-family:"Space Mono",monospace;-webkit-text-size-adjust:100%}' +
  '#sn-dlg{background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:1.2rem;z-index:2147483001}' +
  '#sn-gate *,#sn-dlg *{box-sizing:border-box}' +
  '.g-wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:2rem 1.2rem;background:radial-gradient(ellipse at 50% 40%,rgba(255,255,255,.07),transparent 60%)}' +
  '.g-box{width:min(480px,100%)}' +
  '.g-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:2rem}' +
  '.g-brand{font-size:.8rem;letter-spacing:.3em;text-transform:uppercase;color:rgba(255,255,255,.6)}' +
  '.g-lang button{width:30px;height:30px;border-radius:50%;border:2px solid transparent;background:none;color:#fff;font:inherit;font-size:.62rem;opacity:.5;cursor:pointer}' +
  '.g-lang button[aria-pressed=true]{opacity:1;border-color:#fff}' +
  '.g-h{font-family:"DM Serif Display",Georgia,serif;font-weight:400;font-size:clamp(2.4rem,9vw,3.6rem);line-height:.98;letter-spacing:-.03em;margin:0 0 .6rem}' +
  '.g-sub{font-size:.8rem;line-height:1.7;color:rgba(255,255,255,.65);margin:0 0 1.6rem}' +
  '.g-tabs{display:flex;gap:1.4rem;margin-bottom:1.4rem;border-bottom:1px solid rgba(255,255,255,.15)}' +
  '.g-tabs button{background:none;border:0;border-bottom:2px solid transparent;color:rgba(255,255,255,.55);font:inherit;font-size:.78rem;letter-spacing:.08em;padding:.6rem 0;cursor:pointer;margin-bottom:-1px}' +
  '.g-tabs button[aria-selected=true]{color:#fff;border-bottom-color:#fff}' +
  '.g-f{margin-bottom:1.1rem}.g-f label{display:block;font-size:.72rem;color:rgba(255,255,255,.65);margin-bottom:.3rem}' +
  '.g-f input[type=text],.g-f input[type=email]{width:100%;background:transparent;color:#fff;border:0;border-bottom:1px solid rgba(255,255,255,.4);padding:.6rem 0;font-family:"DM Serif Display",Georgia,serif;font-size:1.35rem;border-radius:0;outline:none}' +
  '.g-f input:focus{border-bottom-color:#ff4350}.g-f input:disabled{opacity:.3}' +
  '.g-c{display:flex;gap:.7rem;align-items:flex-start;font-size:.72rem;line-height:1.6;color:rgba(255,255,255,.72);margin:.8rem 0}' +
  '.g-c input{margin-top:.2rem;width:16px;height:16px;flex:none;accent-color:#fff}.g-c a{color:#fff}' +
  '.g-err{min-height:1.3em;color:#ff8a92;font-size:.74rem;line-height:1.5;margin:.8rem 0}' +
  '.g-btn{display:inline-block;width:100%;padding:1rem 1.4rem;border:0;border-radius:3px;background:#fff;color:#000;font:inherit;font-size:.78rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;cursor:pointer;text-align:center;text-decoration:none}' +
  '.g-btn:hover:not(:disabled){background:#e0212b;color:#fff}.g-btn:disabled{opacity:.3;cursor:not-allowed}' +
  '.g-btn.g2{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.4);margin-top:.6rem}.g-btn.g2:hover:not(:disabled){background:rgba(255,255,255,.1);color:#fff}' +
  '.g-back{display:block;margin-top:1.6rem;font-size:.72rem;color:rgba(255,255,255,.55);text-decoration:none}.g-back:hover{color:#fff}' +
  '.g-id{font-size:clamp(1.3rem,6vw,1.9rem);letter-spacing:.08em;padding:1.1rem;border:1px solid rgba(255,255,255,.5);background:rgba(255,255,255,.06);text-align:center;margin:1rem 0;word-break:break-all;user-select:all}' +
  '.g-row{display:flex;gap:.6rem}.g-row .g-btn{margin-top:0}' +
  '.g-warn{border-left:2px solid #e0212b;padding-left:.9rem;font-size:.78rem;line-height:1.7;margin:0 0 1rem}' +
  '#sn-chip{visibility:visible!important;position:fixed;left:10px;bottom:10px;z-index:2147482000;font:10px/1 "Space Mono",monospace;letter-spacing:.08em;color:rgba(255,255,255,.55);background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:6px 10px;cursor:pointer;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '#sn-chip:hover{color:#fff}' +
  '.g-dlg{width:min(380px,100%);background:#0a0a0a;border:1px solid rgba(255,255,255,.25);padding:1.4rem}';
  document.head.appendChild(s);
}

function onReady(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
function $(s) { return root.querySelector(s); }

function shell(inner) {
  return '<div class="g-wrap"><div class="g-box"><div class="g-top"><span class="g-brand">Senkisem</span>' +
    '<span class="g-lang"><button data-l="hu" aria-pressed="' + (LANG === 'hu') + '">HU</button><button data-l="en" aria-pressed="' + (LANG === 'en') + '">EN</button></span></div>' +
    inner + '</div></div>';
}
function render() {
  var h;
  if (!storageOk) h = shell('<h1 class="g-h">' + t('h') + '</h1><p class="g-err">' + t('noStore') + '</p><a class="g-back" href="/">' + t('back') + '</a>');
  else if (!cryptoOk) h = shell('<h1 class="g-h">' + t('h') + '</h1><p class="g-err">' + t('noCrypto') + '</p><a class="g-back" href="/">' + t('back') + '</a>');
  else if (mode === 'done') {
    h = shell('<h1 class="g-h">' + t('yours') + '</h1><div class="g-id" id="g-id">' + esc(done.id) + '</div><p class="g-warn">' + t('warn') + '</p>' +
      '<div class="g-row"><button class="g-btn g2" id="g-copy" type="button">' + t('copy') + '</button><button class="g-btn g2" id="g-dl" type="button">' + t('dlf') + '</button></div>' +
      '<label class="g-c" style="margin-top:1.2rem"><input type="checkbox" id="g-ok"><span>' + t('saved') + '</span></label>' +
      '<button class="g-btn" id="g-cont" type="button" disabled>' + t('cont') + '</button>');
  } else {
    var tabs = '<div class="g-tabs" role="tablist"><button role="tab" data-m="login" aria-selected="' + (mode === 'login') + '">' + t('tl') + '</button><button role="tab" data-m="reg" aria-selected="' + (mode === 'reg') + '">' + t('tr') + '</button></div>';
    var form;
    if (mode === 'login') {
      form = '<form id="g-form" novalidate><div class="g-f"><label for="g-id-in">' + t('idl') + '</label><input type="text" id="g-id-in" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ID-Senkisem XXXXXX"></div>' +
        '<div class="g-f"><label for="g-mail">' + t('mail') + '</label><input type="email" id="g-mail" autocomplete="email"></div><div class="g-err" id="g-err" role="alert"></div>' +
        '<button class="g-btn" type="submit">' + t('go') + '</button></form>';
    } else {
      form = '<form id="g-form" novalidate><div class="g-f"><label for="g-name">' + t('name') + '</label><input type="text" id="g-name" maxlength="60" autocomplete="given-name"></div>' +
        '<label class="g-c" style="margin-top:0"><input type="checkbox" id="g-anon"><span>' + t('anon') + '</span></label>' +
        '<div class="g-f"><label for="g-mail">' + t('mail') + '</label><input type="email" id="g-mail" autocomplete="email"></div>' +
        '<label class="g-c"><input type="checkbox" id="g-c1"><span>' + t('c1') + '</span></label>' +
        '<label class="g-c"><input type="checkbox" id="g-c2"><span>' + t('c2') + '</span></label>' +
        '<label class="g-c"><input type="checkbox" id="g-c3"><span>' + t('c3') + '</span></label>' +
        '<label class="g-c"><input type="checkbox" id="g-c4"><span>' + t('c4') + '</span></label>' +
        '<div class="g-err" id="g-err" role="alert"></div><button class="g-btn" type="submit">' + t('mk') + '</button></form>';
    }
    h = shell('<h1 class="g-h">' + t('h') + '</h1><p class="g-sub">' + t('sub') + '</p>' + tabs + form + '<a class="g-back" href="/">' + t('back') + '</a>');
  }
  root.innerHTML = h;
  bind();
}
function setLang(l) {
  try { localStorage.setItem('senkisem.lang', l); } catch (e) {}
  var u = new URL(location.href);
  if (u.searchParams.has('lang')) { u.searchParams.set('lang', l); location.replace(u.toString()); } else location.reload();
}
function err(k) { var e = $('#g-err'); if (e) e.textContent = k ? t(k) : ''; }

function bind() {
  root.querySelectorAll('.g-lang button').forEach(function (b) { b.onclick = function () { if (b.dataset.l !== LANG) setLang(b.dataset.l); }; });
  root.querySelectorAll('.g-tabs button').forEach(function (b) { b.onclick = function () { mode = b.dataset.m; render(); }; });
  var f = $('#g-form');
  if (f) {
    if (mode === 'reg') $('#g-anon').onchange = function () { $('#g-name').disabled = this.checked; if (this.checked) $('#g-name').value = ''; };
    f.onsubmit = function (e) { e.preventDefault(); if (busy) return; mode === 'login' ? doLogin() : doRegister(); };
    var first = $('#g-id-in') || $('#g-name'); if (first) first.focus();
  }
  if (mode === 'done') {
    $('#g-copy').onclick = function () { var b = this; (navigator.clipboard ? navigator.clipboard.writeText(done.id) : Promise.reject()).then(function () { b.textContent = t('copied'); }, function () {}); };
    $('#g-dl').onclick = function () {
      var blob = new Blob(['SENKISEM ID\n' + done.id + '\n'], { type: 'text/plain' }), a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'senkisem-id.txt'; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    };
    $('#g-ok').onchange = function () { $('#g-cont').disabled = !this.checked; };
    $('#g-cont').onclick = function () { jset(SK, { a: done.acct.a, at: Date.now() }); location.reload(); };
  }
}

function setBusy(on) { busy = on; var b = root.querySelector('.g-btn'); if (b) b.disabled = on; if (on) err(null); }

function doLogin() {
  var idn = validId($('#g-id-in').value), mail = normMail($('#g-mail').value);
  if (!idn) return err('eId');
  if (!MAIL_RE.test(mail)) return err('eMail');
  setBusy(true);
  var list = jget(AK, []), i = 0;
  function finish(a, publicId) {
    var saveKey = publicId ? derive(publicId, mail, a.salt).then(function (k) {
      a.id = publicId; a.k = k;
      var accounts = jget(AK, []);
      for (var n = 0; n < accounts.length; n++) if (accounts[n].a === a.a) { accounts[n] = a; break; }
      jset(AK, accounts);
    }).catch(function () {}) : Promise.resolve();
    saveKey.then(function () {
      jset(SK, { a: a.a, at: Date.now() });
      setTimeout(function () { location.reload(); }, 150);
    });
  }
  (function next() {
    if (i >= list.length) { setBusy(false); return err('eBad'); }
    var a = list[i++];
    derive(idn, mail, a.salt).then(function (k) {
      if (k !== a.k) return next();
      post('/api/ident/login', { rid: a.rid }).then(function (response) {
        finish(a, validId(response && response.id));
      }).catch(function () { finish(a, null); });
    }).catch(function () { setBusy(false); err('eBad'); });
  })();
}

function doRegister() {
  var anon = $('#g-anon').checked, name = anon ? '' : $('#g-name').value.trim(), mail = normMail($('#g-mail').value);
  if (!MAIL_RE.test(mail)) return err('eMail');
  if (!($('#g-c1').checked && $('#g-c2').checked && $('#g-c3').checked)) return err('eCons');
  var news = $('#g-c4').checked;
  setBusy(true); err(null);
  var salt = hex(rnd(16)), rid = hex(rnd(16)), a = hex(rnd(4));
  post('/api/ident/register', {
      rid: rid, name: name, anonymous: anon, email: mail, lang: LANG, newsletter: news,
      consent: { terms: true, local: true, age: true }, consentVersion: CV
    }).then(function (response) {
    var id = validId(response && response.id);
    if (!id) throw new Error('missing-issued-id');
    return derive(id, mail, salt).then(function (k) { return { id: id, k: k }; });
  }).then(function (issued) {
    var id = issued.id, acct = { a: a, id: id, salt: salt, k: issued.k, rid: rid, name: name, anon: anon, at: Date.now() }, list = jget(AK, []);
    list.push(acct);
    if (!jset(AK, list)) throw new Error('storage');
    done = { id: id, acct: acct }; mode = 'done'; busy = false; render();
  }).catch(function () { setBusy(false); err('eNet'); });
}

/* ---------- chip: kijelentkezés / törlés ---------- */
function chip(a) {
  var c = document.createElement('button');
  c.id = 'sn-chip'; c.type = 'button';
  c.textContent = t('me') + ' · ' + (a.anon || !a.name ? (a.id || 'ID-Senkisem') : a.name);
  c.onclick = function () {
    var d = document.createElement('div'); d.id = 'sn-dlg';
    d.innerHTML = '<div class="g-dlg"><button class="g-btn" data-a="out" type="button">' + t('out') + '</button>' +
      '<button class="g-btn g2" data-a="del" type="button">' + t('del') + '</button><button class="g-btn g2" data-a="x" type="button">' + t('cancel') + '</button></div>';
    d.onclick = function (e) {
      var k = e.target.dataset && e.target.dataset.a;
      if (e.target === d || k === 'x') return d.remove();
      if (k === 'out') window.SenkisemAuth.logout();
      if (k === 'del' && confirm(t('delQ'))) {
        post('/api/ident/erase', { rid: a.rid }).catch(function () {}).then(function () {
          var l = jget(AK, []).filter(function (x) { return x.a !== a.a; });
          jset(AK, l); try { localStorage.removeItem(SK); } catch (e2) {}
          location.reload();
        });
      }
    };
    document.body.appendChild(d);
  };
  document.body.appendChild(c);
}

onReady(function () {
  css();
  root = document.createElement('div'); root.id = 'sn-gate';
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
  document.body.appendChild(root);
  render();
});
})();

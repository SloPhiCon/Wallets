/* Wallets — all app logic lives in this file.
   Sections (search for the "=====" headings):
     1. Data + storage      what is saved, and the money rules
     2. Helpers             formatting, small utilities
     3. Screens             Wallets (home), Pay, Refresh, History
     4. Sheets              the pop-up forms
     5. UPI + QR            building payment links, scanning
     6. Screenshot reader   Gemini call
     7. Settings + backup
     8. Wiring              clicks, tabs, startup
   All money is stored in paise (integers) to avoid rounding errors. */

'use strict';

/* ===== 1. Data + storage ===== */
const STORE_KEY = 'walletapp.v1';
const COLORS = ['#4F63E8', '#0F9D74', '#E0752B', '#B43BC4', '#1193AE', '#C99212', '#D63A5E', '#6B8E23'];
const UPI_APPS = [
  { id: 'gpay', name: 'Google Pay', pkg: 'com.google.android.apps.nbu.paisa.user' },
  { id: 'phonepe', name: 'PhonePe', pkg: 'com.phonepe.app' },
  { id: 'paytm', name: 'Paytm', pkg: 'net.one97.paytm' },
  { id: 'amazon', name: 'Amazon Pay', pkg: 'in.amazon.mShop.android.shopping' },
  { id: 'bhim', name: 'BHIM', pkg: 'in.org.npci.upiapp' },
];

const blank = () => ({
  v: 1,
  started: false,
  bank: 0,            // last bank balance you confirmed
  lastRefresh: null,
  gap: 0,             // bank change found at Refresh that is not yet explained (negative = money left)
  wallets: [],        // { id, name, color, bal }
  tx: [],             // newest first; see addTx / moveMoney / setBank for shapes
  pending: [],        // payments handed to a UPI app, waiting for "Paid / Not paid"
  settings: { geminiKey: '', geminiModel: 'gemini-flash-latest' },
});

let S = blank();
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) S = Object.assign(blank(), JSON.parse(raw));
    S.settings = Object.assign(blank().settings, S.settings);
  } catch (e) { console.warn('Could not read saved data', e); }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
  catch (e) { toast('Could not save on this device'); }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const wallet = id => S.wallets.find(w => w.id === id) || null;
const inWallets = () => S.wallets.reduce((a, w) => a + w.bal, 0);
const unallocated = () => S.bank - inWallets();   // bank money not sitting in any wallet

/* A debit or credit.
   live = true  : it is happening now, so the bank balance changes too (payments, "Add transaction").
   live = false : found during Refresh; the bank balance already includes it, so only the wallet changes. */
function addTx({ type, amt, walletId = null, who = '', note = '', src = 'manual', live = true, ts = Date.now() }) {
  const sign = type === 'credit' ? 1 : -1;
  const w = wallet(walletId);
  const t = { id: uid(), ts, type, amt, wallet: w ? w.id : null, who, note, src,
              bankDelta: live ? sign * amt : 0, walletDelta: w ? sign * amt : 0 };
  S.bank += t.bankDelta;
  if (w) w.bal += t.walletDelta;
  if (!live) S.gap -= sign * amt;
  S.tx.unshift(t);
  save();
  return t;
}

/* Move money between two places inside the app. null means "Unallocated". Bank balance never changes. */
function moveMoney(fromId, toId, amt) {
  const f = wallet(fromId), t = wallet(toId);
  if (f) f.bal -= amt;
  if (t) t.bal += amt;
  S.tx.unshift({ id: uid(), ts: Date.now(), type: 'move', amt, from: f ? f.id : null, to: t ? t.id : null });
  save();
}

/* Refresh: you type the real bank balance; the difference lands in Unallocated until you explain it. */
function setBank(actual) {
  const diff = actual - S.bank;
  S.bank = actual;
  S.lastRefresh = Date.now();
  if (diff !== 0) {
    S.gap += diff;
    S.tx.unshift({ id: uid(), ts: Date.now(), type: 'adjust', amt: diff, bankDelta: diff });
  }
  save();
  return diff;
}

function deleteTx(id) {
  const i = S.tx.findIndex(t => t.id === id);
  if (i < 0) return;
  const t = S.tx[i];
  if (t.type === 'move') {
    const f = wallet(t.from), to = wallet(t.to);
    if (f) f.bal += t.amt;
    if (to) to.bal -= t.amt;
  } else {
    S.bank -= t.bankDelta || 0;
    const w = wallet(t.wallet);
    if (w) w.bal -= t.walletDelta || 0;
  }
  S.tx.splice(i, 1);
  save();
}

function reassignTx(id, walletId) {
  const t = S.tx.find(x => x.id === id);
  if (!t || (t.type !== 'debit' && t.type !== 'credit')) return;
  const old = wallet(t.wallet), nw = wallet(walletId);
  if (old) old.bal -= t.walletDelta;
  const sign = t.type === 'credit' ? 1 : -1;
  t.wallet = nw ? nw.id : null;
  t.walletDelta = nw ? sign * t.amt : 0;
  if (nw) nw.bal += t.walletDelta;
  save();
}

/* ===== 2. Helpers ===== */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(p) {
  const neg = p < 0, a = Math.abs(p);
  const s = new Intl.NumberFormat('en-IN', { minimumFractionDigits: a % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(a / 100);
  return (neg ? '−₹' : '₹') + s;
}
/* "1,250.50" -> 125050 paise. Returns null if it is not a positive amount (or zero when allowZero). */
function parseAmt(str, allowZero = false) {
  const n = Number(String(str ?? '').replace(/[₹,\s]/g, ''));
  if (!isFinite(n) || n < 0 || (!allowZero && n === 0)) return null;
  if (String(str).trim() === '') return null;
  return Math.round(n * 100);
}
function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.round(h / 24);
  return d + (d === 1 ? ' day ago' : ' days ago');
}
const dayLabel = ts => new Date(ts).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const wName = id => { if (!id) return 'Unallocated'; const w = wallet(id); return w ? w.name : 'Deleted wallet'; };
const wColor = id => { const w = wallet(id); return w ? w.color : null; };
const colorTab = id => wColor(id) ? `<i class="tab-c" style="background:${esc(wColor(id))}"></i>` : `<i class="tab-c un"></i>`;

let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* <option> list of wallets, with Unallocated as an optional choice */
function walletOptions(selected, { unalloc = true, balances = true } = {}) {
  let h = '';
  if (unalloc) h += `<option value="">Unallocated${balances ? ' (' + money(unallocated()) + ')' : ''}</option>`;
  for (const w of S.wallets) h += `<option value="${w.id}"${w.id === selected ? ' selected' : ''}>${esc(w.name)}${balances ? ' (' + money(w.bal) + ')' : ''}</option>`;
  return h;
}

/* ===== 3. Screens ===== */
let tab = 'home';
let historyFilter = 'all';
let pay = null;        // the payment being set up on the Pay tab
let scanStream = null; // camera stream while scanning

function render() {
  stopScan();
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  const v = $('#view');
  v.innerHTML = ({ home: viewHome, pay: viewPay, refresh: viewRefresh, history: viewHistory })[tab]();
  if (tab === 'pay' && pay && pay.step === 'scan') startScan();
  window.scrollTo(0, 0);
}

function viewHome() {
  if (!S.started) {
    return `<header class="top"><div class="top-label">Wallets</div><div class="top-amt">Split your bank balance</div>
      <div class="top-sub">Your money stays in the bank. This app only keeps track of which part is for what.</div></header>
      <div class="empty"><strong>Start with your bank balance</strong>Check your bank app and type what it shows right now.</div>
      <div class="actions"><button class="btn primary" data-act="sheetStart">Enter bank balance</button></div>`;
  }
  const un = unallocated();
  const total = Math.max(S.bank, inWallets(), 1);
  const segs = S.wallets.filter(w => w.bal > 0).map(w => `<i style="width:${(w.bal / total * 100).toFixed(2)}%;background:${esc(w.color)}" title="${esc(w.name)}"></i>`).join('')
    + (un > 0 ? `<i class="un" style="width:${(un / total * 100).toFixed(2)}%" title="Unallocated"></i>` : '');

  let h = `<header class="top">
    <div class="top-row"><span class="top-label">In your bank</span>
      <button class="icon-btn" data-act="sheetSettings" aria-label="Settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg></button></div>
    <div class="top-amt num">${money(S.bank)}</div>
    <div class="top-sub">Checked ${ago(S.lastRefresh)}</div>
    <div class="split" role="img" aria-label="How the balance is divided between wallets">${segs}</div>
  </header>`;

  if (S.pending.length) h += `<div class="notice"><span>${S.pending.length} payment${S.pending.length > 1 ? 's' : ''} waiting for you to confirm.</span><button class="btn sm" data-act="confirmNext">Confirm</button></div>`;
  if (un < 0) h += `<div class="notice"><span>${money(-un)} has left your bank but hasn't been taken from any wallet yet.</span><button class="btn sm" data-act="goRefresh">Sort it</button></div>`;

  h += `<div class="block"><div class="list">
    <button class="row" data-act="sheetDivide"><i class="tab-c un"></i><span class="grow"><span class="name">Unallocated</span><span class="muted small">Not in any wallet yet</span></span><span class="amt num ${un < 0 ? 'bad' : ''}">${money(un)}</span></button>`;
  for (const w of S.wallets) h += `<button class="row" data-act="sheetWallet" data-id="${w.id}"><i class="tab-c" style="background:${esc(w.color)}"></i><span class="grow"><span class="name">${esc(w.name)}</span></span><span class="amt num ${w.bal < 0 ? 'bad' : ''}">${money(w.bal)}</span></button>`;
  h += `</div></div>`;
  if (!S.wallets.length) h += `<div class="empty"><strong>No wallets yet</strong>Make one for each thing you set money aside for, like rent, food or savings.</div>`;
  h += `<div class="actions"><button class="btn" data-act="sheetNewWallet">New wallet</button><button class="btn primary" data-act="sheetAddTx" data-live="1">Add transaction</button></div>`;
  return h;
}

function viewPay() {
  if (!S.started || !S.wallets.length) {
    return `<h1 class="page-title">Pay</h1><div class="empty"><strong>Make a wallet first</strong>Payments are taken from a wallet, so you need at least one.</div>
      <div class="actions"><button class="btn primary" data-tabgo="home">Go to wallets</button></div>`;
  }
  if (!pay) {
    return `<h1 class="page-title">Pay</h1><p class="page-lede">Who are you paying?</p>
      <div class="block"><div class="list">
        <button class="row" data-act="payScan"><span class="grow"><span class="name">Scan a QR code</span><span class="muted small">Use the camera</span></span></button>
        <button class="row" data-act="payPickImage"><span class="grow"><span class="name">QR from a photo</span><span class="muted small">Pick a saved image or screenshot</span></span></button>
        <button class="row" data-act="payUpiId"><span class="grow"><span class="name">UPI ID</span><span class="muted small">Like name@okbank</span></span></button>
        <button class="row" data-act="payPhone"><span class="grow"><span class="name">Phone number</span><span class="muted small">You finish the payment inside your UPI app</span></span></button>
      </div></div>
      <input type="file" id="qr-file" accept="image/*" hidden>`;
  }
  if (pay.step === 'scan') {
    return `<h1 class="page-title">Scan a QR code</h1><p class="page-lede">Hold the code inside the square.</p>
      <div class="block"><div class="scanner"><video id="cam" playsinline muted></video></div>
      <p class="err" id="scan-err" hidden></p>
      <button class="btn wide" data-act="payCancel">Cancel</button></div>`;
  }
  // step: details — amount, wallet, then the UPI app
  const amt = parseAmt(pay.amtText);
  const who = pay.name || pay.pa || pay.phone;
  let h = `<h1 class="page-title">Pay</h1><div class="block">
    <div class="payee"><span class="muted small">Paying</span><b>${esc(who)}</b>${pay.name && pay.pa ? `<span class="muted small">${esc(pay.pa)}</span>` : ''}</div>
    <label class="field"><span>Amount (₹)</span><input class="big num" id="pay-amt" inputmode="decimal" autocomplete="off" value="${esc(pay.amtText)}" placeholder="0"></label>
    <label class="field"><span>Note (optional)</span><input id="pay-note" maxlength="50" value="${esc(pay.note)}" placeholder="What is it for?"></label>
    <h2>Pay from which wallet?</h2><div id="pay-wallets">${payWalletRows(amt)}</div>
    <div id="pay-next">${payNext(amt)}</div>
    <button class="btn wide" data-act="payCancel" style="margin-top:10px">Cancel</button></div>`;
  return h;
}
function payWalletRows(amt) {
  return S.wallets.map(w => {
    const short = amt != null && w.bal < amt;
    const sub = amt == null ? `Has ${money(w.bal)}` : short ? `<span class="bad">Not enough. ${money(amt - w.bal)} short</span>` : `<span class="good">Enough. ${money(w.bal - amt)} left after this</span>`;
    return `<div class="pick" aria-pressed="${pay.walletId === w.id}"><button class="row" data-act="payPickWallet" data-id="${w.id}">
      <i class="tab-c" style="background:${esc(w.color)}"></i><span class="grow"><span class="name">${esc(w.name)}</span><span class="small">${sub}</span></span><span class="amt num">${money(w.bal)}</span></button></div>`;
  }).join('');
}
function payNext(amt) {
  const w = wallet(pay.walletId);
  if (amt == null) return `<p class="hint" style="margin-top:8px">Enter an amount to continue.</p>`;
  if (!w) return `<p class="hint" style="margin-top:8px">Choose a wallet to continue.</p>`;
  let h = '';
  if (w.bal < amt) h += `<div class="notice" style="margin:10px 0"><span>${esc(w.name)} is ${money(amt - w.bal)} short. If you pay anyway it will go below zero.</span></div>`;
  h += `<h2 style="margin-top:14px">Open in</h2><div class="btn-row">`;
  for (const a of UPI_APPS) h += `<button class="btn" data-act="payGo" data-app="${a.id}">${a.name}</button>`;
  if (!pay.phone) h += `<button class="btn" data-act="payGo" data-app="any">Other UPI app</button>`;
  h += `</div>`;
  if (pay.phone) h += `<p class="hint" style="margin-top:10px">The number is copied for you. In the UPI app, choose "pay phone number" and paste it.</p>`;
  return h;
}

function viewRefresh() {
  if (!S.started) return `<h1 class="page-title">Refresh</h1><div class="empty"><strong>Nothing to check yet</strong>Enter your bank balance on the Wallets tab first.</div>`;
  let h = `<h1 class="page-title">Refresh</h1><p class="page-lede">Match the app with your real bank balance.</p>`;

  if (S.pending.length) {
    h += `<div class="block"><h2>Payments to confirm</h2><div class="list">`;
    for (const p of S.pending) h += `<div class="row"><span class="grow"><span class="name">${money(p.amt)} to ${esc(p.who)}</span><span class="muted small">From ${esc(wName(p.wallet))}</span></span>
      <button class="btn sm" data-act="pendPaid" data-id="${p.id}">Paid</button><button class="btn sm" data-act="pendDrop" data-id="${p.id}">Not paid</button></div>`;
    h += `</div></div>`;
  }

  h += `<div class="block"><h2>Bank balance right now</h2>
    <label class="field"><input class="big num" id="rf-bal" inputmode="decimal" autocomplete="off" placeholder="0" aria-label="Bank balance right now"></label>
    <p class="hint">The app expects ${money(S.bank)}. Last checked ${ago(S.lastRefresh)}.</p>
    <p class="err" id="rf-err" hidden></p>
    <button class="btn primary wide" data-act="rfCheck">Check balance</button></div>`;

  if (S.gap !== 0) {
    const out = S.gap < 0;
    h += `<div class="notice"><span><b>${money(Math.abs(S.gap))}</b> ${out ? 'left your account' : 'came into your account'} that the app doesn't know about. Add what happened and pick a wallet for each.</span></div>
      <div class="actions"><button class="btn primary" data-act="sheetAddTx" data-live="0" data-type="${out ? 'debit' : 'credit'}">Add a transaction</button><button class="btn" data-act="sheetImport">Read a screenshot</button></div>
      <div class="actions"><button class="btn wide" data-act="rfLeave">Leave the rest in Unallocated</button></div>`;
  } else if (S.lastRefresh) {
    h += `<div class="empty"><strong>Everything is accounted for</strong>Wallets and Unallocated add up to your bank balance.</div>
      <div class="actions"><button class="btn" data-act="sheetImport">Read a screenshot</button></div>`;
  }
  return h;
}

function viewHistory() {
  let h = `<h1 class="page-title">History</h1>`;
  if (!S.tx.length) return h + `<div class="empty"><strong>Nothing here yet</strong>Payments, credits and money you move between wallets will show up here.</div>`;
  h += `<div class="chips"><button class="chip" data-act="histFilter" data-id="all" aria-pressed="${historyFilter === 'all'}">All</button>`;
  for (const w of S.wallets) h += `<button class="chip" data-act="histFilter" data-id="${w.id}" aria-pressed="${historyFilter === w.id}">${esc(w.name)}</button>`;
  h += `</div>`;
  const list = S.tx.filter(t => historyFilter === 'all' || t.wallet === historyFilter || t.from === historyFilter || t.to === historyFilter);
  if (!list.length) return h + `<div class="empty">Nothing recorded for this wallet.</div>`;
  let day = '';
  for (const t of list) {
    const d = dayLabel(t.ts);
    if (d !== day) { if (day) h += `</div></div>`; h += `<div class="day">${d}</div><div class="block" style="padding-top:0"><div class="list">`; day = d; }
    h += txRow(t);
  }
  return h + `</div></div>`;
}
function txRow(t) {
  let title, sub, amt, cls = '', tabEl;
  if (t.type === 'move') {
    title = `${wName(t.from)} to ${wName(t.to)}`; sub = 'Moved inside the app'; amt = money(t.amt); tabEl = colorTab(t.to);
  } else if (t.type === 'adjust') {
    title = 'Bank balance updated'; sub = 'From Refresh'; amt = (t.amt > 0 ? '+' : '') + money(t.amt); cls = t.amt > 0 ? 'good' : 'bad'; tabEl = colorTab(null);
  } else {
    const credit = t.type === 'credit';
    title = t.who || t.note || (credit ? 'Money received' : 'Payment');
    sub = wName(t.wallet) + (t.who && t.note ? ', ' + t.note : '');
    amt = (credit ? '+' : '−') + money(t.amt).replace('−', ''); cls = credit ? 'good' : ''; tabEl = colorTab(t.wallet);
  }
  return `<button class="row" data-act="sheetTx" data-id="${t.id}">${tabEl}<span class="grow"><span class="name">${esc(title)}</span><span class="muted small">${esc(sub)}</span></span><span class="amt num ${cls}">${amt}</span></button>`;
}

/* ===== 4. Sheets (pop-up forms) ===== */
function openSheet(html) { $('#sheet-body').innerHTML = html; $('#sheet').hidden = false; const f = $('#sheet-body [autofocus]'); if (f) setTimeout(() => f.focus(), 60); }
function closeSheet() { $('#sheet').hidden = true; $('#sheet-body').innerHTML = ''; }
const sheetErr = msg => { const e = $('#sheet-body .err'); if (e) { e.textContent = msg; e.hidden = false; } };

const sheets = {
  sheetStart() {
    openSheet(`<h3>Your bank balance</h3><p class="lede">Type what your bank app shows right now.</p>
      <label class="field"><span>Balance (₹)</span><input class="big num" id="f-amt" inputmode="decimal" autocomplete="off" placeholder="0" autofocus></label>
      <p class="err" hidden></p><button class="btn primary wide" data-act="doStart">Save balance</button>`);
  },
  sheetNewWallet() {
    const c = COLORS[S.wallets.length % COLORS.length];
    openSheet(`<h3>New wallet</h3><p class="lede">You can put money in it now or later.</p>
      <label class="field"><span>Name</span><input id="f-name" maxlength="24" placeholder="Rent, Food, Savings" autofocus></label>
      <label class="field"><span>Start with (₹), taken from Unallocated (${money(unallocated())})</span><input class="num" id="f-amt" inputmode="decimal" autocomplete="off" placeholder="0"></label>
      ${swatches(c)}<p class="err" hidden></p><button class="btn primary wide" data-act="doNewWallet">Create wallet</button>`);
  },
  sheetWallet(d) {
    const w = wallet(d.id); if (!w) return;
    const recent = S.tx.filter(t => t.wallet === w.id || t.from === w.id || t.to === w.id).slice(0, 5);
    openSheet(`<h3>${esc(w.name)}</h3><p class="lede num">${money(w.bal)} in this wallet</p>
      <div class="btn-row" style="margin-bottom:10px"><button class="btn primary" data-act="sheetMove" data-to="${w.id}">Add money</button><button class="btn" data-act="sheetMove" data-from="${w.id}">Move out</button></div>
      <div class="btn-row" style="margin-bottom:16px"><button class="btn" data-act="sheetEditWallet" data-id="${w.id}">Rename</button><button class="btn danger" data-act="sheetDeleteWallet" data-id="${w.id}">Delete</button></div>
      ${recent.length ? `<div class="list">${recent.map(txRow).join('')}</div>` : `<p class="muted">No activity in this wallet yet.</p>`}`);
  },
  sheetDivide() {
    if (!S.wallets.length) return sheets.sheetNewWallet();
    sheets.sheetMove({ from: '' });
  },
  sheetMove(d) {
    const from = d.from ?? '', to = d.to ?? '';
    const hasFrom = 'from' in d, hasTo = 'to' in d;
    openSheet(`<h3>Move money</h3><p class="lede">This only changes the split inside the app. Your bank balance stays the same.</p>
      <label class="field"><span>From</span><select id="f-from">${walletOptions(hasFrom ? from : (hasTo ? '' : null))}</select></label>
      <label class="field"><span>To</span><select id="f-to">${walletOptions(hasTo ? to : firstOther(from))}</select></label>
      <label class="field"><span>Amount (₹)</span><input class="big num" id="f-amt" inputmode="decimal" autocomplete="off" placeholder="0" autofocus></label>
      <p class="err" hidden></p><button class="btn primary wide" data-act="doMove">Move money</button>`);
    if (hasFrom) $('#f-from').value = from;
    if (hasTo) $('#f-to').value = to;
  },
  sheetEditWallet(d) {
    const w = wallet(d.id); if (!w) return;
    openSheet(`<h3>Rename wallet</h3><label class="field" style="margin-top:12px"><span>Name</span><input id="f-name" maxlength="24" value="${esc(w.name)}" autofocus></label>
      ${swatches(w.color)}<p class="err" hidden></p><button class="btn primary wide" data-act="doEditWallet" data-id="${w.id}">Save changes</button>`);
  },
  sheetDeleteWallet(d) {
    const w = wallet(d.id); if (!w) return;
    openSheet(`<h3>Delete ${esc(w.name)}?</h3><p class="lede">${w.bal ? `Its ${money(w.bal)} goes back to Unallocated. ` : ''}Past transactions stay in History.</p>
      <div class="btn-row"><button class="btn" data-act="closeSheet">Keep wallet</button><button class="btn danger" data-act="doDeleteWallet" data-id="${w.id}">Delete wallet</button></div>`);
  },
  sheetAddTx(d) {
    const live = d.live !== '0';
    const type = d.type || 'debit';
    openSheet(`<h3>Add a transaction</h3><p class="lede">${live ? 'For money that just moved. Your bank balance in the app changes too.' : 'Explain part of the difference found at Refresh.'}</p>
      <div class="seg" id="f-type" data-val="${type}"><button data-act="segPick" data-val="debit" aria-pressed="${type === 'debit'}">Money out</button><button data-act="segPick" data-val="credit" aria-pressed="${type === 'credit'}">Money in</button></div>
      <label class="field"><span>Amount (₹)</span><input class="big num" id="f-amt" inputmode="decimal" autocomplete="off" placeholder="0" autofocus></label>
      <label class="field"><span>Wallet</span><select id="f-wallet">${walletOptions(S.wallets[0] && S.wallets[0].id)}</select></label>
      <label class="field"><span>Who or what (optional)</span><input id="f-who" maxlength="40" placeholder="Shop, person, salary"></label>
      <p class="err" hidden></p><button class="btn primary wide" data-act="doAddTx" data-live="${live ? 1 : 0}">Add transaction</button>`);
  },
  sheetTx(d) {
    const t = S.tx.find(x => x.id === d.id); if (!t) return;
    const when = new Date(t.ts).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    let body;
    if (t.type === 'move') body = `<h3>${money(t.amt)} moved</h3><p class="lede">${esc(wName(t.from))} to ${esc(wName(t.to))}. ${when}</p>`;
    else if (t.type === 'adjust') body = `<h3>Bank balance updated</h3><p class="lede">Refresh found a change of ${money(t.amt)}. ${when}</p>`;
    else body = `<h3>${t.type === 'credit' ? '+' : '−'}${money(t.amt)}</h3><p class="lede">${esc(t.who || (t.type === 'credit' ? 'Money received' : 'Payment'))}${t.note ? ', ' + esc(t.note) : ''}. ${when}</p>
      <label class="field"><span>Wallet</span><select id="f-wallet" data-change="doReassign" data-id="${t.id}">${walletOptions(t.wallet, { balances: false })}</select></label>`;
    openSheet(body + `<div class="btn-row"><button class="btn" data-act="closeSheet">Close</button><button class="btn danger" data-act="doDeleteTx" data-id="${t.id}">Delete and undo</button></div>`);
    if ($('#f-wallet')) $('#f-wallet').value = t.wallet || '';
  },
  sheetConfirm(d) {
    const p = S.pending.find(x => x.id === d.id); if (!p) return;
    openSheet(`<h3>Did the payment go through?</h3><p class="lede">${money(p.amt)} to ${esc(p.who)}, from ${esc(wName(p.wallet))}.</p>
      <div class="btn-row" style="margin-bottom:10px"><button class="btn primary" data-act="pendPaid" data-id="${p.id}">Paid</button><button class="btn" data-act="pendDrop" data-id="${p.id}">Not paid</button></div>
      <button class="btn wide" data-act="closeSheet">Decide later</button>
      <p class="hint" style="margin-top:12px">If no UPI app opened, that app may not be installed. Choose "Not paid" and try another.</p>`);
  },
  sheetUpiId() {
    openSheet(`<h3>Pay a UPI ID</h3><label class="field" style="margin-top:12px"><span>UPI ID</span><input id="f-pa" inputmode="email" autocapitalize="none" autocomplete="off" placeholder="name@okbank" autofocus></label>
      <label class="field"><span>Name (optional)</span><input id="f-name" maxlength="40"></label>
      <p class="err" hidden></p><button class="btn primary wide" data-act="doUpiId">Continue</button>`);
  },
  sheetPhone() {
    openSheet(`<h3>Pay a phone number</h3><p class="lede">UPI apps don't accept a phone number from other apps, so this picks the wallet here and you paste the number in your UPI app.</p>
      <label class="field"><span>10-digit mobile number</span><input id="f-phone" inputmode="tel" maxlength="20" autocomplete="off" autofocus></label>
      <label class="field"><span>Name (optional)</span><input id="f-name" maxlength="40"></label>
      <p class="err" hidden></p><button class="btn primary wide" data-act="doPhone">Continue</button>`);
  },
  sheetImport() { openImport(); },
  sheetSettings() { openSettings(); },
};
const firstOther = id => { const w = S.wallets.find(x => x.id !== id); return w ? w.id : ''; };
const swatches = sel => `<div class="swatches" id="f-color" data-val="${sel}">${COLORS.map(c => `<button data-act="colorPick" data-val="${c}" aria-pressed="${c === sel}" style="background:${c}" aria-label="Colour"></button>`).join('')}</div>`;

/* What the sheet buttons do */
const actions = {
  closeSheet,
  segPick(d, el) { const seg = el.parentElement; seg.dataset.val = d.val; seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b === el)); },
  colorPick(d, el) { actions.segPick(d, el); },

  doStart() {
    const a = parseAmt($('#f-amt').value, true);
    if (a == null) return sheetErr('Enter your balance as a number, like 25000.');
    S.started = true; S.bank = a; S.lastRefresh = Date.now(); S.gap = 0; save();
    closeSheet(); render(); sheets.sheetNewWallet();
  },
  doNewWallet() {
    const name = $('#f-name').value.trim();
    if (!name) return sheetErr('Give the wallet a name.');
    const raw = $('#f-amt').value.trim();
    const a = raw === '' ? 0 : parseAmt(raw, true);
    if (a == null) return sheetErr('Enter the starting amount as a number.');
    if (a > Math.max(unallocated(), 0)) return sheetErr(`Only ${money(Math.max(unallocated(), 0))} is unallocated.`);
    const w = { id: uid(), name, color: $('#f-color').dataset.val, bal: 0 };
    S.wallets.push(w); save();
    if (a > 0) moveMoney(null, w.id, a);
    closeSheet(); render(); toast(`${name} created`);
  },
  doEditWallet(d) {
    const w = wallet(d.id), name = $('#f-name').value.trim();
    if (!name) return sheetErr('Give the wallet a name.');
    w.name = name; w.color = $('#f-color').dataset.val; save(); closeSheet(); render();
  },
  doDeleteWallet(d) {
    S.wallets = S.wallets.filter(w => w.id !== d.id);
    if (historyFilter === d.id) historyFilter = 'all';
    save(); closeSheet(); render(); toast('Wallet deleted');
  },
  doMove() {
    const from = $('#f-from').value, to = $('#f-to').value, a = parseAmt($('#f-amt').value);
    if (from === to) return sheetErr('Choose two different places.');
    if (a == null) return sheetErr('Enter an amount greater than zero.');
    const have = from ? wallet(from).bal : unallocated();
    if (a > have) return sheetErr(`${wName(from)} only has ${money(Math.max(have, 0))}.`);
    moveMoney(from || null, to || null, a);
    closeSheet(); render(); toast(`${money(a)} moved to ${wName(to)}`);
  },
  doAddTx(d) {
    const a = parseAmt($('#f-amt').value);
    if (a == null) return sheetErr('Enter an amount greater than zero.');
    const type = $('#f-type').dataset.val, live = d.live === '1';
    addTx({ type, amt: a, walletId: $('#f-wallet').value || null, who: $('#f-who').value.trim(), src: live ? 'manual' : 'refresh', live });
    closeSheet(); render(); toast('Transaction added');
  },
  doDeleteTx(d) { deleteTx(d.id); closeSheet(); render(); toast('Deleted and undone'); },
  doReassign(d, el) { reassignTx(d.id, el.value || null); render(); toast(`Moved to ${wName(el.value)}`); },

  /* --- Pay tab --- */
  payScan() { pay = { step: 'scan' }; render(); },
  payPickImage() { $('#qr-file').click(); },
  payUpiId() { sheets.sheetUpiId(); },
  payPhone() { sheets.sheetPhone(); },
  payCancel() { pay = null; render(); },
  doUpiId() {
    const pa = $('#f-pa').value.trim();
    if (!/^[\w.\-]{2,}@[a-zA-Z][\w.\-]*$/.test(pa)) return sheetErr('That does not look like a UPI ID. It should look like name@okbank.');
    startPay({ pa, name: $('#f-name').value.trim() });
    closeSheet();
  },
  doPhone() {
    const ph = $('#f-phone').value.replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    if (!/^[6-9]\d{9}$/.test(ph)) return sheetErr('Enter a 10-digit Indian mobile number.');
    startPay({ phone: ph, name: $('#f-name').value.trim() });
    closeSheet();
  },
  payPickWallet(d) { pay.walletId = d.id; refreshPayPanel(); },
  payGo(d) { launchPayment(d.app); },

  /* --- pending payments --- */
  pendPaid(d) {
    const p = S.pending.find(x => x.id === d.id); if (!p) return;
    S.pending = S.pending.filter(x => x.id !== d.id);
    addTx({ type: 'debit', amt: p.amt, walletId: p.wallet, who: p.who, note: p.note, src: 'pay', live: true });
    closeSheet(); render(); toast(`${money(p.amt)} taken from ${wName(p.wallet)}`);
  },
  pendDrop(d) { S.pending = S.pending.filter(x => x.id !== d.id); save(); closeSheet(); render(); toast('Nothing was deducted'); },
  confirmNext() { if (S.pending[0]) sheets.sheetConfirm({ id: S.pending[0].id }); },

  /* --- Refresh tab --- */
  goRefresh() { tab = 'refresh'; render(); },
  rfCheck() {
    const a = parseAmt($('#rf-bal').value, true), err = $('#rf-err');
    if (a == null) { err.textContent = 'Type the balance your bank shows, like 18250.'; err.hidden = false; return; }
    const diff = setBank(a);
    render();
    toast(diff === 0 ? 'Balance matches' : `${money(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} than expected`);
  },
  rfLeave() { S.gap = 0; save(); render(); toast('Left in Unallocated'); },

  histFilter(d) { historyFilter = d.id; render(); },
};

/* ===== 5. UPI + QR ===== */
/* Reads a UPI QR's text. Returns { pa, name, am, raw } or null if it is not a UPI payment code. */
function parseUpi(text) {
  const m = /^upi:\/\/pay\/?\?(.+)$/i.exec(String(text || '').trim());
  if (!m) return null;
  const q = {};
  for (const part of m[1].split('&')) {
    const i = part.indexOf('=');
    const k = (i < 0 ? part : part.slice(0, i)).toLowerCase();
    let v = i < 0 ? '' : part.slice(i + 1);
    try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { /* keep raw */ }
    q[k] = v;
  }
  if (!q.pa) return null;
  const am = Number(q.am);
  return { pa: q.pa, name: q.pn || '', am: isFinite(am) && am > 0 ? am : null, raw: m[1] };
}

/* Builds the query string handed to the UPI app.
   A scanned code is passed on untouched (merchant codes are signed, so changing them makes apps reject the payment);
   the amount is only added when the code did not carry one. */
function upiQuery(p, amtPaise) {
  const amt = (amtPaise / 100).toFixed(2);
  if (p.raw) {
    if (/(^|&)am=/i.test(p.raw)) return p.rawAmChanged ? p.raw.replace(/(^|&)am=[^&]*/i, `$1am=${amt}`) : p.raw;
    return p.raw + `&am=${amt}` + (/(^|&)cu=/i.test(p.raw) ? '' : '&cu=INR');
  }
  const e = encodeURIComponent;
  return `pa=${e(p.pa).replace(/%40/g, "@")}` + (p.name ? `&pn=${e(p.name)}` : '') + `&am=${amt}&cu=INR` + (p.note ? `&tn=${e(p.note)}` : '');
}
function upiLink(appId, query) {
  const app = UPI_APPS.find(a => a.id === appId);
  return app ? `intent://pay?${query}#Intent;scheme=upi;package=${app.pkg};end` : `upi://pay?${query}`;
}
const appOpenLink = appId => { const a = UPI_APPS.find(x => x.id === appId); return `intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${a.pkg};end`; };

function startPay(p) {
  pay = { step: 'details', pa: p.pa || '', phone: p.phone || '', name: p.name || '', raw: p.raw || '',
          amtText: p.am ? String(p.am) : '', qrAm: p.am || null, note: '', walletId: S.wallets.length === 1 ? S.wallets[0].id : null };
  tab = 'pay'; render();
}
function refreshPayPanel() {
  const amt = parseAmt(pay.amtText);
  $('#pay-wallets').innerHTML = payWalletRows(amt);
  $('#pay-next').innerHTML = payNext(amt);
}
function launchPayment(appId) {
  const amt = parseAmt(pay.amtText), w = wallet(pay.walletId);
  if (amt == null || !w) return;
  pay.note = $('#pay-note').value.trim();
  pay.rawAmChanged = pay.qrAm != null && Math.round(pay.qrAm * 100) !== amt;
  const p = { id: uid(), ts: Date.now(), amt, wallet: w.id, who: pay.name || pay.pa || pay.phone, note: pay.note };
  S.pending.unshift(p); save();
  let url;
  if (pay.phone) {
    if (navigator.clipboard) navigator.clipboard.writeText(pay.phone).catch(() => {});
    url = appOpenLink(appId);
  } else {
    url = upiLink(appId, upiQuery(pay, amt));
  }
  window.__lastUpiLink = url;           // handy when testing
  pay = null; tab = 'home'; render();
  sheets.sheetConfirm({ id: p.id });    // waiting for you when you come back from the UPI app
  if (!window.__noLaunch) window.location.href = url;
}

/* --- QR scanning --- */
function decodeCanvas(cv) {
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const r = window.jsQR ? jsQR(img.data, img.width, img.height) : null;
  return r && r.data ? r.data : null;
}
async function startScan() {
  const err = $('#scan-err');
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nocam');
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const video = $('#cam'); if (!video) return stopScan();
    video.srcObject = scanStream; await video.play();
    const cv = document.createElement('canvas');
    const tick = () => {
      if (!scanStream || !pay || pay.step !== 'scan') return;
      if (video.videoWidth) {
        const s = Math.min(640 / video.videoWidth, 1);
        cv.width = Math.round(video.videoWidth * s); cv.height = Math.round(video.videoHeight * s);
        cv.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, cv.width, cv.height);
        const text = decodeCanvas(cv);
        if (text) {
          const p = parseUpi(text);
          if (p) { stopScan(); return startPay(p); }
          err.textContent = 'That code is not a UPI payment code.'; err.hidden = false;
        }
      }
      setTimeout(tick, 180);
    };
    tick();
  } catch (e) {
    if (err) { err.textContent = 'The camera could not be opened. Allow camera access for this app, or use "QR from a photo".'; err.hidden = false; }
  }
}
function stopScan() { if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; } }

function fileToCanvas(file, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(maxSide / Math.max(img.width, img.height), 1);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url); resolve(cv);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be opened as an image.')); };
    img.src = url;
  });
}
async function qrFromFile(file) {
  try {
    let text = null;
    for (const side of [1000, 1600, 600]) { text = decodeCanvas(await fileToCanvas(file, side)); if (text) break; }
    if (!text) return toast('No QR code found in that image');
    const p = parseUpi(text);
    if (!p) return toast('That code is not a UPI payment code');
    startPay(p);
  } catch (e) { toast(e.message); }
}

/* ===== 6. Screenshot reader (Gemini) ===== */
const IMPORT_PROMPT = `These images are screenshots of an Indian bank passbook, bank statement, or a UPI app's transaction history.
List every completed money transaction you can read. Ignore failed, pending or declined ones, and ignore balance lines.
Reply with only a JSON array. Each item: {"date":"YYYY-MM-DD","amount":number in rupees,"type":"debit" or "credit","party":"who it was paid to or received from"}.
"debit" means money left the account holder's account; "credit" means money came in. If the year is not shown, use ${new Date().getFullYear()}. If nothing is readable, reply [].`;

async function readScreenshots(files) {
  const parts = [{ text: IMPORT_PROMPT }];
  for (const f of files) {
    const cv = await fileToCanvas(f, 1600);
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: cv.toDataURL('image/jpeg', 0.85).split(',')[1] } });
  }
  const model = (S.settings.geminiModel || 'gemini-flash-latest').trim();
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.settings.geminiKey.trim() },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Gemini replied with error ${r.status}.`);
  const text = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(p => p.text || '').join('');
  let arr;
  try { arr = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch (e) { throw new Error('Gemini sent back something that was not a list of transactions. Try again.'); }
  if (!Array.isArray(arr)) arr = arr && Array.isArray(arr.transactions) ? arr.transactions : [];
  return arr.map(x => {
    const amt = parseAmt(String(Math.abs(Number(x.amount))));
    const ts = Date.parse(x.date);
    return amt == null ? null : { amt, type: String(x.type).toLowerCase() === 'credit' ? 'credit' : 'debit', who: String(x.party || '').slice(0, 40), ts: isFinite(ts) ? ts + 12 * 3600e3 : Date.now() };
  }).filter(Boolean);
}
/* True when the app already has a transaction with the same amount and direction within a day. */
const alreadyRecorded = it => S.tx.some(t => t.type === it.type && t.amt === it.amt && Math.abs(t.ts - it.ts) < 36 * 3600e3);

let importItems = [];
function openImport() {
  if (!S.settings.geminiKey.trim()) {
    return openSheet(`<h3>Read a screenshot</h3><p class="lede">This uses Google's Gemini to read transactions from a screenshot of your UPI app or e-passbook. It needs a free API key first.</p>
      <button class="btn primary wide" data-act="sheetSettings">Add the key in Settings</button>`);
  }
  openSheet(`<h3>Read a screenshot</h3><p class="lede">Pick screenshots of your UPI app history or e-passbook. They are sent to Google Gemini to be read.</p>
    <label class="field"><span>Screenshots</span><input type="file" id="imp-files" accept="image/*" multiple></label>
    <p class="err" hidden></p><button class="btn primary wide" data-act="doImportRead">Read transactions</button>`);
}
actions.doImportRead = async (d, el) => {
  const files = [...$('#imp-files').files];
  if (!files.length) return sheetErr('Pick at least one screenshot.');
  el.disabled = true; el.textContent = 'Reading…';
  try {
    importItems = await readScreenshots(files);
    showImportList();
  } catch (e) { el.disabled = false; el.textContent = 'Read transactions'; sheetErr(e.message || 'Could not reach Gemini. Check your internet connection.'); }
};
function showImportList() {
  if (!importItems.length) return openSheet(`<h3>No transactions found</h3><p class="lede">Nothing readable in those screenshots. Try a clearer one, or add the transactions by hand.</p><button class="btn wide" data-act="closeSheet">Close</button>`);
  const first = S.wallets[0] ? S.wallets[0].id : '';
  let h = `<h3>${importItems.length} transaction${importItems.length > 1 ? 's' : ''} found</h3><p class="lede">Tick the ones to add and pick a wallet for each. These are already part of your bank balance, so only the wallets change.</p>`;
  importItems.forEach((it, i) => {
    const dup = alreadyRecorded(it);
    h += `<div class="imp"><div class="imp-head"><input type="checkbox" class="check" id="imp-c${i}" ${dup ? '' : 'checked'} aria-label="Add this transaction">
      <span class="grow"><b>${esc(it.who || (it.type === 'credit' ? 'Money received' : 'Payment'))}</b><br><span class="muted small">${new Date(it.ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}${dup ? ', looks already recorded' : ''}</span></span>
      <b class="num ${it.type === 'credit' ? 'good' : ''}">${it.type === 'credit' ? '+' : '−'}${money(it.amt)}</b></div>
      <select id="imp-w${i}" aria-label="Wallet">${walletOptions(it.type === 'credit' ? '' : first, { balances: false })}</select></div>`;
  });
  openSheet(h + `<button class="btn primary wide" data-act="doImportAdd" style="margin-top:8px">Add ticked transactions</button>`);
  importItems.forEach((it, i) => { if (it.type === 'credit') $('#imp-w' + i).value = ''; });
}
actions.doImportAdd = () => {
  let n = 0;
  importItems.forEach((it, i) => {
    if (!$('#imp-c' + i).checked) return;
    addTx({ type: it.type, amt: it.amt, walletId: $('#imp-w' + i).value || null, who: it.who, src: 'import', live: false, ts: it.ts });
    n++;
  });
  S.tx.sort((a, b) => b.ts - a.ts); save();
  importItems = []; closeSheet(); render(); toast(`${n} transaction${n === 1 ? '' : 's'} added`);
};

/* ===== 7. Settings + backup ===== */
function openSettings() {
  openSheet(`<h3>Settings</h3>
    <h2 class="muted" style="font-size:15px;margin:14px 0 8px">Screenshot reading</h2>
    <label class="field"><span>Gemini API key (free from aistudio.google.com)</span><input id="s-key" type="password" autocomplete="off" value="${esc(S.settings.geminiKey)}"></label>
    <label class="field"><span>Gemini model</span><input id="s-model" autocapitalize="none" autocomplete="off" value="${esc(S.settings.geminiModel)}"></label>
    <p class="hint">The key stays on this phone. Screenshots you choose to read are sent to Google.</p>
    <button class="btn primary wide" data-act="doSaveSettings">Save settings</button>
    <h2 class="muted" style="font-size:15px;margin:22px 0 8px">Your data</h2>
    <p class="hint" style="margin-top:0">Everything is stored only on this phone. Save a backup file now and then.</p>
    <div class="btn-row" style="margin-bottom:10px"><button class="btn" data-act="doExport">Save backup</button><button class="btn" data-act="doImportBackup">Restore backup</button></div>
    <button class="btn danger wide" data-act="sheetErase">Erase everything</button>
    <input type="file" id="s-file" accept="application/json,.json" hidden>`);
}
Object.assign(actions, {
  doSaveSettings() { S.settings.geminiKey = $('#s-key').value.trim(); S.settings.geminiModel = $('#s-model').value.trim() || 'gemini-flash-latest'; save(); closeSheet(); toast('Settings saved'); },
  doExport() {
    const copy = JSON.parse(JSON.stringify(S)); copy.settings.geminiKey = '';   // never put the key in a backup file
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' }));
    a.download = `wallets-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Backup saved to Downloads');
  },
  doImportBackup() { $('#s-file').click(); },
  sheetErase() {
    openSheet(`<h3>Erase everything?</h3><p class="lede">All wallets and history on this phone will be removed. Your bank account is not affected.</p>
      <div class="btn-row"><button class="btn" data-act="closeSheet">Keep my data</button><button class="btn danger" data-act="doErase">Erase everything</button></div>`);
  },
  doErase() { const key = S.settings; S = blank(); S.settings = key; save(); pay = null; tab = 'home'; closeSheet(); render(); },
});
async function restoreBackup(file) {
  try {
    const d = JSON.parse(await file.text());
    if (!d || d.v !== 1 || !Array.isArray(d.wallets) || !Array.isArray(d.tx) || typeof d.bank !== 'number') throw new Error('bad');
    const key = S.settings.geminiKey;
    S = Object.assign(blank(), d); S.settings = Object.assign(blank().settings, d.settings); S.settings.geminiKey = key;
    save(); closeSheet(); tab = 'home'; render(); toast('Backup restored');
  } catch (e) { toast('That file is not a Wallets backup'); }
}

/* ===== 8. Wiring ===== */
document.addEventListener('click', e => {
  const go = e.target.closest('[data-tab],[data-tabgo]');
  if (go) { tab = go.dataset.tab || go.dataset.tabgo; if (tab !== 'pay') pay = null; return render(); }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const name = el.dataset.act, fn = sheets[name] || actions[name];
  if (fn) fn(el.dataset, el);
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'qr-file' && t.files[0]) qrFromFile(t.files[0]);
  if (t.id === 's-file' && t.files[0]) restoreBackup(t.files[0]);
  if (t.dataset.change && actions[t.dataset.change]) actions[t.dataset.change](t.dataset, t);
});
document.addEventListener('input', e => {
  if (e.target.id === 'pay-amt' && pay) { pay.amtText = e.target.value; refreshPayPanel(); }
  if (e.target.id === 'pay-note' && pay) pay.note = e.target.value;
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopScan(); });

load();
render();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

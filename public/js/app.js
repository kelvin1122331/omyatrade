/* ============================================================
   OMYA TRADE — Terminal application
   Live feed · market watch · depth · charts · trading
   ============================================================ */
'use strict';

import { CandleChart } from './chart.js';
import { initAdmin, refresh as refreshAdmin } from './admin.js';

/* ---------------- helpers ---------------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* ---------- money formatting (IDR / USD display) ---------- */
const RATE_FALLBACK = 16245;
const fmtIDR = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const fmtUSD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function idrRate() { const p = S.prices['USDIDR']; return p ? (p.b + p.a) / 2 : RATE_FALLBACK; }
function acctCur() { return S.account?.currency || 'IDR'; }
function toDisp(vAcct) {
  if (S.dispCur === acctCur()) return vAcct;
  return acctCur() === 'IDR' ? vAcct / idrRate() : vAcct * idrRate();
}
function fmtMoney(vAcct) {
  const v = toDisp(vAcct);
  return S.dispCur === 'IDR' ? fmtIDR.format(v) : fmtUSD.format(v);
}
function fmtPL(vAcct) {
  const s = fmtMoney(Math.abs(vAcct));
  return vAcct > 0 ? '+' + s : vAcct < 0 ? '-' + s : s;
}
const p2 = n => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDT(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
const getToken = () => localStorage.getItem('ot.token');
function clearAuth() { localStorage.removeItem('ot.token'); localStorage.removeItem('ot.user'); }
async function api(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = getToken();
  if (tok) headers['Authorization'] = 'Bearer ' + tok;
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    clearAuth();
    showLogin();
    throw new Error('Session expired');
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(j.error || 'Request failed');
  return j;
}

/* ---------------- state ---------------- */
const S = {
  symbols: {},           // specs by name
  symList: [],
  prices: {},            // {sym: {b,a}}
  prevDay: {},           // prev daily close per sym
  account: null,
  deals: [],
  cur: localStorage.getItem('ot.sym') || 'EURUSD',
  tf: localStorage.getItem('ot.tf') || 'M15',
  ctype: localStorage.getItem('ot.ctype') || 'candles',
  lots: localStorage.getItem('ot.lots') || '0.10',
  dispCur: localStorage.getItem('ot.dispcur') || 'IDR',
  sound: localStorage.getItem('ot.sound') !== '0',
  oct: localStorage.getItem('ot.oct') !== '0',
  connected: false,
  m1: new Map(),         // sym -> bars[]
  spark: new Map(),      // sym -> {arr:[last bids]}
  tfHist: new Map(),     // sym|tf -> bars[] (server history, tf >= H1)
  disp: null,            // current display bars for chart
  dispKey: '',
  lastBarBySym: new Map(),
  bootedAt: performance.now(),
};
const TFS = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
const TFS_LIST = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

/* ---------------- sounds ---------------- */
let AC = null;
document.addEventListener('pointerdown', () => { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } }, { once: true });
function beep(seq, type = 'sine', vol = 0.05) {
  if (!S.sound || !AC) return;
  let t = AC.currentTime;
  for (const [f, d] of seq) {
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(AC.destination);
    o.start(t); o.stop(t + d + 0.05);
    t += d * 0.7;
  }
}
const sfx = {
  exec: () => beep([[740, .09], [1180, .14]]),
  close: () => beep([[520, .12]]),
  tp: () => beep([[880, .08], [1175, .08], [1568, .18]]),
  sl: () => beep([[440, .16], [330, .22]], 'triangle'),
  alert: () => beep([[660, .07], [660, .07], [660, .1]], 'square', .035),
  err: () => beep([[240, .18]], 'sawtooth', .04),
};

/* ---------------- toasts ---------------- */
function toast(kind, title, msg, ms = 4200) {
  const box = $('#toasts');
  const icons = {
    ok: '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    err: '<svg viewBox="0 0 24 24"><path d="M12 8v6m0 4h.01M12 3l9.5 17h-19L12 3z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 11v5m0-8h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    gold: '<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.3.9-4.5 4.3 1 6.2-5.5-3-5.5 3 1-6.2L3 9.5l6.3-.9L12 3z" fill="currentColor"/></svg>',
  };
  const t = el('div', `toast ${kind}`, `
    <div class="t-ico">${icons[kind] || icons.info}</div>
    <div><div class="t-title">${title}</div>${msg ? `<div class="t-msg">${msg}</div>` : ''}</div>
    <button class="t-x">×</button>`);
  t.querySelector('.t-x').onclick = () => kill();
  box.appendChild(t);
  const kill = () => { t.classList.add('out'); setTimeout(() => t.remove(), 260); };
  setTimeout(kill, ms);
  while (box.children.length > 4) box.firstChild.remove();
}

/* ---------------- formatting per symbol ---------------- */
const spec = sym => S.symbols[sym];
const px = sym => { const s = S.prices[sym]; return s || { b: 0, a: 0 }; };
const fpx = (sym, v) => v == null ? '—' : Number(v).toFixed(spec(sym)?.digits ?? 5);
function pipDiff(sym, a, b) { const sp = spec(sym); return (a - b) / sp.pip; }
function baseToUSD(sym) {
  const sp = spec(sym);
  switch (sp.base) {
    case 'USD': return 1;
    case 'EUR': return px('EURUSD').b || 1.08;
    case 'GBP': return px('GBPUSD').b || 1.27;
    case 'AUD': return px('AUDUSD').b || 0.66;
    case 'NZD': return px('NZDUSD').b || 0.61;
    case 'JPY': return 1 / (px('USDJPY').b || 150);
    case 'CHF': return 1 / (px('USDCHF').b || 0.88);
    case 'CAD': return 1 / (px('USDCAD').b || 1.36);
    default: return px(sym).b || 1;
  }
}
const marginReq = (sym, lots) => spec(sym).contract * lots * baseToUSD(sym) / (S.account?.leverage || 100);

function showLogin() {
  $('#app').classList.add('hidden');
  const b = $('#boot');
  if (b) { b.classList.add('done'); setTimeout(() => b.remove(), 600); }
  $('#login').classList.remove('hidden');
  $('#login-btn').disabled = false;
  clearTimeout(esTimer);
  try { es && es.close(); } catch (e) {}
  es = null;
  S.connected = false;
}

/* ============================================================
   FEED
   ============================================================ */
let es = null, esTimer = null;
function connectFeed() {
  es = new EventSource('/api/stream?token=' + encodeURIComponent(getToken() || ''));
  es.addEventListener('tick', e => {
    const { t, ticks } = JSON.parse(e.data);
    if (!S.connected) setConn(true);
    for (const tk of ticks) {
      const prev = S.prices[tk.s];
      S.prices[tk.s] = { b: tk.b, a: tk.a };
      const dir = !prev || tk.b > prev.b ? 1 : tk.b < prev.b ? -1 : (prev.dir || 0);
      S.prices[tk.s].dir = dir;
      onTickFor(tk.s, tk, prev, t);
    }
    updateM1Tails();
    updateChartLive();
  });
  es.addEventListener('account', e => {
    S.account = JSON.parse(e.data);
    renderAccount();
    renderPositions();
    renderOrders();
    renderOverlays();
  });
  es.addEventListener('bar', e => {
    const { s, bar, closed } = JSON.parse(e.data);
    S.lastBarBySym.set(s, bar);
    const arr = S.m1.get(s);
    if (arr && arr.length) {
      const last = arr[arr.length - 1];
      if (closed && last.t === closed.t) arr[arr.length - 1] = closed;
      else if (closed && closed.t > last.t) { arr.push(closed); if (arr.length > 20000) arr.splice(0, 2000); }
      if (bar.t > arr[arr.length - 1].t) arr.push({ ...bar });
      if (s === S.cur) rebuildDispTail();
    }
  });
  es.addEventListener('deal', e => onDeal(JSON.parse(e.data)));
  es.addEventListener('admin', () => { try { refreshAdmin(); } catch (x) {} });
  es.onopen = () => { if (!S.connected) setConn(true); };
  es.onerror = () => {
    setConn(false);
    clearTimeout(esTimer);
    esTimer = setTimeout(() => { try { es.close(); } catch (x) {} connectFeed(); }, 2500);
  };
}
function setConn(on) {
  S.connected = on;
  $('#srv-chip').classList.toggle('off', !on);
  $('#conn-badge').classList.toggle('off', !on);
  $('#conn-badge').lastChild.textContent = on ? 'LIVE' : 'RECONNECTING';
}

/* ---------------- deals / notifications ---------------- */
/* ---------------- client-side P/L (tick-smooth) ---------------- */
function quoteToUSDC(sym) {
  switch (spec(sym).quote) {
    case 'USD': return 1;
    case 'JPY': return 1 / (px('USDJPY').b || 150);
    case 'CHF': return 1 / (px('USDCHF').b || 0.88);
    case 'CAD': return 1 / (px('USDCAD').b || 1.36);
    case 'EUR': return px('EURUSD').b || 1.08;
    default: return 1;
  }
}
function clientPL(p) {
  const sp = spec(p.symbol);
  const q = px(p.symbol);
  if (!q.b) return p.profit || 0;
  const cur = p.side === 'buy' ? q.b : q.a;
  const diff = (cur - p.openPrice) * (p.side === 'buy' ? 1 : -1);
  return diff * sp.contract * p.volume * quoteToUSDC(p.symbol);
}
function onTickFor(sym) {
  updateMW(sym);
  if (sym === S.cur) renderDepth();
  const a = S.account;
  if (a) {
    const rate = acctCur() === 'IDR' ? idrRate() : 1;
    let fl = 0;
    for (const p of a.positions) {
      p.profit = clientPL(p) * rate;
      fl += p.profit;
    }
    a.floating = fl;
    a.equity = a.balance + fl;
    patchPositions();
    patchOrders();
    const setM = (id, v) => { $(id).textContent = fmtMoney(v); };
    setM('#acct-equity', a.equity);
    setM('#sum-equity', a.equity);
    const fl1 = $('#acct-floating'), fl2 = $('#sum-floating');
    const txt = fmtPL(fl);
    fl1.textContent = txt; fl2.textContent = txt;
    fl1.className = fl > 0 ? 'pos' : fl < 0 ? 'neg' : '';
    fl2.className = fl > 0 ? 'pos' : fl < 0 ? 'neg' : '';
    if (a.positions.length && a.margin > 0) {
      const lvl = a.equity / a.margin * 100;
      const le = $('#sum-level');
      le.textContent = lvl.toFixed(1) + '%';
      le.className = lvl < 100 ? 'neg' : '';
    }
  }
  const q = px(sym);
  if (q.b) sparkPush(sym, q.b);
}
function onDeal(d) {
  const map = {
    executed: () => { sfx.exec(); toast('ok', 'Order executed', `${esc(d.side.toUpperCase())} ${d.volume.toFixed(2)} ${esc(d.symbol)} @ ${fpx(d.symbol, d.price)}<br>Ticket <b>#${d.ticket}</b>`); },
    closed: () => { sfx.close(); toast(d.profit >= 0 ? 'ok' : 'err', d.partial ? 'Partial close' : 'Position closed', `${esc(d.symbol)} ${d.volume.toFixed(2)} lots @ ${fpx(d.symbol, d.price)} · P/L <b style="color:${d.profit >= 0 ? 'var(--up)' : 'var(--down)'}">${fmtPL(d.profit)}</b>`); },
    closed_all: () => { sfx.close(); toast('info', 'All positions closed', `Net result <b>${fmtPL(d.profit)}</b>`); },
    tp_hit: () => { sfx.tp(); toast('ok', 'Take Profit triggered', `${esc(d.side.toUpperCase())} ${esc(d.symbol)} ${d.volume.toFixed(2)} @ ${fpx(d.symbol, d.price)} · <b style="color:var(--up)">${fmtPL(d.profit)}</b>`); },
    sl_hit: () => { sfx.sl(); toast('err', 'Stop Loss triggered', `${esc(d.side.toUpperCase())} ${esc(d.symbol)} ${d.volume.toFixed(2)} @ ${fpx(d.symbol, d.price)} · <b style="color:var(--down)">${fmtPL(d.profit)}</b>`); },
    stopout: () => { sfx.alert(); toast('err', 'Stop Out', `Margin level fell below 20%. Position <b>#${d.ticket}</b> ${esc(d.symbol)} closed with result <b>${fmtPL(d.profit)}</b>.`, 8000); },
    pending_filled: () => { sfx.exec(); toast('ok', 'Pending order activated', `${esc(d.side.toUpperCase())} ${esc(d.symbol)} ${d.volume.toFixed(2)} @ ${fpx(d.symbol, d.price)}<br>Ticket <b>#${d.ticket}</b>`); },
    placed: () => { toast('gold', 'Pending order placed', `${esc(d.type.toUpperCase())} ${esc(d.symbol)} ${d.volume.toFixed(2)} @ ${fpx(d.symbol, d.price)}<br>Ticket <b>#${d.ticket}</b>`); },
    cancelled: () => { toast('info', 'Order cancelled', `Ticket <b>#${d.ticket}</b>`); },
    modified: () => { toast('info', 'Order modified', `Ticket <b>#${d.ticket}</b>`); },
    rejected: () => { sfx.err(); toast('err', 'Order rejected', esc(d.message || 'Not enough money')); },
  };
  (map[d.type] || (() => {}))();
  if (d.type === 'closed' || d.type === 'closed_all' || d.type === 'tp_hit' || d.type === 'sl_hit' || d.type === 'stopout') refreshDeals();
}

/* ============================================================
   MARKET WATCH
   ============================================================ */
function buildMarketWatch() {
  const q = ($('#mw-search').value || '').toUpperCase();
  const groups = {};
  for (const s of S.symList) {
    if (q && !s.includes(q) && !S.symbols[s].disp.toUpperCase().includes(q)) continue;
    (groups[S.symbols[s].cat] = groups[S.symbols[s].cat] || []).push(s);
  }
  const wrap = $('#mw-groups');
  wrap.innerHTML = '';
  S.mwRefs = {};
  for (const [cat, list] of Object.entries(groups)) {
    wrap.appendChild(el('div', 'mw-cat', esc(cat)));
    for (const s of list) {
      const sp = S.symbols[s];
      const row = el('div', 'mw-row' + (s === S.cur ? ' active' : ''), `
        <div class="mw-id">
          <span class="mw-code">${s}</span>
          <span class="mw-name">${esc(sp.disp)}</span>
        </div>
        <canvas class="mw-spark" width="88" height="30" aria-hidden="true"></canvas>
        <div class="mw-quotes">
          <div class="mw-px"><span class="b">—</span><span class="a">—</span></div>
          <div class="mw-extra">
            <span class="mw-spread">—</span>
            <span class="mw-chg">—</span>
          </div>
        </div>`);
      row.onclick = () => { selectSymbol(s); mobileGo('chart'); };
      wrap.appendChild(row);
      S.mwRefs[s] = {
        row,
        b: row.querySelector('.b'), a: row.querySelector('.a'),
        spr: row.querySelector('.mw-spread'), chg: row.querySelector('.mw-chg'),
        spark: row.querySelector('.mw-spark'),
      };
      const spk = S.spark.get(s);
      if (spk && spk.arr.length > 1) drawSpark(S.mwRefs[s].spark, spk.arr);
    }
  }
  $('#mw-count').textContent = `${S.symList.length} symbols`;
}
function updateMW(s) {
  const ref = S.mwRefs?.[s];
  const p = px(s);
  if (!ref || !p.b) return;
  const sp = spec(s);
  const dir = p.dir;
  const set = (node, v, text) => {
    if (node.textContent !== text) {
      node.textContent = text;
      node.classList.remove('fl-up', 'fl-dn');
      void node.offsetWidth;
      node.classList.add(dir > 0 ? 'fl-up' : 'fl-dn');
      clearTimeout(node._t);
      node._t = setTimeout(() => node.classList.remove('fl-up', 'fl-dn'), 380);
    }
  };
  set(ref.b, p.b, fpx(s, p.b));
  set(ref.a, p.a, fpx(s, p.a));
  ref.spr.textContent = pipDiff(s, p.a, p.b).toFixed(1);
  const pc = S.prevDay[s];
  if (pc) {
    const chg = (p.b / pc - 1) * 100;
    ref.chg.textContent = `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}%`;
    ref.chg.className = 'mw-chg ' + (chg >= 0 ? 'up' : 'down');
  }
}

/* ---------------- sparklines (mini up/down chart per symbol) ---------------- */
function sparkPush(sym, price) {
  let o = S.spark.get(sym);
  if (!o) { o = { arr: [] }; S.spark.set(sym, o); }
  o.arr.push(price);
  if (o.arr.length > 56) o.arr.shift();
  const ref = S.mwRefs?.[sym];
  if (ref?.spark) drawSpark(ref.spark, o.arr);
}
function drawSpark(cv, arr) {
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  ctx.clearRect(0, 0, w, h);
  if (arr.length < 2) return;
  let mn = Infinity, mx = -Infinity;
  for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (mx - mn < 1e-12) { mn -= 1; mx += 1; }
  const up = arr[arr.length - 1] >= arr[0];
  ctx.beginPath();
  for (let i = 0; i < arr.length; i++) {
    const x = 2 + (i / (arr.length - 1)) * (w - 4);
    const y = h - 3 - ((arr[i] - mn) / (mx - mn)) * (h - 6);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = up ? '#2ebd85' : '#f6465d';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.shadowColor = ctx.strokeStyle;
  ctx.shadowBlur = 5;
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/* ---------------- depth ---------------- */
function h32(n) { n = Math.imul(n ^ n >>> 16, 2246822507); n = Math.imul(n ^ n >>> 13, 3266489909); return ((n ^ n >>> 16) >>> 0) / 4294967296; }
function renderDepth() {
  const p = px(S.cur);
  const sp = spec(S.cur);
  if (!p.b) return;
  const box = $('#depth');
  if ($('#depth-sym').textContent !== S.cur) $('#depth-sym').textContent = S.cur;
  const seg = Math.floor(Date.now() / 4000);
  const volOf = i => (2.2 + h32(i * 7919 + seg) * 34).toFixed(1);
  let html = '';
  for (let i = 5; i >= 1; i--) {
    const pr = p.a + sp.pip * i;
    html += `<div class="dp-row ask"><span class="dp-vol">${volOf(i + 40)}</span><div class="dp-bar" style="width:${18 + h32(i * 131 + seg) * 78}%"></div><span class="dp-price">${fpx(S.cur, pr)}</span></div>`;
  }
  html += `<div class="dp-mid"><span>Spread</span><b>${(pipDiff(S.cur, p.a, p.b)).toFixed(1)}</b><span>${fpx(S.cur, (p.a + p.b) / 2)}</span></div>`;
  for (let i = 1; i <= 5; i++) {
    const pr = p.b - sp.pip * i;
    html += `<div class="dp-row bid"><span class="dp-vol">${volOf(i)}</span><div class="dp-bar" style="width:${18 + h32(i * 977 + seg) * 78}%"></div><span class="dp-price">${fpx(S.cur, pr)}</span></div>`;
  }
  box.innerHTML = html;
}

/* ============================================================
   CHART DATA PIPELINE
   ============================================================ */
async function ensureSymbolData(sym, tf) {
  if (!S.m1.has(sym)) {
    try {
      const j = await api(`/api/history?symbol=${sym}&tf=M1&limit=14400`);
      if (sym === S.cur || S.m1.has(sym)) {
        if (!S.m1.has(sym)) S.m1.set(sym, j.bars.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })));
      }
    } catch (e) { if (!S.m1.has(sym)) S.m1.set(sym, []); }
  }
  const key = `${sym}|${tf}`;
  if (TFS[tf] >= 3600 && !S.tfHist.has(key)) {
    try {
      const j = await api(`/api/history?symbol=${sym}&tf=${tf}&limit=3000`);
      S.tfHist.set(key, j.bars);
    } catch (e) { S.tfHist.set(key, []); }
  }
}
const bucketOf = (t, tfSec) => Math.floor(t / (tfSec * 1000)) * tfSec * 1000;
function aggregateFrom(m1, tfSec) {
  const out = [];
  let cur = null, ck = -1;
  for (const b of m1) {
    const k = Math.floor(b.t / (tfSec * 1000));
    if (k !== ck) {
      if (cur) out.push(cur);
      cur = { t: k * tfSec * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      ck = k;
    } else {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c; cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}
function buildDisplay() {
  const sym = S.cur, tf = S.tf, tfSec = TFS[tf];
  const m1 = S.m1.get(sym) || [];
  if (!m1.length) { S.disp = []; return; }
  let bars;
  if (tfSec < 3600) {
    bars = aggregateFrom(m1, tfSec);
  } else {
    const hist = S.tfHist.get(`${sym}|${tf}`) || [];
    const cut = bucketOf(m1[0].t, tfSec);
    bars = hist.filter(b => b.t < cut).concat(aggregateFrom(m1, tfSec));
  }
  S.disp = bars;
}
function rebuildDispTail() {
  if (!S.disp) return;
  const sym = S.cur, tfSec = TFS[S.tf];
  const m1 = S.m1.get(sym);
  if (!m1 || !m1.length) return;
  const tail = m1[m1.length - 1];
  const tKey = bucketOf(tail.t, tfSec);
  const last = S.disp[S.disp.length - 1];
  if (last && last.t === tKey) {
    // recompute this bucket from m1 tail (walk back while same bucket)
    let o = null, h = -Infinity, l = Infinity, c = tail.c, v = 0;
    for (let i = m1.length - 1; i >= 0; i--) {
      const b = m1[i];
      if (bucketOf(b.t, tfSec) !== tKey) break;
      if (o === null) o = b.o;
      if (b.h > h) h = b.h;
      if (b.l < l) l = b.l;
      v += b.v;
    }
    last.o = o ?? tail.o; last.h = h; last.l = l; last.c = c; last.v = v;
  } else if (!last || tKey > last.t) {
    S.disp.push({ t: tKey, o: tail.o, h: tail.h, l: tail.l, c: tail.c, v: tail.v });
  }
}
function updateM1Tails() {
  for (const [sym, arr] of S.m1) {
    if (!arr.length) continue;
    const p = px(sym);
    if (!p.b) continue;
    const mid = (p.b + p.a) / 2;
    const lb = S.lastBarBySym.get(sym);
    const min = Math.floor(Date.now() / 60000) * 60000;
    let last = arr[arr.length - 1];
    if (lb && lb.t === last.t) { last = lb; arr[arr.length - 1] = lb; }
    if (last.t < min) {
      const nb = { t: min, o: mid, h: mid, l: mid, c: mid, v: 0 };
      arr.push(nb);
      if (sym === S.cur) S.lastBarBySym.set(sym, nb);
    } else {
      if (mid > last.h) last.h = mid;
      if (mid < last.l) last.l = mid;
      last.c = mid; last.v += 1;
      if (sym === S.cur) S.lastBarBySym.set(sym, last);
    }
  }
}

/* ---------------- chart ---------------- */
let chart;
function initChart() {
  chart = new CandleChart($('#chart'), { onCrosshair: updateLegend });
  chart.setChartType(S.ctype);
  chart.setVolume(localStorage.getItem('ot.vol') !== '0');
  $('#btn-volume').classList.toggle('active', localStorage.getItem('ot.vol') !== '0');
}
function updateLegend(h) {
  const lg = $('#ohlc-legend');
  if (!h) { lg.style.opacity = '.55'; renderLegend(null); return; }
  lg.style.opacity = '1';
  renderLegend(h.bar);
}
let legendBar = null;
function renderLegend(b) {
  legendBar = b;
  const sp = spec(S.cur);
  const d = S.tf;
  if (!b) {
    $('#ohlc-legend').innerHTML = `<div class="lg-sym">${S.cur}<small>· OmyaTrade · ${d}</small></div>`;
    return;
  }
  const up = b.c >= b.o;
  const dt = new Date(b.t);
  $('#ohlc-legend').innerHTML = `
    <div class="lg-sym">${S.cur}<small>· ${d} · ${p2(dt.getUTCDate())} ${MONTHS[dt.getUTCMonth()]} ${p2(dt.getUTCHours())}:${p2(dt.getUTCMinutes())}</small></div>
    <div class="lg-row"><span>O</span> <b class="${up ? 'lg-up' : 'lg-dn'}">${fpx(S.cur, b.o)}</b> <span>H</span> <b class="${up ? 'lg-up' : 'lg-dn'}">${fpx(S.cur, b.h)}</b> <span>L</span> <b class="${up ? 'lg-up' : 'lg-dn'}">${fpx(S.cur, b.l)}</b> <span>C</span> <b class="${up ? 'lg-up' : 'lg-dn'}">${fpx(S.cur, b.c)}</b></div>`;
}
function updateChartLive() {
  if (!chart || !S.disp) return;
  const p = px(S.cur);
  chart.bars = S.disp;
  chart.setLive({ bid: p.b, ask: p.a });
  chart.mark();
  renderOverlays();
  // header price
  const hp = $('#chart-sym-price');
  hp.textContent = fpx(S.cur, p.b);
  hp.className = 'sym-live ' + (p.dir > 0 ? 'up' : 'down');
  const pc = S.prevDay[S.cur];
  if (pc) {
    const chg = (p.b / pc - 1) * 100;
    const ce = $('#chart-sym-change');
    ce.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
    ce.className = 'sym-change ' + (chg >= 0 ? 'up' : 'down');
  }
  if (legendBar) renderLegend(S.disp[S.disp.length - 1]);
}
function renderOverlays() {
  if (!chart) return;
  const p = px(S.cur);
  const ov = [];
  if (p.b) ov.push({ price: p.b, color: 'rgba(242,213,126,.85)', dash: [5, 4] });
  const acc = S.account;
  if (acc) {
    for (const pos of acc.positions) {
      if (pos.symbol !== S.cur) continue;
      const col = pos.side === 'buy' ? '#2ebd85' : '#f6465d';
      ov.push({ price: pos.openPrice, color: col, dash: [], label: `#${pos.ticket} ${pos.side.toUpperCase()} ${pos.volume.toFixed(2)} · ${fmtPL(pos.profit)}`, labelRight: true });
      if (pos.sl) ov.push({ price: pos.sl, color: 'rgba(246,70,93,.75)', dash: [6, 4], label: `SL ${fpx(S.cur, pos.sl)}` });
      if (pos.tp) ov.push({ price: pos.tp, color: 'rgba(46,189,133,.75)', dash: [6, 4], label: `TP ${fpx(S.cur, pos.tp)}` });
    }
    for (const o of acc.orders) {
      if (o.symbol !== S.cur) continue;
      ov.push({ price: o.price, color: '#4f8ff7', dash: [3, 3], label: `#${o.ticket} ${o.type.toUpperCase()} ${o.volume.toFixed(2)}`, labelRight: true });
      if (o.sl) ov.push({ price: o.sl, color: 'rgba(246,70,93,.5)', dash: [6, 4], label: `SL ${fpx(S.cur, o.sl)}` });
      if (o.tp) ov.push({ price: o.tp, color: 'rgba(46,189,133,.5)', dash: [6, 4], label: `TP ${fpx(S.cur, o.tp)}` });
    }
  }
  chart.setOverlays(ov);
}

/* ---------------- symbol / tf switch ---------------- */
async function selectSymbol(sym, keepTf = true) {
  S.cur = sym;
  localStorage.setItem('ot.sym', sym);
  $$('.mw-row').forEach(r => r.classList.remove('active'));
  S.mwRefs?.[sym]?.row.classList.add('active');
  $('#chart-sym-code').textContent = sym;
  $('#depth-sym').textContent = sym;
  renderLegend(null);
  S.disp = null;
  await ensureSymbolData(sym, S.tf);
  buildDisplay();
  chart.setData(S.disp, { digits: spec(sym).digits, tfSec: TFS[S.tf] });
  updateChartLive();
  renderDepth();
  renderOverlays();
  closeTicket();
}
async function selectTF(tf) {
  S.tf = tf;
  localStorage.setItem('ot.tf', tf);
  $$('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
  $('#tf-group').querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
  S.disp = null;
  await ensureSymbolData(S.cur, tf);
  buildDisplay();
  chart.setData(S.disp, { digits: spec(S.cur).digits, tfSec: TFS[tf] });
  updateChartLive();
}

/* ============================================================
   ACCOUNT RENDERING
   ============================================================ */
let posRefs = new Map();
function renderAccount() {
  const a = S.account;
  if (!a) return;
  $('#acct-no').textContent = `№ ${a.login}`;
  $('#acct-lev').textContent = `1:${a.leverage} · ${a.currency}`;
  const set = (id, v) => { $(id).textContent = v; };
  set('#acct-balance', fmtMoney(a.balance));
  set('#acct-equity', fmtMoney(a.equity));
  const fl = $('#acct-floating');
  fl.textContent = fmtPL(a.floating);
  fl.className = a.floating > 0 ? 'pos' : a.floating < 0 ? 'neg' : '';
  set('#sum-balance', fmtMoney(a.balance));
  set('#sum-equity', fmtMoney(a.equity));
  set('#sum-margin', a.margin ? fmtMoney(a.margin) : '—');
  set('#sum-free', fmtMoney(a.freeMargin));
  const lvl = $('#sum-level');
  lvl.textContent = a.marginLevel ? a.marginLevel.toFixed(1) + '%' : '—';
  lvl.className = a.marginLevel && a.marginLevel < 100 ? 'neg' : '';
  const fl2 = $('#sum-floating');
  fl2.textContent = fmtPL(a.floating);
  fl2.className = a.floating > 0 ? 'pos' : a.floating < 0 ? 'neg' : '';
  $('#badge-positions').textContent = a.positions.length;
  $('#badge-orders').textContent = a.orders.length;
  $('#tb-closeall').classList.toggle('hidden', a.positions.length === 0);
  // one-click + modal prices
  const p = px(S.cur);
  if (p.b) {
    $('#oc-sell-price').textContent = fpx(S.cur, p.b);
    $('#oc-buy-price').textContent = fpx(S.cur, p.a);
    if (!$('#ticket-modal').classList.contains('hidden')) {
      $('#tm-bid').textContent = fpx(S.cur, p.b);
      $('#tm-ask').textContent = fpx(S.cur, p.a);
      $('#tm-sell-price').textContent = fpx(S.cur, p.b);
      $('#tm-buy-price').textContent = fpx(S.cur, p.a);
      $('#tm-spread').textContent = pipDiff(S.cur, p.a, p.b).toFixed(1) + ' pts';
    }
    const mTicket = window._modTicket;
    if (mTicket) {
      const pos = a.positions.find(x => x.ticket === mTicket);
      if (pos) {
        const mp = $('#tm-mpl');
        mp.textContent = fmtPL(pos.profit);        mp.style.color = pos.profit >= 0 ? 'var(--up)' : 'var(--down)';
      }
    }
  }
}

/* ---------------- positions table ---------------- */
function renderPositions() {
  const a = S.account;
  if (!a) return;
  const tb = $('#positions-table tbody');
  posRefs = new Map();
  if (!a.positions.length) {
    tb.innerHTML = `<tr><td colspan="12"><div class="empty-state">
      <svg viewBox="0 0 24 24"><path d="M3 13l4.5-5 3.5 3L16 5l5 6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 20h18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <span>No open positions — place your first order</span></div></td></tr>`;
    return;
  }
  tb.innerHTML = '';
  for (const p of a.positions) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>#${p.ticket}</td>
      <td class="td-time">${fmtDT(p.openTime)}</td>
      <td class="td-sym">${p.symbol}</td>
      <td><span class="type-pill ${p.side}">${p.side}</span></td>
      <td>${p.volume.toFixed(2)}</td>
      <td>${fpx(p.symbol, p.openPrice)}</td>
      <td class="c-sl">${p.sl ? fpx(p.symbol, p.sl) : '—'}</td>
      <td class="c-tp">${p.tp ? fpx(p.symbol, p.tp) : '—'}</td>
      <td class="c-cur">—</td>
      <td>0.00</td>
      <td class="c-pl">—</td>
      <td><span class="row-actions">
        <button class="row-btn" data-act="modify" title="Modify / Close"><svg viewBox="0 0 24 24"><path d="M4 20l4.5-.9L19 8.6a2 2 0 0 0 0-2.8l-.8-.8a2 2 0 0 0-2.8 0L4.9 15.5 4 20z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg></button>
        <button class="row-btn danger" data-act="close" title="Close position">✕</button>
      </span></td>`;
    tr.querySelector('[data-act="modify"]').onclick = () => openTicket({ mode: 'modify', ticket: p.ticket });
    tr.querySelector('[data-act="close"]').onclick = () => closePosition(p.ticket);
    tb.appendChild(tr);
    posRefs.set(p.ticket, {
      cur: tr.querySelector('.c-cur'), pl: tr.querySelector('.c-pl'),
    });
  }
  patchPositions();
}
function patchPositions() {
  const a = S.account;
  if (!a) return;
  for (const p of a.positions) {
    const ref = posRefs.get(p.ticket);
    if (!ref) continue;
    const cur = p.side === 'buy' ? px(p.symbol).b : px(p.symbol).a;
    ref.cur.textContent = fpx(p.symbol, cur);
    ref.pl.textContent = fmtPL(p.profit);
    ref.pl.className = 'c-pl ' + (p.profit >= 0 ? 'profit-pos' : 'profit-neg');
  }
}

/* ---------------- orders table ---------------- */
function renderOrders() {
  const a = S.account;
  if (!a) return;
  const tb = $('#orders-table tbody');
  orderRefs = new Map();
  if (!a.orders.length) {
    tb.innerHTML = `<tr><td colspan="10"><div class="empty-state">
      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12 7.5V12l3 2.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>
      <span>No pending orders</span></div></td></tr>`;
    return;
  }
  tb.innerHTML = '';
  for (const o of a.orders) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>#${o.ticket}</td>
      <td class="td-time">${fmtDT(o.placedTime)}</td>
      <td class="td-sym">${o.symbol}</td>
      <td><span class="type-pill pending">${o.type}</span></td>
      <td>${o.volume.toFixed(2)}</td>
      <td>${fpx(o.symbol, o.price)}</td>
      <td>${o.sl ? fpx(o.symbol, o.sl) : '—'}</td>
      <td>${o.tp ? fpx(o.symbol, o.tp) : '—'}</td>
      <td class="c-cur">—</td>
      <td><span class="row-actions">
        <button class="row-btn danger" data-act="cancel" title="Cancel order">✕</button>
      </span></td>`;
    tr.querySelector('[data-act="cancel"]').onclick = () => cancelOrder(o.ticket);
    tb.appendChild(tr);
    orderRefs.set(o.ticket, { cur: tr.querySelector('.c-cur') });
  }
  patchOrders();
}
let orderRefs = new Map();
function patchOrders() {
  const a = S.account;
  if (!a) return;
  for (const o of a.orders) {
    const ref = orderRefs.get(o.ticket);
    if (!ref) continue;
    const cur = o.type.indexOf('buy') === 0 ? px(o.symbol).a : px(o.symbol).b;
    ref.cur.textContent = fpx(o.symbol, cur);
  }
}

/* ---------------- history ---------------- */
let histRange = 'today';
async function refreshDeals() {
  try {
    const j = await api('/api/deals');
    S.deals = j.history;
    renderHistory();
  } catch (e) {}
}
function renderHistory() {
  const tb = $('#history-table tbody');
  const now = Date.now();
  const startOf = { today: new Date().setUTCHours(0, 0, 0, 0), week: now - 7 * 864e5, month: now - 30 * 864e5, all: 0 }[histRange];
  const list = S.deals.filter(d => d.closeTime >= startOf);
  if (!list.length) {
    tb.innerHTML = `<tr><td colspan="8"><div class="empty-state">
      <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <span>No closed deals in this period</span></div></td></tr>`;
    $('#hist-total').innerHTML = '';
    return;
  }
  let total = 0;
  tb.innerHTML = list.map(d => {
    total += d.profit;
    const reason = { manual: ['MANUAL', 'reason-manual'], tp: ['TAKE PROFIT', 'reason-tp'], sl: ['STOP LOSS', 'reason-sl'], stopout: ['STOP OUT', 'reason-stopout'] }[d.reason] || ['—', ''];
    return `<tr>
      <td class="td-time">${fmtDT(d.openTime)} → ${fmtDT(d.closeTime)}</td>
      <td class="td-sym">${d.symbol}</td>
      <td><span class="type-pill ${d.side}">${d.side}</span></td>
      <td>${d.volume.toFixed(2)}</td>
      <td>${fpx(d.symbol, d.openPrice)}</td>
      <td>${fpx(d.symbol, d.closePrice)}</td>
      <td><span class="reason-badge ${reason[1]}">${reason[0]}</span></td>
      <td class="${d.profit >= 0 ? 'profit-pos' : 'profit-neg'}">${fmtPL(d.profit)}</td>
    </tr>`;
  }).join('');
  $('#hist-total').innerHTML = `${list.length} deals · Net P/L <b class="${total >= 0 ? 'profit-pos' : 'profit-neg'}">${fmtPL(total)}</b>`;
}

/* ---------------- mobile view helper ---------------- */
function mobileGo(view) {
  if (window.innerWidth > 860) return;
  document.body.dataset.view = view;
  $$('#mobile-nav button').forEach(x => x.classList.toggle('active', x.dataset.view === view));
  if (view === 'chart') setTimeout(() => chart?.resize(), 60);
}

/* ============================================================
   TRADING ACTIONS
   ============================================================ */
async function closePosition(ticket) {
  try { await api('/api/position/close', { ticket }); }
  catch (e) { sfx.err(); toast('err', 'Close failed', esc(e.message)); }
}
async function cancelOrder(ticket) {
  try { await api('/api/order/cancel', { ticket }); }
  catch (e) { sfx.err(); toast('err', 'Cancel failed', esc(e.message)); }
}
async function closeAll() {
  try { await api('/api/positions/closeall', {}); }
  catch (e) { sfx.err(); toast('err', 'Failed', esc(e.message)); }
}
async function placeMarket(side, lots, sl, tp) {
  try {
    await api('/api/order', { symbol: S.cur, side, volume: lots, sl: sl || 0, tp: tp || 0 });
    return true;
  } catch (e) {
    sfx.err(); toast('err', 'Order rejected', esc(e.message));
    return false;
  }
}
async function placePending(type, lots, price, sl, tp) {
  try {
    await api('/api/pending', { symbol: S.cur, type, volume: lots, price, sl: sl || 0, tp: tp || 0 });
    return true;
  } catch (e) {
    sfx.err(); toast('err', 'Order rejected', esc(e.message));
    return false;
  }
}

/* ============================================================
   TICKET MODAL
   ============================================================ */
const ticketModal = $('#ticket-modal');
const backdrop = $('#modal-backdrop');
let tmTab = 'market';
function openTicket(opts = {}) {
  const sp = spec(S.cur);
  $('#tm-symbol').textContent = S.cur;
  $('#tm-symname').textContent = sp.disp;
  const modify = opts.mode === 'modify';
  $('#tm-tab-modify').classList.toggle('hidden', !modify);
  setTM(modify ? 'modify' : 'market');
  if (modify) {
    const pos = S.account.positions.find(p => p.ticket === opts.ticket);
    if (!pos) return;
    window._modTicket = pos.ticket;
    $('#tm-mod-info').innerHTML = `
      <div><label>Ticket</label><b>#${pos.ticket}</b></div>
      <div><label>Type</label><b style="color:${pos.side === 'buy' ? 'var(--up)' : 'var(--down)'}">${pos.side.toUpperCase()} ${pos.volume.toFixed(2)}</b></div>
      <div><label>Open</label><b>${fpx(S.cur, pos.openPrice)}</b></div>
      <div><label>S/L · T/P</label><b>${pos.sl ? fpx(S.cur, pos.sl) : '—'} · ${pos.tp ? fpx(S.cur, pos.tp) : '—'}</b></div>`;
    $('#tm-msl').value = pos.sl || '';
    $('#tm-mtp').value = pos.tp || '';
    $('#tm-mvol').value = '';
  } else {
    window._modTicket = null;
    $('#tm-volume').value = S.lots;
    $('#tm-sl').value = ''; $('#tm-tp').value = '';
    $('#tm-sl-on').checked = false; $('#tm-tp-on').checked = false;
    $('#tm-sl').disabled = true; $('#tm-tp').disabled = true;
    updateMarginPreview();
  }
  // pending defaults
  const p = px(S.cur);
  if (p.b) {
    const off = Math.max(20, pipDiff(S.cur, p.a, p.b)) * spec(S.cur).pip * 40;
    $('#tm-pprice').value = (p.a - off).toFixed(sp.digits);
    setPendingHint();
  }
  ticketModal.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  requestAnimationFrame(() => { ticketModal.classList.add('show'); backdrop.classList.add('show'); });
}
function closeTicket() {
  if (ticketModal.classList.contains('hidden')) return;
  ticketModal.classList.remove('show');
  backdrop.classList.remove('show');
  window._modTicket = null;
  setTimeout(() => { ticketModal.classList.add('hidden'); backdrop.classList.add('hidden'); }, 200);
}
function setTM(tab) {
  tmTab = tab;
  $$('#tm-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tt === tab));
  $$('.tm-pane').forEach(p => p.classList.toggle('active', p.dataset.tp === tab));
}
function setPendingHint() {
  const p = px(S.cur);
  const v = parseFloat($('#tm-pprice').value);
  if (!p.b || isNaN(v)) { $('#tm-phint').textContent = 'Set the trigger price.'; return; }
  let hint = '';
  if (v < p.a) hint = 'Below market → BUY LIMIT / SELL STOP zone.';
  else if (v > p.a) hint = 'Above market → SELL LIMIT / BUY STOP zone.';
  $('#tm-phint').textContent = hint;
}
function updateMarginPreview() {
  const v = parseFloat($('#tm-volume').value) || 0;
  const mAcct = marginReq(S.cur, v) * (acctCur() === 'IDR' ? idrRate() : 1);
  $('#tm-margin').textContent = mAcct > 0 ? fmtMoney(mAcct) : '—';
}
function volInput(input) {
  let v = parseFloat(input.value);
  if (isNaN(v)) v = 0.01;
  v = clamp(Math.round(v * 100) / 100, 0.01, 200);
  input.value = v.toFixed(2);
  return v;
}

/* ============================================================
   WIRING
   ============================================================ */
function wire() {
  if (wire._done) return;
  wire._done = true;
  // toolbar tf
  const tg = $('#tf-group');
  for (const tf of TFS_LIST) {
    const b = el('button', 'tf-btn' + (tf === S.tf ? ' active' : ''), tf);
    b.dataset.tf = tf;
    b.onclick = () => selectTF(tf);
    tg.appendChild(b);
  }
  // chart type
  $$('#ctype-group button').forEach(b => {
    b.classList.toggle('active', b.dataset.ctype === S.ctype);
    b.onclick = () => {
      S.ctype = b.dataset.ctype;
      localStorage.setItem('ot.ctype', S.ctype);
      $$('#ctype-group button').forEach(x => x.classList.toggle('active', x === b));
      chart.setChartType(S.ctype);
    };
  });
  $('#btn-volume').onclick = () => {
    const on = !$('#btn-volume').classList.contains('active');
    $('#btn-volume').classList.toggle('active', on);
    localStorage.setItem('ot.vol', on ? '1' : '0');
    chart.setVolume(on);
  };
  // sidebar
  $('#btn-sidebar').onclick = () => $('#sidebar').classList.toggle('open');
  $('#mw-search').addEventListener('input', buildMarketWatch);
  // sound
  const sndBtn = $('#btn-sound');
  sndBtn.classList.toggle('muted', !S.sound);
  sndBtn.onclick = () => {
    S.sound = !S.sound;
    localStorage.setItem('ot.sound', S.sound ? '1' : '0');
    sndBtn.classList.toggle('muted', !S.sound);
  };
  // oct toggle
  const oc = $('#oct-check');
  oc.checked = S.oct;
  $('#oneclick').classList.toggle('oct-visible', S.oct);
  oc.onchange = () => {
    S.oct = oc.checked;
    localStorage.setItem('ot.oct', S.oct ? '1' : '0');
    $('#oneclick').classList.toggle('oct-visible', S.oct);
  };
  // one-click
  const ocLots = $('#oc-lots');
  ocLots.value = S.lots;
  $('#oc-minus').onclick = () => { ocLots.value = volInput(ocLots) - 0.01 < 0.01 ? '0.01' : (volInput(ocLots) - 0.01).toFixed(2); ocLots.value = (parseFloat(ocLots.value)).toFixed(2); saveLots(ocLots.value); };
  $('#oc-plus').onclick = () => { ocLots.value = (volInput(ocLots) + 0.01).toFixed(2); saveLots(ocLots.value); };
  ocLots.onchange = () => { volInput(ocLots); saveLots(ocLots.value); };
  $('#oc-sell').onclick = () => placeMarket('sell', parseFloat(S.lots));
  $('#oc-buy').onclick = () => placeMarket('buy', parseFloat(S.lots));
  // new order
  $('#btn-new-order').onclick = () => openTicket();
  // --- auth ---
  $('#login-form').onsubmit = async e => {
    e.preventDefault();
    const btn = $('#login-btn');
    btn.disabled = true; btn.textContent = 'CONNECTING…';
    $('#login-err').classList.add('hidden');
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#login-user').value.trim(), password: $('#login-pass').value }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || 'Login failed');
      localStorage.setItem('ot.token', j.token);
      localStorage.setItem('ot.user', j.name);
      btn.disabled = false; btn.textContent = 'SIGN IN';
      $('#login').classList.add('hidden');
      boot();
    } catch (err) {
      $('#login-err').textContent = err.message;
      $('#login-err').classList.remove('hidden');
      btn.disabled = false; btn.textContent = 'SIGN IN';
    }
  };
  $('#btn-logout').onclick = async () => {
    try { await api('/api/auth/logout', {}); } catch (e) {}
    clearAuth();
    location.reload();
  };
  // --- secret: 3 clicks on the brand opens Market Control ---
  let brandHits = 0, brandTimer = null;
  document.querySelector('.brand').addEventListener('click', () => {
    brandHits++;
    clearTimeout(brandTimer);
    brandTimer = setTimeout(() => { brandHits = 0; }, 900);
    if (brandHits >= 3) { brandHits = 0; window.__tryOpenAdmin?.(); }
  });
  const fab = $('#fab-order');
  if (fab) fab.onclick = () => openTicket();
  // currency display toggle (IDR / USD)
  const curBtn = $('#btn-currency');
  const renderCurToggle = () => {
    curBtn.querySelectorAll('.cur-opt').forEach(o => o.classList.toggle('active', o.dataset.cur === S.dispCur));
  };
  curBtn.onclick = () => {
    S.dispCur = S.dispCur === 'IDR' ? 'USD' : 'IDR';
    localStorage.setItem('ot.dispcur', S.dispCur);
    renderCurToggle();
    renderAccount();
    renderHistory();
    patchPositions();
    patchOrders();
    updateMarginPreview();
  };
  renderCurToggle();
  // modal
  $('#tm-close').onclick = closeTicket;
  backdrop.onclick = closeTicket;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTicket(); });
  $$('#tm-tabs button').forEach(b => b.onclick = () => setTM(b.dataset.tt));
  // volume steppers in modal
  $$('.stepper [data-step]').forEach(b => {
    b.onclick = () => {
      const input = b.parentElement.querySelector('input');
      const d = parseFloat(b.dataset.step);
      if (input.id === 'tm-volume' || input.id === 'tm-pvolume') {
        const v = volInput(input);
        input.value = clamp(v + d * 0.01, 0.01, 200).toFixed(2);
        if (input.id === 'tm-volume') { saveLots(input.value); updateMarginPreview(); }
      } else if (input.id === 'oc-lots') {
        input.value = clamp((parseFloat(input.value) || 0) + d * 0.01, 0.01, 200).toFixed(2);
        saveLots(input.value);
      }
    };
  });
  $('#tm-volume').addEventListener('input', updateMarginPreview);
  $('#tm-volume').addEventListener('change', () => { volInput($('#tm-volume')); saveLots($('#tm-volume').value); updateMarginPreview(); });
  $('#tm-sl-on').onchange = e => { $('#tm-sl').disabled = !e.target.checked; };
  $('#tm-tp-on').onchange = e => { $('#tm-tp').disabled = !e.target.checked; };
  $('#tm-psl-on').onchange = e => { $('#tm-psl').disabled = !e.target.checked; };
  $('#tm-ptp-on').onchange = e => { $('#tm-ptp').disabled = !e.target.checked; };
  // exec
  $('#tm-buy').onclick = async () => {
    const v = volInput($('#tm-volume'));
    const sl = $('#tm-sl-on').checked ? parseFloat($('#tm-sl').value) || 0 : 0;
    const tp = $('#tm-tp-on').checked ? parseFloat($('#tm-tp').value) || 0 : 0;
    if (await placeMarket('buy', v, sl, tp)) closeTicket();
  };
  $('#tm-sell').onclick = async () => {
    const v = volInput($('#tm-volume'));
    const sl = $('#tm-sl-on').checked ? parseFloat($('#tm-sl').value) || 0 : 0;
    const tp = $('#tm-tp-on').checked ? parseFloat($('#tm-tp').value) || 0 : 0;
    if (await placeMarket('sell', v, sl, tp)) closeTicket();
  };
  $('#tm-ptype').onchange = setPendingHint;
  $('#tm-pprice').addEventListener('input', setPendingHint);
  $('#tm-place').onclick = async () => {
    const v = volInput($('#tm-pvolume'));
    const price = parseFloat($('#tm-pprice').value);
    const sl = $('#tm-psl-on').checked ? parseFloat($('#tm-psl').value) || 0 : 0;
    const tp = $('#tm-ptp-on').checked ? parseFloat($('#tm-ptp').value) || 0 : 0;
    if (isNaN(price) || price <= 0) { toast('err', 'Invalid price', 'Enter a valid trigger price.'); return; }
    if (await placePending($('#tm-ptype').value, v, price, sl, tp)) closeTicket();
  };
  // modify pane
  $('#tm-save-mod').onclick = async () => {
    const ticket = window._modTicket;
    if (!ticket) return;
    const sl = parseFloat($('#tm-msl').value) || 0;
    const tp = parseFloat($('#tm-mtp').value) || 0;
    try { await api('/api/position/modify', { ticket, sl, tp }); closeTicket(); }
    catch (e) { sfx.err(); toast('err', 'Modify failed', esc(e.message)); }
  };
  $('#tm-close-pos').onclick = async () => {
    const ticket = window._modTicket;
    if (!ticket) return;
    const pv = parseFloat($('#tm-mvol').value);
    try {
      await api('/api/position/close', { ticket, volume: isNaN(pv) || pv <= 0 ? undefined : pv });
      closeTicket();
    } catch (e) { sfx.err(); toast('err', 'Close failed', esc(e.message)); }
  };
  // toolbox tabs
  $$('#tb-tabs .tb-tab').forEach(b => {
    b.onclick = () => {
      $$('#tb-tabs .tb-tab').forEach(x => x.classList.toggle('active', x === b));
      $$('.tb-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === b.dataset.tab));
      if (b.dataset.tab === 'history') refreshDeals();
    };
  });
  $('#tb-closeall').onclick = closeAll;
  $$('#hist-range button').forEach(b => {
    b.onclick = () => {
      histRange = b.dataset.range;
      $$('#hist-range button').forEach(x => x.classList.toggle('active', x === b));
      renderHistory();
    };
  });
  // mobile nav
  $$('#mobile-nav button').forEach(b => {
    b.onclick = () => {
      const v = b.dataset.view;
      document.body.dataset.view = v;
      $$('#mobile-nav button').forEach(x => x.classList.toggle('active', x === b));
      if (v === 'history') refreshDeals();
      if (v === 'trade') {
        $$('#tb-tabs .tb-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === 'positions'));
        $$('.tb-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === 'positions'));
      }
      if (v === 'chart') chart?.resize();
    };
  });
  // clock + latency
  setInterval(() => {
    const d = new Date();
    $('#clock').textContent = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  }, 1000);
  setInterval(() => {
    const t = 16 + Math.abs(Math.sin(Date.now() / 4700)) * 21 + Math.random() * 7;
    $('#srv-ping').textContent = `${t.toFixed(0)} ms`;
  }, 1800);
}
function saveLots(v) { S.lots = v; localStorage.setItem('ot.lots', v); $('#tm-volume').value = v; $('#oc-lots').value = v; }

/* ============================================================
   BOOT
   ============================================================ */
async function boot() {
  // default view for small screens
  if (window.innerWidth <= 860 && !document.body.dataset.view) document.body.dataset.view = 'chart';
  wire();
  initChart();
  if (!getToken()) { bootAway(); return showLogin(); }
  try {
    S.user = await api('/api/auth/check');
  } catch (e) { return; }
  try {
    const j = await api('/api/bootstrap');
    for (const sp of j.symbols) S.symbols[sp.symbol] = sp;
    S.symList = j.symbols.map(s => s.symbol);
    S.account = j.account;
    S.deals = j.history || [];
    if ($('#boot-msg')) $('#boot-msg').textContent = 'Authenticating account…';
    if ($('#boot-fill')) $('#boot-fill').style.width = '42%';
    await Promise.all(S.symList.map(async s => {
      try {
        const h = await api(`/api/history?symbol=${s}&tf=D1&limit=2`);
        if (h.bars.length >= 2) S.prevDay[s] = h.bars[h.bars.length - 2].c;
        else if (h.bars.length === 1) S.prevDay[s] = h.bars[0].o;
      } catch (e) {}
    }));
    if ($('#boot-msg')) $('#boot-msg').textContent = 'Synchronizing market data…';
    if ($('#boot-fill')) $('#boot-fill').style.width = '78%';
    buildMarketWatch();
    renderHistory();
    renderAccount();
    await selectSymbol(S.cur);
    const minBoot = new Promise(r2 => setTimeout(r2, 2300));
    if ($('#boot-fill')) $('#boot-fill').style.width = '100%';
    if ($('#boot-msg')) $('#boot-msg').textContent = 'Connected to OmyaTrade-Real03';
    await minBoot;
    initAdmin({ api, toast, $, $$, S, fmtMoney, sfx, getSymbol: () => S.cur });
    $('#boot')?.classList.add('done');
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    chart.resize();
    connectFeed();
    setTimeout(() => $('#boot')?.remove(), 900);
  } catch (e) {
    console.error('[boot] failed:', e);
    if ($('#boot-msg')) $('#boot-msg').textContent = 'Connection failed — retrying…';
    if (getToken()) setTimeout(boot, 2200);
  }
}
function bootAway() {
  const b = $('#boot');
  if (b) { b.classList.add('done'); setTimeout(() => b.remove(), 650); }
}
boot();

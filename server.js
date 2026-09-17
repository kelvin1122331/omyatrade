/* ============================================================
   OMYA TRADE — Market & Trading Server
   Zero-dependency Node.js server:
   - Realistic tick-by-tick price engine (multi-symbol)
   - Layered synthetic history (D1 -> H1 -> M1, consistent)
   - Trading engine: market/pending orders, SL/TP, margin,
     stop-out, deal history, server-side persistence
   - REST API + Server-Sent Events live stream
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';
const TICK_MS = 280;
const DAY = 86400000;
const HOUR = 3600000;
const MIN = 60000;
const LEVERAGE = 100;
const SERVER_NAME = 'OmyaTrade-Real03';
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNT_FILE = path.join(DATA_DIR, 'account.json');

/* ---------------- Authentication ---------------- */
/* Passwords are never kept in plaintext in memory: they are scrypt-hashed at
   boot. Override defaults with OMYA_ADMIN_PASS / OMYA_TRADER_PASS env vars. */
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
function hashPassword(pw, salt = crypto.randomBytes(16)) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64, SCRYPT_OPTS) };
}
function verifyPassword(pw, rec) {
  const cand = crypto.scryptSync(String(pw), rec.salt, 64, SCRYPT_OPTS);
  return crypto.timingSafeEqual(cand, rec.hash);
}
const DUMMY_PW = hashPassword(crypto.randomBytes(16).toString('hex')); // for constant-time unknown-user path
const DEFAULT_PASS = { admin: 'admin123', trader: 'trader123' };
const USERS = {
  admin:  { role: 'admin',  name: 'Administrator', ...hashPassword(process.env.OMYA_ADMIN_PASS  || DEFAULT_PASS.admin) },
  trader: { role: 'trader', name: 'Trader',        ...hashPassword(process.env.OMYA_TRADER_PASS || DEFAULT_PASS.trader) },
};
for (const [u, v] of Object.entries(DEFAULT_PASS)) {
  if (!process.env[`OMYA_${u.toUpperCase()}_PASS`]) console.warn(`[omya] WARNING: "${u}" is using the default password — set OMYA_${u.toUpperCase()}_PASS`);
}
const USERNAME_RE = /^[a-z0-9_.-]{1,32}$/;
const PASSWORD_MAX = 128;

/* --- brute-force protection: per-IP and per-account sliding window --- */
const LOGIN_WINDOW_MS = 15 * MIN;
const LOGIN_MAX_PER_IP = 20;
const LOGIN_MAX_PER_USER = 5;
const LOCKOUT_MS = 15 * MIN;
const loginAttempts = new Map(); // key -> { fails: number[], lockedUntil }
function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function attemptRec(key) {
  let r = loginAttempts.get(key);
  if (!r) { r = { fails: [], lockedUntil: 0 }; loginAttempts.set(key, r); }
  const cut = Date.now() - LOGIN_WINDOW_MS;
  r.fails = r.fails.filter(t => t > cut);
  return r;
}
function isLocked(key, max) {
  const r = attemptRec(key);
  if (r.lockedUntil > Date.now()) return true;
  return r.fails.length >= max;
}
function recordFail(key, max) {
  const r = attemptRec(key);
  r.fails.push(Date.now());
  if (r.fails.length >= max) r.lockedUntil = Date.now() + LOCKOUT_MS;
}
function clearFails(key) { loginAttempts.delete(key); }
setInterval(() => { // GC stale entries
  const cut = Date.now() - LOGIN_WINDOW_MS;
  for (const [k, r] of loginAttempts) if (r.lockedUntil < Date.now() && !r.fails.some(t => t > cut)) loginAttempts.delete(k);
}, 5 * MIN).unref();

/* --- sessions: only a SHA-256 digest of the bearer token is stored/persisted --- */
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 days absolute
const SESSION_IDLE = 7 * 24 * 3600 * 1000;  // 7 days idle
const sessions = new Map(); // tokenHash -> {user, role, name, loginAt, lastSeen}
function tokenHash(tok) { return crypto.createHash('sha256').update(String(tok)).digest('hex'); }
function sessionAlive(v, now) {
  return v && v.loginAt && now - v.loginAt < SESSION_TTL && now - (v.lastSeen || v.loginAt) < SESSION_IDLE;
}
function loadSessions() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(j)) {
      if (k.length === 64 && sessionAlive(v, now)) sessions.set(k, v); // 64 = sha256 hex; drops legacy plaintext-token files
    }
    if (sessions.size) console.log(`[omya] restored ${sessions.size} session(s)`);
  } catch (e) { /* fresh */ }
}
let sessSaveT = null;
function saveSessions() {
  clearTimeout(sessSaveT);
  sessSaveT = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = SESSIONS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
      fs.renameSync(tmp, SESSIONS_FILE);
    } catch (e) { console.error('session persist failed', e.message); }
  }, 400);
}
function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function sessionOf(req, url, { allowQuery = false } = {}) {
  let tok = null;
  const h = req.headers['authorization'];
  if (h && h.startsWith('Bearer ')) tok = h.slice(7).trim();
  if (!tok && allowQuery) tok = url.searchParams.get('token'); // only for EventSource, which cannot set headers
  if (!tok || tok.length > 128) return null;
  const key = tokenHash(tok);
  const s = sessions.get(key);
  const now = Date.now();
  if (!sessionAlive(s, now)) { if (s) { sessions.delete(key); saveSessions(); } return null; }
  if (now - (s.lastSeen || 0) > MIN) { s.lastSeen = now; saveSessions(); }
  return Object.assign({ token: key }, s);
}
function revokeUserSessions(user) {
  for (const [k, v] of sessions) if (v.user === user) sessions.delete(k);
  saveSessions();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------------- Cheat engine (admin) ---------------- */
const CHEAT_RUN_MS = 20000;   // slow run in the cheat direction
const CHEAT_DIP_MS = 5000;    // brief counter-move
const cheat = { symbol: null, mode: null, source: null, phase: 'run', phaseStart: 0 };
const bot = { enabled: false, symbol: 'EURUSD', lots: 0.10, ticket: null, side: null,
              opened: 0, wins: 0, pl: 0, openedAt: 0, cooldownUntil: 0, nextSide: 'buy' };

function cheatActiveFor(sym) { return cheat.symbol === sym && !!cheat.mode; }
function adminState() {
  const now = Date.now();
  return {
    bot: {
      enabled: bot.enabled, symbol: bot.symbol, lots: bot.lots,
      opened: bot.opened, wins: bot.wins, pl: r(bot.pl, 2),
      hasPosition: !!bot.ticket, side: bot.side, ticket: bot.ticket,
    },
    cheat: {
      symbol: cheat.symbol, mode: cheat.mode, source: cheat.source, phase: cheat.phase,
      msLeft: cheat.mode ? (cheat.phase === 'run' ? CHEAT_RUN_MS - (now - cheat.phaseStart) : CHEAT_DIP_MS - (now - cheat.phaseStart)) : 0,
    },
    balance: account.balance,
  };
}
function broadcastAdmin() {
  broadcast({ event: 'admin', data: adminState() });
}
function setManualCheat(mode, sym) {
  if (mode === 'off' || !mode) {
    if (cheat.source === 'manual') { cheat.symbol = null; cheat.mode = null; cheat.source = null; }
  } else {
    cheat.symbol = sym; cheat.mode = mode; cheat.source = 'manual';
    cheat.phase = 'run'; cheat.phaseStart = Date.now();
  }
  broadcastAdmin();
}
function botStep() {
  if (!bot.enabled) return;
  const now = Date.now();
  if (bot.ticket) {
    const still = account.positions.some(x => x.ticket === bot.ticket);
    if (!still) {
      const deal = account.history.find(h => h.positionTicket === bot.ticket);
      if (deal) { bot.pl += deal.profit; if (deal.profit > 0) bot.wins++; }
      bot.ticket = null; bot.side = null;
      bot.cooldownUntil = now + 1200;
      if (cheat.source === 'bot') { cheat.symbol = null; cheat.mode = null; cheat.source = null; }
      broadcastAdmin();
    } else if (cheat.source !== 'manual' && now - bot.openedAt > 8000 &&
               (cheat.symbol !== bot.symbol || cheat.mode !== bot.side)) {
      // re-assert the flow-reading cheat behind our position
      cheat.symbol = bot.symbol; cheat.mode = bot.side; cheat.source = 'bot';
      cheat.phase = 'run'; cheat.phaseStart = now;
      broadcastAdmin();
    }
  }
  if (!bot.ticket && now >= bot.cooldownUntil) {
    const S = SYMBOLS[bot.symbol];
    if (!S) return;
    const { ask, bid } = priceOf(bot.symbol);
    const side = bot.nextSide;
    bot.nextSide = rand() < 0.5 ? 'buy' : 'sell';
    const price = side === 'buy' ? ask : bid;
    const tp = r(price * (1 + (side === 'buy' ? 1 : -1) * 0.0015), S.digits);
    bot.ticket = openPosition(bot.symbol, side, bot.lots, price, 0, tp, 'bot');
    bot.side = side; bot.opened++; bot.openedAt = now;
    if (cheat.source !== 'manual') {
      cheat.symbol = bot.symbol; cheat.mode = side; cheat.source = 'bot';
      cheat.phase = 'run'; cheat.phaseStart = now;
    }
    broadcastAccount();
    broadcastAdmin();
  }
}

/* ---------------- RNG helpers ---------------- */
let _seed = 987654321;
function srand(s) { _seed = s >>> 0; }
function rand() { _seed ^= _seed << 13; _seed ^= _seed >>> 17; _seed ^= _seed << 5; _seed >>>= 0; return _seed / 4294967296; }
function randn() { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

/* ---------------- Symbol specifications ---------------- */
const SYMBOLS = {
  'EURUSD': { cat: 'Forex',    price: 1.08652,  digits: 5, pip: 0.0001, spread: 0.9,  dvol: 0.0050, contract: 100000, quote: 'USD', base: 'EUR', disp: 'Euro / US Dollar' },
  'GBPUSD': { cat: 'Forex',    price: 1.27034,  digits: 5, pip: 0.0001, spread: 1.4,  dvol: 0.0062, contract: 100000, quote: 'USD', base: 'GBP', disp: 'Pound / US Dollar' },
  'USDJPY': { cat: 'Forex',    price: 150.248,  digits: 3, pip: 0.01,   spread: 1.2,  dvol: 0.0058, contract: 100000, quote: 'JPY', base: 'USD', disp: 'US Dollar / Yen' },
  'USDCHF': { cat: 'Forex',    price: 0.88412,  digits: 5, pip: 0.0001, spread: 1.6,  dvol: 0.0048, contract: 100000, quote: 'CHF', base: 'USD', disp: 'US Dollar / Franc' },
  'AUDUSD': { cat: 'Forex',    price: 0.65804,  digits: 5, pip: 0.0001, spread: 1.2,  dvol: 0.0068, contract: 100000, quote: 'USD', base: 'AUD', disp: 'Aussie / US Dollar' },
  'NZDUSD': { cat: 'Forex',    price: 0.61192,  digits: 5, pip: 0.0001, spread: 1.9,  dvol: 0.0070, contract: 100000, quote: 'USD', base: 'NZD', disp: 'Kiwi / US Dollar' },
  'USDCAD': { cat: 'Forex',    price: 1.35822,  digits: 5, pip: 0.0001, spread: 1.5,  dvol: 0.0044, contract: 100000, quote: 'CAD', base: 'USD', disp: 'US Dollar / Canadian' },
  'USDIDR': { cat: 'Exotics',  price: 16245,    digits: 0, pip: 1,      spread: 30,   dvol: 0.0038, contract: 100000, quote: 'IDR', base: 'USD', disp: 'US Dollar / Rupiah' },
  'EURJPY': { cat: 'Forex',    price: 163.294,  digits: 3, pip: 0.01,   spread: 1.8,  dvol: 0.0061, contract: 100000, quote: 'JPY', base: 'EUR', disp: 'Euro / Yen' },
  'GBPJPY': { cat: 'Forex',    price: 190.842,  digits: 3, pip: 0.01,   spread: 2.6,  dvol: 0.0076, contract: 100000, quote: 'JPY', base: 'GBP', disp: 'Pound / Yen' },
  'XAUUSD': { cat: 'Metals',   price: 2385.42,  digits: 2, pip: 0.01,   spread: 30,   dvol: 0.0092, contract: 100,    quote: 'USD', base: 'XAU', disp: 'Gold / US Dollar' },
  'XAGUSD': { cat: 'Metals',   price: 28.452,   digits: 3, pip: 0.001,  spread: 25,   dvol: 0.0130, contract: 5000,   quote: 'USD', base: 'XAG', disp: 'Silver / US Dollar' },
  'USOIL':  { cat: 'Energy',   price: 78.42,    digits: 2, pip: 0.01,   spread: 3,    dvol: 0.0160, contract: 1000,   quote: 'USD', base: 'WBS', disp: 'WTI Crude Oil' },
  'US30':   { cat: 'Indices',  price: 39162.5,  digits: 1, pip: 1,      spread: 3.0,  dvol: 0.0092, contract: 1,      quote: 'USD', base: 'USD', disp: 'Dow Jones 30' },
  'NAS100': { cat: 'Indices',  price: 18254.8,  digits: 1, pip: 1,      spread: 1.8,  dvol: 0.0125, contract: 1,      quote: 'USD', base: 'USD', disp: 'Nasdaq 100' },
  'SPX500': { cat: 'Indices',  price: 5231.4,   digits: 1, pip: 0.1,    spread: 0.5,  dvol: 0.0085, contract: 1,      quote: 'USD', base: 'USD', disp: 'S&P 500' },
  'GER40':  { cat: 'Indices',  price: 18322.6,  digits: 1, pip: 1,      spread: 1.8,  dvol: 0.0090, contract: 1,      quote: 'EUR', base: 'EUR', disp: 'DAX 40' },
  'BTCUSD': { cat: 'Crypto',   price: 63482,    digits: 2, pip: 1,      spread: 18,   dvol: 0.0280, contract: 1,      quote: 'USD', base: 'BTC', disp: 'Bitcoin / US Dollar' },
  'ETHUSD': { cat: 'Crypto',   price: 3152.4,   digits: 2, pip: 0.01,   spread: 1.2,  dvol: 0.0330, contract: 1,      quote: 'USD', base: 'ETH', disp: 'Ethereum / US Dollar' },
};
const SYM_NAMES = Object.keys(SYMBOLS);
for (const s of SYM_NAMES) { SYMBOLS[s].symbol = s; SYMBOLS[s].dvol = SYMBOLS[s].dvol; }

const r = (v, d) => { const p = Math.pow(10, d); return Math.round(v * p) / p; };

/* ---------------- Layered history generation ---------------- */
function subdivide(parent, n, tfMs, tStart) {
  const o = parent.o, c = parent.c, range = Math.max(parent.h - parent.l, parent.o * 0.0004);
  const sigma = range / 4.2 / Math.sqrt(n);
  const w = []; let acc = 0;
  for (let i = 0; i <= n; i++) { acc += randn(); w.push(acc); }
  const wn = w[n];
  const kids = [];
  for (let i = 0; i < n; i++) {
    const ko = i === 0 ? o : parent.o + (c - o) * (i / n) + (w[i] - wn * (i / n)) * sigma * 0.9;
    const kc = parent.o + (c - o) * ((i + 1) / n) + (w[i + 1] - wn * ((i + 1) / n)) * sigma * 0.9;
    let hi = Math.max(ko, kc) + Math.abs(randn()) * sigma * 0.62;
    let lo = Math.min(ko, kc) - Math.abs(randn()) * sigma * 0.62;
    kids.push({ t: tStart + i * tfMs, o: ko, h: hi, l: lo, c: kc, v: Math.floor(n * 55 + Math.abs(randn()) * 140 + range * 4000) });
  }
  let iMax = 0, iMin = 0;
  for (let i = 0; i < n; i++) { if (kids[i].h > kids[iMax].h) iMax = i; if (kids[i].l < kids[iMin].l) iMin = i; }
  kids[iMax].h = Math.max(kids[iMax].h, parent.h);
  kids[iMin].l = Math.min(kids[iMin].l, parent.l);
  return kids;
}

function genHistory() {
  srand(20240607 ^ Date.now() % 100000);
  const now = Date.now();
  const day0 = Math.floor(now / DAY) * DAY;
  const m1Start = day0 - 10 * DAY;
  const h1Start = day0 - 90 * DAY;
  const d1Count = 400, h1Days = 90;

  for (const name of SYM_NAMES) {
    const S = SYMBOLS[name];
    const target = S.price;
    const dSigma = target * S.dvol;
    const dig = S.digits;

    // 1) Daily parent bars: h1Start-400d .. day0-1d (490 bars)
    const d1Full = [];
    let p = target - dSigma * randn() * 8;
    for (let i = 0; i < d1Count + h1Days; i++) {
      const t = h1Start - (d1Count - i) * DAY;
      const o = p;
      const c = o + dSigma * randn() * (rand() < 0.06 ? 2.4 : 1);
      const hi = Math.max(o, c) + Math.abs(randn()) * dSigma * 0.45;
      const lo = Math.min(o, c) - Math.abs(randn()) * dSigma * 0.45;
      p = c + dSigma * 0.15 * randn();
      d1Full.push({ t, o, h: hi, l: lo, c });
    }
    // drift the last 10 parents so the series lands on target
    const shift = target - d1Full[d1Full.length - 1].c;
    for (let i = 0; i < d1Full.length; i++) {
      const w = i < d1Full.length - 10 ? 0 : (i - (d1Full.length - 10)) / 10;
      d1Full[i].o += shift * w; d1Full[i].c += shift * w; d1Full[i].h += shift * w; d1Full[i].l += shift * w;
    }
    S.d1 = d1Full.slice(0, d1Count).map(b => ({ t: b.t, o: r(b.o, dig), h: r(b.h, dig), l: r(b.l, dig), c: r(b.c, dig), v: Math.floor(90000 + Math.abs(randn()) * 25000) }));

    // 2) Hourly bars: subdivide the last 90 daily parents + synthetic "today so far"
    const yC = d1Full[d1Full.length - 1].c;
    const today = {
      t: day0, o: yC, c: target,
      h: Math.max(yC, target) + Math.abs(randn()) * dSigma * 0.3,
      l: Math.min(yC, target) - Math.abs(randn()) * dSigma * 0.3,
    };
    const elapsedH = Math.floor((now - day0) / HOUR); // completed hours today
    const parents = d1Full.slice(-h1Days).map(b => ({ t: b.t, o: r(b.o, dig), h: r(b.h, dig), l: r(b.l, dig), c: r(b.c, dig) }));
    const h1All = [];
    for (const dbar of parents) {
      for (const k of subdivide(dbar, 24, HOUR, dbar.t)) {
        h1All.push({ t: k.t, o: r(k.o, dig), h: r(k.h, dig), l: r(k.l, dig), c: r(k.c, dig), v: Math.floor(k.v * 3.2) });
      }
    }
    const todayHours = [];
    if (elapsedH >= 1) {
      for (const k of subdivide(today, elapsedH, HOUR, day0)) {
        todayHours.push({ t: k.t, o: r(k.o, dig), h: r(k.h, dig), l: r(k.l, dig), c: r(k.c, dig), v: Math.floor(k.v * 3.2) });
      }
    }
    S.h1 = h1All.filter(b => b.t < m1Start);

    // 3) Minute bars for the last 10 days (complete hours) + current hour partial
    const m1 = [];
    const hourParents = h1All.filter(b => b.t >= m1Start).concat(todayHours);
    for (const hbar of hourParents) {
      for (const k of subdivide(hbar, 60, MIN, hbar.t)) {
        m1.push({ t: k.t, o: r(k.o, dig), h: r(k.h, dig), l: r(k.l, dig), c: r(k.c, dig), v: Math.floor(k.v * 2.4) });
      }
    }
    // current hour -> completed minutes
    const nowHour = day0 + elapsedH * HOUR;
    const curMin = Math.max(0, Math.floor((now - nowHour) / MIN));
    let seedPrice = m1.length ? m1[m1.length - 1].c : yC;
    if (curMin >= 1) {
      const curHour = { t: nowHour, o: seedPrice, c: seedPrice + dSigma / 60 * randn() * 2, h: 0, l: 0 };
      curHour.h = Math.max(curHour.o, curHour.c) + Math.abs(randn()) * dSigma / 60;
      curHour.l = Math.min(curHour.o, curHour.c) - Math.abs(randn()) * dSigma / 60;
      for (const k of subdivide(curHour, curMin, MIN, nowHour)) {
        m1.push({ t: k.t, o: r(k.o, dig), h: r(k.h, dig), l: r(k.l, dig), c: r(k.c, dig), v: Math.floor(k.v * 2.4) });
      }
      seedPrice = m1[m1.length - 1].c;
    }
    S.m1 = m1;

    // 4) live state
    S.mid = seedPrice;
    S.volMult = 1; S.trend = 0; S.spike = 0;
    S.curBar = { t: nowHour + curMin * MIN, o: seedPrice, h: seedPrice, l: seedPrice, c: seedPrice, v: 0 };
  }
}

/* ---------------- Aggregation ---------------- */
function aggregate(bars, tfSec) {
  const out = [];
  let cur = null, curKey = -1;
  for (const b of bars) {
    const key = Math.floor(b.t / (tfSec * 1000));
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = { t: key * tfSec * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      curKey = key;
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l);
      cur.c = b.c; cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function historyFor(symbol, tf, limit) {
  const S = SYMBOLS[symbol];
  if (!S) return null;
  const tfSec = TF_MAP[tf];
  if (!tfSec) return null;
  let bars;
  if (tf === 'M1') bars = S.m1.concat([S.curBar]);
  else if (tf === 'M5' || tf === 'M15' || tf === 'M30') bars = aggregate(S.m1.concat([S.curBar]), tfSec);
  else if (tf === 'H1' || tf === 'H4') bars = aggregate(S.h1.concat(aggregate(S.m1.concat([S.curBar]), 3600)), tfSec);
  else bars = S.d1.concat(aggregate(S.h1.concat(aggregate(S.m1.concat([S.curBar]), 3600)), 86400));
  if (limit && bars.length > limit) bars = bars.slice(-limit);
  return bars;
}
const TF_MAP = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };

/* ---------------- Tick engine ---------------- */
function sigmaTick(S) {
  return S.mid * S.dvol / Math.sqrt(1440 * (60000 / TICK_MS));
}
function doTick() {
  const now = Date.now();
  const minute = Math.floor(now / MIN) * MIN;
  const ticks = [];
  for (const name of SYM_NAMES) {
    const S = SYMBOLS[name];
    // regime / volatility spikes
    if (S.spike > 0) { S.spike--; if (S.spike === 0) S.volMult = 1; }
    else if (rand() < 0.0012) { S.spike = 150 + Math.floor(rand() * 900); S.volMult = 1.4 + rand() * 2.2; }
    const sg = sigmaTick(S) * S.volMult;
    if (cheatActiveFor(name)) {
      // forced pattern: slow run in cheat direction (20s) -> brief counter-dip (5s) -> repeat
      const el = now - cheat.phaseStart;
      if (cheat.phase === 'run' && el > CHEAT_RUN_MS) { cheat.phase = 'dip'; cheat.phaseStart = now; broadcastAdmin(); }
      else if (cheat.phase === 'dip' && el > CHEAT_DIP_MS) { cheat.phase = 'run'; cheat.phaseStart = now; broadcastAdmin(); }
      const dir = cheat.mode === 'buy' ? 1 : -1;
      S.mid += (cheat.phase === 'run' ? dir * sg * 5.0 : -dir * sg * 6.0) + sg * 0.35 * randn();
    } else {
      S.trend += -S.trend * 0.012 + randn() * 0.05;
      if (S.trend > 1.6) S.trend = 1.6; if (S.trend < -1.6) S.trend = -1.6;
      S.mid += S.trend * sg * 0.33 + sg * randn();
    }

    const half = S.spread * S.pip / 2 * (1 + 0.25 * Math.abs(randn()) * (rand() < 0.02 ? 4 : 1));
    S.bid = r(S.mid - half, S.digits);
    S.ask = r(S.mid + half, S.digits);
    ticks.push({ s: name, b: S.bid, a: S.ask });

    // build M1 bars
    const cb = S.curBar;
    if (minute > cb.t) {
      cb.v = Math.max(cb.v, 1);
      S.m1.push(cb);
      if (S.m1.length > 22000) S.m1.splice(0, 4000);
      S.curBar = { t: minute, o: S.mid, h: S.mid, l: S.mid, c: S.mid, v: 0 };
      broadcastBar(name, S.curBar, cb);
    } else {
      cb.h = Math.max(cb.h, S.bid); cb.l = Math.min(cb.l, S.bid); cb.c = S.mid; cb.v++;
    }
  }
  broadcast({ event: 'tick', data: { t: now, ticks } });
  engineCheck();
  botStep();
}

/* ---------------- Account / Trading engine ---------------- */
function loadAccount() {
  try {
    const j = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    if (j && typeof j.balance === 'number') return j;
  } catch (e) { /* fresh */ }
  return {
    login: 88419220, name: 'Omya Trade Markets Ltd', currency: 'IDR', leverage: LEVERAGE,
    balance: 20000000.00, credit: 0,
    positions: [], orders: [], history: [],
    nextTicket: 910034571,
  };
}
const account = loadAccount();
let saveTimer = null;
function saveAccount() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(account));
    } catch (e) { console.error('persist failed', e.message); }
  }, 700);
}

function priceOf(sym) { const S = SYMBOLS[sym]; return { bid: S.bid, ask: S.ask }; }

/* account-currency conversion (account is IDR-denominated; P/L is computed
   in USD then converted at the live USDIDR rate - like a real IDR account) */
function acctRate() {
  return account.currency === 'IDR' ? (SYMBOLS['USDIDR'].mid || 16245) : 1;
}

function baseToUSD(sym, price) {
  const S = SYMBOLS[sym];
  switch (S.base) {
    case 'USD': return 1;
    case 'EUR': return SYMBOLS['EURUSD'].mid;
    case 'GBP': return SYMBOLS['GBPUSD'].mid;
    case 'AUD': return SYMBOLS['AUDUSD'].mid;
    case 'NZD': return SYMBOLS['NZDUSD'].mid;
    case 'JPY': return 1 / SYMBOLS['USDJPY'].mid;
    case 'CHF': return 1 / SYMBOLS['USDCHF'].mid;
    case 'CAD': return 1 / SYMBOLS['USDCAD'].mid;
    case 'IDR': return 1 / (SYMBOLS['USDIDR'].mid || 16245);
    default: return price; // XAU, XAG, BTC, ETH, WBS — quoted in USD per unit
  }
}
function quoteToUSD(sym, price) {
  const S = SYMBOLS[sym];
  switch (S.quote) {
    case 'USD': return 1;
    case 'JPY': return 1 / SYMBOLS['USDJPY'].mid;
    case 'CHF': return 1 / SYMBOLS['USDCHF'].mid;
    case 'CAD': return 1 / SYMBOLS['USDCAD'].mid;
    case 'EUR': return SYMBOLS['EURUSD'].mid;
    case 'IDR': return 1 / (SYMBOLS['USDIDR'].mid || 16245);
    default: return 1;
  }
}
function positionPL(p) {
  const S = SYMBOLS[p.symbol];
  const { bid, ask } = priceOf(p.symbol);
  const cur = p.side === 'buy' ? bid : ask;
  const diff = (cur - p.openPrice) * (p.side === 'buy' ? 1 : -1);
  return diff * S.contract * p.volume * quoteToUSD(p.symbol, cur) * acctRate();
}
function marginOf(sym, volume, price) {
  const S = SYMBOLS[sym];
  const notional = S.contract * volume * baseToUSD(sym, price || S.mid);
  return notional / account.leverage * acctRate();
}
function usedMargin() {
  let m = 0;
  for (const p of account.positions) m += marginOf(p.symbol, p.volume, p.openPrice);
  return m;
}
function floatingPL() {
  let f = 0;
  for (const p of account.positions) f += positionPL(p);
  return f;
}
function snapshot() {
  const bal = account.balance;
  const fl = floatingPL();
  const eq = bal + fl;
  const um = usedMargin();
  const fm = eq - um;
  return {
    login: account.login, leverage: account.leverage, currency: account.currency,
    balance: r(bal, 2), equity: r(eq, 2), margin: r(um, 2), freeMargin: r(fm, 2),
    marginLevel: um > 0 ? r(eq / um * 100, 1) : 0,
    floating: r(fl, 2),
    positions: account.positions.map(p => ({
      ticket: p.ticket, symbol: p.symbol, side: p.side, volume: p.volume,
      openPrice: p.openPrice, openTime: p.openTime, sl: p.sl, tp: p.tp,
      swap: p.swap, commission: p.commission,
      current: (p.side === 'buy' ? SYMBOLS[p.symbol].bid : SYMBOLS[p.symbol].ask),
      profit: r(positionPL(p), 2),
    })),
    orders: account.orders.map(o => ({
      ticket: o.ticket, symbol: o.symbol, type: o.type, volume: o.volume,
      price: o.price, sl: o.sl, tp: o.tp, placedTime: o.placedTime,
      current: (o.type.indexOf('buy') === 0 ? SYMBOLS[o.symbol].ask : SYMBOLS[o.symbol].bid),
    })),
  };
}

const STOP_LEVEL_PIPS = 2; // min distance for SL/TP/pending
function validStops(sym, side, price, sl, tp, ref) {
  const S = SYMBOLS[sym];
  const minDist = STOP_LEVEL_PIPS * S.pip;
  if (sl && sl > 0) {
    if (side === 'buy' && !(sl <= ref - minDist)) return 'Invalid S/L';
    if (side === 'sell' && !(sl >= ref + minDist)) return 'Invalid S/L';
  }
  if (tp && tp > 0) {
    if (side === 'buy' && !(tp >= ref + minDist)) return 'Invalid T/P';
    if (side === 'sell' && !(tp <= ref - minDist)) return 'Invalid T/P';
  }
  return null;
}
function validVolume(v) {
  if (typeof v !== 'number' || isNaN(v) || v < 0.01 || v > 200) return false;
  return Math.abs(v / 0.01 - Math.round(v / 0.01)) < 1e-6;
}
function checkFreeMargin(sym, volume) {
  const need = marginOf(sym, volume) * 1.05;
  const { freeMargin } = snapshot();
  if (need > freeMargin) return false;
  return true;
}
function symbol(s) { return s; }

function openPosition(sym, side, volume, price, sl, tp, reason) {
  const t = account.nextTicket++;
  account.positions.push({
    ticket: t, symbol: sym, side, volume, openPrice: price,
    openTime: Date.now(), sl: sl || 0, tp: tp || 0, swap: 0, commission: 0, comment: reason || '',
  });
  return t;
}
function closePositionObj(p, price, reason) {
  const profit = (() => {
    const S = SYMBOLS[p.symbol];
    const diff = (price - p.openPrice) * (p.side === 'buy' ? 1 : -1);
    return diff * S.contract * p.volume * quoteToUSD(p.symbol, price) * acctRate();
  })();
  account.balance += profit;
  account.positions = account.positions.filter(x => x.ticket !== p.ticket);
  account.history.unshift({
    ticket: account.nextTicket++, positionTicket: p.ticket, symbol: p.symbol, side: p.side,
    volume: p.volume, openPrice: p.openPrice, closePrice: price,
    openTime: p.openTime, closeTime: Date.now(), profit: r(profit, 2),
    swap: 0, commission: 0, reason: reason || 'manual',
  });
  if (account.history.length > 500) account.history.length = 500;
  return profit;
}
function notifyDeal(type, extra) {
  broadcast({ event: 'deal', data: Object.assign({ type, time: Date.now() }, extra || {}) });
}

function engineCheck() {
  let changed = false;
  // pending order triggers
  for (const o of [...account.orders]) {
    const S = SYMBOLS[o.symbol];
    const { bid, ask } = priceOf(o.symbol);
    let hit = false;
    if (o.type === 'buy limit') hit = ask <= o.price;
    else if (o.type === 'sell limit') hit = bid >= o.price;
    else if (o.type === 'buy stop') hit = ask >= o.price;
    else if (o.type === 'sell stop') hit = bid <= o.price;
    if (hit) {
      const fill = o.type.indexOf('buy') === 0 ? ask : bid;
      const slip = (o.type.indexOf('buy') === 0 ? 1 : -1) * Math.abs(randn()) * S.pip * 0.3;
      const fp = r(fill + slip, S.digits);
      if (!checkFreeMargin(o.symbol, o.volume)) {
        account.orders = account.orders.filter(x => x.ticket !== o.ticket);
        notifyDeal('rejected', { message: 'Not enough money', ticket: o.ticket, symbol: o.symbol });
      } else {
        account.orders = account.orders.filter(x => x.ticket !== o.ticket);
        openPosition(o.symbol, o.type.indexOf('buy') === 0 ? 'buy' : 'sell', o.volume, fp, o.sl, o.tp, 'pending');
        notifyDeal('pending_filled', { ticket: o.ticket, symbol: o.symbol, volume: o.volume, price: fp, side: o.type.indexOf('buy') === 0 ? 'buy' : 'sell' });
      }
      changed = true;
    }
  }
  // SL / TP + stop-out
  for (const p of [...account.positions]) {
    const S = SYMBOLS[p.symbol];
    const { bid, ask } = priceOf(p.symbol);
    let closed = null;
    if (p.side === 'buy') {
      if (p.sl > 0 && bid <= p.sl) closed = { price: p.sl - Math.abs(randn()) * S.pip * 0.4, reason: 'sl' };
      else if (p.tp > 0 && bid >= p.tp) closed = { price: p.tp, reason: 'tp' };
    } else {
      if (p.sl > 0 && ask >= p.sl) closed = { price: p.sl + Math.abs(randn()) * S.pip * 0.4, reason: 'sl' };
      else if (p.tp > 0 && ask <= p.tp) closed = { price: p.tp, reason: 'tp' };
    }
    if (closed) {
      const profit = closePositionObj(p, r(closed.price, S.digits), closed.reason);
      notifyDeal(closed.reason === 'tp' ? 'tp_hit' : 'sl_hit', { ticket: p.ticket, symbol: p.symbol, volume: p.volume, price: r(closed.price, S.digits), profit: r(profit, 2), side: p.side });
      changed = true;
    }
  }
  // margin stop-out at 20%
  const snap = snapshot();
  if (snap.positions.length > 0 && snap.margin > 0 && snap.marginLevel <= 20) {
    let worst = null, worstPL = 0;
    for (const p of account.positions) { const pl = positionPL(p); if (!worst || pl < worstPL) { worst = p; worstPL = pl; } }
    if (worst) {
      const S = SYMBOLS[worst.symbol];
      const { bid, ask } = priceOf(worst.symbol);
      const price = worst.side === 'buy' ? bid : ask;
      const profit = closePositionObj(worst, price, 'stopout');
      notifyDeal('stopout', { ticket: worst.ticket, symbol: worst.symbol, volume: worst.volume, price, profit: r(profit, 2) });
      changed = true;
    }
  }
  if (changed) { broadcastAccount(); saveAccount(); }
}

/* ---------------- API ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS });
  res.end(body);
}
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
};
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > limit) { req.destroy(); resolve({}); } });
    req.on('end', () => { try { const j = d ? JSON.parse(d) : {}; resolve(j && typeof j === 'object' ? j : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
/* Same-origin enforcement for state-changing requests (CSRF hardening; the
   browser front-end is served from this very origin, so cross-site POSTs are never legitimate). */
function sameOrigin(req) {
  const origin = req.headers.origin || (req.headers.referer ? (() => { try { return new URL(req.headers.referer).origin; } catch (e) { return null; } })() : null);
  if (!origin) return true; // non-browser clients (curl etc.) — bearer token is still required
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

async function handleAPI(req, res, url) {
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, SEC_HEADERS); return res.end(); }
  if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'Cross-origin request rejected' });

  /* ----- public: login ----- */
  if (p === '/api/auth/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const body = await readBody(req, 4096);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!USERNAME_RE.test(username) || !password || password.length > PASSWORD_MAX) {
      recordFail('ip:' + ip, LOGIN_MAX_PER_IP);
      await sleep(300);
      return json(res, 400, { error: 'Invalid account or password' });
    }
    if (isLocked('ip:' + ip, LOGIN_MAX_PER_IP) || isLocked('user:' + username, LOGIN_MAX_PER_USER)) {
      res.setHeader('Retry-After', String(Math.ceil(LOCKOUT_MS / 1000)));
      return json(res, 429, { error: 'Too many login attempts. Try again later.' });
    }
    const u = USERS[username];
    const ok = u ? verifyPassword(password, u) : (verifyPassword(password, DUMMY_PW), false);
    if (!ok) {
      recordFail('ip:' + ip, LOGIN_MAX_PER_IP);
      recordFail('user:' + username, LOGIN_MAX_PER_USER);
      console.warn(`[omya] failed login user="${username}" ip=${ip}`);
      await sleep(300 + Math.floor(Math.random() * 200));
      return json(res, 401, { error: 'Invalid account or password' });
    }
    clearFails('ip:' + ip); clearFails('user:' + username);
    const tok = makeToken();
    const now = Date.now();
    sessions.set(tokenHash(tok), { user: username, role: u.role, name: u.name, loginAt: now, lastSeen: now, ip });
    saveSessions();
    console.log(`[omya] login user="${username}" role=${u.role} ip=${ip}`);
    return json(res, 200, { ok: true, token: tok, role: u.role, name: u.name, login: account.login, server: SERVER_NAME });
  }

  const sess = sessionOf(req, url);
  if (p === '/api/auth/check') {
    if (!sess) return json(res, 401, { error: 'Unauthorized' });
    return json(res, 200, { ok: true, role: sess.role, name: sess.name, user: sess.user });
  }
  if (!sess) return json(res, 401, { error: 'Unauthorized' });
  if (p === '/api/auth/logout' && req.method === 'POST') {
    sessions.delete(sess.token);
    saveSessions();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/auth/logout-all' && req.method === 'POST') {
    revokeUserSessions(sess.user);
    return json(res, 200, { ok: true });
  }

  /* ----- admin ----- */
  if (p.startsWith('/api/admin/')) {
    if (sess.role !== 'admin') return json(res, 403, { error: 'Forbidden' });
    if (p === '/api/admin/login' && req.method === 'POST') {
      // Re-authentication (step-up) for the admin console. Never escalates a role.
      const ip = clientIp(req);
      if (isLocked('user:' + sess.user, LOGIN_MAX_PER_USER)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
      const body = await readBody(req, 4096);
      const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const u = USERS[username];
      const ok = username === sess.user && u && u.role === 'admin' && password.length <= PASSWORD_MAX && verifyPassword(password, u);
      if (!ok) {
        recordFail('user:' + sess.user, LOGIN_MAX_PER_USER);
        console.warn(`[omya] failed admin re-auth user="${sess.user}" ip=${ip}`);
        await sleep(300);
        return json(res, 401, { error: 'Invalid administrator credentials' });
      }
      clearFails('user:' + sess.user);
      return json(res, 200, { ok: true, role: 'admin' });
    }
    if (p === '/api/admin/state') return json(res, 200, adminState());
    if (p === '/api/admin/deposit' && req.method === 'POST') {
      const { amount } = await readBody(req);
      if (typeof amount !== 'number' || isNaN(amount) || Math.abs(amount) > 1e12) return json(res, 400, { error: 'Invalid amount' });
      account.balance = Math.max(0, r(account.balance + amount, 2));
      broadcastAccount(); saveAccount(); broadcastAdmin();
      return json(res, 200, { ok: true, balance: account.balance });
    }
    if (p === '/api/admin/cheat' && req.method === 'POST') {
      const { mode, symbol } = await readBody(req);
      if (mode !== 'off' && !SYMBOLS[symbol]) return json(res, 400, { error: 'Unknown symbol' });
      setManualCheat(mode, symbol);
      return json(res, 200, { ok: true, state: adminState().cheat });
    }
    if (p === '/api/admin/bot' && req.method === 'POST') {
      const { enabled, symbol, lots } = await readBody(req);
      if (typeof enabled !== 'boolean') return json(res, 400, { error: 'Invalid payload' });
      if (enabled) {
        if (!SYMBOLS[symbol]) return json(res, 400, { error: 'Unknown symbol' });
        if (!validVolume(lots)) return json(res, 400, { error: 'Invalid volume' });
        bot.symbol = symbol; bot.lots = lots;
      }
      bot.enabled = enabled;
      if (!enabled) {
        if (bot.ticket) {
          const p2 = account.positions.find(x => x.ticket === bot.ticket);
          if (p2) {
            const { bid, ask } = priceOf(p2.symbol);
            closePositionObj(p2, p2.side === 'buy' ? bid : ask, 'manual');
          }
          bot.ticket = null; bot.side = null;
        }
        if (cheat.source === 'bot') { cheat.symbol = null; cheat.mode = null; cheat.source = null; }
      }
      broadcastAccount(); saveAccount(); broadcastAdmin();
      return json(res, 200, { ok: true, state: adminState() });
    }
    return json(res, 404, { error: 'Not found' });
  }

  if (p === '/api/bootstrap' && req.method === 'GET') {
    return json(res, 200, {
      server: { name: SERVER_NAME, time: Date.now(), leverage: LEVERAGE },
      symbols: SYM_NAMES.map(n => {
        const S = SYMBOLS[n];
        return { symbol: n, cat: S.cat, disp: S.disp, digits: S.digits, pip: S.pip, spread: S.spread, contract: S.contract, quote: S.quote, base: S.base };
      }),
      account: snapshot(),
      history: account.history,
    });
  }
  if (p === '/api/history' && req.method === 'GET') {
    const q = url.searchParams;
    const bars = historyFor(q.get('symbol'), q.get('tf') || 'M1', parseInt(q.get('limit') || '3000', 10));
    if (!bars) return json(res, 400, { error: 'bad symbol/tf' });
    return json(res, 200, { symbol: q.get('symbol'), tf: q.get('tf') || 'M1', bars });
  }
  if (p === '/api/deals' && req.method === 'GET') return json(res, 200, { history: account.history });

  const body = await readBody(req);
  if (p === '/api/order' && req.method === 'POST') {
    const { symbol: sym, side, volume, sl, tp } = body;
    const S = SYMBOLS[sym];
    if (!S) return json(res, 400, { error: 'Unknown symbol' });
    if (!validVolume(volume)) return json(res, 400, { error: 'Invalid volume' });
    if (side !== 'buy' && side !== 'sell') return json(res, 400, { error: 'Invalid side' });
    const { bid, ask } = priceOf(sym);
    const ref = side === 'buy' ? ask : bid;
    const vs = validStops(sym, side, 0, sl, tp, ref);
    if (vs) return json(res, 400, { error: vs });
    if (!checkFreeMargin(sym, volume)) return json(res, 400, { error: 'Not enough money' });
    const slip = (side === 'buy' ? 1 : -1) * Math.abs(randn()) * S.pip * 0.25;
    const price = r(ref + slip, S.digits);
    const t = openPosition(sym, side, volume, price, sl, tp, 'market');
    broadcastAccount(); saveAccount();
    notifyDeal('executed', { ticket: t, symbol: sym, side, volume, price, sl: sl || 0, tp: tp || 0 });
    return json(res, 200, { ok: true, ticket: t, price });
  }
  if (p === '/api/pending' && req.method === 'POST') {
    const { symbol: sym, type, volume, price, sl, tp } = body;
    const S = SYMBOLS[sym];
    if (!S) return json(res, 400, { error: 'Unknown symbol' });
    if (!validVolume(volume)) return json(res, 400, { error: 'Invalid volume' });
    if (!['buy limit', 'sell limit', 'buy stop', 'sell stop'].includes(type)) return json(res, 400, { error: 'Invalid order type' });
    if (typeof price !== 'number' || price <= 0) return json(res, 400, { error: 'Invalid price' });
    const { bid, ask } = priceOf(sym);
    const ref = type.indexOf('buy') === 0 ? ask : bid;
    const minDist = STOP_LEVEL_PIPS * S.pip;
    if (type === 'buy limit' && !(price <= ref - minDist)) return json(res, 400, { error: 'Invalid price' });
    if (type === 'sell limit' && !(price >= ref + minDist)) return json(res, 400, { error: 'Invalid price' });
    if (type === 'buy stop' && !(price >= ref + minDist)) return json(res, 400, { error: 'Invalid price' });
    if (type === 'sell stop' && !(price <= ref - minDist)) return json(res, 400, { error: 'Invalid price' });
    const vs = validStops(sym, type.indexOf('buy') === 0 ? 'buy' : 'sell', 0, sl, tp, price);
    if (vs) return json(res, 400, { error: vs });
    const t = account.nextTicket++;
    account.orders.push({ ticket: t, symbol: sym, type, volume, price: r(price, S.digits), sl: sl || 0, tp: tp || 0, placedTime: Date.now() });
    broadcastAccount(); saveAccount();
    notifyDeal('placed', { ticket: t, symbol: sym, type, volume, price: r(price, S.digits) });
    return json(res, 200, { ok: true, ticket: t });
  }
  if (p === '/api/position/close' && req.method === 'POST') {
    const { ticket, volume } = body;
    const p = account.positions.find(x => x.ticket === ticket);
    if (!p) return json(res, 404, { error: 'Position not found' });
    const S = SYMBOLS[p.symbol];
    const { bid, ask } = priceOf(p.symbol);
    let vol = p.volume;
    if (typeof volume === 'number' && volume > 0 && volume < p.volume) {
      if (!validVolume(volume)) return json(res, 400, { error: 'Invalid volume' });
      // partial close
      const price = p.side === 'buy' ? bid : ask;
      const diff = (price - p.openPrice) * (p.side === 'buy' ? 1 : -1);
      const profit = diff * S.contract * volume * quoteToUSD(p.symbol, price) * acctRate();
      account.balance += profit;
      p.volume = r(p.volume - volume, 2);
      account.history.unshift({
        ticket: account.nextTicket++, positionTicket: p.ticket, symbol: p.symbol, side: p.side,
        volume, openPrice: p.openPrice, closePrice: price, openTime: p.openTime, closeTime: Date.now(),
        profit: r(profit, 2), swap: 0, commission: 0, reason: 'manual',
      });
      broadcastAccount(); saveAccount();
      notifyDeal('closed', { ticket: p.ticket, symbol: p.symbol, volume, price, profit: r(profit, 2), partial: true });
      return json(res, 200, { ok: true, profit: r(profit, 2) });
    }
    const price = p.side === 'buy' ? bid : ask;
    const profit = closePositionObj(p, price, 'manual');
    broadcastAccount(); saveAccount();
    notifyDeal('closed', { ticket: p.ticket, symbol: p.symbol, volume: vol, price, profit: r(profit, 2) });
    return json(res, 200, { ok: true, profit: r(profit, 2) });
  }
  if (p === '/api/position/modify' && req.method === 'POST') {
    const { ticket, sl, tp } = body;
    const p = account.positions.find(x => x.ticket === ticket);
    if (!p) return json(res, 404, { error: 'Position not found' });
    const { bid, ask } = priceOf(p.symbol);
    const ref = p.side === 'buy' ? bid : ask;
    const vs = validStops(p.symbol, p.side, 0, sl, tp, ref);
    if (vs) return json(res, 400, { error: vs });
    p.sl = sl || 0; p.tp = tp || 0;
    broadcastAccount(); saveAccount();
    notifyDeal('modified', { ticket: p.ticket, symbol: p.symbol, sl: p.sl, tp: p.tp });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/order/cancel' && req.method === 'POST') {
    const { ticket } = body;
    const before = account.orders.length;
    account.orders = account.orders.filter(x => x.ticket !== ticket);
    if (account.orders.length === before) return json(res, 404, { error: 'Order not found' });
    broadcastAccount(); saveAccount();
    notifyDeal('cancelled', { ticket });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/positions/closeall' && req.method === 'POST') {
    let total = 0;
    for (const p of [...account.positions]) {
      const S = SYMBOLS[p.symbol];
      const { bid, ask } = priceOf(p.symbol);
      const price = p.side === 'buy' ? bid : ask;
      total += closePositionObj(p, price, 'manual');
    }
    broadcastAccount(); saveAccount();
    notifyDeal('closed_all', { profit: r(total, 2) });
    return json(res, 200, { ok: true, profit: r(total, 2) });
  }
  return json(res, 404, { error: 'Not found' });
}

/* ---------------- SSE ---------------- */
const sseClients = new Set();
function sseInit(req, res, url) {
  if (!sessionOf(req, url, { allowQuery: true })) { res.writeHead(401, { 'Content-Type': 'text/plain', ...SEC_HEADERS }); return res.end('Unauthorized'); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SEC_HEADERS,
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  broadcastAccount(res);
  req.on('close', () => sseClients.delete(res));
}
function broadcast({ event, data }) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(frame); } catch (e) { sseClients.delete(res); } }
}
function broadcastAccount(single) {
  const frame = `event: account\ndata: ${JSON.stringify(snapshot())}\n\n`;
  const targets = single ? [single] : sseClients;
  for (const res of targets) { try { res.write(frame); } catch (e) { sseClients.delete(res); } }
}
function broadcastBar(sym, newBar, closedBar) {
  broadcast({ event: 'bar', data: { s: sym, bar: newBar, closed: closedBar } });
}

/* ---------------- Static files ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};
const PUB = path.join(__dirname, 'public');
function serveStatic(req, res, url) {
  let fp = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  fp = path.normalize(fp).replace(/^(\.\.[/\\])+/, '');
  const abs = path.join(PUB, fp);
  if (!abs.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(abs, (err, buf) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUB, 'index.html'), (e2, b2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); }
        else { res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', ...SEC_HEADERS }); res.end(b2); }
      });
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache', ...SEC_HEADERS });
    res.end(buf);
  });
}

/* ---------------- Server ---------------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/stream') return sseInit(req, res, url);
  if (url.pathname.startsWith('/api/')) return void handleAPI(req, res, url).catch(e => { try { json(res, 500, { error: e.message }); } catch (_) {} });
  serveStatic(req, res, url);
});
server.listen(PORT, HOST, () => console.log(`[omya] ${SERVER_NAME} listening on http://${HOST}:${PORT}`));

/* ---------------- Boot ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
loadSessions();
genHistory();
// seed live prices so the very first snapshot is consistent
doTick();
setInterval(doTick, TICK_MS);
setInterval(() => { broadcastAccount(); }, 2000);
setInterval(() => { for (const res of sseClients) { try { res.write(': ping\n\n'); } catch (e) {} } }, 15000);

/* ============================================================
   OMYA TRADE — Admin control module
   Secret page (logo ×3) · treasury · autoplay bot · chart flow
   ============================================================ */
'use strict';

let ctx = null;          // { api, toast, $, $$, S, fmtMoney, sfx, getSymbol }
let pollTimer = null;
let lastState = null;

export function initAdmin(context) {
  ctx = context;
  const { $, S } = ctx;

  window.__tryOpenAdmin = tryOpenAdmin;
  window.__adminRefresh = () => refresh(true);

  $('#admin-close').onclick = closeAdmin;
  $('#admin-page').addEventListener('click', e => { if (e.target.id === 'admin-page') closeAdmin(); });

  // admin credential form
  $('#admin-login-form').onsubmit = async e => {
    e.preventDefault();
    try {
      await ctx.api('/api/admin/login', { username: $('#admin-user').value.trim(), password: $('#admin-pass').value });
      S.user = { role: 'admin', name: 'Administrator' };
      $('#admin-err').classList.add('hidden');
      ctx.toast('gold', 'Access granted', 'Welcome, Administrator.');
      renderDash();
    } catch (err) {
      $('#admin-err').textContent = err.message;
      $('#admin-err').classList.remove('hidden');
    }
  };

  // treasury
  $$('.adm-chip').forEach(c => {
    c.onclick = () => { $('#adm-amount').value = c.dataset.amt; };
  });
  $('#adm-apply').onclick = async () => {
    const amt = parseFloat($('#adm-amount').value);
    if (isNaN(amt) || amt === 0) { ctx.toast('err', 'Invalid amount', 'Enter a non-zero amount.'); return; }
    try {
      const r = await ctx.api('/api/admin/deposit', { amount: amt });
      ctx.toast(amt > 0 ? 'ok' : 'info', amt > 0 ? 'Funds added' : 'Funds withdrawn', `New balance ${ctx.fmtMoney(r.balance)}`);
      $('#adm-amount').value = '';
    } catch (err) { ctx.toast('err', 'Failed', err.message); }
  };

  // bot
  $('#adm-bot-toggle').onchange = e => setBot(e.target.checked);
  $('#adm-bot-lots').onchange = () => { if ($('#adm-bot-toggle').checked) setBot(true); };

  // cheat (dashboard + orb)
  bindSeg('#adm-cheat', mode => setMode(mode));
  bindSeg('#orb-cheat', mode => setMode(mode));
  $('#orb-bot').onchange = e => setBot(e.target.checked);
  $('#orb-open-admin').onclick = () => { collapseOrb(); tryOpenAdmin(); };

  // orb dragging + tap
  setupOrb();

  // polling loop (only when visible)
  const loop = async () => {
    try {
      const overlayOpen = !$('#admin-page').classList.contains('hidden');
      const orbOn = !$('#cheat-orb').classList.contains('hidden');
      if (overlayOpen || orbOn) await refresh();
    } catch (e) {}
    pollTimer = setTimeout(loop, 1000);
  };
  loop();
}

/* ---------------- helpers ---------------- */
function bindSeg(sel, cb) {
  ctx.$$(sel + ' button').forEach(b => {
    b.onclick = () => { cb(b.dataset.mode); };
  });
}
async function setMode(mode) {
  try {
    await ctx.api('/api/admin/cheat', { mode, symbol: ctx.getSymbol() });
    ctx.toast('gold', mode === 'off' ? 'Flow control released' : `Flow control · ${mode.toUpperCase()}`,
      mode === 'off' ? 'Natural market flow restored.' : `${ctx.getSymbol()} will follow the ${mode === 'buy' ? 'up' : 'down'} pattern.`);
  } catch (err) { ctx.toast('err', 'Failed', err.message); }
}
async function setBot(on) {
  try {
    const lots = Math.max(0.01, parseFloat($('#adm-bot-lots').value) || 0.1);
    await ctx.api('/api/admin/bot', { enabled: on, symbol: ctx.getSymbol(), lots });
    ctx.toast(on ? 'ok' : 'info', on ? 'AutoPlay bot engaged' : 'AutoPlay bot stopped',
      on ? `Flow reader is scanning ${ctx.getSymbol()}…` : 'All bot positions closed.');
  } catch (err) { ctx.toast('err', 'Failed', err.message); }
}

/* ---------------- open / close page ---------------- */
function tryOpenAdmin() {
  const { $, S } = ctx;
  $('#admin-page').classList.remove('hidden');
  requestAnimationFrame(() => $('#admin-page').classList.add('show'));
  if (S.user?.role === 'admin') renderDash();
  else {
    $('#admin-dash').classList.add('hidden');
    $('#admin-login-view').classList.remove('hidden');
    setTimeout(() => $('#admin-user').focus(), 120);
  }
  refresh();
}
function closeAdmin() {
  const { $ } = ctx;
  $('#admin-page').classList.remove('show');
  setTimeout(() => $('#admin-page').classList.add('hidden'), 200);
}
function renderDash() {
  const { $, S } = ctx;
  $('#admin-login-view').classList.add('hidden');
  $('#admin-dash').classList.remove('hidden');
  $('#adm-who').textContent = S.user?.name || 'Administrator';
  $('#adm-balance').textContent = S.account ? ctx.fmtMoney(S.account.balance) : '—';
}

/* ---------------- state refresh ---------------- */
let refreshing = false;
export async function refresh(force) {
  if (!ctx || refreshing) return;
  refreshing = true;
  try {
    const st = await ctx.api('/api/admin/state');
    lastState = st;
    render(st, force);
  } catch (e) { /* ignore */ }
  refreshing = false;
}

function render(st) {
  const { $, S, fmtMoney } = ctx;
  const isAdmin = S.user?.role === 'admin';
  if (!isAdmin) { $('#cheat-orb').classList.add('hidden'); return; }

  // dashboard values
  $('#adm-balance').textContent = S.account ? fmtMoney(S.account.balance) : fmtMoney(st.balance);
  $('#adm-bot-symbol').textContent = st.bot.symbol;
  $('#adm-bot-lots').value = st.bot.lots.toFixed(2);
  $('#adm-opened').textContent = st.bot.opened;
  $('#adm-wins').textContent = st.bot.wins;
  const plEl = $('#adm-pl');
  plEl.textContent = fmtMoney(st.bot.pl);
  plEl.style.color = st.bot.pl > 0 ? 'var(--up)' : st.bot.pl < 0 ? 'var(--down)' : '';
  $('#adm-bot-toggle').checked = st.bot.enabled;
  $('#orb-bot').checked = st.bot.enabled;
  const bstat = st.bot.enabled
    ? (st.bot.hasPosition
      ? `Holding ${st.bot.side?.toUpperCase()} #${st.bot.ticket} — flow locked in favor, driving to TP…`
      : 'Reading order flow — entering next position…')
    : 'Standby.';
  $('#adm-bot-status').textContent = bstat;

  // cheat
  const active = !!st.cheat.mode;
  $('#adm-cheat-symbol').textContent = active ? st.cheat.symbol : ctx.getSymbol();
  $$('#adm-cheat button, #orb-cheat button').forEach(b => b.classList.toggle('active', b.dataset.mode === st.cheat.mode));
  const phaseTxt = active
    ? (st.cheat.phase === 'run' ? 'trending' : 'retrace')
    : 'idle';
  const secs = active ? Math.max(0, Math.ceil(st.cheat.msLeft / 1000)) : 0;
  const cstat = active
    ? `${st.cheat.mode.toUpperCase()} ${st.cheat.symbol} · ${phaseTxt} · ${st.cheat.phase === 'run' ? `slow ${st.cheat.mode === 'buy' ? 'rise' : 'fall'} — turns in ${secs}s` : `brief counter-move — resumes in ${secs}s`}`
    : 'Idle — natural market flow.';
  $('#adm-cheat-status').textContent = cstat;

  // orb visibility & content
  const orb = $('#cheat-orb');
  const showOrb = isAdmin && (st.bot.enabled || active);
  orb.classList.toggle('hidden', !showOrb);
  if (showOrb) {
    $('#orb-botstats').textContent = st.bot.enabled
      ? `Opened ${st.bot.opened} · Wins ${st.bot.wins} · P/L ${fmtMoney(st.bot.pl)}`
      : 'Bot offline';
    $('#orb-status').textContent = active ? `${st.cheat.mode.toUpperCase()} ${st.cheat.symbol} · ${phaseTxt} ${active ? secs + 's' : ''}` : 'Cheat idle';
  }
}

/* ---------------- draggable orb ---------------- */
function setupOrb() {
  const orb = ctx.$('#cheat-orb');
  const btn = ctx.$('#orb-btn');
  const panel = ctx.$('#orb-panel');
  let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, dragging = false;

  // default position
  orb.style.left = 'calc(100vw - 78px)';
  orb.style.top = '58vh';

  const place = (x, y) => {
    const r = orb.getBoundingClientRect();
    const w = panel.classList.contains('hidden') ? r.width : Math.max(r.width, 224);
    const cx = Math.min(Math.max(8, x), window.innerWidth - 64);
    const cy = Math.min(Math.max(8, y), window.innerHeight - 64);
    orb.style.left = cx + 'px';
    orb.style.top = cy + 'px';
    // panel flips above/below depending on space
    const spaceBelow = window.innerHeight - cy;
    panel.style.top = spaceBelow > 330 ? '62px' : 'auto';
    panel.style.bottom = spaceBelow > 330 ? 'auto' : '62px';
    panel.style.left = cx + window.innerWidth - cx - 236 < 0 ? '8px' : '0px';
  };

  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    btn.setPointerCapture(e.pointerId);
    const r = orb.getBoundingClientRect();
    ox = r.left; oy = r.top;
    sx = e.clientX; sy = e.clientY;
    moved = false; dragging = true;
    orb.classList.add('dragging');
  });
  btn.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
    if (moved) place(ox + dx, oy + dy);
  });
  const end = e => {
    if (!dragging) return;
    dragging = false;
    orb.classList.remove('dragging');
    if (!moved) togglePanel();
  };
  btn.addEventListener('pointerup', end);
  btn.addEventListener('pointercancel', end);

  function togglePanel() {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
      const r = orb.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.top;
      panel.style.top = spaceBelow > 340 ? '62px' : 'auto';
      panel.style.bottom = spaceBelow > 340 ? 'auto' : '62px';
      panel.style.left = (r.left + 250 > window.innerWidth) ? 'auto' : '0px';
      panel.style.right = (r.left + 250 > window.innerWidth) ? '0px' : 'auto';
      refresh(true);
    }
  }
  function collapseOrb() { panel.classList.add('hidden'); }
  window.__collapseOrb = collapseOrb;
}

function collapseOrb() { window.__collapseOrb?.(); }

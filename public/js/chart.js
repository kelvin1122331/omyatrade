/* ============================================================
   OMYA TRADE — Canvas chart engine
   Candlesticks / hollow / line / area + volume, crosshair,
   wheel & pinch zoom, drag pan, price overlays, countdown.
   ============================================================ */
'use strict';

const UP = '#2ebd85';
const DOWN = '#f6465d';
const GRID = 'rgba(148,163,196,0.07)';
const AXIS_TXT = '#5f6b80';
const AXIS_LINE = 'rgba(148,163,196,0.16)';
const CROSS = 'rgba(212,175,55,0.55)';
const FONT = '10px "JetBrains Mono", monospace';

function niceStep(range, n) {
  const raw = range / Math.max(n, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step;
  if (norm < 1.5) step = 1; else if (norm < 3) step = 2; else if (norm < 7) step = 5; else step = 10;
  return step * mag;
}
function fmtTimeAxis(t, tfSec, prevT) {
  const d = new Date(t);
  const p2 = n => String(n).padStart(2, '0');
  const dayNew = !prevT || new Date(prevT).getUTCDate() !== d.getUTCDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (dayNew) return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
  if (tfSec >= 86400) return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

export class CandleChart {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.bars = [];
    this.digits = 5;
    this.tfSec = 60;
    this.ctype = 'candles';
    this.showVolume = true;
    this.overlays = [];
    this.onCrosshair = opts.onCrosshair || (() => {});
    this.live = null; // {bid, ask, ts}

    // viewport
    this.spacing = 8;          // px per bar
    this.rightOffset = 0;      // bars of empty space at right
    this.follow = true;

    this.hover = null;         // {x, y, idx}
    this.dirty = true;
    this.pointers = new Map();
    this.pinD = 0;

    this.axisW = 66;
    this.axisH = 24;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement);
    this.resize();
    this.bind();
    this.loop();
  }

  /* ---------- sizing ---------- */
  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = Math.max(r.width, 50); this.h = Math.max(r.height, 50);
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.dpr = dpr;
    this.mark();
  }
  mark() { this.dirty = true; }
  loop() {
    const step = () => {
      if (this.dirty) { this.dirty = false; this.draw(); }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------- data ---------- */
  setData(bars, meta = {}) {
    this.bars = bars;
    if (meta.digits != null) this.digits = meta.digits;
    if (meta.tfSec != null) this.tfSec = meta.tfSec;
    this.follow = true; this.rightOffset = 0;
    this.mark();
  }
  setLive(l) { this.live = l; this.mark(); }
  setOverlays(list) { this.overlays = list || []; this.mark(); }
  setChartType(t) { this.ctype = t; this.mark(); }
  setVolume(v) { this.showVolume = v; this.mark(); }

  /* ---------- geometry ---------- */
  get plotW() { return this.w - this.axisW; }
  get plotH() { return this.h - this.axisH; }
  visRange() {
    const n = this.bars.length;
    const count = Math.min(n, Math.floor(this.plotW / this.spacing) + 1);
    const from = Math.max(0, n - count - Math.floor(this.rightOffset));
    return [from, Math.min(n, from + count + 1)];
  }
  xOf(i) {
    const n = this.bars.length;
    return this.plotW - (n - 1 - i - this.rightOffset) * this.spacing - this.spacing * 0.5;
  }
  iOf(x) {
    const n = this.bars.length;
    const i = Math.round(n - 1 - (this.plotW - x - this.spacing * 0.5) / this.spacing + this.rightOffset);
    return i;
  }

  /* ---------- interactions ---------- */
  bind() {
    const cv = this.cv;
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinD = Math.abs(a.x - b.x);
      } else if (this.pointers.size === 1) {
        this.dragX = e.offsetX; this.dragRO = this.rightOffset;
        cv.classList.add('grabbing');
      }
    });
    cv.addEventListener('pointermove', e => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.abs(a.x - b.x);
        if (this.pinD > 0 && d > 0) {
          const mid = (a.x + b.x) / 2;
          const idx = this.iOf(mid);
          this.spacing = clamp(this.spacing * (d / this.pinD), 1.6, 46);
          this.pinD = d;
          // keep index under midpoint stable
          const n = this.bars.length;
          this.rightOffset = clamp(n - 1 - idx - (this.plotW - mid - this.spacing * 0.5) / this.spacing, 0, n);
          this.follow = this.rightOffset < 0.5;
        }
        this.mark(); return;
      }
      if (this.pointers.size === 1 && this.dragX != null) {
        const dx = e.offsetX - this.dragX;
        if (Math.abs(dx) > 2) {
          const n = this.bars.length;
          this.rightOffset = clamp(this.dragRO + dx / this.spacing, 0, n);
          this.follow = this.rightOffset < 0.5;
          this.mark();
        }
      }
      this.hover = { x: e.offsetX, y: e.offsetY, idx: this.iOf(e.offsetX) };
      this.emitCross();
      this.mark();
    });
    const up = e => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) { this.dragX = null; cv.classList.remove('grabbing'); }
      if (this.pointers.size < 2) this.pinD = 0;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', e => {
      if (this.pointers.size === 0) { this.hover = null; this.emitCross(); this.mark(); }
    });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const mx = e.offsetX;
      const idx = this.iOf(mx);
      const f = Math.exp(e.deltaY * 0.0016);
      this.spacing = clamp(this.spacing * f, 1.6, 46);
      const n = this.bars.length;
      this.rightOffset = clamp(n - 1 - idx - (this.plotW - mx - this.spacing * 0.5) / this.spacing, 0, n);
      this.follow = this.rightOffset < 0.5;
      this.mark();
    }, { passive: false });
    cv.addEventListener('dblclick', () => { this.follow = true; this.rightOffset = 0; this.mark(); });
  }
  emitCross() {
    if (!this.hover) return this.onCrosshair(null);
    const i = this.hover.idx;
    if (i < 0 || i >= this.bars.length) return this.onCrosshair(null);
    this.onCrosshair({ bar: this.bars[i], x: this.hover.x, y: this.hover.y, idx: i });
  }

  /* ---------- drawing ---------- */
  draw() {
    const c = this.ctx;
    c.save();
    c.scale(this.dpr, this.dpr);
    c.clearRect(0, 0, this.w, this.h);
    c.fillStyle = '#06080c';
    c.fillRect(0, 0, this.w, this.h);

    const [from, to] = this.visRange();
    const bars = this.bars;
    const n = bars.length;
    if (!n) { c.restore(); return; }

    // price range
    let pMin = Infinity, pMax = -Infinity, vMax = 0;
    for (let i = from; i < to; i++) {
      const b = bars[i];
      if (b.l < pMin) pMin = b.l;
      if (b.h > pMax) pMax = b.h;
      if (b.v > vMax) vMax = b.v;
    }
    // include live bid & overlays-ish
    if (this.live && this.live.bid) { pMin = Math.min(pMin, this.live.bid); pMax = Math.max(pMax, this.live.bid); }
    for (const o of this.overlays) {
      if (o.price && o.inScale !== false) { pMin = Math.min(pMin, o.price); pMax = Math.max(pMax, o.price); }
    }
    if (!isFinite(pMin)) { pMin = 0; pMax = 1; }
    const pad = (pMax - pMin) * 0.08 || pMax * 0.001 || 1;
    pMin -= pad; pMax += pad;
    const plotW = this.plotW, plotH = this.plotH;
    const volH = this.showVolume ? plotH * 0.16 : 0;
    const priceH = plotH - volH - 4;
    const yP = p => (pMax - p) / (pMax - pMin) * priceH;

    // grid + price axis
    const step = niceStep(pMax - pMin, Math.max(3, Math.floor(priceH / 54)));
    const start = Math.ceil(pMin / step) * step;
    c.font = FONT;
    c.textAlign = 'left'; c.textBaseline = 'middle';
    for (let p = start; p <= pMax; p += step) {
      const y = yP(p);
      if (y < 8 || y > priceH - 2) continue;
      c.strokeStyle = GRID; c.beginPath(); c.moveTo(0, y); c.lineTo(plotW, y); c.stroke();
      c.fillStyle = AXIS_TXT;
      c.fillText(p.toFixed(this.digits), plotW + 8, y);
    }

    // time axis ticks
    const every = Math.max(1, Math.round(88 / this.spacing));
    c.textAlign = 'center'; c.textBaseline = 'top';
    let prevT = null;
    for (let i = from; i < to; i++) {
      if ((i - from) % every !== 0) continue;
      const x = this.xOf(i);
      if (x < 20 || x > plotW - 10) continue;
      const label = fmtTimeAxis(bars[i].t, this.tfSec, prevT);
      prevT = bars[i].t;
      c.strokeStyle = GRID; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, plotH); c.stroke();
      c.fillStyle = AXIS_TXT;
      c.fillText(label, x, plotH + 7);
    }
    // axis border
    c.strokeStyle = AXIS_LINE;
    c.beginPath(); c.moveTo(plotW + .5, 0); c.lineTo(plotW + .5, this.h); c.stroke();
    c.beginPath(); c.moveTo(0, plotH + .5); c.lineTo(this.w, plotH + .5); c.stroke();

    // volume
    if (this.showVolume && vMax > 0) {
      const vy0 = plotH;
      for (let i = from; i < to; i++) {
        const b = bars[i];
        const x = this.xOf(i);
        const bw = Math.max(1, this.spacing * 0.66);
        const hgt = (b.v / vMax) * (volH - 6);
        c.fillStyle = b.c >= b.o ? 'rgba(46,189,133,.28)' : 'rgba(246,70,93,.28)';
        c.fillRect(x - bw / 2, vy0 - hgt, bw, hgt);
      }
    }

    // series
    if (this.ctype === 'candles' || this.ctype === 'hollow') {
      const bw = Math.max(1, this.spacing * 0.7);
      for (let i = from; i < to; i++) {
        const b = bars[i];
        const x = this.xOf(i);
        const up = b.c >= b.o;
        const col = up ? UP : DOWN;
        c.strokeStyle = col; c.fillStyle = col;
        c.lineWidth = Math.max(1, Math.min(1.6, this.spacing * 0.12));
        c.beginPath();
        c.moveTo(x, yP(b.h)); c.lineTo(x, yP(b.l));
        c.stroke();
        const yO = yP(b.o), yC = yP(b.c);
        const top = Math.min(yO, yC), hh = Math.max(1, Math.abs(yC - yO));
        if (this.ctype === 'hollow' && up) {
          c.lineWidth = 1.2; c.strokeRect(x - bw / 2, top, bw, hh);
        } else {
          c.fillRect(x - bw / 2, top, bw, hh);
        }
      }
    } else {
      // line / area
      c.beginPath();
      for (let i = from; i < to; i++) {
        const x = this.xOf(i), y = yP(bars[i].c);
        i === from ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      if (this.ctype === 'area') {
        const grad = c.createLinearGradient(0, 0, 0, priceH);
        grad.addColorStop(0, 'rgba(212,175,55,.28)');
        grad.addColorStop(1, 'rgba(212,175,55,.02)');
        c.save();
        c.lineTo(this.xOf(to - 1), priceH); c.lineTo(this.xOf(from), priceH); c.closePath();
        c.fillStyle = grad; c.fill();
        c.restore();
        c.beginPath();
        for (let i = from; i < to; i++) {
          const x = this.xOf(i), y = yP(bars[i].c);
          i === from ? c.moveTo(x, y) : c.lineTo(x, y);
        }
      }
      c.strokeStyle = '#e7c565'; c.lineWidth = 1.5;
      c.lineJoin = 'round'; c.stroke();
    }

    // overlays (entry / sl / tp / pending / bid)
    for (const o of this.overlays) {
      if (!o.price) continue;
      const y = yP(o.price);
      if (y < -4 || y > priceH + 4) continue;
      c.strokeStyle = o.color || '#888';
      c.lineWidth = 1;
      c.setLineDash(o.dash || []);
      c.beginPath(); c.moveTo(0, y); c.lineTo(plotW, y); c.stroke();
      c.setLineDash([]);
      if (o.label) {
        const tw = c.measureText(o.label).width;
        const lx = o.labelRight ? plotW - tw - 14 : 8;
        c.fillStyle = 'rgba(8,10,15,.78)';
        roundRect(c, lx - 4, y - 8, tw + 10, 15, 4); c.fill();
        c.strokeStyle = o.color || '#888'; c.lineWidth = 1;
        roundRect(c, lx - 4, y - 8, tw + 10, 15, 4); c.stroke();
        c.fillStyle = o.color || '#ccc';
        c.textAlign = 'left'; c.textBaseline = 'middle';
        c.fillText(o.label, lx + 1, y);
      }
    }

    // last price chip + countdown
    const lastBar = bars[n - 1];
    let lp = null, lcol = UP;
    if (this.live && this.live.bid != null) { lp = this.live.bid; lcol = lastBar && lp >= lastBar.o ? UP : DOWN; }
    else lp = lastBar.c;
    const yl = clamp(yP(lp), 8, priceH - 8);
    c.strokeStyle = lcol; c.setLineDash([4, 4]); c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, yl); c.lineTo(plotW, yl); c.stroke();
    c.setLineDash([]);
    const ptxt = lp.toFixed(this.digits);
    c.font = '600 10px "JetBrains Mono", monospace';
    const pw = c.measureText(ptxt).width + 12;
    c.fillStyle = lcol;
    roundRect(c, plotW + 2, yl - 9, this.axisW - 4, 18, 4); c.fill();
    c.fillStyle = '#07090d';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(ptxt, plotW + 2 + (this.axisW - 4) / 2, yl);
    // countdown
    if (lastBar) {
      const tfMs = this.tfSec * 1000;
      const end = lastBar.t + tfMs;
      const rem = Math.max(0, Math.floor((end - Date.now()) / 1000));
      const mm = Math.floor(rem / 60), ss = rem % 60;
      const ctxt = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      c.font = FONT;
      const cw = c.measureText(ctxt).width + 10;
      c.fillStyle = 'rgba(15,19,27,.95)';
      roundRect(c, plotW + 2, yl + 11, this.axisW - 4, 15, 4); c.fill();
      c.strokeStyle = AXIS_LINE; c.lineWidth = 1;
      roundRect(c, plotW + 2, yl + 11, this.axisW - 4, 15, 4); c.stroke();
      c.fillStyle = AXIS_TXT;
      c.fillText(ctxt, plotW + 2 + (this.axisW - 4) / 2, yl + 19);
    }

    // crosshair
    if (this.hover && this.hover.x < plotW && this.hover.y < plotH) {
      const i = clamp(this.hover.idx, 0, n - 1);
      const x = this.xOf(i);
      c.strokeStyle = CROSS; c.lineWidth = 1; c.setLineDash([5, 4]);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, plotH); c.stroke();
      if (this.hover.y <= priceH) {
        c.beginPath(); c.moveTo(0, this.hover.y); c.lineTo(plotW, this.hover.y); c.stroke();
        const pv = pMax - (this.hover.y / priceH) * (pMax - pMin);
        c.setLineDash([]);
        c.font = '600 10px "JetBrains Mono", monospace';
        const tw = c.measureText(pv.toFixed(this.digits)).width + 12;
        c.fillStyle = '#1d2433';
        roundRect(c, plotW + 2, this.hover.y - 9, this.axisW - 4, 18, 4); c.fill();
        c.fillStyle = '#f2d57e';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(pv.toFixed(this.digits), plotW + 2 + (this.axisW - 4) / 2, this.hover.y);
      }
      c.setLineDash([]);
      // time chip
      const tlabel = fmtTimeFull(bars[i].t);
      c.font = FONT;
      const tw2 = c.measureText(tlabel).width + 14;
      c.fillStyle = '#1d2433';
      const tx = clamp(x - tw2 / 2, 2, plotW - tw2 - 2);
      roundRect(c, tx, plotH + 3, tw2, 17, 4); c.fill();
      c.fillStyle = '#e8ecf4';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(tlabel, tx + tw2 / 2, plotH + 12);
    }
    c.restore();
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function fmtTimeFull(t) {
  const d = new Date(t);
  const p2 = n => String(n).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${p2(d.getUTCDate())} ${months[d.getUTCMonth()]} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

/* FlowDesk UI helpers: DOM builders, canvas sizing, axes, colours. */
(function () {
'use strict';
const OF = window.OF;
const C = OF.C = {
  bg: '#0a0d12', panel: '#0f141b', grid: '#1a212c', text: '#c9d1d9', muted: '#7d8590', faint: '#4b5563',
  buy: '#22c55e', sell: '#ef4444', buyA: 'rgba(34,197,94,', sellA: 'rgba(239,68,68,', amber: '#f59e0b', blue: '#38bdf8', purple: '#a78bfa', yellow: '#facc15'
};
const el = OF.el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
OF.ui = {};

OF.ui.seg = (label, opts, val, onChange, help) => {
  const wrap = el('div', 'grp'); if (label) wrap.appendChild(el('span', 'lbl', label));
  const s = el('div', 'seg');
  opts.forEach(([v, t]) => {
    const b = el('button', v === val ? 'on' : '', t);
    b.onclick = () => { [...s.children].forEach(c => c.classList.remove('on')); b.classList.add('on'); onChange(v); };
    s.appendChild(b);
  });
  wrap.appendChild(s);
  if (help) wrap.appendChild(OF.ui.help(help));
  return wrap;
};
OF.ui.toggle = (text, on, onChange, title) => {
  const b = el('button', 'tgl' + (on ? ' on' : ''), (on ? '● ' : '○ ') + text);
  if (title) b.title = title;
  b.onclick = () => { on = !on; b.className = 'tgl' + (on ? ' on' : ''); b.innerHTML = (on ? '● ' : '○ ') + text; onChange(on); };
  return b;
};
OF.ui.select = (label, opts, val, onChange) => {
  const wrap = el('div', 'grp'); if (label) wrap.appendChild(el('span', 'lbl', label));
  const s = el('select'); opts.forEach(([v, t]) => { const o = el('option', '', t); o.value = v; if (String(v) === String(val)) o.selected = true; s.appendChild(o); });
  s.onchange = () => onChange(s.value); wrap.appendChild(s); return wrap;
};
OF.ui.help = text => { const b = el('span', 'help', '?'); b.title = text; return b; };

OF.ui.canvas = parent => {
  const cv = el('canvas'); parent.appendChild(cv);
  const o = { cv, ctx: cv.getContext('2d'), w: 0, h: 0 };
  o.fit = () => {
    const r = parent.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.floor(r.width)), h = Math.max(10, Math.floor(r.height));
    if (w !== o.w || h !== o.h || cv.width !== Math.round(w * dpr)) { o.w = w; o.h = h; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
    o.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return o;
  };
  return o;
};

/* price axis on the right: returns nothing, draws grid lines across [x0, x1] */
OF.ui.priceAxis = (ctx, x0, x1, top, h, lo, hi, opts) => {
  opts = opts || {};
  const step = OF.niceStep((hi - lo) / Math.max(2, h / 50));
  ctx.font = '11px ui-monospace,Menlo,Consolas,monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const y = top + h - (p - lo) / (hi - lo) * h;
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + .5); ctx.lineTo(x1, Math.round(y) + .5); ctx.stroke();
    ctx.fillStyle = C.muted; ctx.fillText(opts.fmt ? opts.fmt(p) : OF.fp(p), x1 + 6, y);
  }
};
OF.ui.timeAxis = (ctx, x0, w, y, t0, t1, minPx) => {
  const span = t1 - t0, steps = [1e3, 5e3, 15e3, 3e4, 6e4, 3e5, 9e5, 18e5, 36e5, 144e5, 864e5, 6048e5];
  const st = steps.find(s => s / span * w >= (minPx || 90)) || steps[steps.length - 1];
  ctx.font = '11px ui-monospace,Menlo,Consolas,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = C.muted;
  const tz = new Date().getTimezoneOffset() * 60000;
  for (let t = Math.ceil((t0 - tz) / st) * st + tz; t <= t1; t += st) {
    const x = x0 + (t - t0) / span * w;
    ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, y); ctx.stroke();
    const d = new Date(t);
    ctx.fillText(st >= 864e5 ? (d.getMonth() + 1) + '/' + d.getDate() : OF.hm(t, st < 6e4), x, y + 4);
  }
};
OF.ui.tag = (ctx, x, y, text, bg, fg) => {
  ctx.font = '11px ui-monospace,Menlo,Consolas,monospace'; const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = bg; ctx.fillRect(x, y - 8, w, 16); ctx.fillStyle = fg || '#000'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 4, y);
};
/* labels placed this frame — used to push overlapping labels apart */
OF._lbls = [];
OF.ui.lblReset = () => { OF._lbls = []; };
OF.ui.hline = (ctx, x0, x1, y, color, dash, label, lx) => {
  ctx.save(); ctx.strokeStyle = color; ctx.setLineDash(dash || [4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + .5); ctx.lineTo(x1, Math.round(y) + .5); ctx.stroke(); ctx.restore();
  if (label) {
    ctx.font = '11px ui-monospace,Menlo,Consolas,monospace';
    const x = (lx != null ? lx : x0) + 4, w = ctx.measureText(label).width + 6;
    let ly = y - 2;
    for (let i = 0; i < 12; i++) {
      const hit = OF._lbls.find(r => Math.abs(r.y - ly) < 12 && r.x < x + w && x < r.x + r.w);
      if (!hit) break; ly = hit.y + (ly >= hit.y ? 12 : -12);
    }
    OF._lbls.push({ x, y: ly, w });
    ctx.fillStyle = 'rgba(10,13,18,.75)'; ctx.fillRect(x - 2, ly - 11, w, 12);
    ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(label, x, ly);
  }
};
/* mouse tracking + crosshair with a price tag on the axis (works over the price scale too) */
OF.ui.track = view => {
  const cv = view.c.cv;
  cv.addEventListener('mousemove', e => { const r = cv.getBoundingClientRect(); view.mouse = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY }; });
  cv.addEventListener('mouseleave', () => { view.mouse = null; OF.ui.tip(); });
};
OF.ui.cross = (ctx, m, x0, x1, top, h, lo, hi, axisX, timeAt) => {
  if (!m || m.y < top || m.y > top + h) return null;
  const p = lo + (top + h - m.y) / h * (hi - lo);
  ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(x0, Math.round(m.y) + .5); ctx.lineTo(x1, Math.round(m.y) + .5);
  if (m.x < x1) { ctx.moveTo(Math.round(m.x) + .5, top); ctx.lineTo(Math.round(m.x) + .5, top + h); }
  ctx.stroke(); ctx.restore();
  OF.ui.tag(ctx, axisX, m.y, OF.fp(p), '#2563eb', '#fff');
  const S = OF.S;
  if (S && S.last) { const d = (p / S.last - 1) * 100; ctx.font = '10px ui-monospace,monospace'; ctx.fillStyle = '#93c5fd'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText((d >= 0 ? '+' : '') + d.toFixed(2) + '% from price', x1 - 4, m.y - 3); }
  if (timeAt && m.x < x1) { const t = timeAt(m.x); if (t) OF.ui.tag(ctx, OF.clamp(m.x - 30, 0, x1 - 70), top + h + 9, OF.hm(t), '#2563eb', '#fff'); }
  return p;
};
OF.ui.msg = (ctx, w, h, text) => { ctx.fillStyle = C.muted; ctx.font = '13px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, w / 2, h / 2); };

/* heatmap palette: deep navy → blue → cyan → yellow → near-white */
const stops = [[0, [8, 20, 40]], [0.25, [14, 58, 120]], [0.5, [28, 120, 205]], [0.7, [52, 190, 230]], [0.86, [245, 220, 90]], [1, [255, 250, 225]]];
OF.heatLUT = Array.from({ length: 256 }, (_, i) => {
  const v = i / 255; let a = stops[0], b = stops[stops.length - 1];
  for (let j = 0; j < stops.length - 1; j++) if (v >= stops[j][0] && v <= stops[j + 1][0]) { a = stops[j]; b = stops[j + 1]; break; }
  const f = (v - a[0]) / ((b[0] - a[0]) || 1);
  return 'rgb(' + a[1].map((c, k) => Math.round(c + (b[1][k] - c) * f)).join(',') + ')';
});

/* tooltip */
OF.ui.tip = (x, y, html) => {
  const t = document.getElementById('tip'); if (!html) { t.classList.add('hidden'); return; }
  t.innerHTML = html; t.classList.remove('hidden');
  const r = t.getBoundingClientRect();
  t.style.left = Math.min(window.innerWidth - r.width - 8, x + 14) + 'px';
  t.style.top = Math.min(window.innerHeight - r.height - 8, y + 14) + 'px';
};

/* candles helpers shared by chart-like views */
OF.ema = (arr, n, key) => { const out = new Array(arr.length); const a = 2 / (n + 1); let e = null; for (let i = 0; i < arr.length; i++) { const v = arr[i][key || 'c']; e = e == null ? v : v * a + e * (1 - a); out[i] = e; } return out; };
OF.rsi = (arr, n) => {
  const out = new Array(arr.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i].c - arr[i - 1].c, up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = l ? 100 - 100 / (1 + g / l) : 100; }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l ? 100 - 100 / (1 + g / l) : 100; }
  }
  return out;
};
OF.drawCandles = (ctx, k, i0, i1, X, Y, bw) => {
  for (let i = i0; i < i1; i++) {
    const c = k[i], x = X(i), up = c.c >= c.o;
    ctx.strokeStyle = ctx.fillStyle = up ? C.buy : C.sell;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, Y(c.h)); ctx.lineTo(Math.round(x) + .5, Y(c.l)); ctx.stroke();
    const y1 = Y(Math.max(c.o, c.c)), y2 = Y(Math.min(c.o, c.c));
    ctx.fillRect(Math.round(x - bw / 2), y1, Math.max(1, Math.round(bw)), Math.max(1, y2 - y1));
  }
};
})();

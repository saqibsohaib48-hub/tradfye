/* Swing Structure Bands [ChartPrime] — JavaScript port of the TradingView (Pine v6) indicator.
   This Pine Script™ code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
   © ChartPrime (original) · Ported to FlowDesk with the same rules, inputs, defaults and colours.

   Rules, bar by bar, as in the Pine script:
   • hiMax / loMin = highest high / lowest low of the last `Swing Length` bars; ATR(200) = RMA of true range.
   • dir = 1 when high == hiMax, -1 when low == loMin (low wins on the same bar).
   • Swing high on the previous bar when high[1] == hiMax and high < hiMax (swing low: mirror). It resets lh (ll) to 1.
   • When dir flips to -1 → label "Swing High" at that swing, ATR above it; flips to 1 → "Swing Low", ATR below.
   • lh, ll += 1 every bar. TOP band middle = MA(high, lh), BOTTOM band middle = MA(low, ll), MA type selectable.
     So each band is the average of the highs (lows) since the last swing high (low).
   • A band is hidden on bars where its MA moved more than one ATR from the bar before (plot.style_linebr gap).
   • Outer lines = middle ± ATR; gradient fill from the middle (colour, 70 % transparent) to the outer lines (clear).
   • Sell diamond: high crosses under the TOP band after more than 20 unbroken bars, and more than 10 bars since the last
     sell. Buy diamond: low crosses over the BOTTOM band after more than 15 unbroken bars, more than 10 bars since the last buy.
   Pine runs from the first bar of the chart's history; here the history is the candles loaded for the timeframe
   (up to 1,000), so the ATR(200) warms up on those. Values on the right side match once enough bars have passed. */
(function () {
'use strict';
const OF = window.OF, LS = OF.LS, el = OF.el;
const B = OF.ssbands = {};
const DEF = { on: true, len: 100, maType: 'SMA', bands: true, colDn: '#E040FB', colUp: '#4CAF50' };   // Pine color.fuchsia / color.green
B.cfg = () => Object.assign({}, DEF, LS.get('ssb', {}));
B.save = c => { LS.set('ssb', c); B._c = null; };
B.toggle = on => { const c = B.cfg(); c.on = on; B.save(c); };

/* ---------- calculation over the whole candle array (the last, forming candle included, like TradingView) ---------- */
function calc(k, c) {
  const n = k.length, L = c.len, NA = NaN;
  const hi = new Float64Array(n), lo = new Float64Array(n), vol = new Float64Array(n);
  for (let i = 0; i < n; i++) { hi[i] = k[i].h; lo[i] = k[i].l; vol[i] = k[i].v || 0; }
  // ATR(200) = rma(tr(true), 200): first value is the SMA of the first 200 true ranges
  const atr = new Float64Array(n).fill(NA); let s = 0, a = NA;
  for (let i = 0; i < n; i++) {
    const tr = i === 0 ? hi[i] - lo[i] : Math.max(hi[i] - lo[i], Math.abs(hi[i] - k[i - 1].c), Math.abs(lo[i] - k[i - 1].c));
    if (i < 200) { s += tr; if (i === 199) a = s / 200; } else a = (a * 199 + tr) / 200;
    atr[i] = a;
  }
  // highest / lowest of the last L bars (na until L bars exist), monotonic deques
  const hiMax = new Float64Array(n).fill(NA), loMin = new Float64Array(n).fill(NA), dqH = [], dqL = [];
  for (let i = 0; i < n; i++) {
    while (dqH.length && hi[dqH[dqH.length - 1]] <= hi[i]) dqH.pop(); dqH.push(i); if (dqH[0] <= i - L) dqH.shift();
    while (dqL.length && lo[dqL[dqL.length - 1]] >= lo[i]) dqL.pop(); dqL.push(i); if (dqL[0] <= i - L) dqL.shift();
    if (i >= L - 1) { hiMax[i] = hi[dqH[0]]; loMin[i] = lo[dqL[0]]; }
  }
  // prefix sums for SMA / WMA / VWMA with a length that changes every bar
  const P1h = new Float64Array(n + 1), P2h = new Float64Array(n + 1), P1l = new Float64Array(n + 1), P2l = new Float64Array(n + 1), Pv = new Float64Array(n + 1), Pvh = new Float64Array(n + 1), Pvl = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    P1h[i + 1] = P1h[i] + hi[i]; P2h[i + 1] = P2h[i] + (i + 1) * hi[i];
    P1l[i + 1] = P1l[i] + lo[i]; P2l[i + 1] = P2l[i] + (i + 1) * lo[i];
    Pv[i + 1] = Pv[i] + vol[i]; Pvh[i + 1] = Pvh[i] + vol[i] * hi[i]; Pvl[i + 1] = Pvl[i] + vol[i] * lo[i];
  }
  const sma = (P1, i, len) => len > i + 1 ? NA : (P1[i + 1] - P1[i + 1 - len]) / len;
  const wma = (P1, P2, i, len) => { if (len > i + 1) return NA; const a0 = i + 1 - len; return ((P2[i + 1] - P2[a0]) - a0 * (P1[i + 1] - P1[a0])) / (len * (len + 1) / 2); };
  const vwma = (Px, i, len) => { if (len > i + 1) return NA; const v = Pv[i + 1] - Pv[i + 1 - len]; return v ? (Px[i + 1] - Px[i + 1 - len]) / v : NA; };
  const out = { n, atr, ub: new Float64Array(n).fill(NA), lb: new Float64Array(n).fill(NA), labels: [], sells: [], buys: [] };
  let dir = 0, prevDir = NaN, lh = 1, ll = 1, hiIdx = 0, hiPx = 0, loIdx = 0, loPx = 0;
  let eH = NA, eL = NA;                       // f_ema / f_rma state (v[1])
  let maHiPrev = NA, maLoPrev = NA, uc = 0, lc = 0, uIdx = 0, lIdx = 0;
  for (let i = 0; i < n; i++) {
    const isHiSw = i > 0 && hi[i - 1] === hiMax[i] && hi[i] < hiMax[i];
    const isLoSw = i > 0 && lo[i - 1] === loMin[i] && lo[i] > loMin[i];
    if (hi[i] === hiMax[i]) dir = 1;
    if (lo[i] === loMin[i]) dir = -1;
    if (isLoSw) { loIdx = i - 1; loPx = lo[i - 1]; ll = 1; }
    if (isHiSw) { hiIdx = i - 1; hiPx = hi[i - 1]; lh = 1; }
    if (i > 0 && dir !== prevDir && dir === -1 && !isNaN(atr[i])) out.labels.push({ i: hiIdx, p: hiPx + atr[i], at: hiPx, hi: true });
    if (i > 0 && dir !== prevDir && dir === 1 && !isNaN(atr[i])) out.labels.push({ i: loIdx, p: loPx - atr[i], at: loPx, hi: false });
    prevDir = dir;
    lh += 1; ll += 1;
    let maHi, maLo;
    switch (c.maType) {
      case 'EMA': { const aH = 2 / (lh + 1), aL = 2 / (ll + 1); eH = isNaN(eH) ? hi[i] : aH * hi[i] + (1 - aH) * eH; eL = isNaN(eL) ? lo[i] : aL * lo[i] + (1 - aL) * eL; maHi = eH; maLo = eL; break; }
      case 'SMMA (RMA)': { eH = isNaN(eH) ? sma(P1h, i, lh) : (1 / lh) * hi[i] + (1 - 1 / lh) * eH; eL = isNaN(eL) ? sma(P1l, i, ll) : (1 / ll) * lo[i] + (1 - 1 / ll) * eL; maHi = eH; maLo = eL; break; }
      case 'WMA': maHi = wma(P1h, P2h, i, lh); maLo = wma(P1l, P2l, i, ll); break;
      case 'VWMA': maHi = vwma(Pvh, i, lh); maLo = vwma(Pvl, i, ll); break;
      default: maHi = sma(P1h, i, lh); maLo = sma(P1l, i, ll);
    }
    // a comparison with na is false in Pine, so a missing value never hides the band
    const dHi = Math.abs(maHi - maHiPrev) > atr[i], dLo = Math.abs(maLo - maLoPrev) > atr[i];
    maHiPrev = maHi; maLoPrev = maLo;
    uc = !dHi ? uc + 1 : 0; lc = !dLo ? lc + 1 : 0;
    out.ub[i] = dHi ? NA : maHi; out.lb[i] = dLo ? NA : maLo;
    // ta.crossunder(high, ub) / ta.crossover(low, lb)
    const sell = i > 0 && hi[i] < out.ub[i] && hi[i - 1] >= out.ub[i - 1] && uc > 20;
    const buy = i > 0 && lo[i] > out.lb[i] && lo[i - 1] <= out.lb[i - 1] && lc > 15;
    if (sell && i - uIdx > 10 && !isNaN(atr[i])) out.sells.push({ i, p: hi[i - 1] + atr[i] });
    if (buy && i - lIdx > 10 && !isNaN(atr[i])) out.buys.push({ i, p: lo[i - 1] - atr[i] });
    if (sell) uIdx = i;
    if (buy) lIdx = i;
  }
  return out;
}
B.calc = function (k) {
  const c = B.cfg(), last = k[k.length - 1], key = JSON.stringify(c) + k.length + ':' + (last ? last.t + ':' + last.h + ':' + last.l + ':' + last.c : '');
  if (B._c && B._c.k === k && B._c.key === key) return B._c.r;
  if (B._c && B._c.k === k && Date.now() - B._c.at < 500 && B._c.cfgKey === JSON.stringify(c)) return B._c.r;   // at most 2 recalculations a second
  const r = calc(k, c); B._c = { k, key, r, at: Date.now(), cfgKey: JSON.stringify(c) }; return r;
};
B.run = calc;   // used by tests

/* ---------- drawing: g = { k, i0, end, X, Y, pw, top, bottom } ---------- */
const rgba = (hex, a) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex; };
B.draw = function (ctx, g) {
  const c = B.cfg(); if (!c.on) return;
  const k = g.k; if (!k || k.length < c.len + 2) return;
  const r = B.calc(k), from = Math.max(1, g.i0), to = Math.min(g.end, r.n);
  ctx.save(); ctx.beginPath(); ctx.rect(0, g.top || 0, g.pw, (g.bottom || 1e4) - (g.top || 0)); ctx.clip();
  const band = (mid, col) => {
    // gradient fills: from the middle line (colour, 70 % transparent) out to ±ATR (clear) — Pine fill(top_color = na)
    if (c.bands) for (let i = from; i < to; i++) {
      const m0 = mid[i - 1], m1 = mid[i], a0 = r.atr[i - 1], a1 = r.atr[i];
      if (isNaN(m0) || isNaN(m1) || isNaN(a0) || isNaN(a1)) continue;
      const x0 = g.X(i - 1), x1 = g.X(i);
      for (const s of [1, -1]) {
        const ym = (g.Y(m0) + g.Y(m1)) / 2, yo = (g.Y(m0 + s * a0) + g.Y(m1 + s * a1)) / 2;
        const gr = ctx.createLinearGradient(0, ym, 0, yo); gr.addColorStop(0, rgba(col, 0.3)); gr.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = gr; ctx.beginPath();
        ctx.moveTo(x0, g.Y(m0)); ctx.lineTo(x1, g.Y(m1)); ctx.lineTo(x1, g.Y(m1 + s * a1)); ctx.lineTo(x0, g.Y(m0 + s * a0)); ctx.closePath(); ctx.fill();
      }
    }
    // lines, broken where the value is na (plot.style_linebr)
    const line = (off, colr) => {
      ctx.strokeStyle = colr; ctx.lineWidth = 1; ctx.beginPath(); let on = false;
      for (let i = Math.max(0, g.i0); i < to; i++) {
        const v = mid[i] + off(i); if (isNaN(v)) { on = false; continue; }
        const x = g.X(i), y = g.Y(v); if (on) ctx.lineTo(x, y); else { ctx.moveTo(x, y); on = true; }
      }
      ctx.stroke();
    };
    if (c.bands) { line(i => r.atr[i], rgba(col, 0.5)); line(i => -r.atr[i], rgba(col, 0.5)); }
    line(() => 0, col);
  };
  band(r.ub, c.colDn); band(r.lb, c.colUp);
  // buy / sell diamonds: tiny solid on top of a small 60 %-transparent one
  const diamond = (x, y, s, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); ctx.fill(); };
  for (const [list, col] of [[r.sells, c.colDn], [r.buys, c.colUp]]) for (const d of list) {
    if (d.i < g.i0 || d.i >= g.end) continue; const x = g.X(d.i), y = g.Y(d.p);
    diamond(x, y, 7, rgba(col, 0.4)); diamond(x, y, 4, col);
  }
  // "Swing High" / "Swing Low" labels (label_down above, label_up below), background 80 % transparent
  ctx.font = '600 11px Inter,system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const L of r.labels) {
    if (L.i < g.i0 || L.i >= g.end) continue;
    const t = L.hi ? 'Swing High' : 'Swing Low', w = ctx.measureText(t).width + 14, h = 20, x = g.X(L.i), y = g.Y(L.p), col = L.hi ? c.colDn : c.colUp;
    const by = L.hi ? y - 6 - h : y + 6;
    ctx.fillStyle = rgba(col, 0.2); ctx.beginPath(); ctx.roundRect(x - w / 2, by, w, h, 4); ctx.fill();
    ctx.beginPath(); if (L.hi) { ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y - 6); ctx.lineTo(x, y); } else { ctx.moveTo(x - 6, y + 6); ctx.lineTo(x + 6, y + 6); ctx.lineTo(x, y); } ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#D1D4DC'; ctx.fillText(t, x, by + h / 2 + .5);
  }
  ctx.restore();
};

/* ---------- settings popover (same inputs as the Pine script) ---------- */
B.panel = function (anchor) {
  let pop = document.getElementById('ssbPop'); if (pop) { pop.remove(); return; }
  const c = B.cfg();
  pop = el('div', 'colspop htfpop'); pop.id = 'ssbPop';
  const r = anchor.getBoundingClientRect(); pop.style.top = (r.bottom + 8) + 'px'; pop.style.left = Math.max(8, Math.min(window.innerWidth - 380, r.left - 120)) + 'px'; pop.style.width = '360px';
  const opt = ['SMA', 'EMA', 'SMMA (RMA)', 'WMA', 'VWMA'].map(o => `<option${o === c.maType ? ' selected' : ''}>${o}</option>`).join('');
  pop.innerHTML = `<div class="cph">Swing Structure Bands <button class="cpx">✕</button></div>
    <div class="htfline"><span>Swing Length</span><input type="number" min="2" max="1000" data-k="len" value="${c.len}"><span>MA Type</span><select data-k="maType">${opt}</select></div>
    <label class="vrow"><input type="checkbox" data-k="bands" ${c.bands ? 'checked' : ''}> Bands</label>
    <div class="htfline"><span>Bear Color</span><input type="color" data-k="colDn" value="${c.colDn}"><span>Bull Color</span><input type="color" data-k="colUp" value="${c.colUp}"></div>
    <div class="vbtns"><button data-a="reset">Reset to defaults</button></div>
    <div class="muted sm" style="margin-top:8px">Port of “Swing Structure Bands [ChartPrime]” · © ChartPrime · Mozilla Public License 2.0</div>`;
  const read = () => {
    const n = B.cfg();
    pop.querySelectorAll('[data-k]').forEach(i => { const k = i.dataset.k; n[k] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? Math.max(2, Math.round(+i.value) || 100) : i.value; });
    B.save(n);
  };
  pop.querySelectorAll('input,select').forEach(i => { i.onchange = read; if (i.type === 'color') i.oninput = read; });
  pop.querySelector('.cpx').onclick = () => pop.remove();
  pop.querySelector('[data-a=reset]').onclick = () => { const on = B.cfg().on; B.save(Object.assign({}, DEF, { on })); pop.remove(); B.panel(anchor); };
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener('pointerdown', function f(e) { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('pointerdown', f); } }), 0);
};
})();

/* FlowDesk swings — swing highs and swing lows on the candle charts (Chart, Whales, Trade plan).
   • A swing high is a candle whose high is above the highs of `len` candles on each side (swing low: the mirror image).
   • Only confirmed swings are drawn: a swing needs `len` CLOSED candles after it, so a mark never appears and then vanishes.
   • Each swing is labelled against the previous one of its kind: HH / LH (highs), HL / LL (lows).
   • A dotted line runs from each recent swing until a candle CLOSES beyond it (a break of structure), or to the right edge
     if it still holds. The nearest unbroken swing high and low get price tags on the right axis.
   • Structure: last high HH + last low HL = uptrend, LH + LL = downtrend, anything else = range. */
(function () {
'use strict';
const OF = window.OF, ui = OF.ui, LS = OF.LS;
const SW = OF.swings = {};

SW.cfg = () => Object.assign({ len: 5 }, LS.get('swing', {}));
SW.set = (k, v) => { const c = LS.get('swing', {}); c[k] = v; LS.set('swing', c); SW._c = null; };

/* find confirmed swings on candles k (the last candle is still forming and is never used) */
SW.find = function (k, len) {
  const n = k.length - 2;                         // index of the last CLOSED candle
  const key = len + ':' + k.length + ':' + (k[n] ? k[n].t + ':' + k[n].c : '');
  if (SW._c && SW._c.k === k && SW._c.key === key) return SW._c.r;
  const list = []; let lastH = null, lastL = null;
  for (let i = len; i <= n - len; i++) {
    let h = true, l = true;
    for (let j = i - len; j <= i + len && (h || l); j++) {
      if (j === i) continue;
      if (j < i ? k[j].h >= k[i].h : k[j].h > k[i].h) h = false;   // ties: the earlier candle wins
      if (j < i ? k[j].l <= k[i].l : k[j].l < k[i].l) l = false;
    }
    if (h) { const s = { i, p: k[i].h, hi: true, tag: !lastH ? 'H' : k[i].h > lastH.p ? 'HH' : 'LH' }; list.push(s); lastH = s; }
    if (l) { const s = { i, p: k[i].l, hi: false, tag: !lastL ? 'L' : k[i].l > lastL.p ? 'HL' : 'LL' }; list.push(s); lastL = s; }
  }
  // break of structure: the first closed candle after confirmation that closes beyond the swing
  for (const s of list) {
    s.broken = null;
    for (let j = s.i + len + 1; j <= n; j++) if (s.hi ? k[j].c > s.p : k[j].c < s.p) { s.broken = j; break; }
  }
  const trend = lastH && lastL ? (lastH.tag === 'HH' && lastL.tag === 'HL' ? 'UP' : lastH.tag === 'LH' && lastL.tag === 'LL' ? 'DOWN' : 'RANGE') : null;
  const r = { list, lastH, lastL, trend, len };
  SW._c = { k, key, r };
  return r;
};

/* g = { k, i0, end, X, Y, lo, hi, pw, top, bottom, tf } */
SW.draw = function (ctx, g) {
  if (!OF.app.lines.swing) return;
  const k = g.k; if (!k || k.length < 20) return;
  const len = SW.cfg().len, r = SW.find(k, len), C = OF.C, px = OF.S && OF.S.last;
  const col = s => s.tag === 'HH' || s.tag === 'HL' ? C.buy : s.tag === 'LH' || s.tag === 'LL' ? C.sell : C.muted;
  const top = g.top || 0, bottom = g.bottom;
  ctx.save();
  // 1. dotted lines: the most recent 4 swing highs and 4 swing lows that are still on screen or still unbroken
  const recent = side => r.list.filter(s => s.hi === side && (s.broken == null || s.broken >= g.i0)).slice(-4);
  for (const s of recent(true).concat(recent(false))) {
    const y = g.Y(s.p); if (y < top || y > bottom) continue;
    const x0 = Math.max(0, g.X(s.i)), x1 = s.broken != null ? g.X(s.broken) : g.pw;
    if (x1 <= 0) continue;
    ctx.strokeStyle = col(s); ctx.globalAlpha = s.broken != null ? 0.45 : 0.85; ctx.lineWidth = 1; ctx.setLineDash(s.broken != null ? [2, 3] : [4, 3]);
    ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + .5); ctx.lineTo(x1, Math.round(y) + .5); ctx.stroke(); ctx.setLineDash([]);
    if (s.broken != null && s.broken >= g.i0) {        // where structure broke
      ctx.globalAlpha = 1; ctx.font = '700 9.5px Inter,system-ui,sans-serif'; ctx.fillStyle = s.hi ? C.buy : C.sell; ctx.textAlign = 'center'; ctx.textBaseline = s.hi ? 'bottom' : 'top';
      ctx.fillText('BOS', x1, s.hi ? y - 3 : y + 3);
    }
  }
  ctx.globalAlpha = 1;
  // 2. markers + labels on every confirmed swing in view
  ctx.font = '800 10px Inter,system-ui,sans-serif'; ctx.textAlign = 'center';
  for (const s of r.list) {
    if (s.i < g.i0 || s.i >= g.end) continue;
    const x = g.X(s.i), y = g.Y(s.p); if (y < top - 4 || y > bottom + 4) continue;
    const c = col(s), d = s.hi ? -1 : 1;
    ctx.fillStyle = c; ctx.beginPath();
    ctx.moveTo(x, y + d * 3); ctx.lineTo(x - 5, y + d * 11); ctx.lineTo(x + 5, y + d * 11); ctx.closePath(); ctx.fill();
    ctx.textBaseline = s.hi ? 'bottom' : 'top';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(10,4,24,.9)'; ctx.strokeText(s.tag, x, y + d * 13);
    ctx.fillText(s.tag, x, y + d * 13);
  }
  // 3. nearest unbroken swing high / low: price tag on the right axis
  const live = side => { let best = null; for (const s of r.list) if (s.hi === side && s.broken == null && (!best || s.i > best.i)) best = s; return best; };
  for (const s of [live(true), live(false)]) {
    if (!s) continue; const y = g.Y(s.p); if (y < top || y > bottom) continue;
    ui.tag(ctx, g.pw + 1, y, (s.hi ? 'SH ' : 'SL ') + OF.fp(s.p), s.hi ? C.sell : C.buy, '#0b0b10');
  }
  // 4. structure badge
  if (r.trend) {
    const t = `Swings (${len}): ${r.trend === 'UP' ? '▲ uptrend · HH + HL' : r.trend === 'DOWN' ? '▼ downtrend · LH + LL' : '◆ range · mixed swings'}`;
    const c = r.trend === 'UP' ? C.buy : r.trend === 'DOWN' ? C.sell : C.amber;
    ctx.font = '700 11px Inter,system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(t).width + 16, x = Math.max(8, g.pw / 2 - w / 2), y = top + 4;
    ctx.fillStyle = 'rgba(16,6,36,.88)'; ctx.strokeStyle = c; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x, y, w, 20, 10); ctx.fill(); ctx.stroke();
    ctx.fillStyle = c; ctx.fillText(t, x + 8, y + 10.5);
  }
  ctx.restore();
};
})();

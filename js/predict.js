/* FlowDesk next-candle prediction — a yellow "ghost" candle one step ahead on the candle charts.
   • Direction comes from the tool's LIVE readings, grouped in five families whose weight depends on the timeframe:
       flow      — trade flow over the last candle-length, aggression, CVD, current candle delta, whales
       book      — order-book imbalance, walls, pulled (fake) walls
       trend     — multi-timeframe direction for this and the next timeframe, key-points trend
       structure — swing structure (HH/HL vs LH/LL), key support / resistance close by, Swing Structure Bands extremes
       futures   — futures aggression and CVD, funding, open interest, liquidation magnet
     Short timeframes lean on flow and the book; long ones on trend and structure.
   • Size comes from candles only: typical body and ATR(14) of that timeframe. Key resistance / support caps the high / low.
   • Model %: how strong and how consistent the readings are (capped near 80 %, never certain).
   • Measured %: every prediction is frozen when the next candle starts and checked when that candle closes; the hit rate
     per timeframe is kept in this browser. Once there are 20+ checks, the shown confidence leans on what was measured. */
(function () {
'use strict';
const OF = window.OF, LS = OF.LS, ui = OF.ui;
const P = OF.predict = {};
const TFS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
const FAM = ['flow', 'book', 'trend', 'structure', 'futures'];
const FAMNAME = { flow: 'Order flow', book: 'Order book', trend: 'Trend', structure: 'Structure & levels', futures: 'Futures' };
const W = { '1m': [1.6, 1.3, 0.5, 0.4, 0.8], '5m': [1.4, 1.1, 0.7, 0.6, 0.8], '15m': [1.1, 0.8, 1.0, 0.9, 0.9], '30m': [0.9, 0.6, 1.2, 1.0, 0.9],
  '1h': [0.7, 0.4, 1.4, 1.2, 1.0], '4h': [0.4, 0.2, 1.6, 1.4, 1.0], '1d': [0.3, 0.1, 1.7, 1.5, 1.0] };
const NEXT = { '1m': '5m', '5m': '15m', '15m': '1h', '30m': '1h', '1h': '4h', '4h': '12h', '1d': '12h' };
const clamp1 = v => OF.clamp(v, -1, 1);

function mtfScore(tf) {
  const m = OF.mtf(); if (!m) return null; const R = {}; for (const r of m.rows) R[r.tf] = r.score;
  if (tf === '30m') return R['15m'] != null && R['1h'] != null ? (R['15m'] + R['1h']) / 2 : null;
  if (tf === '1d') return R['12h'];
  return R[tf] != null ? R[tf] : null;
}

/* ---------- the prediction for one timeframe ---------- */
P.calc = function (tf) {
  const S = OF.S; if (!S || !S.info || !S.last) return null;
  const k = S.k[tf]; if (!k || k.length < 40) { OF.loadKlines(tf); return null; }
  const ms = OF.tfMs[tf], now = OF.now(), px = S.last;
  const met = OF.meters(), M = {}; if (met) for (const m of met.list) M[m.key] = m;
  const F = [];
  const fac = (fam, name, v, text) => { if (v == null || isNaN(v)) return; F.push({ fam, name, v: clamp1(v), text }); };
  const mm = (fam, key, scale) => { const m = M[key]; if (m && m.score != null) fac(fam, m.name, m.score / 100 * (scale || 1), m.text); };
  // flow
  const win = OF.clamp(ms, 6e4, 36e5), fl = OF.flow(now - win);
  if (fl.tot) fac('flow', 'Trade flow (last ' + (win >= 36e5 ? '1 h' : Math.round(win / 6e4) + ' min') + ')', fl.d / fl.tot * 2.5, OF.fmtUsd(fl.d, true) + ' net of ' + OF.fmtUsd(fl.tot));
  mm('flow', 'aggr'); mm('flow', 'cvd5'); mm('flow', 'd' + tf); mm('flow', 'large', 0.8); mm('flow', 'whale', 0.6); mm('flow', 'absorb', 0.6);
  // book
  mm('book', 'imb'); mm('book', 'walls', 0.8); mm('book', 'fake', 0.7);
  // trend
  const ms1 = mtfScore(tf), ms2 = mtfScore(NEXT[tf]);
  if (ms1 != null) fac('trend', tf + ' direction', ms1 / 100, 'score ' + ms1);
  if (ms2 != null) fac('trend', NEXT[tf] + ' direction', ms2 / 100 * 0.8, 'score ' + ms2);
  const kr = OF.keyRead(tf);
  if (kr) fac('trend', 'Key points trend (' + tf + ')', kr.trend === 'UP' ? 0.6 : kr.trend === 'DOWN' ? -0.6 : 0, (kr.trendWhy || []).slice(0, 2).join(' · '));
  // structure
  const atr = OF.atr(k) || px * 0.002;
  try { const sw = OF.swings.find(k, OF.swings.cfg().len); if (sw.trend) fac('structure', 'Swing structure', sw.trend === 'UP' ? 0.6 : sw.trend === 'DOWN' ? -0.6 : 0, sw.trend === 'UP' ? 'HH + HL' : sw.trend === 'DOWN' ? 'LH + LL' : 'mixed swings'); } catch (e) { /* optional */ }
  if (kr && kr.res) { const d = (kr.res.lo - px) / atr; if (d >= 0 && d < 0.6) fac('structure', 'Key resistance just above', -0.5 * (1 - d / 0.6), OF.fp(kr.res.p) + ' is ' + d.toFixed(2) + ' ATR away'); }
  if (kr && kr.sup) { const d = (px - kr.sup.hi) / atr; if (d >= 0 && d < 0.6) fac('structure', 'Key support just below', 0.5 * (1 - d / 0.6), OF.fp(kr.sup.p) + ' is ' + d.toFixed(2) + ' ATR away'); }
  try {
    if (OF.ssbands && k.length > OF.ssbands.cfg().len + 2) {
      const b = OF.ssbands.calc(k), i = k.length - 1, ub = b.ub[i], lb = b.lb[i], a2 = b.atr[i];
      if (!isNaN(ub) && !isNaN(a2) && px > ub) fac('structure', 'Above the top swing band', -0.4 * Math.min(1, (px - ub) / a2), 'stretched above ' + OF.fp(ub));
      if (!isNaN(lb) && !isNaN(a2) && px < lb) fac('structure', 'Below the bottom swing band', 0.4 * Math.min(1, (lb - px) / a2), 'stretched below ' + OF.fp(lb));
    }
  } catch (e) { /* optional */ }
  // futures
  mm('futures', 'faggr'); mm('futures', 'fcvd15'); mm('futures', 'fuel', 0.8); mm('futures', 'fund', 0.6); mm('futures', 'oi', 0.6);

  // combine families with timeframe weights
  const w = W[tf] || W['15m'], fams = {}; let s = 0, sw = 0;
  FAM.forEach((f, j) => { const xs = F.filter(x => x.fam === f); if (!xs.length) return; const v = xs.reduce((a, x) => a + x.v, 0) / xs.length; fams[f] = v; s += v * w[j]; sw += w[j]; });
  s = sw ? s / sw : 0;
  const voting = F.filter(x => Math.abs(x.v) > 0.15), agree = voting.length ? voting.filter(x => Math.sign(x.v) === Math.sign(s)).length / voting.length : 0;
  const pUp = 0.5 + 0.5 * Math.tanh(1.3 * s) * (0.35 + 0.35 * agree);      // never far from a coin flip on purpose
  const dir = Math.abs(s) < 0.06 ? 0 : s > 0 ? 1 : -1;
  const model = dir === 0 ? 0.5 : Math.max(pUp, 1 - pUp);

  // size from this timeframe's candles
  const bodies = k.slice(-51, -1).map(c => Math.abs(c.c - c.o)).sort((a, b) => a - b), med = bodies[bodies.length >> 1] || atr * 0.4;
  // the next candle opens where the current one closes: start from the newest candle's close so the yellow candle joins the chart
  const o = k[k.length - 1].c, body = dir * Math.min(atr * 0.9, med * (0.4 + 1.2 * Math.abs(s)));
  let c = o + body; const wick = Math.max(atr * 0.15, atr * 0.9 - Math.abs(body));
  let h = Math.max(o, c) + wick * (0.5 - 0.2 * s), l = Math.min(o, c) - wick * (0.5 + 0.2 * s);
  const notes = [];
  if (kr && kr.res && kr.res.lo > o && h > kr.res.hi) { h = kr.res.hi; if (c > kr.res.lo) { c = kr.res.lo; notes.push('close held under key resistance ' + OF.fp(kr.res.p)); } }
  if (kr && kr.sup && kr.sup.hi < o && l < kr.sup.lo) { l = kr.sup.lo; if (c < kr.sup.hi) { c = kr.sup.hi; notes.push('close held above key support ' + OF.fp(kr.sup.p)); } }
  h = Math.max(h, o, c); l = Math.min(l, o, c);

  const T = k[k.length - 1].t + ms;                    // open time of the predicted candle
  const st = P.stats(tf), conf = P.blend(model, st);
  return { tf, t: T, opensIn: T - now, dir, s, pUp, model, conf, agree, o, h, l, c, atr, factors: F, fams, notes, stats: st };
};

/* ---------- journal: freeze at candle start, check at candle close ---------- */
const key = tf => 'pred:' + (OF.demo ? 'demo:' : '') + OF.S.symbol + ':' + tf;   // demo data never mixes into real results
const bucket = p => p < 0.55 ? '<55%' : p < 0.6 ? '55–60%' : p < 0.65 ? '60–65%' : '65%+';
P.stats = function (tf) {
  const j = LS.get(key(tf), { log: [] }), log = j.log || [];
  const out = { n: log.length, hit: log.filter(x => x.ok).length, inR: log.filter(x => x.inR).length, b: {} };
  for (const x of log) { const b = (out.b[x.b] = out.b[x.b] || { n: 0, hit: 0 }); b.n++; if (x.ok) b.hit++; }
  return out;
};
P.blend = function (model, st) {
  if (!st || !st.n) return model;
  const b = st.b[bucket(model)], n = b ? b.n : 0, hit = b ? b.hit : 0;
  return n >= 20 ? (hit + model * 10) / (n + 10) : model;   // lean on what was measured once there is enough of it
};
P.track = function () {
  const S = OF.S; if (!S || !S.info || !S.last) return;
  const now = OF.now();
  for (const tf of TFS) {
    const k = S.k[tf]; if (!k || k.length < 40) continue;
    const j = LS.get(key(tf), { log: [] }), pend = j.pend, lastT = k[k.length - 1].t;
    // the predicted candle has closed (a newer candle exists): check it
    if (pend && lastT > pend.t) {
      const c = k.find(x => x.t === pend.t);
      // only a prediction refreshed shortly before its candle started counts (not one left over from a closed page)
      if (c && pend.dir && pend.at > pend.t - Math.max(OF.tfMs[tf] * 0.25, 3e4)) {
        const ad = Math.sign(c.c - c.o);
        j.log = (j.log || []).concat([{ t: pend.t, d: pend.dir, p: +pend.model.toFixed(3), b: bucket(pend.model), ok: ad === pend.dir, inR: c.c >= pend.l && c.c <= pend.h }]).slice(-500);
      }
      j.pend = null;
    }
    // keep the pending prediction fresh until the candle it predicts starts, then it is frozen
    const p = P.calc(tf);
    if (p && now < p.t && (!j.pend || j.pend.t === p.t)) j.pend = { t: p.t, at: now, dir: p.dir, model: p.model, o: p.o, h: p.h, l: p.l, c: p.c };
    LS.set(key(tf), j);
  }
};
P.reset = tf => { LS.set(key(tf), { log: [] }); };

/* ---------- drawing: g = { k, end, X, Y, bw, tf, pw, top, bottom, mouse, cv } ---------- */
const YEL = '#FFD60A';
P.draw = function (ctx, g) {
  if (!OF.app.lines.pred) return;
  const k = g.k; if (!k || g.end !== k.length) return;      // only when the newest candle is on screen
  const p = P.calc(g.tf); if (!p) return;
  const x = g.X(k.length), bw = g.bw, top = g.top || 0, bottom = g.bottom;
  if (x > g.pw - 4) return;
  const yo = g.Y(p.o), yc = g.Y(p.c), yh = g.Y(p.h), yl = g.Y(p.l), conf = Math.round(p.conf * 100);
  ctx.save();
  // column + separator
  const cw = Math.max(16, bw * 1.4);
  ctx.fillStyle = 'rgba(255,214,10,.07)'; ctx.fillRect(x - cw / 2, top, cw, bottom - top);
  ctx.strokeStyle = 'rgba(255,214,10,.45)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x - cw / 2 + .5, top); ctx.lineTo(x - cw / 2 + .5, bottom); ctx.stroke(); ctx.setLineDash([]);
  // wick + body
  ctx.strokeStyle = YEL; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, yh); ctx.lineTo(Math.round(x) + .5, yl); ctx.stroke();
  const bwid = Math.max(10, bw * 0.8), hgt = Math.max(6, Math.abs(yc - yo)), y1 = Math.abs(yc - yo) >= 6 ? Math.min(yo, yc) : (yo + yc) / 2 - 3;
  ctx.shadowColor = YEL; ctx.shadowBlur = 12; ctx.fillStyle = 'rgba(255,214,10,.78)'; ctx.fillRect(x - bwid / 2, y1, bwid, hgt); ctx.shadowBlur = 0;
  ctx.setLineDash([3, 2]); ctx.strokeStyle = '#fff3b0'; ctx.lineWidth = 1; ctx.strokeRect(x - bwid / 2 + .5, y1 + .5, bwid - 1, hgt - 1); ctx.setLineDash([]);
  // label above the high
  const arrow = p.dir > 0 ? '▲ UP' : p.dir < 0 ? '▼ DOWN' : '◆ FLAT', st = p.stats;
  const l1 = `NEXT ${g.tf} ${arrow} · ${conf}%`, l2 = st.n >= 5 ? `measured ${Math.round(st.hit / st.n * 100)}% of ${st.n}` : 'measuring… (' + st.n + ' checked)';
  const mins = Math.max(0, p.opensIn), l3 = 'opens in ' + (mins >= 36e5 ? Math.floor(mins / 36e5) + 'h ' + Math.floor(mins % 36e5 / 6e4) + 'm' : Math.floor(mins / 6e4) + 'm ' + Math.floor(mins % 6e4 / 1e3) + 's');
  ctx.font = '800 11px Inter,system-ui,sans-serif'; const w1 = ctx.measureText(l1).width; ctx.font = '600 10px Inter,system-ui,sans-serif';
  const wb = Math.max(w1, ctx.measureText(l2).width, ctx.measureText(l3).width) + 16, hb = 44;
  const midY = (yh + yl) / 2, low = midY < (top + bottom) / 2;      // candle in the upper half → label near the bottom, and vice versa
  const bx = OF.clamp(x + cw / 2 - wb, 4, g.pw - wb - 4), by = low ? bottom - hb - 8 : top + 26;
  ctx.strokeStyle = 'rgba(255,214,10,.7)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, low ? yl + 2 : yh - 2); ctx.lineTo(x, low ? by : by + hb); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = YEL; ctx.shadowColor = 'rgba(255,214,10,.45)'; ctx.shadowBlur = 14; ctx.beginPath(); ctx.roundRect(bx, by, wb, hb, 8); ctx.fill(); ctx.shadowBlur = 0;
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillStyle = '#1a1300'; ctx.font = '800 11px Inter,system-ui,sans-serif'; ctx.fillText(l1, bx + 8, by + 5);
  ctx.font = '600 10px Inter,system-ui,sans-serif'; ctx.fillStyle = '#3d3000'; ctx.fillText(l2, bx + 8, by + 19); ctx.fillText(l3, bx + 8, by + 31);
  // predicted close on the price scale
  const ylast = g.Y(k[k.length - 1].c), yt = Math.abs(yc - ylast) < 18 ? ylast + (yc >= ylast ? 18 : -18) : yc;
  ui.tag(ctx, g.pw + 1, yt, '≈' + OF.fp(p.c), YEL, '#1a1300');
  ctx.restore();
  // hover: the full breakdown
  const m = g.mouse;
  const over = m && g.cv && Math.abs(m.x - x) < Math.max(14, bw) && m.y > top && m.y < bottom;
  if (!over && P._tip) { P._tip = false; ui.tip(); }
  if (over) {
    P._tip = true;
    const r = g.cv.getBoundingClientRect(), pct = v => (v >= 0 ? '+' : '') + Math.round(v * 100);
    const famRows = FAM.filter(f => p.fams[f] != null).map(f => `<div>${FAMNAME[f]}: <b class="${p.fams[f] > 0.1 ? 'g' : p.fams[f] < -0.1 ? 'r' : ''}">${pct(p.fams[f])}</b></div>`).join('');
    const top3 = p.factors.slice().sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 6).map(f => `<div>${f.v > 0 ? '▲' : '▼'} ${f.name} <span class="muted">${pct(f.v)}</span></div>`).join('');
    const bk = Object.entries(st.b).map(([b, v]) => `${b}: ${Math.round(v.hit / v.n * 100)}% of ${v.n}`).join(' · ');
    ui.tip(r.left + m.x, r.top + m.y, `<b>Next ${g.tf} candle — ${arrow}</b><br>open ≈ ${OF.fp(p.o)} · high ≈ ${OF.fp(p.h)} · low ≈ ${OF.fp(p.l)} · close ≈ ${OF.fp(p.c)}<br>
      model ${Math.round(p.model * 100)}% · shown ${conf}% · ${Math.round(p.agree * 100)}% of readings agree<br>${famRows}<br><b>Strongest readings</b>${top3}
      ${p.notes.length ? '<br>' + p.notes.join('<br>') : ''}<br><span class="muted">Measured on this coin: ${st.n ? Math.round(st.hit / st.n * 100) + '% right of ' + st.n + (bk ? ' (' + bk + ')' : '') + ' · close inside the range ' + Math.round(st.inR / st.n * 100) + '%' : 'no checks yet'}.<br>An estimate, not a promise.</span>`);
  }
};

// keep the journal running on every tab (every 5 s) and on coin change
setInterval(() => { try { P.track(); } catch (e) { console.error(e); } }, 5000);
})();

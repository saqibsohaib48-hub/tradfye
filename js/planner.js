/* FlowDesk trade planner — combines every reading into one rule-based intraday setup on the 1h chart.
   1) Bias: 12 factors (trend 1h/4h, structure, value, flow, delta, whales, book, futures, liquidations, gamma, RSI).
   2) Levels: every support/resistance source (swings 1h+4h, POC/VA/VWAP, prior day, book walls, liquidation
      clusters, gamma walls, whale zones, round numbers) merged into zones; strength = how many sources agree.
   3) Plan: entry at the strongest nearby zone in the bias direction, stop beyond that zone (ATR-buffered),
      targets at the next opposing zones. Too little reward for the risk → NO TRADE. */
(function () {
'use strict';
const OF = window.OF, C = OF.C, el = OF.el, ui = OF.ui, LS = OF.LS;

OF.atr = (k, n = 14) => { let a = null; for (let i = Math.max(1, k.length - n * 4); i < k.length; i++) { const tr = Math.max(k[i].h - k[i].l, Math.abs(k[i].h - k[i - 1].c), Math.abs(k[i].l - k[i - 1].c)); a = a == null ? tr : (a * (n - 1) + tr) / n; } return a; };
function pivots(k, lb, look) {
  const hi = [], lo = [];
  for (let i = Math.max(lb, k.length - look); i < k.length - lb; i++) {
    let h = true, l = true;
    for (let j = i - lb; j <= i + lb; j++) { if (j === i) continue; if (k[j].h >= k[i].h) h = false; if (k[j].l <= k[i].l) l = false; }
    if (h) hi.push({ t: k[i].t, p: k[i].h }); if (l) lo.push({ t: k[i].t, p: k[i].l });
  }
  return { hi, lo };
}
const clamp1 = v => OF.clamp(v, -1, 1);


/* Merge raw levels (price, weight, source) into zones; nearby levels within mergeK × ATR join. */
function makeZones(lv, px, atr, mergeK) {
  lv.sort((a, b) => a.p - b.p);
  const zones = [];
  for (const l of lv) {
    const z = zones[zones.length - 1];
    if (z && l.p - z.hi < atr * mergeK) { z.hi = Math.max(z.hi, l.p); z.pw += l.p * l.w; z.w += l.w; z.src.push(l.src); }
    else zones.push({ lo: l.p, hi: l.p, pw: l.p * l.w, w: l.w, src: [l.src] });
  }
  zones.forEach(z => { z.p = z.pw / z.w; z.src = [...new Set(z.src)]; });
  return { zones, sup: zones.filter(z => z.hi < px - atr * 0.05).sort((a, b) => b.p - a.p), res: zones.filter(z => z.lo > px + atr * 0.05).sort((a, b) => a.p - b.p) };
}
/* Entry at the strongest nearby zone on our side, stop beyond it, targets at the next opposing zones. */
function buildPlan(dir, px, atr, sup, res, c) {
  const strong = z => z.w >= 2.5, near = dir > 0 ? sup : res, far = dir > 0 ? res : sup;
  let best = null;
  for (const z of near) { const d = Math.abs(z.p - px) / atr; if (d > c.near) break; const sc = z.w / (1 + d); if (!best || sc > best.sc) best = { z, sc, d }; }
  let entry, eType, base;
  if (best) { base = best.z; entry = dir > 0 ? base.hi : base.lo; eType = Math.abs(entry - px) < atr * 0.2 ? 'market' : 'limit'; if (eType === 'market') entry = px; }
  else { entry = px; eType = 'market'; base = near[0] || null; }
  let stop = base ? (dir > 0 ? base.lo - atr * c.buf : base.hi + atr * c.buf) : entry - dir * atr * (c.minR + c.maxR) / 2;
  let risk = Math.abs(entry - stop);
  if (risk < atr * c.minR) { stop = entry - dir * atr * c.minR; risk = atr * c.minR; }
  if (risk > atr * c.maxR) { stop = entry - dir * atr * c.maxR; risk = atr * c.maxR; }
  const tz = far.filter(z => dir > 0 ? z.lo > entry + risk * 0.8 : z.hi < entry - risk * 0.8);
  const edge = z => dir > 0 ? z.lo - atr * 0.05 : z.hi + atr * 0.05;
  const tp1z = tz.find(z => Math.abs(edge(z) - entry) >= risk) || null;
  let tp1 = tp1z ? edge(tp1z) : entry + dir * risk * c.tp1R;
  if (Math.abs(tp1 - entry) > atr * c.tp1Cap) tp1 = entry + dir * risk * c.tp1R;
  const beyond = z => dir > 0 ? edge(z) > tp1 + atr * c.step : edge(z) < tp1 - atr * c.step;
  const tp2z = tz.find(z => beyond(z) && strong(z)) || tz.find(beyond);
  let tp2 = tp2z ? edge(tp2z) : entry + dir * risk * c.tp2R;
  if (Math.abs(tp2 - entry) > atr * c.tp2Cap) tp2 = entry + dir * risk * c.tp2R;
  const blocker = far.find(z => strong(z) && (dir > 0 ? z.lo > entry && z.lo < tp1 : z.hi < entry && z.hi > tp1));
  return { dir, entry, eType, stop, risk, tp1, tp2, rr1: Math.abs(tp1 - entry) / risk, rr2: Math.abs(tp2 - entry) / risk, base, tp1z, tp2z, blocker,
    trigger: dir > 0 ? (res[0] ? res[0].hi : px + atr) : (sup[0] ? sup[0].lo : px - atr) };
}
/* Measured hit rate: replay the same kind of setup on past candles.
   Signal = EMA9 vs EMA21 in our direction, close on our side of EMA50, last-5-candle taker delta in our direction.
   Each signal: enter at close, stop = same ATR multiple as the live plan, TP1/TP2 at the live plan's R multiples,
   half off at TP1 then stop to entry. A candle touching both stop and TP1 counts as a loss (conservative). */
function backtest(k, dir, rATR, rr1, rr2, maxBars, label) {
  if (!k || k.length < 120 || !(rATR > 0)) return null;
  const e9 = OF.ema(k, 9), e21 = OF.ema(k, 21), e50 = OF.ema(k, 50), atr = new Array(k.length);
  let a = null; for (let i = 1; i < k.length; i++) { const tr = Math.max(k[i].h - k[i].l, Math.abs(k[i].h - k[i - 1].c), Math.abs(k[i].l - k[i - 1].c)); a = a == null ? tr : (a * 13 + tr) / 14; atr[i] = a; }
  let w1 = 0, w2 = 0, loss = 0, to = 0, sumR = 0;
  for (let i = 60; i < k.length - 2;) {
    let d5 = 0; for (let j = i - 4; j <= i; j++) d5 += 2 * k[j].bqv - k[j].qv;
    const sig = dir > 0 ? e9[i] > e21[i] && k[i].c > e50[i] && d5 > 0 : e9[i] < e21[i] && k[i].c < e50[i] && d5 < 0;
    if (!sig) { i++; continue; }
    const en = k[i].c, R = rATR * atr[i], st = en - dir * R, t1 = en + dir * R * rr1, t2 = en + dir * R * rr2;
    let res = null, hit1 = false, j = i + 1;
    for (; j < k.length && j <= i + maxBars; j++) {
      const c = k[j], hi = dir > 0 ? c.h : -c.l, lo = dir > 0 ? c.l : -c.h, S_ = dir * st, T1 = dir * t1, T2 = dir * t2, EN = dir * en;
      if (!hit1) { if (lo <= S_) { res = 'loss'; break; } if (hi >= T1) { hit1 = true; if (hi >= T2) { res = 'w2'; break; } continue; } }
      else { if (hi >= T2) { res = 'w2'; break; } if (lo <= EN) { res = 'w1'; break; } }
    }
    if (!res) res = hit1 ? 'w1' : 'to';
    if (res === 'loss') { loss++; sumR -= 1; } else if (res === 'w1') { w1++; sumR += rr1 / 2; } else if (res === 'w2') { w2++; sumR += (rr1 + rr2) / 2; } else to++;
    i = j + 1;
  }
  const decided = w1 + w2 + loss, n = decided + to;
  if (!decided) return { n: 0, label };
  return { n, decided, win: (w1 + w2) / decided, w2: w2 / decided, loss: loss / decided, to, exp: sumR / n, be: 1 / (1 + rr1 / 2), label };
}

OF.tradePlan = function () {
  const S = OF.S; if (!S || !S.info) return { wait: 'Loading…' };
  const k1 = S.k['1h'], k4 = S.k['4h'];
  if (!k1 || k1.length < 60 || !k4 || k4.length < 60) { OF.loadKlines('1h'); OF.loadKlines('4h'); return { wait: 'Loading 1h and 4h candles…' }; }
  const px = S.last || k1[k1.length - 1].c, atr = OF.atr(k1), atr4 = OF.atr(k4);
  const met = OF.meters(), M = {}; if (met) for (const m of met.list) M[m.key] = m;
  const dec = OF.lastDecision || OF.decision();
  const ss = OF.session(), now = OF.now();

  /* ---------- 1. bias ---------- */
  const F = [];
  const fac = (name, w, s, text, group) => F.push({ name, w, s: s == null ? null : clamp1(s), text, group });
  const trend = (k, a, label) => {
    const e21 = OF.ema(k, 21), e50 = OF.ema(k, 50), i = k.length - 1, c = k[i].c;
    const s = 0.5 * Math.sign(e21[i] - e50[i]) + 0.5 * clamp1((c - e21[i]) / a);
    return [s, `${label}: price ${c > e21[i] ? 'above' : 'below'} EMA21 (${OF.fp(e21[i])}), EMA21 ${e21[i] > e50[i] ? 'above' : 'below'} EMA50`];
  };
  let [s4, t4] = trend(k4, atr4, '4h'); fac('4h trend', 2, s4, t4, 'Trend');
  let [s1, t1] = trend(k1, atr, '1h'); fac('1h trend', 1.5, s1, t1, 'Trend');
  const pv = pivots(k1, 3, 120), H = pv.hi.slice(-2), L = pv.lo.slice(-2);
  let st = 0, stt = 'not enough swings';
  if (H.length === 2 && L.length === 2) {
    const hh = H[1].p > H[0].p, hl = L[1].p > L[0].p;
    st = hh && hl ? 1 : !hh && !hl ? -1 : 0;
    stt = (hh ? 'higher high' : 'lower high') + ' + ' + (hl ? 'higher low' : 'lower low') + (st > 0 ? ' → uptrend structure' : st < 0 ? ' → downtrend structure' : ' → range / transition');
  }
  fac('1h structure', 1, st, stt, 'Trend');
  const k1r = OF.rsi(k1, 14), rsi = k1r[k1r.length - 1];
  fac('RSI 14 (1h)', 0.5, rsi > 75 ? -0.4 : rsi < 25 ? 0.4 : (rsi - 50) / 50, rsi.toFixed(1) + (rsi > 70 ? ' — stretched up, late to chase longs' : rsi < 30 ? ' — stretched down, late to chase shorts' : ''), 'Trend');
  if (M.va || M.vwap) fac('Value (VWAP / value area)', 1, ((M.va ? M.va.score : 0) + (M.vwap ? M.vwap.score : 0)) / (M.va && M.vwap ? 200 : 100), [M.va && M.va.text, M.vwap && M.vwap.text].filter(Boolean).join(' · '), 'Value');
  if (dec) fac('Order flow now', 1, dec.score / 60, 'Decision engine ' + OF.label(dec.score) + ' ' + Math.round(Math.abs(dec.score)), 'Flow');
  const dl = ['d1h', 'd4h'].map(k => M[k]).filter(x => x && x.score != null);
  if (dl.length) fac('Delta 1h + 4h candles', 1, dl.reduce((a, x) => a + x.score, 0) / dl.length / 100, dl.map(x => x.name + ' ' + x.text.split('·')[0]).join(' · '), 'Flow');
  // whales over the last 4h (what has been recorded)
  const wl = OF.whaleList('big', S.whaleThr || 1e9, now - 4 * 36e5); let wb = 0, ws = 0, wbp = 0, wsp = 0;
  for (const w of wl) { if (w.buy) { wb += w.n; wbp += w.n * w.p; } else { ws += w.n; wsp += w.n * w.p; } }
  const recFrom = S.trades.length ? S.trades[0].t : now, recH = (now - recFrom) / 36e5;
  fac('Whales (4h window)', 1, (wb + ws) ? (wb - ws) / (wb + ws) : 0, `${OF.fmtUsd(wb - ws, true)} net from ${wl.length} prints ≥ ${OF.fmtUsd(S.whaleThr)}` + (recH < 4 ? ` (only ${recH < 1 ? Math.round(recH * 60) + ' min' : recH.toFixed(1) + ' h'} recorded so far)` : ''), 'Whales');
  if (M.walls) fac('Book liquidity ±0.5%', 0.5, M.walls.score / 100, M.walls.text, 'Liquidity');
  if (M.fake) fac('Fake walls', 0.4, M.fake.score / 100, M.fake.text, 'Liquidity');
  const lm = OF.liqMap();
  if (lm && lm.shortsAbove3 != null && (lm.shortsAbove3 + lm.longsBelow3)) fac('Liquidation magnet ±3%', 0.7, (lm.shortsAbove3 - lm.longsBelow3) / (lm.shortsAbove3 + lm.longsBelow3), `est. ${OF.fmtUsd(lm.shortsAbove3)} shorts above vs ${OF.fmtUsd(lm.longsBelow3)} longs below — price tends to hunt the bigger pool`, 'Liquidity');
  if (M.fund || M.oi) fac('Funding + open interest', 0.5, ((M.fund ? M.fund.score : 0) + (M.oi ? M.oi.score : 0)) / 200, [M.fund && M.fund.text, M.oi && M.oi.text].filter(Boolean).join(' · '), 'Futures');
  OF.loadGamma(); const g = OF.gammaCalc({ days: 30 });
  if (g && g.flip) fac('Options gamma', 0.4, px > g.flip ? 0.3 : -0.3, (g.net < 0 ? 'negative gamma (moves extend)' : 'positive gamma (ranges hold)') + ` · price ${px > g.flip ? 'above' : 'below'} zero-gamma ${OF.fp(g.flip)}`, 'Options');

  let sw = 0, sum = 0; for (const f of F) if (f.s != null) { sum += f.s * f.w; sw += f.w; }
  const bias = sw ? sum / sw : 0;
  const voting = F.filter(f => f.s != null && Math.abs(f.s) > 0.15), agree = voting.length ? voting.filter(f => Math.sign(f.s) === Math.sign(bias)).length / voting.length : 0;

  /* ---------- 2. levels ---------- */
  const lv = [];
  const add = (p, w, src) => { if (p && isFinite(p) && Math.abs(p / px - 1) < 0.06) lv.push({ p, w, src }); };
  const p4 = pivots(k4, 2, 90);
  p4.hi.slice(-6).forEach(x => add(x.p, 2, '4h swing high')); p4.lo.slice(-6).forEach(x => add(x.p, 2, '4h swing low'));
  pv.hi.slice(-8).forEach(x => add(x.p, 1.2, '1h swing high')); pv.lo.slice(-8).forEach(x => add(x.p, 1.2, '1h swing low'));
  if (ss) {
    if (ss.today) { add(ss.today.poc, 1.5, 'today POC'); add(ss.today.vah, 1.2, 'today VAH'); add(ss.today.val, 1.2, 'today VAL'); }
    if (ss.prev) { add(ss.prev.poc, 1.2, 'prev-day POC'); add(ss.prev.vah, 1, 'prev-day VAH'); add(ss.prev.val, 1, 'prev-day VAL'); }
    if (ss.vwap) add(ss.vwap, 1.2, 'VWAP');
    if (S.day && S.day.prev.length) { let h = -Infinity, l = Infinity; for (const c of S.day.prev) { h = Math.max(h, c.h); l = Math.min(l, c.l); } add(h, 1.5, 'prev-day high'); add(l, 1.5, 'prev-day low'); }
  }
  if (S.synced) {
    const bb = OF.bookBins(1.5, OF.niceStep(px * 0.0008)), walls = [];
    for (const [p, n] of bb.b) walls.push({ p: p + bb.bin / 2, n, side: 'bid' }); for (const [p, n] of bb.a) walls.push({ p: p + bb.bin / 2, n, side: 'ask' });
    walls.sort((a, b) => b.n - a.n); const mx = walls.length ? walls[0].n : 1;
    walls.slice(0, 8).forEach(w => add(w.p, 0.8 + 1.5 * w.n / mx, (w.side === 'bid' ? 'bid wall ' : 'ask wall ') + OF.fmtUsd(w.n)));
  }
  if (lm && lm.rows.length) {
    const rows = lm.rows.slice().sort((a, b) => (b.long + b.short) - (a.long + a.short)).slice(0, 6), mx = rows.length ? rows[0].long + rows[0].short : 1;
    rows.forEach(r => add(r.p + lm.bin / 2, 0.8 + 1.2 * (r.long + r.short) / mx, 'liq cluster ' + OF.fmtUsd(r.long + r.short)));
  }
  if (g) { add(g.callWall, 1.5, 'call wall'); add(g.putWall, 1.5, 'put wall'); add(g.flip, 0.8, 'zero-gamma'); add(g.maxPain, 0.5, 'max pain'); }
  if (wl.length) {
    const zb = OF.niceStep(atr / 2), zm = new Map(); for (const w of wl) { const kk = Math.floor(w.p / zb) * zb; zm.set(kk, (zm.get(kk) || 0) + w.n); }
    const top = [...zm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3), mx = top.length ? top[0][1] : 1;
    top.forEach(([p, v]) => add(p + zb / 2, 0.8 + v / mx, 'whale zone ' + OF.fmtUsd(v)));
    if (wb) add(wbp / wb, 0.8, 'whale buyers avg'); if (ws) add(wsp / ws, 0.8, 'whale sellers avg');
  }
  const rs = OF.niceStep(px * 0.01); add(Math.round(px / rs) * rs, 0.5, 'round number'); add((Math.round(px / rs) + 1) * rs, 0.5, 'round number'); add((Math.round(px / rs) - 1) * rs, 0.5, 'round number');
  const { zones, sup, res } = makeZones(lv, px, atr, 0.25);
  const strong = z => z.w >= 2.5;
  const build = dir => buildPlan(dir, px, atr, sup, res, { near: 1.6, buf: 0.25, minR: 0.6, maxR: 2, tp1R: 1.5, tp1Cap: 4, tp2R: 3, tp2Cap: 6, step: 0.3 });
  const long = build(1), short = build(-1);
  let side = 0, why = [];
  if (Math.abs(bias) >= 0.2 && agree >= 0.55) side = Math.sign(bias);
  else why.push(Math.abs(bias) < 0.2 ? 'the factors cancel out (bias ' + (bias * 100).toFixed(0) + ')' : 'only ' + Math.round(agree * 100) + '% of factors agree');
  let plan = side > 0 ? long : side < 0 ? short : null;
  if (plan && plan.rr1 < 1.3) { why.push(`reward to the first target is only ${plan.rr1.toFixed(1)}R — a ${side > 0 ? 'resistance' : 'support'} zone sits too close`); plan = null; }
  if (plan && rsi > 78 && side > 0 && plan.eType === 'market') { why.push('1h RSI is above 78 — wait for the pullback limit instead of buying here'); plan.eType = 'limit'; }
  if (plan && rsi < 22 && side < 0 && plan.eType === 'market') { why.push('1h RSI is below 22 — wait for the bounce limit instead of selling here'); plan.eType = 'limit'; }
  const conf = Math.round(OF.clamp(Math.abs(bias) * 100 * 0.7 + agree * 40 + (plan && plan.base && strong(plan.base) ? 10 : 0), 0, 95));
  const ref = plan || (Math.abs(bias) > 0 ? (bias > 0 ? long : short) : long);
  const prob = backtest(k1, ref.dir, ref.risk / OF.atr(k1), ref.rr1, ref.rr2, 24, 'last ' + Math.round(k1.length / 24) + ' days of 1h candles');
  return { at: Date.now(), px, atr, atr4, bias, agree, factors: F, zones, sup, res, long, short, side: plan ? side : 0, plan, why, conf, rsi, recH, prob,
    verdict: plan ? (side > 0 ? 'LONG' : 'SHORT') : 'NO TRADE' };
};


/* ---------- weekly candles (kept outside S.k: Binance weeks start Monday, so they are not live-built) ---------- */
OF.loadWeekly = function () {
  const S = OF.S; if (S.kw || S._kwLoading) return S.kw || null;
  if (OF.demo) { const d = OF.demoKlines('1d'); S.kw = []; for (let i = 0; i < d.length; i += 7) { const g = d.slice(i, i + 7); S.kw.push({ t: g[0].t, o: g[0].o, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[g.length - 1].c, v: 0, qv: 0, bv: 0, bqv: 0 }); } return S.kw; }
  S._kwLoading = true;
  OF.getJ(`/api/v3/klines?symbol=${S.symbol}&interval=1w&limit=200`).then(r => { if (OF.S === S) S.kw = r.map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], qv: +x[7], bv: +x[9], bqv: +x[10] })); }).catch(() => { S._kwLoading = false; });
  return null;
};

/* ===================== SWING PLAN (daily) =====================
   Daily candles for levels, ATR and stops; 4h and weekly trend as context; liquidation clusters,
   options walls and order-book walls as extra levels. A swing is CONFIRMED only when 7 of 9 checks
   pass, including the three ★ ones. Win % is measured on ~2–3 years of daily candles. */
function trendOf(k, a) {
  const e21 = OF.ema(k, 21), e50 = OF.ema(k, 50), i = k.length - 1, c = k[i].c;
  return { s: OF.clamp(0.5 * Math.sign(e21[i] - e50[i]) + 0.5 * (c - e21[i]) / a, -1, 1), e21: e21[i], e50: e50[i] };
}
OF.swingPlan = function () {
  const S = OF.S; if (!S || !S.info) return { wait: 'Loading…' };
  const kd = S.k['1d'], k4 = S.k['4h'], kw = OF.loadWeekly();
  if (!kd || kd.length < 80 || !k4 || k4.length < 60) { OF.loadKlines('1d'); OF.loadKlines('4h'); return { wait: 'Loading daily and 4h candles…' }; }
  const px = S.last || kd[kd.length - 1].c, atr = OF.atr(kd), atr4 = OF.atr(k4), now = OF.now();
  const met = OF.meters(), M = {}; if (met) for (const m of met.list) M[m.key] = m;
  const F = [], fac = (name, w, s, text, group) => F.push({ name, w, s: s == null ? null : clamp1(s), text, group });
  const td = trendOf(kd, atr), t4 = trendOf(k4, atr4), tw = kw && kw.length > 55 ? trendOf(kw, OF.atr(kw)) : null;
  fac('Daily trend', 2, td.s, `price ${px > td.e21 ? 'above' : 'below'} daily EMA21 ${OF.fp(td.e21)}, EMA21 ${td.e21 > td.e50 ? 'above' : 'below'} EMA50`, 'Trend');
  fac('4h trend', 1.2, t4.s, `price ${px > t4.e21 ? 'above' : 'below'} 4h EMA21 ${OF.fp(t4.e21)}`, 'Trend');
  if (tw) fac('Weekly trend', 1.5, tw.s, `price ${px > tw.e21 ? 'above' : 'below'} weekly EMA21 ${OF.fp(tw.e21)}`, 'Trend');
  const pd = pivots(kd, 2, 200), H = pd.hi.slice(-2), Lo = pd.lo.slice(-2); let st = 0, stt = 'not enough daily swings';
  if (H.length === 2 && Lo.length === 2) { const hh = H[1].p > H[0].p, hl = Lo[1].p > Lo[0].p; st = hh && hl ? 1 : !hh && !hl ? -1 : 0; stt = (hh ? 'higher high' : 'lower high') + ' + ' + (hl ? 'higher low' : 'lower low'); }
  fac('Daily structure', 1.2, st, stt, 'Trend');
  const r = OF.rsi(kd, 14), rsi = r[r.length - 1];
  fac('RSI 14 (daily)', 0.6, rsi > 75 ? -0.4 : rsi < 25 ? 0.4 : (rsi - 50) / 50, rsi.toFixed(1), 'Trend');
  const dm = k => (M[k] && M[k].score != null) ? M[k] : null;
  if (dm('d1d')) fac('Daily candle delta', 1, M.d1d.score / 100, M.d1d.text, 'Flow');
  if (dm('d4h')) fac('4h candle delta', 0.8, M.d4h.score / 100, M.d4h.text, 'Flow');
  if (dm('whale')) fac('Whales (recorded)', 0.6, M.whale.score / 100, M.whale.text, 'Flow');
  if (dm('fund')) fac('Funding (crowd)', 0.6, M.fund.score / 100, M.fund.text, 'Futures');
  if (dm('oi')) fac('Open interest vs price', 0.5, M.oi.score / 100, M.oi.text, 'Futures');
  if (dm('fuel')) fac('Liquidation magnet', 0.8, M.fuel.score / 100, M.fuel.text, 'Futures');
  OF.loadGamma(); const g = OF.gammaCalc({ days: 30 });
  if (g && g.flip) fac('Options gamma', 0.5, px > g.flip ? 0.3 : -0.3, `price ${px > g.flip ? 'above' : 'below'} zero-gamma ${OF.fp(g.flip)} · call wall ${OF.fp(g.callWall)} · put wall ${OF.fp(g.putWall)}`, 'Options');
  let sw = 0, sum = 0; for (const f of F) if (f.s != null) { sum += f.s * f.w; sw += f.w; }
  const bias = sw ? sum / sw : 0, voting = F.filter(f => f.s != null && Math.abs(f.s) > 0.15);
  const agree = voting.length ? voting.filter(f => Math.sign(f.s) === Math.sign(bias)).length / voting.length : 0;

  // levels within ±15 %
  const lv = [], add = (p, w, src) => { if (p && isFinite(p) && Math.abs(p / px - 1) < 0.15) lv.push({ p, w, src }); };
  pd.hi.slice(-8).forEach(x => add(x.p, 2, 'daily swing high')); pd.lo.slice(-8).forEach(x => add(x.p, 2, 'daily swing low'));
  const p4 = pivots(k4, 2, 150); p4.hi.slice(-6).forEach(x => add(x.p, 1.2, '4h swing high')); p4.lo.slice(-6).forEach(x => add(x.p, 1.2, '4h swing low'));
  if (kw && kw.length > 2) { const w = kw[kw.length - 2]; add(w.h, 1.8, 'last week high'); add(w.l, 1.8, 'last week low'); const pw = pivots(kw, 2, 60); pw.hi.slice(-4).forEach(x => add(x.p, 2.2, 'weekly swing high')); pw.lo.slice(-4).forEach(x => add(x.p, 2.2, 'weekly swing low')); }
  const yd = kd[kd.length - 2]; add(yd.h, 1.2, 'yesterday high'); add(yd.l, 1.2, 'yesterday low');
  const e = OF.ema(kd, 50), e200 = OF.ema(kd, 200); add(e[e.length - 1], 1, 'daily EMA50'); if (kd.length >= 200) add(e200[e200.length - 1], 1.5, 'daily EMA200');
  const lm = OF.liqMap(); if (lm) lm.rows.slice().sort((a, b) => (b.long + b.short) - (a.long + a.short)).slice(0, 8).forEach(r => add(r.p + lm.bin / 2, 1.2, 'liq cluster ' + OF.fmtUsd(r.long + r.short)));
  if (g) { add(g.callWall, 1.6, 'call wall'); add(g.putWall, 1.6, 'put wall'); add(g.maxPain, 0.6, 'max pain'); }
  if (S.synced) { const bb = OF.bookBins(3, OF.niceStep(px * 0.002)), ws = []; for (const [p, n] of bb.b) ws.push({ p: p + bb.bin / 2, n, s: 'bid' }); for (const [p, n] of bb.a) ws.push({ p: p + bb.bin / 2, n, s: 'ask' }); ws.sort((a, b) => b.n - a.n); ws.slice(0, 6).forEach(w => add(w.p, 0.6, w.s + ' wall ' + OF.fmtUsd(w.n))); }
  const rs = OF.niceStep(px * 0.02); for (let j = -3; j <= 3; j++) add((Math.round(px / rs) + j) * rs, 0.6, 'round number');
  const { zones, sup, res } = makeZones(lv, px, atr, 0.3);
  const cfg = { near: 1.0, buf: 0.25, minR: 0.6, maxR: 1.8, tp1R: 1.5, tp1Cap: 4, tp2R: 3, tp2Cap: 6, step: 0.3 };
  const long = buildPlan(1, px, atr, sup, res, cfg), short = buildPlan(-1, px, atr, sup, res, cfg);
  const dir = bias >= 0 ? 1 : -1, pl = dir > 0 ? long : short;
  const sc = k => (M[k] && M[k].score != null ? M[k].score : 0) * dir, fund = S.fut.funding;
  const CH = [
    ['Daily and 4h trend agree', td.s * dir > 0.15 && t4.s * dir > -0.15, `daily ${Math.round(td.s * 100)} · 4h ${Math.round(t4.s * 100)}`, true],
    ['Weekly trend not strongly against', !tw || tw.s * dir > -0.5, tw ? 'weekly ' + Math.round(tw.s * 100) : 'loading weekly', false],
    ['Daily structure not against', st * dir >= 0, stt, true],
    ['Today’s candle delta not against', sc('d1d') > -20, M.d1d ? M.d1d.text : '', false],
    ['Strong zone protects the stop', !!(pl.base && pl.base.w >= 2.5), pl.base ? `${OF.fp(pl.base.p)} · ${pl.base.src.slice(0, 3).join(', ')}` : 'no zone near price', true],
    ['Room to TP1 (no strong zone in the way)', !pl.blocker, pl.blocker ? 'zone at ' + OF.fp(pl.blocker.p) : 'clear', false],
    ['Funding not crowded on our side', fund == null || fund * dir < 0.0003, fund == null ? 'no futures data' : (fund * 100).toFixed(4) + '% per 8 h', false],
    ['Liquidation pull not against us', sc('fuel') > -30, M.fuel ? M.fuel.text : 'no estimate', false],
    ['RSI not stretched in our direction', dir > 0 ? rsi < 72 : rsi > 28, 'daily RSI ' + rsi.toFixed(1), false]
  ].map(([name, ok, text, key]) => ({ name, ok, text, key }));
  const passed = CH.filter(c => c.ok).length, keyOk = CH.filter(c => c.key).every(c => c.ok);
  const confirmed = passed >= 7 && keyOk && Math.abs(bias) >= 0.15 && pl.rr1 >= 1.2;
  const why = confirmed ? [] : [`${passed}/9 checks pass` + (keyOk ? '' : ' and a key check fails')];
  const hist = kd.slice(0, -1);
  const prob = backtest(hist, dir, pl.risk / atr, pl.rr1, pl.rr2, 15, 'last ' + (hist.length / 365).toFixed(1) + ' years of daily candles');
  const conf = Math.round(OF.clamp(passed / 9 * 60 + Math.abs(bias) * 40, 0, 95));
  return { at: Date.now(), scalp: true, px, atr, bias, agree, factors: F, zones, sup, res, long, short, plan: confirmed ? pl : null, idea: pl, side: confirmed ? dir : 0,
    checks: CH, passed, why, conf, prob, verdict: confirmed ? (dir > 0 ? 'LONG SWING' : 'SHORT SWING') : 'NO SWING' };
};

/* ===================== TRADE PLAN TAB =====================
   A plan is LOCKED when created so its levels do not move every refresh. It is then tracked tick by tick:
   waiting → active (entry touched) → tp1 (half off, stop to entry) → done / breakeven, or stopped,
   missed (target reached before entry), expired (not filled in 4 h). The analysis below keeps updating. */
const FINAL = { stopped: 1, done: 1, breakeven: 1, missed: 1, expired: 1 };
function lockPlan(p, symbol, expMs, expLabel) {
  const pl = p.plan;
  return { symbol, created: OF.now(), dir: pl.dir, entry: pl.entry, stop: pl.stop, stopNow: pl.stop, tp1: pl.tp1, tp2: pl.tp2, rr1: pl.rr1, rr2: pl.rr2, risk: pl.risk, eType: pl.eType,
    baseSrc: pl.base ? pl.base.src.slice(0, 2) : [], tp1Src: pl.tp1z ? pl.tp1z.src.slice(0, 2) : [], tp2Src: pl.tp2z ? pl.tp2z.src.slice(0, 2) : [],
    state: pl.eType === 'market' ? 'active' : 'waiting', filledAt: pl.eType === 'market' ? OF.now() : null, events: [], lastT: OF.now(), expires: OF.now() + expMs, expLabel, conf: p.conf, prob: p.prob, scalp: !!p.scalp };
}
function step(L, price, t) {
  const d = L.dir, up = x => d > 0 ? price >= x : price <= x, down = x => d > 0 ? price <= x : price >= x;
  if (L.state === 'waiting') {
    if (down(L.entry)) { L.state = 'active'; L.filledAt = t; L.events.push([t, 'Entry filled at ' + OF.fp(L.entry)]); }
    else if (up(L.tp1)) { L.state = 'missed'; L.events.push([t, 'Price reached TP1 before the entry — missed, do not chase']); }
    else if (t > L.expires) { L.state = 'expired'; L.events.push([t, 'Not filled within ' + (L.expLabel || '4 h') + ' — cancelled']); }
  } else if (L.state === 'active') {
    if (down(L.stopNow)) { L.state = 'stopped'; L.events.push([t, 'Stop hit at ' + OF.fp(L.stopNow) + ' (−1R)']); }
    else if (up(L.tp1)) { L.state = 'tp1'; L.stopNow = L.entry; L.events.push([t, 'TP1 hit — half closed, stop moved to entry']); }
  } else if (L.state === 'tp1') {
    if (up(L.tp2)) { L.state = 'done'; L.events.push([t, 'TP2 hit — trade complete']); }
    else if (down(L.stopNow)) { L.state = 'breakeven'; L.events.push([t, 'Returned to entry after TP1 — rest closed at breakeven']); }
  }
}
OF.views.plan = {
  label: 'Trade plan', title: 'Everything combined into one 1h intraday setup — entry, stop, targets, and live status',
  o: (() => { const o = Object.assign({ acct: 1000, risk: 1, full: false, ctf: '1h', ctfS: '1d', mode: 'intraday' }, LS.get('plan', {})); if (o.mode === 'scalp') o.mode = 'swing'; if (!['4h', '1d'].includes(o.ctfS)) o.ctfS = '1d'; return o; })(),
  zv: { n: 72, off: 0 },
  save() { LS.set('plan', this.o); },
  toolbar(tb) {
    const o = this.o;
    const inp = (lab, key, step) => { const w = el('div', 'grp'); w.appendChild(el('span', 'lbl', lab)); const i = el('input', 'num'); i.type = 'number'; i.step = step; i.value = o[key]; i.oninput = () => { o[key] = +i.value || 0; this.save(); this.html(); }; w.appendChild(i); return w; };
    tb.append(ui.seg('Mode', [['intraday', 'Intraday 1h'], ['swing', '📅 Swing 1D']], o.mode, v => { o.mode = v; this.save(); OF.app.remount(); }));
    tb.append(inp('Account $', 'acct', 100), inp('Risk %', 'risk', 0.25));
    const nb = el('button', 'tgl on', '✚ New plan'); nb.title = 'Discard the current plan and build a fresh one from the latest data'; nb.onclick = () => { this.unlock(); this.p = this.gen(); this.maybeLock(); this.html(); };
    tb.append(nb);
    if (o.mode === 'swing') tb.append(ui.seg('Chart', [['4h', '4h'], ['1d', '1D']], o.ctfS, v => { o.ctfS = v; this.save(); this.zv = { n: 90, off: 0 }; }));
    else tb.append(ui.seg('Chart', [['15m', '15m'], ['1h', '1h'], ['4h', '4h']], o.ctf, v => { o.ctf = v; this.save(); this.zv = { n: 72, off: 0 }; }));
    tb.append(ui.toggle('⛶ Full chart', o.full, v => { o.full = v; this.save(); this.applyFull(); }, 'Give the chart the whole page (status banner stays). Scroll = zoom, drag = pan, double-click = reset.'));
    tb.append(el('span', 'lbl', 'Rule-based setup — a decision aid, not financial advice.'));
  },
  isScalp() { return this.o.mode === 'swing'; },
  key() { return (this.isScalp() ? 'lockD:' : 'lock:') + OF.S.symbol; },
  gen() { return this.isScalp() ? OF.swingPlan() : OF.tradePlan(); },
  unlock() { this.L = null; LS.set(this.key(), null); },
  maybeLock() {
    const p = this.p; if (!p || p.wait || !p.plan) return;
    if (this.L && !FINAL[this.L.state]) return;
    this.L = this.isScalp() ? lockPlan(p, OF.S.symbol, 3 * 864e5, '3 days') : lockPlan(p, OF.S.symbol, 4 * 36e5, '4 h'); LS.set(this.key(), this.L);
  },
  applyFull() { if (this.root) this.root.classList.toggle('plfull', !!this.o.full); this.c && this.c.fit(); },
  mount(v) {
    this.root = v; v.classList.add('scroll');
    v.innerHTML = '<div id="plStatus"></div><div id="plTop"></div><div class="plgrid"><div class="gbox plchart" id="plChart"></div><div id="plSide"></div></div><div id="plFactors"></div>';
    this.c = ui.canvas(document.getElementById('plChart')); ui.track(this);
    const cv = this.c.cv; let drag = null;
    cv.onwheel = e => { e.preventDefault(); this.zv.n = OF.clamp(Math.round(this.zv.n * (e.deltaY > 0 ? 1.15 : 0.87)), 15, 600); };
    cv.onmousedown = e => { drag = { x: e.clientX, off: this.zv.off }; };
    window.addEventListener('mouseup', () => drag = null);
    cv.addEventListener('mousemove', e => { if (drag && this.bw) this.zv.off = Math.max(0, drag.off + Math.round((e.clientX - drag.x) / this.bw)); });
    cv.ondblclick = () => { this.zv = { n: 72, off: 0 }; };
    const saved = LS.get(this.key(), null);
    this.L = saved && saved.symbol === OF.S.symbol ? saved : null;
    this.p = null; this.applyFull();
  },
  track() {
    const L = this.L, S = OF.S; if (!L || FINAL[L.state]) return;
    const tr = S.trades, first = tr.length ? tr[0].t : OF.now(), kh = S.k['1h'];
    // catch up on hours the page was closed: replay 1h candles (worst-case extreme first)
    if (kh && L.lastT < first - 36e5) {
      for (const c of kh) {
        if (c.t + 36e5 <= L.lastT || c.t >= first) continue;
        const adverse = L.dir > 0 ? c.l : c.h, favour = L.dir > 0 ? c.h : c.l;
        step(L, adverse, c.t + 36e5 - 1); if (FINAL[L.state]) break; step(L, favour, c.t + 36e5 - 1); if (FINAL[L.state]) break;
      }
      L.lastT = Math.max(L.lastT, first - 1);
    }
    for (let i = OF.lb(tr, L.lastT + 1); i < tr.length; i++) { step(L, tr[i].p, tr[i].t); if (FINAL[L.state]) break; }
    if (!FINAL[L.state] && L.state === 'waiting' && OF.now() > L.expires) step(L, S.last, OF.now());
    L.lastT = tr.length ? tr[tr.length - 1].t : OF.now();
    LS.set(this.key(), L);
  },
  reading() {
    const p = this.p; if (!p || p.wait) return 'Collecting data for the plan…';
    if (p.scalp) return `Swing engine (daily): bias <b class="${p.bias > 0 ? 'g' : 'r'}">${p.bias > 0 ? 'bullish' : 'bearish'} ${Math.abs(p.bias * 100).toFixed(0)}</b> · <b>${p.passed}/9</b> confirmation checks pass · daily ATR ${OF.fp(p.atr)} · re-checked every 15 s; a confirmed swing is locked and tracked (cancelled if not filled within 3 days). Hold time: days, not hours.`;
    return `Live analysis: bias <b class="${p.bias > 0 ? 'g' : 'r'}">${p.bias > 0 ? 'bullish' : 'bearish'} ${Math.abs(p.bias * 100).toFixed(0)}</b> · ${Math.round(p.agree * 100)}% of factors agree · 1h ATR ${OF.fp(p.atr)} · ${p.zones.length} price zones. Updates every 15 s; a locked plan keeps its levels.`;
  },
  status() {
    const L = this.L, p = this.p, S = OF.S, box = document.getElementById('plStatus'); if (!box) return;
    if (!p || p.wait) { box.innerHTML = ''; return; }
    const px = S.last, fp = OF.fp, hm = OF.hm, dist = x => Math.abs(x / px - 1) * 100;
    const pnlR = L ? (px - L.entry) * L.dir / L.risk : 0;
    let cls = 'wait', icon = '⏳', head = '', body = '';
    if (!L) {
      if (p.scalp) {
        head = `NO CONFIRMED SWING — ${p.passed}/9 checks pass`;
        body = `Do nothing yet. Missing: ${p.checks.filter(c => !c.ok).map(c => c.name).join(' · ')}. It re-checks every 15 s and locks a swing the moment 7/9 pass (including the three ★ checks).`;
      } else {
      head = 'NO TRADE — waiting for a trigger';
      body = `No plan is active. Watch for a 1h candle to <b>close above ${fp(p.long.trigger)}</b> (long idea) or <b>below ${fp(p.short.trigger)}</b> (short idea). Do nothing until then.`;
      }
    } else {
      const side = L.dir > 0 ? 'BUY' : 'SELL', live = p.plan ? p.side : 0;
      const flip = live && live !== L.dir ? `<div class="y">⚠ Live analysis now points ${live > 0 ? 'LONG' : 'SHORT'} — consider cancelling this plan (✚ New plan).</div>` : '';
      if (L.state === 'waiting') {
        icon = '⏳'; cls = 'wait';
        head = `WAITING — not active yet. Place a ${side} LIMIT at ${fp(L.entry)}`;
        body = `Price ${fp(px)} is <b>${dist(L.entry).toFixed(2)}% ${px < L.entry ? 'below' : 'above'}</b> the entry. The trade only starts if price comes to ${fp(L.entry)}. Stop ${fp(L.stop)} · TP1 ${fp(L.tp1)} · TP2 ${fp(L.tp2)}. Cancel at ${L.expires - Date.now() > 864e5 ? new Date(L.expires).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' : ''}${hm(L.expires)} if not filled.` + flip;
      } else if (L.state === 'active') {
        icon = '🟢'; cls = pnlR >= 0 ? 'on' : 'risk';
        head = `ACTIVE — ${side} filled at ${fp(L.entry)}${L.filledAt ? ' (' + hm(L.filledAt) + ')' : ''}`;
        body = `Now <b class="${pnlR >= 0 ? 'g' : 'r'}">${pnlR >= 0 ? '+' : ''}${pnlR.toFixed(2)}R</b>. Stop ${fp(L.stopNow)} (${dist(L.stopNow).toFixed(2)}% away) · TP1 ${fp(L.tp1)} (${dist(L.tp1).toFixed(2)}% away). Keep the stop where it is.` + flip;
      } else if (L.state === 'tp1') {
        icon = '✅'; cls = 'on';
        head = `TP1 HIT — half closed, stop moved to entry ${fp(L.entry)}`;
        body = `Remaining half is risk-free. Next target TP2 ${fp(L.tp2)} (${dist(L.tp2).toFixed(2)}% away). Now ${pnlR >= 0 ? '+' : ''}${pnlR.toFixed(2)}R on the runner.`;
      } else {
        const res = { stopped: ['❌', 'risk', 'STOPPED OUT (−1R)'], done: ['🏁', 'on', `COMPLETE — TP1 + TP2 (≈ +${((L.rr1 + L.rr2) / 2).toFixed(1)}R)`], breakeven: ['➖', 'wait', `CLOSED — half at TP1, half at entry (≈ +${(L.rr1 / 2).toFixed(1)}R)`], missed: ['↷', 'wait', 'MISSED — price left without filling the entry'], expired: ['⌛', 'wait', 'EXPIRED — entry not filled within 4 h'] }[L.state];
        icon = res[0]; cls = res[1]; head = res[2] + ' · plan finished';
        body = `Press <b>✚ New plan</b> for a fresh setup from the latest data${p.plan ? ` (it currently suggests a ${p.side > 0 ? 'LONG' : 'SHORT'})` : ' (right now it says NO TRADE)'}.`;
      }
      if (L.events.length) body += `<div class="plev">${L.events.slice(-4).map(e => `<span>${hm(e[0], true)} · ${e[1]}</span>`).join('')}</div>`;
    }
    box.innerHTML = `<div class="plstatus ${cls}"><span class="pli">${icon}</span><div><div class="plsh">${head}</div><div class="plsb">${body}</div></div></div>`;
  },
  html() {
    const p = this.p, S = OF.S, L = this.L; if (!p) return;
    const top = document.getElementById('plTop'), side = document.getElementById('plSide'), fac = document.getElementById('plFactors'); if (!top) return;
    this.status();
    if (p.wait) { top.innerHTML = '<div class="empty">' + p.wait + '</div>'; return; }
    const o = this.o, fmt = OF.fp, pct = x => ((x / p.px - 1) * 100).toFixed(2) + '%';
    const lockedCard = L => {
      const qty = L.risk ? o.acct * o.risk / 100 / L.risk : 0, dirTxt = L.dir > 0 ? 'LONG' : 'SHORT';
      return `<div class="plcard ${L.dir > 0 ? 'long' : 'short'}">
        <div class="plh"><b>${dirTxt} ${L.scalp ? 'swing' : 'plan'} · locked ${new Date(L.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${OF.hm(L.created)}</b><span class="muted sm">${L.eType === 'limit' ? (L.dir > 0 ? 'buy' : 'sell') + ' limit order' : 'at market'} · ${L.scalp ? 'daily swing (days)' : '1h intraday'} · confidence ${L.conf}%</span></div>
        <div class="plrow"><span>Entry</span><b class="mono">${fmt(L.entry)}</b><span class="muted sm">${L.baseSrc.length ? 'at ' + L.baseSrc.join(', ') : ''}</span></div>
        <div class="plrow"><span class="r">Stop loss</span><b class="mono r">${fmt(L.stopNow)}</b><span class="muted sm">${L.stopNow === L.entry ? 'moved to entry after TP1' : 'risk ' + fmt(L.risk) + ' per ' + S.info.base}</span></div>
        <div class="plrow"><span class="g">Take profit 1</span><b class="mono g">${fmt(L.tp1)}</b><span class="muted sm">${L.rr1.toFixed(1)}R${L.tp1Src.length ? ' · ' + L.tp1Src.join(', ') : ''} — close half, stop to entry</span></div>
        <div class="plrow"><span class="g">Take profit 2</span><b class="mono g">${fmt(L.tp2)}</b><span class="muted sm">${L.rr2.toFixed(1)}R${L.tp2Src.length ? ' · ' + L.tp2Src.join(', ') : ''}</span></div>
        <div class="plrow"><span>Size</span><b class="mono">${qty < 1 ? qty.toFixed(4) : qty.toFixed(3)} ${S.info.base}</b><span class="muted sm">${OF.fmtUsd(qty * L.entry)} notional · loses ${OF.fmtUsd(o.acct * o.risk / 100)} at the stop</span></div></div>`;
    };
    const condCard = pl => `<div class="plcard alt"><div class="plh"><b>Idea if it turns: ${pl.dir > 0 ? 'LONG' : 'SHORT'}</b><span class="muted sm">not active</span></div>
        <div class="muted sm" style="margin-bottom:4px">${p.scalp ? `Locks automatically when the ${pl.dir > 0 ? 'buy' : 'sell'} checks reach 7/9.` : `Only after a 1h candle <b>closes ${pl.dir > 0 ? 'above' : 'below'} ${fmt(pl.trigger)}</b> and the bias turns ${pl.dir > 0 ? 'bullish' : 'bearish'} — then press ✚ New plan.`}</div>
        <div class="plrow"><span>Entry area</span><b class="mono">${fmt(pl.entry)}</b><span class="muted sm">${pct(pl.entry)} from price</span></div>
        <div class="plrow"><span class="r">Stop</span><b class="mono r">${fmt(pl.stop)}</b><span></span></div>
        <div class="plrow"><span class="g">Targets</span><b class="mono g">${fmt(pl.tp1)}</b><span class="muted sm">then ${fmt(pl.tp2)} · ${pl.rr1.toFixed(1)}R / ${pl.rr2.toFixed(1)}R</span></div></div>`;
    const pr = (L && L.prob) || p.prob;
    const probHtml = !pr ? '<div class="plcard"><div class="plh"><b>Win probability</b></div><div class="muted sm">Measuring on past candles…</div></div>'
      : !pr.decided ? `<div class="plcard"><div class="plh"><b>Win probability</b></div><div class="muted sm">No similar setups found in the ${pr.label}.</div></div>`
      : (() => {
        const w = Math.round(pr.win * 100), be = Math.round(pr.be * 100), edge = w - be, cls = edge >= 5 ? 'g' : edge >= 0 ? 'y' : 'r', low = pr.decided < 30;
        return `<div class="plcard prob"><div class="plh"><b>Win probability (TP1 before stop)</b><span class="muted sm">measured, not guessed</span></div>
          <div class="pbig ${cls}">${w}%</div>
          <div class="pbar"><i style="width:${w}%"></i><b style="left:${be}%"></b></div>
          <div class="muted sm">From <b>${pr.decided}</b> similar ${L ? (L.dir > 0 ? 'long' : 'short') : ''} setups in the ${pr.label}${low ? ' — <span class="y">small sample, treat with care</span>' : ''}.
          Break-even needs <b>${be}%</b> at these targets → edge <b class="${cls}">${edge >= 0 ? '+' : ''}${edge}%</b>.
          Reached TP2: ${Math.round(pr.w2 * 100)}% · average result ${pr.exp >= 0 ? '+' : ''}${pr.exp.toFixed(2)}R per setup.
          Order-book checks can't be replayed (no book history), so this is the base rate before them.</div></div>`;
      })();
    const checksHtml = p.scalp ? `<div class="plcard checks"><div class="plh"><b>Confirmation checks ${p.passed}/9</b><span class="muted sm">★ = must pass</span></div>${p.checks.map(c => `<div class="chk ${c.ok ? 'ok' : 'no'}"><span>${c.ok ? '✓' : '✗'}</span><b>${c.name}${c.key ? ' ★' : ''}</b><span class="muted sm">${c.text}</span></div>`).join('')}</div>` : '';
    top.innerHTML = `<div class="plcards">${probHtml}${checksHtml}</div><div class="plcards">${L ? lockedCard(L) + condCard(L.dir > 0 ? p.short : p.long) : condCard(p.long) + condCard(p.short)}</div>`;
    const zl = z => `<div class="zr"><b class="mono">${fmt(z.p)}</b><span class="zw" style="width:${Math.min(60, z.w * 9)}px"></span><span class="muted sm">${z.src.join(' · ')}</span></div>`;
    side.innerHTML = `<div class="sh">Resistance above (nearest first)</div>${p.res.slice(0, 7).map(zl).join('') || '<div class="muted pad">none within 6%</div>'}
      <div class="zr now"><b class="mono">${fmt(p.px)}</b><span class="muted sm">price now</span></div>
      <div class="sh">Support below (nearest first)</div>${p.sup.slice(0, 7).map(zl).join('') || '<div class="muted pad">none within 6%</div>'}`;
    const groups = [...new Set(p.factors.map(f => f.group))];
    fac.innerHTML = '<h3>What the ' + (p.scalp ? 'swing engine' : 'analysis') + ' is based on (live)</h3><table class="tbl"><thead><tr><th>Factor</th><th>Weight</th><th>Vote</th><th>Reading</th></tr></thead><tbody>' +
      groups.map(gp => p.factors.filter(f => f.group === gp).map(f => {
        const v = f.s == null ? '—' : f.s > 0.15 ? '<b class="g">▲ long</b>' : f.s < -0.15 ? '<b class="r">▼ short</b>' : '<span class="muted">neutral</span>';
        return `<tr><td>${f.name}</td><td class="mono muted">${f.w}</td><td>${v} <span class="mono muted sm">${f.s == null ? '' : (f.s * 100).toFixed(0)}</span></td><td class="wrap">${f.text}</td></tr>`;
      }).join('')).join('') + '</tbody></table>';
  },
  render() {
    if (!this.p || Date.now() - this.p.at > 15000 || this.p.wait) { this.p = this.gen(); this.p.at = this.p.at || Date.now(); this.maybeLock(); this.html(); }
    this.track();
    if (!this._st || Date.now() - this._st > 1000) { this._st = Date.now(); this.status(); }
    const p = this.p, c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h, S = OF.S, L = this.L;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (!p || p.wait) { ui.msg(ctx, W, H, p ? p.wait : 'Loading…'); return; }
    const tf = this.isScalp() ? this.o.ctfS : this.o.ctf, k = S.k[tf]; if (!k || !k.length) { OF.loadKlines(tf); ui.msg(ctx, W, H, 'Loading ' + tf + ' candles…'); return; }
    const ms = OF.tfMs[tf], AX = 80, TB = 18, pw = W - AX, ph = H - TB;
    const n = Math.min(this.zv.n, k.length), end = Math.max(n, k.length - this.zv.off), i0 = Math.max(0, end - n);
    const bw = pw / (n + Math.max(6, n * 0.18)), X = i => (i - i0 + 0.5) * bw; this.bw = bw;
    const pl = L || (p.long.rr1 >= p.short.rr1 ? p.long : p.short), lv = L ? [L.entry, L.stopNow, L.stop, L.tp1, L.tp2] : [pl.entry, pl.stop, pl.tp1, pl.tp2];
    let lo = Infinity, hi = -Infinity; for (let i = i0; i < end; i++) { lo = Math.min(lo, k[i].l); hi = Math.max(hi, k[i].h); }
    lv.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
    const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
    const Y = v => 6 + (ph - 12) - (v - lo) / (hi - lo) * (ph - 12);
    ui.priceAxis(ctx, 0, pw, 6, ph - 12, lo, hi);
    ui.timeAxis(ctx, 0, (end - i0) * bw, ph, k[i0].t, k[end - 1].t + ms, 90);
    for (const z of p.zones) {
      if (z.hi < lo || z.lo > hi) continue;
      const a = Math.min(0.3, 0.05 + z.w * 0.033), y1 = Y(z.hi + p.atr * 0.06), y2 = Y(z.lo - p.atr * 0.06);
      ctx.fillStyle = (z.p > p.px ? 'rgba(239,68,68,' : 'rgba(34,197,94,') + a + ')'; ctx.fillRect(0, y1, pw, Math.max(2, y2 - y1));
      if (z.w >= 2) { ctx.font = '10px ui-monospace,monospace'; ctx.fillStyle = '#cbd5e1'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(OF.fp(z.p) + ' · ' + z.src.slice(0, 2).join(', '), pw * 0.62, (y1 + y2) / 2); }
    }
    OF.drawCandles(ctx, k, i0, end, X, Y, bw * 0.65);
    const e21 = OF.ema(k, 21); ctx.strokeStyle = C.blue; ctx.beginPath(); for (let i = i0; i < end; i++) i === i0 ? ctx.moveTo(X(i), Y(e21[i])) : ctx.lineTo(X(i), Y(e21[i])); ctx.stroke();
    if (OF.app.lines.liq) OF.drawLiqLines(ctx, pw, Y, lo, hi);
    // plan box from creation time (or last candle) to the right edge
    const tx = t => X(i0 + (t - k[i0].t) / ms - 0.5);
    const x0 = Math.max(0, L ? tx(L.created) : X(end - 1) + bw), x1 = pw - 4, ye = Y(pl.entry), stopShown = L ? L.stopNow : pl.stop;
    ctx.fillStyle = 'rgba(239,68,68,.16)'; ctx.fillRect(x0, Math.min(ye, Y(stopShown === pl.entry ? pl.stop : stopShown)), x1 - x0, Math.abs(Y(stopShown === pl.entry ? pl.stop : stopShown) - ye));
    ctx.fillStyle = 'rgba(34,197,94,.16)'; ctx.fillRect(x0, Math.min(ye, Y(pl.tp2)), x1 - x0, Math.abs(Y(pl.tp2) - ye));
    const tagX = Math.min(x0, pw - 260);
    ui.hline(ctx, 0, pw, ye, '#e5e7eb', [], (L ? (L.state === 'waiting' ? 'ENTRY (waiting) ' : 'ENTRY ') : 'idea entry ') + OF.fp(pl.entry), tagX);
    ui.hline(ctx, 0, pw, Y(stopShown), C.sell, [5, 3], 'STOP ' + OF.fp(stopShown) + (L && L.stopNow !== L.stop ? ' (moved)' : ''), tagX);
    ui.hline(ctx, 0, pw, Y(pl.tp1), C.buy, [5, 3], 'TP1 ' + OF.fp(pl.tp1) + ' (' + pl.rr1.toFixed(1) + 'R)', tagX);
    ui.hline(ctx, 0, pw, Y(pl.tp2), C.buy, [2, 3], 'TP2 ' + OF.fp(pl.tp2) + ' (' + pl.rr2.toFixed(1) + 'R)', tagX);
    if (L && L.filledAt) { ctx.beginPath(); ctx.arc(tx(L.filledAt), ye, 5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); }
    if (S.last) { ui.hline(ctx, 0, pw, Y(S.last), 'rgba(229,231,235,.5)', [1, 3]); ui.tag(ctx, pw + 1, Y(S.last), OF.fp(S.last), '#e5e7eb', '#000'); }
    ctx.font = '11px ui-monospace,monospace'; ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(S.symbol + ' · ' + tf + ' · scroll = zoom · drag = pan · double-click = reset · green zones support, red resistance', 8, 8);
    ui.cross(ctx, this.mouse, 0, pw, 6, ph - 12, lo, hi, pw + 1, x => k[i0].t + (x / bw) * ms);
  }
};
})();

/* ===================== KEY POINTS (plain-language market read, shown on every tab) =====================
   Key levels = zones where several day-trading sources agree: real book walls (weighted by size and how long
   they have stood; pulled-again-and-again walls are down-weighted and flagged), today's POC / VAH / VAL, VWAP,
   today's open, yesterday's high / low / POC, 15m and 1h swings, liquidation clusters, round numbers. */
(function () {
const OF = window.OF, C = OF.C, ui = OF.ui;
function wallStand(p) {
  const S = OF.S, bin = S.bin; if (!bin) return 0; let since = OF.now(), ref = null; const j0 = Math.floor(p / bin);
  for (let i = S.cols.length - 1; i >= 0; i--) { const c = S.cols[i], j = j0 - c.b0, v = (c.arr[j] || 0) + (c.arr[j - 1] || 0) + (c.arr[j + 1] || 0); if (ref == null) ref = v; if (!ref || v < ref * 0.5) break; since = c.t; }
  return (OF.now() - since) / 1000;
}
function pullsNear(p, w) { const S = OF.S, t0 = OF.now() - 300000; let n = 0; for (let i = S.events.length - 1; i >= 0 && S.events[i].t > t0; i--) { const e = S.events[i]; if (e.type === 'pull' && Math.abs(e.p - p) <= w) n++; } return n; }
function pivots(k, lb, look) { const hi = [], lo = []; for (let i = Math.max(lb, k.length - look); i < k.length - lb; i++) { let h = true, l = true; for (let j = i - lb; j <= i + lb; j++) { if (j === i) continue; if (k[j].h >= k[i].h) h = false; if (k[j].l <= k[i].l) l = false; } if (h) hi.push(k[i].h); if (l) lo.push(k[i].l); } return { hi, lo }; }
function zonesOf(lv, px, atr) {
  lv.sort((a, b) => a.p - b.p); const zs = [];
  for (const l of lv) { const z = zs[zs.length - 1]; if (z && l.p - z.hi < atr * 0.35) { z.hi = Math.max(z.hi, l.p); z.pw += l.p * l.w; z.w += l.w; z.src.push(l.src); z.fake = z.fake || l.fake; } else zs.push({ lo: l.p, hi: l.p, pw: l.p * l.w, w: l.w, src: [l.src], fake: !!l.fake }); }
  zs.forEach(z => { z.p = z.pw / z.w; z.src = [...new Set(z.src)]; }); return zs;
}
OF.keyRead = function () {
  const S = OF.S; if (!S || !S.info || !S.last) return null;
  if (S._kr && Date.now() - S._kr.at < 3000) return S._kr;
  const k15 = S.k['15m'], k1h = S.k['1h'], kd = S.k['1d']; if (!k15 || k15.length < 30 || !k1h || k1h.length < 30) return null;
  const px = S.last, atr = OF.atr(k15) || px * 0.002, ss = OF.session(), now = OF.now();
  const met = OF.meters(), M = {}; if (met) for (const m of met.list) M[m.key] = m;
  const mt = OF.mtf(), T = {}; if (mt) for (const r of mt.rows) T[r.tf] = r.score;
  const lv = [], add = (p, w, src, fake) => { if (p && isFinite(p) && Math.abs(p / px - 1) < 0.02) lv.push({ p, w, src, fake }); };
  if (S.synced) {
    const bb = OF.bookBins(1, OF.niceStep(px * 0.0002)), ws = [];
    for (const [p, n] of bb.b) ws.push({ p: p + bb.bin / 2, n, side: 'bid' }); for (const [p, n] of bb.a) ws.push({ p: p + bb.bin / 2, n, side: 'ask' });
    ws.sort((a, b) => b.n - a.n); const mx = ws.length ? ws[0].n : 1;
    for (const w of ws.slice(0, 10)) {
      const st = wallStand(w.p), pu = pullsNear(w.p, bb.bin * 1.5), fake = pu >= 3;
      let wt = 1 + 2 * w.n / mx; if (st > 120) wt *= 1.3; if (fake) wt *= 0.4;
      add(w.p, wt, `${w.side} wall ${OF.fmtUsd(w.n)}${fake ? ' ⚠ pulled ' + pu + '×' : st > 60 ? ' · ' + (st < 120 ? Math.round(st) + 's' : Math.round(st / 60) + 'm') + ' old' : ''}`, fake);
    }
  }
  if (ss) {
    if (ss.today) { add(ss.today.poc, 1.6, 'today POC'); add(ss.today.vah, 1.3, 'today VAH'); add(ss.today.val, 1.3, 'today VAL'); }
    if (ss.vwap) add(ss.vwap, 1.4, 'VWAP');
    if (ss.prev) add(ss.prev.poc, 1, 'yesterday POC');
    if (S.day && S.day.prev.length) { let h = -Infinity, l = Infinity; for (const c of S.day.prev) { h = Math.max(h, c.h); l = Math.min(l, c.l); } add(h, 1.6, 'yesterday high'); add(l, 1.6, 'yesterday low'); }
  }
  const dOpen = kd && kd.length ? kd[kd.length - 1].o : null; add(dOpen, 0.9, 'today open');
  const p15 = pivots(k15, 3, 120), p1 = pivots(k1h, 2, 80);
  p15.hi.slice(-5).forEach(p => add(p, 1, '15m swing high')); p15.lo.slice(-5).forEach(p => add(p, 1, '15m swing low'));
  p1.hi.slice(-5).forEach(p => add(p, 1.5, '1h swing high')); p1.lo.slice(-5).forEach(p => add(p, 1.5, '1h swing low'));
  const lm = OF.liqMap(); if (lm) lm.rows.slice().sort((a, b) => (b.long + b.short) - (a.long + a.short)).slice(0, 6).forEach(r => add(r.p + lm.bin / 2, 1.2, (r.p > lm.mid ? 'short' : 'long') + ' liquidations ' + OF.fmtUsd(r.long + r.short)));
  const rs = OF.niceStep(px * 0.005); for (let j = -2; j <= 2; j++) add((Math.round(px / rs) + j) * rs, 0.5, 'round number');
  const zs = zonesOf(lv, px, atr);
  const above = zs.filter(z => z.lo > px).sort((a, b) => a.p - b.p), below = zs.filter(z => z.hi < px).sort((a, b) => b.p - a.p);
  const pick = (list, min) => list.find(z => z.w >= min && !(z.fake && z.src.length === 1)) || list.find(z => z.w >= min) || list[0] || null;
  const res = pick(above, 2.2), sup = pick(below, 2.2);
  const res2 = res ? pick(above.filter(z => z.lo > res.hi + atr * 0.3), 1.8) : null, sup2 = sup ? pick(below.filter(z => z.hi < sup.lo - atr * 0.3), 1.8) : null;
  const inside = zs.find(z => z.lo - atr * 0.1 <= px && z.hi + atr * 0.1 >= px && z.w >= 2.2) || null;

  // today's trend
  const why = []; let ts = 0;
  if (ss && ss.vwap) { const a = px > ss.vwap; ts += a ? 0.3 : -0.3; why.push((a ? 'above' : 'below') + ' VWAP ' + OF.fp(ss.vwap)); }
  if (dOpen) { const a = px > dOpen; ts += a ? 0.25 : -0.25; why.push((a ? 'above' : 'below') + ' today’s open ' + OF.fp(dOpen) + ' (' + ((px / dOpen - 1) * 100).toFixed(2) + '%)'); }
  if (T['1h'] != null) { ts += OF.clamp(T['1h'] / 100, -1, 1) * 0.25; why.push('1h ' + (T['1h'] > 15 ? 'up' : T['1h'] < -15 ? 'down' : 'flat')); }
  if (T['4h'] != null) { ts += OF.clamp(T['4h'] / 100, -1, 1) * 0.2; why.push('4h ' + (T['4h'] > 15 ? 'up' : T['4h'] < -15 ? 'down' : 'flat')); }
  const trend = ts > 0.35 ? 'UP' : ts < -0.35 ? 'DOWN' : 'RANGE';
  // pressure now
  const f5 = OF.flow(now - 300000), f1 = OF.flow(now - 60000), imb = M.imb ? M.imb.score / 100 : 0;
  const pr = OF.clamp(0.4 * (f5.tot ? f5.d / f5.tot : 0) * 2 + 0.3 * (f1.tot ? f1.d / f1.tot : 0) * 2 + 0.3 * imb, -1, 1);
  const pside = pr > 0.15 ? 'BUYERS' : pr < -0.15 ? 'SELLERS' : 'BALANCED', buyShare = f5.tot ? f5.b / f5.tot : 0.5;
  // what it means
  const fp = OF.fp, rTop = res ? res.hi : null, sBot = sup ? sup.lo : null;
  let lean, leanCls;
  if (trend === 'UP' && pside !== 'SELLERS') { lean = `Lean LONG — trend and pressure agree. Better entries are dips toward support ${sup ? fp(sup.p) : '—'}; idea is wrong below ${sBot ? fp(sBot) : '—'}.`; leanCls = 'up'; }
  else if (trend === 'DOWN' && pside !== 'BUYERS') { lean = `Lean SHORT — trend and pressure agree. Better entries are rallies into resistance ${res ? fp(res.p) : '—'}; idea is wrong above ${rTop ? fp(rTop) : '—'}.`; leanCls = 'dn'; }
  else if (trend === 'RANGE') { lean = `RANGE day — no trend. Play the edges only if the wall holds: buy near ${sup ? fp(sup.p) : '—'}, sell near ${res ? fp(res.p) : '—'}; avoid the middle.`; leanCls = 'flat'; }
  else { lean = `MIXED — today’s trend is ${trend === 'UP' ? 'up' : 'down'} but ${pside.toLowerCase()} are pushing right now. Wait for a break of ${rTop ? fp(rTop) : '—'} or ${sBot ? fp(sBot) : '—'}.`; leanCls = 'flat'; }
  const brk = `Above <b>${rTop ? fp(rTop) : '—'}</b> → buyers take control, next ${res2 ? fp(res2.p) : rTop ? fp(rTop + atr * 2) : '—'} · Below <b>${sBot ? fp(sBot) : '—'}</b> → sellers take control, next ${sup2 ? fp(sup2.p) : sBot ? fp(sBot - atr * 2) : '—'}`;
  const where = inside ? `Price is sitting ON a key zone (${fp(inside.p)}) — expect a reaction here.` : res && sup ? `Price is ${Math.abs(res.p - px) < Math.abs(px - sup.p) ? 'closer to resistance' : 'closer to support'}.` : '';
  S._kr = { at: Date.now(), px, atr, zones: zs, res, sup, res2, sup2, inside, trend, trendWhy: why, ts, pressure: pr, pside, buyShare, lean, leanCls, brk, where };
  return S._kr;
};

/* Draw the key levels as highlighted bands with plain labels (heatmap, columns, charts). */
OF.drawKeyLevels = (ctx, x0, x1, Y, lo, hi) => {
  if (!OF.app.lines.key) return;
  const k = OF.keyRead(); if (!k) return;
  const band = (z, kind, label, strong) => {
    if (!z) return;
    const col = kind === 'res' ? '239,68,68' : kind === 'at' ? '245,158,11' : '34,197,94';
    if (z.hi < lo || z.lo > hi) {   // off screen: say where it is
      if (!strong) return;
      const up = z.lo > hi; ctx.font = 'bold 11px ui-monospace,Menlo,monospace'; ctx.fillStyle = `rgb(${col})`; ctx.textAlign = 'left'; ctx.textBaseline = up ? 'top' : 'bottom';
      ctx.fillText(`${up ? '↑' : '↓'} ${label} ${OF.fp(z.p)} (${((z.p / k.px - 1) * 100).toFixed(2)}%, off chart)`, x0 + 290, up ? Y(hi) + 4 : Y(lo) - 4); return;
    }
    // thin band at the level (capped — wide merged zones used to paint over half the chart)
    const half = Math.min((z.hi - z.lo) / 2 + k.atr * 0.04, k.atr * 0.12), y1 = Y(z.p + half), y2 = Y(z.p - half);
    ctx.fillStyle = `rgba(${col},${strong ? 0.14 : 0.07})`; ctx.fillRect(x0, y1, x1 - x0, Math.max(3, y2 - y1));
    ctx.strokeStyle = `rgba(${col},${strong ? 0.95 : 0.5})`; ctx.lineWidth = strong ? 2 : 1; ctx.setLineDash(strong ? [] : [4, 4]);
    ctx.beginPath(); ctx.moveTo(x0, Math.round(Y(z.p)) + .5); ctx.lineTo(x1, Math.round(Y(z.p)) + .5); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    ctx.font = 'bold 11px ui-monospace,Menlo,monospace'; const t = `${label} ${OF.fp(z.p)}${z.fake ? ' ⚠' : ''}`, w = ctx.measureText(t).width + 12, yTop = Y(hi), yBot = Y(lo), ly = OF.clamp(Y(z.p), yTop + 10, yBot - 10);
    ctx.fillStyle = `rgb(${col})`; ctx.fillRect(x0 + 4, ly - 9, w, 18); ctx.fillStyle = '#000'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(t, x0 + 10, ly);
    if (strong) { ctx.font = '10px ui-monospace,monospace'; ctx.fillStyle = `rgb(${col})`; ctx.fillText(z.src.slice(0, 2).map(s => s.replace(/ — .*$/, '').replace(/ \(standing.*?\)/, '')).join(' · '), x0 + w + 10, ly); }
  };
  band(k.inside, 'at', '★ KEY LEVEL — price is here', true);
  band(k.res, 'res', '★ KEY RESISTANCE', true); band(k.sup, 'sup', '★ KEY SUPPORT', true);
  band(k.res2, 'res', 'next resistance', false); band(k.sup2, 'sup', 'next support', false);
};
})();

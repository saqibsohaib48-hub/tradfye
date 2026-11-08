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
  const a1 = OF.atr(k1), lbl = 'last ' + Math.round(k1.length / 24) + ' days of 1h candles';
  const probL = backtest(k1, 1, long.risk / a1, long.rr1, long.rr2, 24, lbl), probS = backtest(k1, -1, short.risk / a1, short.rr1, short.rr2, 24, lbl);
  const prob = ref.dir > 0 ? probL : probS;
  return { at: Date.now(), px, atr, atr4, bias, agree, factors: F, zones, sup, res, long, short, side: plan ? side : 0, plan, why, conf, rsi, recH, prob, probL, probS, trigTf: '1h',
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
  const lblD = 'last ' + (hist.length / 365).toFixed(1) + ' years of daily candles';
  const probL = backtest(hist, 1, long.risk / atr, long.rr1, long.rr2, 15, lblD), probS = backtest(hist, -1, short.risk / atr, short.rr1, short.rr2, 15, lblD);
  const prob = dir > 0 ? probL : probS;
  const conf = Math.round(OF.clamp(passed / 9 * 60 + Math.abs(bias) * 40, 0, 95));
  return { at: Date.now(), scalp: true, px, atr, bias, agree, factors: F, zones, sup, res, long, short, plan: confirmed ? pl : null, idea: pl, side: confirmed ? dir : 0,
    checks: CH, passed, why, conf, prob, probL, probS, trigTf: 'daily', verdict: confirmed ? (dir > 0 ? 'LONG SWING' : 'SHORT SWING') : 'NO SWING' };
};

/* ===================== TRADE PLAN TAB =====================
   Three views:
   • My trades  – every trade you track stays live (waiting → active → TP1 → done / stopped …) with P&L and a
                  health check that re-tests it against the latest analysis: HOLD / TIGHTEN / CONSIDER CLOSING.
   • Next plan  – the fresh setup for the chosen mode. It first checks your open trades for conflicts.
                  "Track this plan" freezes its levels and adds it to My trades.
   • History    – finished trades with result in R and $, win rate. Nothing is ever overwritten. */
const FINAL = { stopped: 1, done: 1, breakeven: 1, missed: 1, expired: 1, closed: 1 };
const MODES = { intraday: { name: 'Intraday 1h', exp: 4 * 36e5, expLabel: '4 h', stale: 12 * 36e5 }, swing: { name: 'Swing 1D', exp: 3 * 864e5, expLabel: '3 days', stale: 10 * 864e5 } };
const dstr = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + OF.hm(t);
function newTrade(o, symbol, mode, src) {
  const t = OF.now(), riskUsd = (o.acct || 0) * (o.risk || 0) / 100, risk = Math.abs(src.entry - src.stop);
  return { id: t, symbol, mode, created: t, dir: src.dir, entry: src.entry, stop: src.stop, stopNow: src.stop, tp1: src.tp1, tp2: src.tp2 || src.tp1,
    rr1: Math.abs(src.tp1 - src.entry) / risk, rr2: Math.abs((src.tp2 || src.tp1) - src.entry) / risk, risk, eType: src.eType || 'manual',
    baseSrc: src.base ? src.base.src.slice(0, 2) : [], tp1Src: src.tp1z ? src.tp1z.src.slice(0, 2) : [], tp2Src: src.tp2z ? src.tp2z.src.slice(0, 2) : [],
    state: src.eType === 'limit' ? 'waiting' : 'active', filledAt: src.eType === 'limit' ? null : t, events: [[t, src.eType === 'manual' ? 'Added by you (already open)' : src.eType === 'limit' ? 'Plan tracked — limit order placed' : 'Plan tracked — entered at market']],
    lastT: t, expires: t + MODES[mode].exp, expLabel: MODES[mode].expLabel, conf: src.conf || null, prob: src.prob || null, riskUsd, qty: risk ? riskUsd / risk : 0 };
}
function step(L, price, t) {
  const d = L.dir, up = x => d > 0 ? price >= x : price <= x, down = x => d > 0 ? price <= x : price >= x;
  if (L.state === 'waiting') {
    if (down(L.entry)) { L.state = 'active'; L.filledAt = t; L.events.push([t, 'Entry filled at ' + OF.fp(L.entry)]); }
    else if (up(L.tp1)) { L.state = 'missed'; L.events.push([t, 'Price reached TP1 before the entry — missed, do not chase']); }
    else if (t > L.expires) { L.state = 'expired'; L.events.push([t, 'Not filled within ' + L.expLabel + ' — cancelled']); }
  } else if (L.state === 'active') {
    if (down(L.stopNow)) { L.state = 'stopped'; L.exitPx = L.stopNow; L.closedAt = t; L.events.push([t, 'Stop hit at ' + OF.fp(L.stopNow)]); }
    else if (up(L.tp1)) { L.state = 'tp1'; L.stopNow = L.entry; L.events.push([t, 'TP1 hit — half closed, stop moved to entry']); }
  } else if (L.state === 'tp1') {
    if (up(L.tp2)) { L.state = 'done'; L.closedAt = t; L.events.push([t, 'TP2 hit — trade complete']); }
    else if (down(L.stopNow)) { L.state = 'breakeven'; L.closedAt = t; L.events.push([t, 'Back to entry after TP1 — rest closed at breakeven']); }
  }
}
function resultR(L, px) {
  const open = (p) => (p - L.entry) * L.dir / L.risk;
  switch (L.state) {
    case 'stopped': return L.stopNow === L.stop ? -1 : 0;
    case 'done': return (L.rr1 + L.rr2) / 2;
    case 'breakeven': return L.rr1 / 2;
    case 'missed': case 'expired': return 0;
    case 'closed': return L.halfOff ? L.rr1 / 2 + open(L.exitPx) / 2 : open(L.exitPx);
    case 'tp1': return L.rr1 / 2 + open(px) / 2;
    case 'active': return open(px);
    default: return 0;
  }
}
function statusOf(L, px) {
  const fp = OF.fp, dist = x => Math.abs(x / px - 1) * 100, side = L.dir > 0 ? 'BUY' : 'SELL', r = resultR(L, px);
  const pnl = `<b class="${r >= 0 ? 'g' : 'r'}">${r >= 0 ? '+' : ''}${r.toFixed(2)}R${L.riskUsd ? ' (' + OF.fmtUsd(r * L.riskUsd, true) + ')' : ''}</b>`;
  if (L.state === 'waiting') return { cls: 'wait', icon: '⏳', head: `WAITING — ${side} LIMIT at ${fp(L.entry)} not filled yet`, body: `Price ${fp(px)} is ${dist(L.entry).toFixed(2)}% ${px < L.entry ? 'below' : 'above'} the entry. Cancel at ${dstr(L.expires)} if not filled.` };
  if (L.state === 'active') return { cls: r >= 0 ? 'on' : 'risk', icon: '🟢', head: `OPEN — ${side} from ${fp(L.entry)}${L.filledAt ? ' since ' + dstr(L.filledAt) : ''} · now ${pnl}`, body: `Stop ${fp(L.stopNow)} (${dist(L.stopNow).toFixed(2)}% away) · TP1 ${fp(L.tp1)} (${dist(L.tp1).toFixed(2)}% away) · TP2 ${fp(L.tp2)}` };
  if (L.state === 'tp1') return { cls: 'on', icon: '✅', head: `TP1 HIT — half closed, stop at entry ${fp(L.entry)} · now ${pnl}`, body: `Runner is risk-free. TP2 ${fp(L.tp2)} is ${dist(L.tp2).toFixed(2)}% away.` };
  const m = { stopped: ['❌', 'risk', 'STOPPED OUT'], done: ['🏁', 'on', 'COMPLETE — TP1 + TP2'], breakeven: ['➖', 'wait', 'CLOSED — TP1 + breakeven'], missed: ['↷', 'wait', 'MISSED — never filled'], expired: ['⌛', 'wait', 'EXPIRED — never filled'], closed: ['✋', r >= 0 ? 'on' : 'risk', 'CLOSED BY YOU at ' + fp(L.exitPx)] }[L.state];
  return { cls: m[1], icon: m[0], head: `${m[2]} · ${pnl}`, body: '' };
}

OF.views.plan = {
  label: 'Trade plan', title: 'My open trades with live health checks, the next plan, and history',
  o: (() => { const o = Object.assign({ acct: 1000, risk: 1, full: false, ctf: '1h', ctfS: '1d', mode: 'intraday', sub: 'next', auto: true }, LS.get('plan', {})); if (o.mode === 'scalp') o.mode = 'swing'; if (!['4h', '1d'].includes(o.ctfS)) o.ctfS = '1d'; return o; })(),
  zv: { n: 72, off: 0 }, an: {},
  save() { LS.set('plan', this.o); },
  isScalp() { return this.o.mode === 'swing'; },
  gen(mode) { return (mode || this.o.mode) === 'swing' ? OF.swingPlan() : OF.tradePlan(); },
  analysis(mode) { const a = this.an[mode]; if (!a || a.wait || Date.now() - a.at > 15000) { this.an[mode] = this.gen(mode); this.an[mode].at = this.an[mode].at || Date.now(); } return this.an[mode]; },
  // trade store (per symbol); migrates the old single-plan locks so yesterday's plan is not lost
  load() {
    const sym = OF.S.symbol, key = 'trades:' + sym; let a = LS.get(key, []);
    for (const [k, mode] of [['lock:', 'intraday'], ['lockS:', 'swing'], ['lockD:', 'swing']]) {
      const x = LS.get(k + sym, null);
      if (x && !a.find(t => t.created === x.created)) { x.id = x.created; x.mode = mode; x.symbol = sym; x.riskUsd = x.riskUsd || 0; a.push(x); }
      if (x) LS.set(k + sym, null);
    }
    this.T = a; this.Tsym = sym; this.saveT();
  },
  saveT() { LS.set('trades:' + OF.S.symbol, this.T.slice(-300)); },
  openT() { return this.T.filter(t => !FINAL[t.state]); },
  toolbar(tb) {
    const o = this.o;
    const inp = (lab, key, st) => { const w = el('div', 'grp'); w.appendChild(el('span', 'lbl', lab)); const i = el('input', 'num'); i.type = 'number'; i.step = st; i.value = o[key]; i.oninput = () => { o[key] = +i.value || 0; this.save(); this.html(); }; w.appendChild(i); return w; };
    this.subSeg = el('span'); tb.append(this.subSeg); this.renderSub();
    tb.append(ui.seg('Mode', [['intraday', 'Intraday 1h'], ['swing', '📅 Swing 1D']], o.mode, v => { o.mode = v; this.save(); OF.app.remount(); }));
    tb.append(inp('Account $', 'acct', 100), inp('Risk %', 'risk', 0.25));
    if (o.mode === 'swing') tb.append(ui.seg('Chart', [['4h', '4h'], ['1d', '1D']], o.ctfS, v => { o.ctfS = v; this.save(); this.zv = { n: 72, off: 0 }; }));
    else tb.append(ui.seg('Chart', [['15m', '15m'], ['1h', '1h'], ['4h', '4h']], o.ctf, v => { o.ctf = v; this.save(); this.zv = { n: 72, off: 0 }; }));
    tb.append(ui.toggle('🤖 Auto', o.auto, v => { o.auto = v; this.save(); this.html(); }, 'Fully automatic: waits for the candle close, confirms, creates and tracks the trade by itself. One auto trade per mode at a time.'));
    if (window.Notification && Notification.permission === 'default') { const nb = el('button', 'tgl', '🔔 Notify me'); nb.title = 'Desktop notification when a trade is auto-confirmed or hits a level'; nb.onclick = () => Notification.requestPermission().then(() => nb.remove()); tb.append(nb); }
    tb.append(ui.toggle('⛶ Full chart', o.full, v => { o.full = v; this.save(); this.applyFull(); }, 'Chart takes the page. Scroll = zoom, drag = pan, double-click = reset.'));
  },
  renderSub() {
    if (!this.subSeg || !this.T) return;
    const n = this.openT().length;
    this.subSeg.innerHTML = ''; this.subSeg.appendChild(ui.seg('', [['open', `📂 My trades${n ? ' (' + n + ')' : ''}`], ['next', '✨ Next plan'], ['hist', '📜 History']], this.o.sub, v => { this.o.sub = v; this.save(); this.html(); }));
  },
  applyFull() { if (this.root) this.root.classList.toggle('plfull', !!this.o.full); this.c && this.c.fit(); },
  mount(v) {
    this.root = v; v.classList.add('scroll');
    v.innerHTML = '<div id="plMain"></div><div class="plgrid"><div class="gbox plchart" id="plChart"></div><div id="plSide"></div></div><div id="plFactors"></div>';
    this.c = ui.canvas(document.getElementById('plChart')); ui.track(this);
    const cv = this.c.cv; let drag = null;
    this.yz = 1; this.yoff = 0;
    const onAxis = e => { const r = cv.getBoundingClientRect(); return e.clientX - r.left > (this.pw || 1e9); };
    cv.onwheel = e => {
      e.preventDefault();
      if (e.shiftKey || onAxis(e)) this.yz = OF.clamp(this.yz * (e.deltaY > 0 ? 1.12 : 0.89), 0.05, 20);   // price zoom
      else this.zv.n = OF.clamp(Math.round(this.zv.n * (e.deltaY > 0 ? 1.15 : 0.87)), 10, 600);               // time zoom
    };
    cv.onmousedown = e => { drag = { x: e.clientX, y: e.clientY, off: this.zv.off, yoff: this.yoff, axis: onAxis(e) }; };
    window.addEventListener('mouseup', () => drag = null);
    cv.addEventListener('mousemove', e => {
      if (!drag) return;
      if (drag.axis) { if (this.ppx) this.yz = OF.clamp(this.yz * Math.exp((e.clientY - drag.y) / 300), 0.05, 20), drag.y = e.clientY; return; }
      if (this.bw) this.zv.off = Math.max(0, drag.off + Math.round((e.clientX - drag.x) / this.bw));
      if (this.ppx) this.yoff = drag.yoff + (e.clientY - drag.y) * this.ppx;
    });
    cv.ondblclick = () => { this.zv = { n: 72, off: 0 }; this.yz = 1; this.yoff = 0; };
    this.load(); this.renderSub(); this.applyFull(); this.lastHtml = 0;
  },
  /* follow every open trade through the trades (and 1h candles for time the page was closed) */
  trackAll() {
    const S = OF.S, tr = S.trades, first = tr.length ? tr[0].t : OF.now(), kh = S.k['1h']; let changed = false;
    for (const L of this.openT()) {
      const before = L.state;
      if (kh && L.lastT < first - 36e5) {
        for (const c of kh) { if (c.t + 36e5 <= L.lastT || c.t >= first) continue; step(L, L.dir > 0 ? c.l : c.h, c.t + 36e5 - 1); if (FINAL[L.state]) break; step(L, L.dir > 0 ? c.h : c.l, c.t + 36e5 - 1); if (FINAL[L.state]) break; }
        L.lastT = Math.max(L.lastT, first - 1);
      }
      for (let i = OF.lb(tr, L.lastT + 1); i < tr.length && !FINAL[L.state]; i++) step(L, tr[i].p, tr[i].t);
      if (!FINAL[L.state] && L.state === 'waiting' && OF.now() > L.expires) step(L, S.last, OF.now());
      L.lastT = tr.length ? tr[tr.length - 1].t : OF.now();
      if (L.state !== before) changed = true;
    }
    if (changed || !this._sv || Date.now() - this._sv > 10000) { this.saveT(); this._sv = Date.now(); }
    if (changed) { this.renderSub(); this.lastHtml = 0; }
  },
  /* ---------- 🤖 AUTO: watch the candle close, confirm, create and track trades by itself ---------- */
  autoKey(mode) { return 'auto:' + OF.S.symbol + ':' + mode; },
  autoTick() {
    const S = OF.S; if (!S || !S.info || !S.last) return;
    if (!this.T || this.Tsym !== S.symbol) this.load();
    this.trackAll();
    if (!this.o.auto) return;
    for (const mode of ['intraday', 'swing']) {
      const p = this.analysis(mode); if (!p || p.wait) continue;
      const tf = mode === 'swing' ? '1d' : '1h', ms = OF.tfMs[tf], k = S.k[tf]; if (!k || k.length < 3) continue;
      const st = LS.get(this.autoKey(mode), {}), open = this.openT().filter(t => t.mode === mode), last = k[k.length - 2];
      const lastAuto = this.T.filter(t => t.mode === mode && t.auto).sort((a, b) => b.created - a.created)[0];
      const cooling = lastAuto && FINAL[lastAuto.state] && OF.now() - (lastAuto.closedAt || lastAuto.created) < ms;
      const log = m => { (st.log = st.log || []).push([OF.now(), m]); if (st.log.length > 30) st.log.shift(); };
      const add = (q, why) => {
        const t = newTrade(this.o, S.symbol, mode, Object.assign({}, q, { conf: p.conf, prob: q.dir > 0 ? p.probL : p.probS }));
        t.auto = true; t.events.push([OF.now(), '🤖 ' + why]); this.T.push(t); this.saveT(); log('Auto trade created: ' + (q.dir > 0 ? 'LONG' : 'SHORT') + ' — ' + why);
        OF.notify(`🤖 Auto ${q.dir > 0 ? 'LONG' : 'SHORT'} ${MODES[mode].name} confirmed`, `${why}. ${q.eType === 'limit' ? 'Limit entry' : 'Entry'} ${OF.fp(q.entry)} · stop ${OF.fp(q.stop)} · TP1 ${OF.fp(q.tp1)} · TP2 ${OF.fp(q.tp2)}`);
        this.renderSub(); this.lastHtml = 0;
      };
      if (st.lastClose == null) st.lastClose = last.t;            // first run: never fire on old candles
      else if (last.t > st.lastClose) {                            // a new candle has just closed
        st.lastClose = last.t;
        const arm = st.armed || { long: p.long.trigger, short: p.short.trigger };
        const dir = last.c > arm.long ? 1 : last.c < arm.short ? -1 : 0;
        if (!dir) log(`${tf} closed at ${OF.fp(last.c)} — inside ${OF.fp(arm.short)}–${OF.fp(arm.long)}, still waiting`);
        else if (open.length) log(`${tf} closed ${dir > 0 ? 'above' : 'below'} the trigger, but a trade is already open — skipped`);
        else if (cooling) log(`${tf} trigger hit, but the last auto trade just finished — waiting one candle`);
        else if (p.bias * dir < -0.3) log(`${tf} closed ${dir > 0 ? 'above' : 'below'} the trigger, but the analysis is strongly against — skipped`);
        else add(dir > 0 ? p.long : p.short, `${tf} candle closed ${dir > 0 ? 'above' : 'below'} ${OF.fp(dir > 0 ? arm.long : arm.short)} at ${OF.fp(last.c)} — confirmed`);
      }
      if (p.plan && !this.openT().filter(t => t.mode === mode).length && !cooling) add(p.plan, 'analysis confirmed the setup (' + (p.scalp ? p.passed + '/9 checks' : Math.round(p.agree * 100) + '% of factors agree') + ')');
      st.armed = { long: p.long.trigger, short: p.short.trigger, at: Date.now() };
      st.nextClose = k[k.length - 1].t + ms;
      LS.set(this.autoKey(mode), st);
    }
  },
  /* banner at the top of the chart: waiting for confirmation → confirmed / managed */
  drawStage(ctx, pw, open, p) {
    const S = OF.S, mode = this.o.mode, st = LS.get(this.autoKey(mode), {}), tf = mode === 'swing' ? 'daily' : '1h';
    const left = st.nextClose ? Math.max(0, st.nextClose - OF.now()) : null, mm = left == null ? '' : left > 36e5 ? Math.floor(left / 36e5) + 'h ' + Math.floor(left % 36e5 / 6e4) + 'm' : Math.floor(left / 6e4) + 'm ' + Math.floor(left % 6e4 / 1e3) + 's';
    let lines;
    if (!this.o.auto) lines = [['#9ca3af', '🤖 Auto is OFF — turn it on in the toolbar to confirm and track trades automatically']];
    else if (open.length) { const L = open[open.length - 1], stt = statusOf(L, S.last); lines = [[L.state === 'waiting' ? C.amber : C.buy, `${L.state === 'waiting' ? '⏳ CONFIRMED — waiting for entry fill' : '✅ CONFIRMED — trade open'} · #${open.length} ${L.dir > 0 ? 'LONG' : 'SHORT'}${L.auto ? ' (auto)' : ''}`], ['#cbd5e1', stt.head.replace(/<[^>]+>/g, '')]]; }
    else if (p.plan) lines = [[C.buy, '✅ CONFIRMED by the analysis — creating the trade…']];
    else lines = [[C.amber, `⏳ WAITING FOR CONFIRMATION — next ${tf} close in ${mm}`], [C.buy, `LONG if it closes above ${OF.fp(p.long.trigger)} (${((p.long.trigger / S.last - 1) * 100).toFixed(2)}%)`], [C.sell, `SHORT if it closes below ${OF.fp(p.short.trigger)} (${((p.short.trigger / S.last - 1) * 100).toFixed(2)}%)`]];
    const lg = (st.log || []).slice(-1)[0]; if (lg && this.o.auto) lines.push(['#9ca3af', 'last: ' + OF.hm(lg[0]) + ' ' + lg[1]]);
    ctx.font = 'bold 12px ui-monospace,monospace'; let w = 0; lines.forEach(([, t]) => { w = Math.max(w, ctx.measureText(t).width); });
    ctx.fillStyle = 'rgba(10,13,18,.9)'; ctx.fillRect(8, 40, w + 16, lines.length * 17 + 8); ctx.strokeStyle = lines[0][0]; ctx.strokeRect(8.5, 40.5, w + 15, lines.length * 17 + 7);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    lines.forEach(([c, t], i) => { ctx.font = (i ? '' : 'bold ') + '12px ui-monospace,monospace'; ctx.fillStyle = c; ctx.fillText(t, 16, 45 + i * 17); });
  },
  /* re-test an open trade against the latest data */
  health(L) {
    const S = OF.S, px = S.last, p = this.analysis(L.mode), k = OF.keyRead(L.mode === 'swing' ? '4h' : '1h'), out = []; let sc = 0;
    if (!p || p.wait) return { v: 'CHECKING', cls: 'wait', items: ['Loading analysis…'] };
    const d = L.dir, r = resultR(L, px), word = d > 0 ? 'up' : 'down';
    if (p.bias * d > 0.2) out.push(['ok', `Analysis still points ${word} (bias ${Math.round(p.bias * 100)}, ${Math.round(p.agree * 100)}% agree)`]);
    else if (p.bias * d < -0.2 && p.agree >= 0.55) { out.push(['bad', `Analysis has FLIPPED against you (bias ${Math.round(p.bias * 100)}, ${Math.round(p.agree * 100)}% agree)`]); sc -= 2; }
    else { out.push(['warn', `Analysis is neutral now (bias ${Math.round(p.bias * 100)})`]); sc -= 0.5; }
    if (k) {
      const t = k.trend === 'UP' ? 1 : k.trend === 'DOWN' ? -1 : 0;
      if (t === d) out.push(['ok', `Trend (${k.tf}) is with you`]); else if (t === -d) { out.push(['bad', `Trend (${k.tf}) is against you`]); sc -= 1; } else out.push(['warn', `Trend (${k.tf}) is a range`]);
      const ps = k.pside === 'BUYERS' ? 1 : k.pside === 'SELLERS' ? -1 : 0;
      if (ps === -d) { out.push(['warn', `${k.pside.toLowerCase()} are pushing right now`]); sc -= 0.5; } else if (ps === d) out.push(['ok', `${k.pside.toLowerCase()} are pushing your way`]);
    }
    if (L.state !== 'waiting') {
      const prot = (d > 0 ? p.sup : p.res).find(z => d > 0 ? z.lo > L.stopNow && z.hi < px : z.hi < L.stopNow && z.lo > px && z.w >= 2);
      if (prot) out.push(['ok', `${d > 0 ? 'Support' : 'Resistance'} at ${OF.fp(prot.p)} (${prot.src.slice(0, 2).join(', ')}) protects your stop`]);
      else { out.push(['warn', `No strong ${d > 0 ? 'support' : 'resistance'} between price and your stop`]); sc -= 0.5; }
      const tgt = L.state === 'tp1' ? L.tp2 : L.tp1;
      const block = (d > 0 ? p.res : p.sup).find(z => z.w >= 2.5 && (d > 0 ? z.lo > px && z.lo < tgt : z.hi < px && z.hi > tgt));
      if (block) { out.push(['warn', `Strong ${d > 0 ? 'resistance' : 'support'} at ${OF.fp(block.p)} before your target — price may stall there`]); sc -= 0.5; }
      const age = OF.now() - (L.filledAt || L.created);
      if (age > MODES[L.mode].stale) { out.push(['warn', `Open ${Math.round(age / 36e5)} h — longer than this kind of trade usually needs`]); sc -= 0.5; }
    }
    let v, cls, act;
    if (L.state === 'waiting') {
      if (sc <= -2) { v = '⛔ CANCEL THE ORDER'; cls = 'risk'; act = 'The setup no longer holds — cancel the limit order.'; }
      else { v = '✅ KEEP THE ORDER'; cls = 'on'; act = 'Setup still valid — leave the limit order in place.'; }
    } else if (sc <= -2.5) { v = '⛔ CONSIDER CLOSING'; cls = 'risk'; act = r > 0 ? 'Take the profit you have.' : 'The reason for the trade is gone — closing early usually costs less than waiting for the stop.'; }
    else if (sc <= -1 || (r >= 1 && L.stopNow === L.stop && L.state === 'active')) { v = '⚠ TIGHTEN / TAKE PARTIAL'; cls = 'wait'; act = r >= 1 ? `You are +${r.toFixed(1)}R: move the stop to entry ${OF.fp(L.entry)} or take half off.` : 'Warnings are building — consider a smaller position or a tighter stop.'; }
    else { v = '✅ HOLD'; cls = 'on'; act = 'Nothing has changed against the trade — keep the plan (stop and targets).'; }
    return { v, cls, act, items: out };
  },
  html() {
    const S = OF.S, main = document.getElementById('plMain'), side = document.getElementById('plSide'), fac = document.getElementById('plFactors'); if (!main) return;
    this.lastHtml = Date.now(); this.renderSub();
    const o = this.o, sub = o.sub, px = S.last, fp = OF.fp, p = this.analysis(o.mode), open = this.openT();
    side.style.display = sub === 'next' ? '' : 'none'; fac.style.display = sub === 'next' ? '' : 'none';
    const pill = s => `<span class="pill ${s > 0 ? 'b' : 's'}">${s > 0 ? 'LONG' : 'SHORT'}</span>`;
    if (sub === 'open') {
      const card = L => {
        const st = statusOf(L, px), h = this.health(L);
        return `<div class="trd ${st.cls}" data-id="${L.id}">
          <div class="trh">${pill(L.dir)} <b>${L.symbol}</b> <span class="muted sm">${MODES[L.mode] ? MODES[L.mode].name : L.mode} · tracked ${dstr(L.created)}</span><span class="trb"><button data-a="mode" title="Move this trade to the other mode (which chart it shows on)">↔ make ${L.mode === 'swing' ? 'Intraday' : 'Swing'}</button><button data-a="close">✋ I closed it (at ${fp(px)})</button><button data-a="del" title="Remove from the list">🗑</button></span></div>
          <div class="plstatus ${st.cls}"><span class="pli">${st.icon}</span><div><div class="plsh">${st.head}</div><div class="plsb">${st.body}</div></div></div>
          <div class="trn mono"><span>Entry <b>${fp(L.entry)}</b></span><span class="r">Stop <b>${fp(L.stopNow)}</b>${L.stopNow !== L.stop ? ' (moved)' : ''}</span><span class="g">TP1 <b>${fp(L.tp1)}</b></span><span class="g">TP2 <b>${fp(L.tp2)}</b></span><span>Size <b>${L.qty ? (L.qty < 1 ? L.qty.toFixed(4) : L.qty.toFixed(3)) + ' ' + S.info.base : '—'}</b></span></div>
          <div class="hl ${h.cls}"><div class="hlv">Health check: <b>${h.v}</b> — ${h.act || ''}</div>${h.items.map(([c, t]) => `<div class="hli ${c}">${c === 'ok' ? '✓' : c === 'bad' ? '✗' : '!'} ${t}</div>`).join('')}<div class="muted sm">Re-checked every 15 s against the latest ${MODES[L.mode] ? MODES[L.mode].name : ''} analysis and key points. Rules, not advice — you decide.</div></div>
          ${L.events.length ? `<div class="plev">${L.events.slice(-4).map(e => `<span>${dstr(e[0])} · ${e[1]}</span>`).join('')}</div>` : ''}</div>`;
      };
      const fresh = this._lastSub !== 'open' || !main.querySelector('#plCards');
      if (fresh) main.innerHTML = '<div id="plCards"></div>' + addForm(o);
      const cardsBox = main.querySelector('#plCards');
      cardsBox.innerHTML = open.length ? open.map(card).join('') : '<div class="empty">No open trades tracked. Use <b>✨ Next plan → Track this plan</b>, or add a trade you already have below.</div>';
      this._lastSub = 'open';
      cardsBox.querySelectorAll('.trd').forEach(div => {
        const L = this.T.find(t => String(t.id) === div.dataset.id);
        div.querySelector('[data-a=close]').onclick = () => { if (L.state === 'tp1') L.halfOff = true; L.state = 'closed'; L.exitPx = S.last; L.closedAt = OF.now(); L.events.push([OF.now(), 'Closed by you at ' + OF.fp(S.last)]); this.saveT(); this.html(); };
        div.querySelector('[data-a=mode]').onclick = () => { L.mode = L.mode === 'swing' ? 'intraday' : 'swing'; L.expires = L.created + MODES[L.mode].exp; L.expLabel = MODES[L.mode].expLabel; this.saveT(); this.html(); };
        div.querySelector('[data-a=del]').onclick = () => { this.T = this.T.filter(t => t !== L); this.saveT(); this.html(); };
      });
      const f = main.querySelector('.addf');
      if (fresh) f.querySelector('button').onclick = () => {
        const g = n => +f.querySelector(`[name=${n}]`).value, dir = f.querySelector('[name=dir]').value === 'long' ? 1 : -1;
        const src = { dir, entry: g('entry'), stop: g('stop'), tp1: g('tp1'), tp2: g('tp2') || g('tp1'), eType: 'manual' };
        if (!(src.entry > 0 && src.stop > 0 && src.tp1 > 0) || (src.entry - src.stop) * dir <= 0 || (src.tp1 - src.entry) * dir <= 0) { f.querySelector('.err').textContent = 'Check the numbers: for a long, stop below entry and TP above; for a short, the opposite.'; return; }
        this.T.push(newTrade(o, S.symbol, f.querySelector('[name=mode]').value, src)); this.saveT(); f.open = false; this.html();
      };
    } else if (sub === 'hist') {
      this._lastSub = 'hist';
      const done = this.T.filter(t => FINAL[t.state]).sort((a, b) => (b.closedAt || b.created) - (a.closedAt || a.created));
      const traded = done.filter(t => !['missed', 'expired'].includes(t.state)), rs = traded.map(t => resultR(t, px));
      const wins = rs.filter(r => r > 0).length, tot = rs.reduce((a, r) => a + r, 0), usd = traded.reduce((a, t) => a + resultR(t, px) * (t.riskUsd || 0), 0);
      main.innerHTML = `<div class="cards"><div class="card sm"><div class="ct">Finished trades</div><div class="cv">${traded.length}</div></div><div class="card sm"><div class="ct">Win rate</div><div class="cv">${traded.length ? Math.round(wins / traded.length * 100) + '%' : '—'}</div></div><div class="card sm"><div class="ct">Total</div><div class="cv ${tot >= 0 ? 'g' : 'r'}">${tot >= 0 ? '+' : ''}${tot.toFixed(2)}R</div></div><div class="card sm"><div class="ct">Total $</div><div class="cv ${usd >= 0 ? 'g' : 'r'}">${OF.fmtUsd(usd, true)}</div></div><div class="card sm"><div class="ct">Never filled</div><div class="cv">${done.length - traded.length}</div></div></div>
        <table class="tbl"><thead><tr><th>Tracked</th><th>Mode</th><th>Side</th><th class="rt">Entry</th><th class="rt">Stop</th><th class="rt">TP1 / TP2</th><th>Result</th><th class="rt">R</th><th class="rt">$</th><th></th></tr></thead><tbody>${done.map(t => { const r = resultR(t, px); return `<tr><td class="mono">${dstr(t.created)}</td><td>${MODES[t.mode] ? MODES[t.mode].name : t.mode}</td><td>${pill(t.dir)}</td><td class="rt mono">${fp(t.entry)}</td><td class="rt mono">${fp(t.stop)}</td><td class="rt mono">${fp(t.tp1)} / ${fp(t.tp2)}</td><td>${statusOf(t, px).icon} ${t.state}</td><td class="rt mono ${r >= 0 ? 'g' : 'r'}">${r >= 0 ? '+' : ''}${r.toFixed(2)}</td><td class="rt mono">${t.riskUsd ? OF.fmtUsd(r * t.riskUsd, true) : '—'}</td><td><button class="hdel" data-id="${t.id}" title="Remove">🗑</button></td></tr>`; }).join('') || '<tr><td colspan="10" class="empty">No finished trades yet.</td></tr>'}</tbody></table>`;
      main.querySelectorAll('.hdel').forEach(b => b.onclick = () => { this.T = this.T.filter(t => String(t.id) !== b.dataset.id); this.saveT(); this.html(); });
    } else { this._lastSub = 'next'; this.htmlNext(main, side, fac, p, open); }
  },
  htmlNext(main, side, fac, p, open) {
    const S = OF.S, o = this.o, fmt = OF.fp, pct = x => ((x / p.px - 1) * 100).toFixed(2) + '%';
    if (!p || p.wait) { main.innerHTML = '<div class="empty">' + (p ? p.wait : 'Loading…') + '</div>'; side.innerHTML = ''; fac.innerHTML = ''; return; }
    // 1) re-check open trades first
    let pre = '';
    if (open.length) {
      const hs = open.map(L => [L, this.health(L)]), bad = hs.filter(([, h]) => /CLOS|CANCEL/.test(h.v)).length, same = p.plan ? open.filter(L => L.dir === p.side).length : 0, opp = p.plan ? open.filter(L => L.dir !== p.side).length : 0;
      pre = `<div class="plstatus ${bad ? 'risk' : 'wait'}"><span class="pli">📂</span><div><div class="plsh">You have ${open.length} open trade${open.length > 1 ? 's' : ''} — check ${open.length > 1 ? 'them' : 'it'} first</div><div class="plsb">${hs.map(([L, h]) => `${L.dir > 0 ? 'LONG' : 'SHORT'} from ${fmt(L.entry)} → <b>${h.v}</b>`).join(' · ')}.
        ${p.plan ? (opp ? ' <b class="r">This new plan points the OTHER way</b> — sort out the open trade before taking it.' : same ? ' This new plan is the same direction — taking it doubles your risk on one idea.' : '') : ''} <a href="#" class="goopen">Open My trades →</a></div></div></div>`;
    }
    // 2) the next plan
    const pl = p.plan;
    let head, body, cls = 'wait', icon = '⏳';
    if (pl) { cls = 'on'; icon = '✨'; head = `NEXT PLAN: ${pl.dir > 0 ? 'LONG' : 'SHORT'} ${pl.eType === 'limit' ? 'limit at ' + fmt(pl.entry) : 'at market ' + fmt(pl.entry)}`; body = `Stop ${fmt(pl.stop)} · TP1 ${fmt(pl.tp1)} (${pl.rr1.toFixed(1)}R) · TP2 ${fmt(pl.tp2)} (${pl.rr2.toFixed(1)}R). ${this.o.auto ? '🤖 Auto is ON — it will be tracked automatically within seconds.' : 'Levels keep updating until you press <b>Track this plan</b>, which freezes them and adds the trade to My trades.'}`; }
    else if (p.scalp) { const rb = rankIdeas(p)[0]; head = `NO CONFIRMED SWING — ${p.passed}/9 checks pass`; body = `Missing: ${p.checks.filter(c => !c.ok).map(c => c.name).join(' · ')}. Do nothing yet. <b>More likely next: ${rb.q.dir > 0 ? 'LONG' : 'SHORT'}</b> — ${rb.why.join(', ')}. Both ideas are drawn on the chart.${rankIdeas(p).bothBad ? ' <b class="y">Both ideas have lost money at these levels in the past (win % below break-even) — waiting is the better choice.</b>' : ''}`; }
    else { const rb = rankIdeas(p)[0]; head = 'NO TRADE right now'; body = `${p.why.join('; ')}. Watch for a 1h close above <b>${fmt(p.long.trigger)}</b> (long idea) or below <b>${fmt(p.short.trigger)}</b> (short idea). <b>More likely next: ${rb.q.dir > 0 ? 'LONG' : 'SHORT'}</b> — ${rb.why.join(', ')}. Both ideas are drawn on the chart.${rankIdeas(p).bothBad ? ' <b class="y">Both ideas have lost money at these levels in the past (win % below break-even) — waiting is the better choice.</b>' : ''}`; }
    const pr = p.prob;
    const probHtml = !pr ? '' : !pr.decided ? `<div class="plcard"><div class="plh"><b>Win probability</b></div><div class="muted sm">No similar setups found in the ${pr.label}.</div></div>` : (() => {
      const w = Math.round(pr.win * 100), be = Math.round(pr.be * 100), edge = w - be, c = edge >= 5 ? 'g' : edge >= 0 ? 'y' : 'r';
      return `<div class="plcard prob"><div class="plh"><b>Win probability (TP1 before stop)</b><span class="muted sm">measured, not guessed</span></div><div class="pbig ${c}">${w}%</div><div class="pbar"><i style="width:${w}%"></i><b style="left:${be}%"></b></div>
        <div class="muted sm">From <b>${pr.decided}</b> similar setups in the ${pr.label}${pr.decided < 30 ? ' — <span class="y">small sample</span>' : ''}. Break-even needs <b>${be}%</b> → edge <b class="${c}">${edge >= 0 ? '+' : ''}${edge}%</b>. Average ${pr.exp >= 0 ? '+' : ''}${pr.exp.toFixed(2)}R per setup.</div></div>`; })();
    const checksHtml = p.scalp ? `<div class="plcard checks"><div class="plh"><b>Confirmation checks ${p.passed}/9</b><span class="muted sm">★ = must pass</span></div>${p.checks.map(c => `<div class="chk ${c.ok ? 'ok' : 'no'}"><span>${c.ok ? '✓' : '✗'}</span><b>${c.name}${c.key ? ' ★' : ''}</b><span class="muted sm">${c.text}</span></div>`).join('')}</div>` : '';
    const ranks = pl ? null : rankIdeas(p), rk = q => ranks && ranks.find(r => r.q === q);
    const planCard = (q, main) => {
      const qty = q.risk ? o.acct * o.risk / 100 / q.risk : 0, r = rk(q), pr = q.dir > 0 ? p.probL : p.probS;
      const badge = r ? (r.best ? `<span class="best">⭐ MORE LIKELY</span>` : `<span class="muted sm">less likely</span>`) : `<span class="muted sm">${main ? (q.eType === 'limit' ? 'limit order' : 'at market') : 'not active'}</span>`;
      return `<div class="plcard ${main ? (q.dir > 0 ? 'long' : 'short') : r && r.best ? (q.dir > 0 ? 'long' : 'short') + ' idea' : 'alt'}"><div class="plh"><b>${main ? 'Next plan' : 'If it turns'}: ${q.dir > 0 ? 'LONG' : 'SHORT'}</b>${badge}</div>
      ${r ? `<div class="trig">Starts only after a ${p.trigTf} candle <b>closes ${q.dir > 0 ? 'above' : 'below'} ${fmt(q.trigger)}</b> <span class="muted">(${r.trig.toFixed(2)}% away)</span><div class="muted sm">${r.why.join(' · ')}</div></div>` : ''}
      <div class="plrow"><span>Entry</span><b class="mono">${fmt(q.entry)}</b><span class="muted sm">${pct(q.entry)}${q.base ? ' · ' + q.base.src.slice(0, 2).join(', ') : ''}</span></div>
      <div class="plrow"><span class="r">Stop loss</span><b class="mono r">${fmt(q.stop)}</b><span class="muted sm">risk ${fmt(q.risk)}</span></div>
      <div class="plrow"><span class="g">TP1</span><b class="mono g">${fmt(q.tp1)}</b><span class="muted sm">${q.rr1.toFixed(1)}R — half off, stop to entry</span></div>
      <div class="plrow"><span class="g">TP2</span><b class="mono g">${fmt(q.tp2)}</b><span class="muted sm">${q.rr2.toFixed(1)}R</span></div>
      ${!main && pr && pr.decided ? `<div class="plrow"><span>Win %</span><b class="mono ${pr.win - pr.be >= 0.05 ? 'g' : pr.win >= pr.be ? 'y' : 'r'}">${Math.round(pr.win * 100)}%</b><span class="muted sm">needs ${Math.round(pr.be * 100)}% · ${pr.decided} past setups</span></div>` : ''}
      ${main ? `<div class="plrow"><span>Size</span><b class="mono">${qty < 1 ? qty.toFixed(4) : qty.toFixed(3)} ${S.info.base}</b><span class="muted sm">loses ${OF.fmtUsd(o.acct * o.risk / 100)} at the stop</span></div><button class="trackbtn">✔ Track this plan (I am taking it)</button>`
        : `<button class="trackany" data-d="${q.dir}">Track anyway — not confirmed (${qty < 1 ? qty.toFixed(4) : qty.toFixed(3)} ${S.info.base})</button>`}</div>`; };
    main.innerHTML = pre + `<div class="plstatus ${cls}"><span class="pli">${icon}</span><div><div class="plsh">${head}</div><div class="plsb">${body}</div></div></div>
      <div class="plcards">${probHtml}${checksHtml}</div><div class="plcards">${pl ? planCard(pl, true) + planCard(pl.dir > 0 ? p.short : p.long, false) : planCard(p.long, false) + planCard(p.short, false)}</div>`;
    const g = main.querySelector('.goopen'); if (g) g.onclick = e => { e.preventDefault(); this.o.sub = 'open'; this.save(); this.html(); };
    const tb = main.querySelector('.trackbtn');
    if (tb) tb.onclick = () => { this.T.push(newTrade(o, S.symbol, o.mode, Object.assign({}, pl, { conf: p.conf, prob: p.prob }))); this.saveT(); this.o.sub = 'open'; this.save(); this.html(); };
    main.querySelectorAll('.trackany').forEach(b => b.onclick = () => {
      const q = +b.dataset.d > 0 ? p.long : p.short, t = newTrade(o, S.symbol, o.mode, Object.assign({}, q, { prob: q.dir > 0 ? p.probL : p.probS }));
      t.events.push([OF.now(), 'Tracked by you WITHOUT confirmation']); t.unconfirmed = true; this.T.push(t); this.saveT(); this.o.sub = 'open'; this.save(); this.html();
    });
    const zl = z => `<div class="zr"><b class="mono">${fmt(z.p)}</b><span class="zw" style="width:${Math.min(60, z.w * 9)}px"></span><span class="muted sm">${z.src.join(' · ')}</span></div>`;
    side.innerHTML = `<div class="sh">Resistance above</div>${p.res.slice(0, 7).map(zl).join('') || '<div class="muted pad">none</div>'}<div class="zr now"><b class="mono">${fmt(p.px)}</b><span class="muted sm">price now</span></div><div class="sh">Support below</div>${p.sup.slice(0, 7).map(zl).join('') || '<div class="muted pad">none</div>'}`;
    const groups = [...new Set(p.factors.map(f => f.group))];
    fac.innerHTML = '<h3>What the analysis is based on (live)</h3><table class="tbl"><thead><tr><th>Factor</th><th>Weight</th><th>Vote</th><th>Reading</th></tr></thead><tbody>' + groups.map(gp => p.factors.filter(f => f.group === gp).map(f => { const v = f.s == null ? '—' : f.s > 0.15 ? '<b class="g">▲ long</b>' : f.s < -0.15 ? '<b class="r">▼ short</b>' : '<span class="muted">neutral</span>'; return `<tr><td>${f.name}</td><td class="mono muted">${f.w}</td><td>${v}</td><td class="wrap">${f.text}</td></tr>`; }).join('')).join('') + '</tbody></table>';
  },
  reading() {
    const n = this.T ? this.openT().length : 0, p = this.an[this.o.mode];
    return `📂 ${n} open trade${n === 1 ? '' : 's'} tracked (health re-checked every 15 s) · ✨ Next plan (${MODES[this.o.mode].name}): ${p && !p.wait ? (p.plan ? (p.side > 0 ? 'LONG' : 'SHORT') + ' setup ready' : 'no trade right now') : 'loading…'} · chart: solid lines = your open trades, dashed = next plan.`;
  },
  render() {
    if (!this.T || this.Tsym !== OF.S.symbol) this.load();
    this.trackAll();
    if (Date.now() - this.lastHtml > (this.o.sub === 'next' ? 15000 : 3000)) this.html();
    const p = this.analysis(this.o.mode), c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h, S = OF.S;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (!p || p.wait) { ui.msg(ctx, W, H, p ? p.wait : 'Loading…'); return; }
    const tf = this.isScalp() ? this.o.ctfS : this.o.ctf, k = S.k[tf]; if (!k || !k.length) { OF.loadKlines(tf); ui.msg(ctx, W, H, 'Loading ' + tf + ' candles…'); return; }
    const ms = OF.tfMs[tf], AX = 80, TB = 18, pw = W - AX, ph = H - TB, allOpen = this.openT(), open = allOpen.filter(L => (L.mode || 'intraday') === this.o.mode), others = allOpen.length - open.length;
    this.pw = pw;
    const n = Math.min(this.zv.n, k.length), end = Math.max(n, k.length - this.zv.off), i0 = Math.max(0, end - n);
    const bw = pw / (n + Math.max(6, n * 0.18)), X = i => (i - i0 + 0.5) * bw; this.bw = bw;
    const nxt = this.o.sub !== 'open' && !open.length ? p.plan : null, lv = [], ideas = !p.plan && !open.length ? rankIdeas(p) : [];
    ideas.forEach(r => lv.push(r.q.entry, r.q.stop, r.q.tp1));
    open.forEach(L => lv.push(L.entry, L.stopNow, L.tp1, L.tp2)); if (nxt) lv.push(nxt.entry, nxt.stop, nxt.tp1, nxt.tp2);
    let lo = Infinity, hi = -Infinity; for (let i = i0; i < end; i++) { lo = Math.min(lo, k[i].l); hi = Math.max(hi, k[i].h); }
    // include trade levels only if they are reasonably close; far ones become edge arrows (they used to flatten the candles)
    const span0 = hi - lo; lv.forEach(v => { if (v > lo - span0 * 0.8 && v < hi + span0 * 0.8) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
    { const mid = (lo + hi) / 2 + this.yoff, half = (hi - lo) / 2 * this.yz; lo = mid - half; hi = mid + half; }
    const Y = v => 6 + (ph - 12) - (v - lo) / (hi - lo) * (ph - 12); this.ppx = (hi - lo) / (ph - 12);
    ui.priceAxis(ctx, 0, pw, 6, ph - 12, lo, hi);
    ui.timeAxis(ctx, 0, (end - i0) * bw, ph, k[i0].t, k[end - 1].t + ms, 90);
    for (const z of p.zones) {
      if (z.hi < lo || z.lo > hi) continue;
      const a = Math.min(0.25, 0.04 + z.w * 0.03), y1 = Y(z.hi + p.atr * 0.06), y2 = Y(z.lo - p.atr * 0.06);
      ctx.fillStyle = (z.p > p.px ? 'rgba(239,68,68,' : 'rgba(34,197,94,') + a + ')'; ctx.fillRect(0, y1, pw, Math.max(2, y2 - y1));
    }
    OF.drawCandles(ctx, k, i0, end, X, Y, bw * 0.65);
    const e21 = OF.ema(k, 21); ctx.strokeStyle = C.blue; ctx.beginPath(); for (let i = i0; i < end; i++) i === i0 ? ctx.moveTo(X(i), Y(e21[i])) : ctx.lineTo(X(i), Y(e21[i])); ctx.stroke();
    if (OF.app.lines.liq) OF.drawLiqLines(ctx, pw, Y, lo, hi);
    const tx = t => X(i0 + (t - k[i0].t) / ms - 0.5);
    // open trades: solid
    open.forEach((L, idx) => {
      const x0 = OF.clamp(tx(L.created), 0, pw - 40), lab = `#${idx + 1} ${L.dir > 0 ? 'LONG' : 'SHORT'} `, ye = Y(L.entry), ys = Y(L.stopNow);
      ctx.fillStyle = 'rgba(239,68,68,.13)'; ctx.fillRect(x0, Math.min(ye, ys), pw - x0, Math.abs(ys - ye));
      ctx.fillStyle = 'rgba(34,197,94,.13)'; ctx.fillRect(x0, Math.min(ye, Y(L.tp2)), pw - x0, Math.abs(Y(L.tp2) - ye));
      const lx = Math.min(x0, pw - 280);
      ui.hline(ctx, x0, pw, ye, '#e5e7eb', [], lab + (L.state === 'waiting' ? 'entry (waiting) ' : 'entry ') + OF.fp(L.entry), lx);
      ui.hline(ctx, x0, pw, ys, C.sell, [], lab + 'stop ' + OF.fp(L.stopNow) + (L.stopNow !== L.stop ? ' (moved)' : ''), lx);
      ui.hline(ctx, x0, pw, Y(L.tp1), C.buy, [], lab + 'TP1 ' + OF.fp(L.tp1) + (L.state === 'tp1' ? ' ✓' : ''), lx);
      ui.hline(ctx, x0, pw, Y(L.tp2), C.buy, [], lab + 'TP2 ' + OF.fp(L.tp2), lx);
      if (L.filledAt) { ctx.beginPath(); ctx.arc(tx(L.filledAt), ye, 5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); }
    });
    // next plan: dashed
    if (nxt) {
      const x0 = X(end - 1) + bw, lx = Math.min(x0, pw - 260);
      ui.hline(ctx, 0, pw, Y(nxt.entry), '#a5b4fc', [6, 4], 'NEXT entry ' + OF.fp(nxt.entry), lx);
      ui.hline(ctx, 0, pw, Y(nxt.stop), '#fca5a5', [6, 4], 'NEXT stop ' + OF.fp(nxt.stop), lx);
      ui.hline(ctx, 0, pw, Y(nxt.tp1), '#86efac', [6, 4], 'NEXT TP1 ' + OF.fp(nxt.tp1), lx);
      ui.hline(ctx, 0, pw, Y(nxt.tp2), '#86efac', [2, 4], 'NEXT TP2 ' + OF.fp(nxt.tp2), lx);
    }
    // off-screen levels: arrows at the top / bottom edge
    const offUp = [], offDn = [];
    open.forEach((L, idx) => [['entry', L.entry, '#e5e7eb'], ['stop', L.stopNow, C.sell], ['TP1', L.tp1, C.buy], ['TP2', L.tp2, C.buy]].forEach(([t, v, col]) => {
      if (v > hi) offUp.push([`↑ #${idx + 1} ${L.dir > 0 ? 'LONG' : 'SHORT'} ${t} ${OF.fp(v)} (${((v / S.last - 1) * 100).toFixed(2)}%)`, col]);
      else if (v < lo) offDn.push([`↓ #${idx + 1} ${L.dir > 0 ? 'LONG' : 'SHORT'} ${t} ${OF.fp(v)} (${((v / S.last - 1) * 100).toFixed(2)}%)`, col]);
    }));
    ctx.font = '11px ui-monospace,monospace'; ctx.textAlign = 'right';
    offUp.forEach(([t, col], i) => { ctx.textBaseline = 'top'; ctx.fillStyle = 'rgba(10,13,18,.8)'; ctx.fillRect(pw - ctx.measureText(t).width - 10, 22 + i * 14, ctx.measureText(t).width + 8, 13); ctx.fillStyle = col; ctx.fillText(t, pw - 6, 22 + i * 14); });
    offDn.forEach(([t, col], i) => { ctx.textBaseline = 'bottom'; ctx.fillStyle = 'rgba(10,13,18,.8)'; ctx.fillRect(pw - ctx.measureText(t).width - 10, ph - 8 - (i + 1) * 14, ctx.measureText(t).width + 8, 13); ctx.fillStyle = col; ctx.fillText(t, pw - 6, ph - 8 - i * 14); });
    // both conditional ideas (no confirmed plan): the more likely one bold, the other faint
    ideas.slice().reverse().forEach(r => {
      const q = r.q, a = r.best ? 1 : 0.45, nm = (r.best ? '⭐ ' : '') + 'IF ' + (q.dir > 0 ? 'LONG' : 'SHORT'), x0 = X(end - 1) + bw * 0.6, lx = Math.min(x0, pw - 250) - (r.best ? 0 : 0);
      ctx.save(); ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(239,68,68,.12)'; ctx.fillRect(x0, Math.min(Y(q.entry), Y(q.stop)), pw - x0, Math.abs(Y(q.stop) - Y(q.entry)));
      ctx.fillStyle = 'rgba(34,197,94,.12)'; ctx.fillRect(x0, Math.min(Y(q.entry), Y(q.tp1)), pw - x0, Math.abs(Y(q.tp1) - Y(q.entry)));
      ui.hline(ctx, 0, pw, Y(q.trigger), q.dir > 0 ? '#86efac' : '#fca5a5', [2, 2], `${nm} trigger: ${p.trigTf} close ${q.dir > 0 ? 'above' : 'below'} ${OF.fp(q.trigger)}`, 6);
      ui.hline(ctx, x0, pw, Y(q.entry), '#e5e7eb', [6, 3], `${nm} entry ${OF.fp(q.entry)}`, lx);
      ui.hline(ctx, x0, pw, Y(q.stop), C.sell, [6, 3], `${nm} stop ${OF.fp(q.stop)}`, lx);
      ui.hline(ctx, x0, pw, Y(q.tp1), C.buy, [6, 3], `${nm} TP1 ${OF.fp(q.tp1)}`, lx);
      ctx.restore();
    });
    OF.drawKeyLevels(ctx, 0, pw, Y, lo, hi);
    if (S.last) { ui.hline(ctx, 0, pw, Y(S.last), 'rgba(229,231,235,.5)', [1, 3]); ui.tag(ctx, pw + 1, Y(S.last), OF.fp(S.last), '#e5e7eb', '#000'); }
    ctx.font = '11px ui-monospace,monospace'; ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    this.drawStage(ctx, pw, open, p);
    ctx.font = '11px ui-monospace,monospace'; ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(S.symbol + ' · ' + tf + ' · ' + MODES[this.o.mode].name + ' trades solid, next plan dashed · scroll = time zoom · scroll on price scale (or Shift) = price zoom · drag = pan · double-click = reset', 8, 8);
    if (others) { ctx.fillStyle = C.amber; ctx.fillText(`${others} ${this.o.mode === 'swing' ? 'intraday' : 'swing'} trade${others > 1 ? 's' : ''} not shown here — switch Mode to ${this.o.mode === 'swing' ? 'Intraday 1h' : '📅 Swing 1D'} to see ${others > 1 ? 'them' : 'it'}`, 8, 22); }
    ui.cross(ctx, this.mouse, 0, pw, 6, ph - 12, lo, hi, pw + 1, x => k[i0].t + (x / bw) * ms);
  }
};
/* Which of the two "if it turns" ideas matters more right now: analysis lean, distance to its trigger, measured edge, reward. */
function rankIdeas(p) {
  const px = p.px, out = [p.long, p.short].map(q => {
    const pr = q.dir > 0 ? p.probL : p.probS, lean = p.bias * q.dir, trig = Math.abs(q.trigger - px) / px * 100, ent = Math.abs(q.entry - px) / p.atr;
    const edge = pr && pr.decided >= 10 ? pr.win - pr.be : 0;
    const score = 0.45 * OF.clamp(lean / 0.4, -1, 1) + 0.25 * OF.clamp(edge / 0.1, -1, 1) + 0.2 * (1 - OF.clamp(ent / 1.5, 0, 1)) + 0.1 * OF.clamp((q.rr1 - 1) / 2, 0, 1);
    const why = [lean > 0.1 ? `analysis leans ${q.dir > 0 ? 'up' : 'down'} (${Math.round(p.bias * 100)})` : lean < -0.1 ? `analysis leans the other way (${Math.round(p.bias * 100)})` : 'analysis is neutral',
      `trigger ${trig.toFixed(2)}% away`, pr && pr.decided ? `measured win ${Math.round(pr.win * 100)}% vs ${Math.round(pr.be * 100)}% needed` : 'no history yet'];
    return { q, pr, score, trig, why };
  });
  out.sort((a, b) => b.score - a.score);
  out[0].best = true;
  out.bothBad = out.every(r => r.pr && r.pr.decided >= 10 && r.pr.win < r.pr.be);
  return out;
}
function addForm(o) {
  const px = OF.S.last || 0, fp = v => v ? v.toFixed(OF.S.info.dp) : '';
  return `<details class="addf"><summary>➕ Add a trade I already have (e.g. yesterday’s plan)</summary>
    <div class="addrow"><select name="dir"><option value="long">LONG</option><option value="short">SHORT</option></select>
    <select name="mode"><option value="intraday">Intraday</option><option value="swing">Swing</option></select>
    <label>Entry <input name="entry" type="number" step="any" value="${fp(px)}"></label><label>Stop <input name="stop" type="number" step="any"></label>
    <label>TP1 <input name="tp1" type="number" step="any"></label><label>TP2 <input name="tp2" type="number" step="any" placeholder="optional"></label>
    <button class="tgl on">Add & track</button></div><div class="err r sm"></div>
    <div class="muted sm">Size uses your current Account $ and Risk %. It is tracked from now on and gets the same health check.</div></details>`;
}
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
/* Which data the key points use for each header timeframe. a/b = swing timeframes, atrTf = zone width,
   rng = how far from price to look, wall* = order-book walls, rs = round-number step, sess = weight of intraday session levels. */
const KCFG = {
  '1m':  { a: '5m',  b: '15m', atrTf: '5m',  rng: 0.008, wallPct: 0.5, wallBin: 0.0001, wallW: 1.2, rs: 0.002, sess: 1 },
  '5m':  { a: '5m',  b: '15m', atrTf: '5m',  rng: 0.012, wallPct: 0.8, wallBin: 0.00015, wallW: 1.1, rs: 0.003, sess: 1 },
  '15m': { a: '15m', b: '1h',  atrTf: '15m', rng: 0.02,  wallPct: 1,   wallBin: 0.0002, wallW: 1,   rs: 0.005, sess: 1 },
  '30m': { a: '30m', b: '1h',  atrTf: '30m', rng: 0.03,  wallPct: 1.5, wallBin: 0.0003, wallW: 0.9, rs: 0.005, sess: 1 },
  '1h':  { a: '1h',  b: '4h',  atrTf: '1h',  rng: 0.05,  wallPct: 2,   wallBin: 0.0005, wallW: 0.6, rs: 0.01,  sess: 0.6 },
  '4h':  { a: '4h',  b: '1d',  atrTf: '4h',  rng: 0.10,  wallPct: 3,   wallBin: 0.001,  wallW: 0.4, rs: 0.02,  sess: 0, week: true },
  '1d':  { a: '1d',  b: '1w',  atrTf: '1d',  rng: 0.18,  wallPct: 3,   wallBin: 0.002,  wallW: 0.3, rs: 0.05,  sess: 0, week: true }
};
OF.keyRead = function (tfArg) {
  const S = OF.S; if (!S || !S.info || !S.last) return null;
  const tf = tfArg || OF.app.tf, cf = KCFG[tf] || KCFG['15m'], cache = (S._krm = S._krm || {});
  if (cache[tf] && Date.now() - cache[tf].at < 3000) return cache[tf];
  const kd = S.k['1d'], kA = S.k[cf.a], kB = cf.b === '1w' ? OF.loadWeekly() : S.k[cf.b], kT = S.k[cf.atrTf];
  [cf.a, cf.b, cf.atrTf].forEach(x => { if (x !== '1w' && !S.k[x]) OF.loadKlines(x); });
  if (!kA || kA.length < 30 || !kT || kT.length < 20) return cache[tf] || null;
  const px = S.last, atr = OF.atr(kT) || px * 0.002, ss = OF.session(), now = OF.now();
  const met = OF.meters(), M = {}; if (met) for (const m of met.list) M[m.key] = m;
  const mt = OF.mtf(), T = {}; if (mt) for (const r of mt.rows) T[r.tf] = r.score;
  const lv = [], add = (p, w, src, fake) => { if (p && isFinite(p) && Math.abs(p / px - 1) < cf.rng) lv.push({ p, w, src, fake }); };
  if (S.synced) {
    const bb = OF.bookBins(cf.wallPct, OF.niceStep(px * cf.wallBin)), ws = [];
    for (const [p, n] of bb.b) ws.push({ p: p + bb.bin / 2, n, side: 'bid' }); for (const [p, n] of bb.a) ws.push({ p: p + bb.bin / 2, n, side: 'ask' });
    ws.sort((a, b) => b.n - a.n); const mx = ws.length ? ws[0].n : 1;
    for (const w of ws.slice(0, 10)) {
      const st = wallStand(w.p), pu = pullsNear(w.p, bb.bin * 1.5), fake = pu >= 3;
      let wt = (1 + 2 * w.n / mx) * cf.wallW; if (st > 120) wt *= 1.3; if (fake) wt *= 0.4;
      add(w.p, wt, `${w.side} wall ${OF.fmtUsd(w.n)}${fake ? ' ⚠ pulled ' + pu + '×' : st > 60 ? ' · ' + (st < 120 ? Math.round(st) + 's' : Math.round(st / 60) + 'm') + ' old' : ''}`, fake);
    }
  }
  if (ss) {
    const q = cf.sess;
    if (q && ss.today) { add(ss.today.poc, 1.6 * q, 'today POC'); add(ss.today.vah, 1.3 * q, 'today VAH'); add(ss.today.val, 1.3 * q, 'today VAL'); }
    if (q && ss.vwap) add(ss.vwap, 1.4 * q, 'VWAP');
    if (q && ss.prev) add(ss.prev.poc, 1 * q, 'yesterday POC');
    if (S.day && S.day.prev.length) { let h = -Infinity, l = Infinity; for (const c of S.day.prev) { h = Math.max(h, c.h); l = Math.min(l, c.l); } add(h, 1.6, 'yesterday high'); add(l, 1.6, 'yesterday low'); }
  }
  const dOpen = kd && kd.length ? kd[kd.length - 1].o : null; add(dOpen, 0.9, 'today open');
  const nm = x => x === '1d' ? 'daily' : x === '1w' ? 'weekly' : x;
  const pA = pivots(kA, 3, 120); pA.hi.slice(-5).forEach(p => add(p, 1.2, nm(cf.a) + ' swing high')); pA.lo.slice(-5).forEach(p => add(p, 1.2, nm(cf.a) + ' swing low'));
  if (kB && kB.length > 20) { const pB = pivots(kB, 2, 100); pB.hi.slice(-5).forEach(p => add(p, 1.8, nm(cf.b) + ' swing high')); pB.lo.slice(-5).forEach(p => add(p, 1.8, nm(cf.b) + ' swing low')); }
  if (cf.week) { const kw = OF.loadWeekly(); if (kw && kw.length > 2) { const w = kw[kw.length - 2]; add(w.h, 2, 'last week high'); add(w.l, 2, 'last week low'); } }
  const lm = OF.liqMap(); if (lm) lm.rows.slice().sort((a, b) => (b.long + b.short) - (a.long + a.short)).slice(0, 6).forEach(r => add(r.p + lm.bin / 2, 1.2, (r.p > lm.mid ? 'short' : 'long') + ' liquidations ' + OF.fmtUsd(r.long + r.short)));
  const rs = OF.niceStep(px * cf.rs); for (let j = -2; j <= 2; j++) add((Math.round(px / rs) + j) * rs, 0.5, 'round number');
  const zs = zonesOf(lv, px, atr);
  const above = zs.filter(z => z.lo > px).sort((a, b) => a.p - b.p), below = zs.filter(z => z.hi < px).sort((a, b) => b.p - a.p);
  const pick = (list, min) => list.find(z => z.w >= min && !(z.fake && z.src.length === 1)) || list.find(z => z.w >= min) || list.slice(0, 6).reduce((b, z) => !b || z.w > b.w ? z : b, null);
  const res = pick(above, 2.2), sup = pick(below, 2.2);
  const res2 = res ? pick(above.filter(z => z.lo > res.hi + atr * 0.3), 1.8) : null, sup2 = sup ? pick(below.filter(z => z.hi < sup.lo - atr * 0.3), 1.8) : null;
  const inside = zs.find(z => z.lo - atr * 0.1 <= px && z.hi + atr * 0.1 >= px && z.w >= 2.2) || null;

  // today's trend
  const why = []; let ts = 0;
  if (!cf.sess) {   // higher timeframes: trend from that timeframe and the next one up
    for (const [x, w] of [[cf.a, 0.55], [cf.b, 0.45]]) {
      const k = x === '1w' ? OF.loadWeekly() : S.k[x]; if (!k || k.length < 55) continue;
      const e21 = OF.ema(k, 21), e50 = OF.ema(k, 50), i = k.length - 1, a = OF.atr(k) || 1;
      const sc = OF.clamp(0.5 * Math.sign(e21[i] - e50[i]) + 0.5 * (k[i].c - e21[i]) / a, -1, 1);
      ts += sc * w; why.push(nm(x) + ' ' + (sc > 0.2 ? 'up' : sc < -0.2 ? 'down' : 'flat') + ' (price ' + (k[i].c > e21[i] ? 'above' : 'below') + ' EMA21 ' + OF.fp(e21[i]) + ')');
    }
  } else if (ss && ss.vwap) { const a = px > ss.vwap; ts += a ? 0.3 : -0.3; why.push((a ? 'above' : 'below') + ' VWAP ' + OF.fp(ss.vwap)); }
  if (cf.sess && dOpen) { const a = px > dOpen; ts += a ? 0.25 : -0.25; why.push((a ? 'above' : 'below') + ' today’s open ' + OF.fp(dOpen) + ' (' + ((px / dOpen - 1) * 100).toFixed(2) + '%)'); }
  if (cf.sess && T['1h'] != null) { ts += OF.clamp(T['1h'] / 100, -1, 1) * 0.25; why.push('1h ' + (T['1h'] > 15 ? 'up' : T['1h'] < -15 ? 'down' : 'flat')); }
  if (cf.sess && T['4h'] != null) { ts += OF.clamp(T['4h'] / 100, -1, 1) * 0.2; why.push('4h ' + (T['4h'] > 15 ? 'up' : T['4h'] < -15 ? 'down' : 'flat')); }
  const trend = ts > 0.35 ? 'UP' : ts < -0.35 ? 'DOWN' : 'RANGE';
  // pressure now
  const f5 = OF.flow(now - 300000), f1 = OF.flow(now - 60000), imb = M.imb ? M.imb.score / 100 : 0;
  let pr = OF.clamp(0.4 * (f5.tot ? f5.d / f5.tot : 0) * 2 + 0.3 * (f1.tot ? f1.d / f1.tot : 0) * 2 + 0.3 * imb, -1, 1);
  const dm = M['d' + tf]; if (!cf.sess && dm && dm.score != null) pr = OF.clamp(0.4 * pr + 0.6 * dm.score / 100, -1, 1);
  const pside = pr > 0.15 ? 'BUYERS' : pr < -0.15 ? 'SELLERS' : 'BALANCED', buyShare = f5.tot ? f5.b / f5.tot : 0.5;
  // what it means
  const fp = OF.fp, rTop = res ? res.hi : null, sBot = sup ? sup.lo : null;
  let lean, leanCls;
  if (trend === 'UP' && pside !== 'SELLERS') { lean = `Lean LONG — trend and pressure agree. Better entries are dips toward support ${sup ? fp(sup.p) : '—'}; idea is wrong below ${sBot ? fp(sBot) : '—'}.`; leanCls = 'up'; }
  else if (trend === 'DOWN' && pside !== 'BUYERS') { lean = `Lean SHORT — trend and pressure agree. Better entries are rallies into resistance ${res ? fp(res.p) : '—'}; idea is wrong above ${rTop ? fp(rTop) : '—'}.`; leanCls = 'dn'; }
  else if (trend === 'RANGE') { lean = `${cf.sess ? 'RANGE day' : 'RANGE on ' + tf} — no trend. Play the edges only if the wall holds: buy near ${sup ? fp(sup.p) : '—'}, sell near ${res ? fp(res.p) : '—'}; avoid the middle.`; leanCls = 'flat'; }
  else { lean = `MIXED — the ${cf.sess ? 'day' : tf} trend is ${trend === 'UP' ? 'up' : 'down'} but ${pside.toLowerCase()} are pushing right now. Wait for a break of ${rTop ? fp(rTop) : '—'} or ${sBot ? fp(sBot) : '—'}.`; leanCls = 'flat'; }
  const brk = `Above <b>${rTop ? fp(rTop) : '—'}</b> → buyers take control, next ${res2 ? fp(res2.p) : rTop ? fp(rTop + atr * 2) : '—'} · Below <b>${sBot ? fp(sBot) : '—'}</b> → sellers take control, next ${sup2 ? fp(sup2.p) : sBot ? fp(sBot - atr * 2) : '—'}`;
  const where = inside ? `Price is sitting ON a key zone (${fp(inside.p)}) — expect a reaction here.` : res && sup ? `Price is ${Math.abs(res.p - px) < Math.abs(px - sup.p) ? 'closer to resistance' : 'closer to support'}.` : '';
  cache[tf] = { at: Date.now(), tf, trendLabel: cf.sess ? 'TODAY’S TREND' : 'TREND (' + tf + ' + ' + nm(cf.b) + ')', px, atr, zones: zs, res, sup, res2, sup2, inside, trend, trendWhy: why, ts, pressure: pr, pside, buyShare, lean, leanCls, brk, where };
  return cache[tf];
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

/* toast + optional desktop notification */
OF.notify = function (title, body) {
  let box = document.getElementById('toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = 'toast'; t.innerHTML = `<b>${title}</b><div>${body}</div>`; t.onclick = () => t.remove(); box.appendChild(t);
  setTimeout(() => t.remove(), 20000);
  try { if (window.Notification && Notification.permission === 'granted') new Notification(title, { body }); } catch (e) {}
  const old = document.title; document.title = '🔔 ' + title; setTimeout(() => { document.title = old; }, 8000);
};
/* tracked trades + auto triggers on the other charts (Lines → Plan) */
OF.drawTradeLines = function (ctx, pw, Y, lo, hi) {
  const v = OF.views.plan, S = OF.S; if (!v || !v.T || v.Tsym !== S.symbol) return;
  const open = v.T.filter(t => !({ stopped: 1, done: 1, breakeven: 1, missed: 1, expired: 1, closed: 1 })[t.state]);
  open.forEach((L, i) => {
    const tag = `#${i + 1} ${L.dir > 0 ? 'LONG' : 'SHORT'}${L.auto ? ' auto' : ''} `;
    [['entry', L.entry, '#e5e7eb'], ['stop', L.stopNow, OF.C.sell], ['TP1', L.tp1, OF.C.buy], ['TP2', L.tp2, OF.C.buy]].forEach(([n, p, c]) => { if (p > lo && p < hi) OF.ui.hline(ctx, 0, pw, Y(p), c, [], tag + n + ' ' + OF.fp(p), pw * 0.55); });
  });
  if (!open.length && v.o.auto) {
    const st = OF.LS.get('auto:' + S.symbol + ':intraday', {});
    if (st.armed) {
      if (st.armed.long > lo && st.armed.long < hi) OF.ui.hline(ctx, 0, pw, Y(st.armed.long), '#86efac', [2, 2], '⏳ LONG if 1h closes above ' + OF.fp(st.armed.long), pw * 0.55);
      if (st.armed.short > lo && st.armed.short < hi) OF.ui.hline(ctx, 0, pw, Y(st.armed.short), '#fca5a5', [2, 2], '⏳ SHORT if 1h closes below ' + OF.fp(st.armed.short), pw * 0.55);
    }
  }
};

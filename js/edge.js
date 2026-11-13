/* FlowDesk edge — measuring the plan rules and guarding them.
   1. Factor families      price-derived factors are grouped so they are not counted several times
   2. Market-type gate     trend / range / chaos decides which setups are allowed
   3. Costs                fees are taken off every R figure; trades whose costs eat the target are rejected
   4. Breakout filter      a candle close must clear the trigger with margin, volume and delta
   5. Sweep and reclaim    entry after stops beyond a zone are run and price closes back
   6. Rules backtest       replays the candle-based rules (same zone and entry code as live) on 1h history
   7. Signal journal       every signal, taken or not, with its factor readings and what happened after
   8. Learned weights      factor weights adjusted from the journal once 100 signals have finished
   9. Risk limits          daily loss limit, trades per day, trading hours, half size in high danger
  10. Saved recordings     whales, per-minute CVD and wall ages survive a page refresh */
(function () {
'use strict';
const OF = window.OF, LS = OF.LS, P = OF._pl;
const E = OF.edge = {};
const clamp1 = v => OF.clamp(v, -1, 1);
const fmtR = r => (r >= 0 ? '+' : '') + r.toFixed(2) + 'R';

/* ---------- settings ---------- */
const DEF = { market: 'perp', fee: 0.1, dayLoss: 2, maxTrades: 3, h0: 0, h1: 24, exit: 'auto', halfDanger: true, learn: true };
E.cfg = () => Object.assign({}, DEF, LS.get('rules', {}));
E.setCfg = (k, v) => { const c = LS.get('rules', {}); c[k] = v; LS.set('rules', c); E._bt = null; };

/* ---------- 1. factor families ---------- */
const FAM = { Trend: 'trend', Value: 'trend', Timeframes: 'trend', Flow: 'flow', 'Flow now': 'flow', Whales: 'flow', Liquidity: 'liquidity', 'Order book': 'liquidity', Futures: 'leverage', Options: 'leverage' };
const FW = { trend: 0.35, flow: 0.3, liquidity: 0.2, leverage: 0.15 };
E.FAMS = ['trend', 'flow', 'leverage', 'liquidity'];
E.FAMNAME = { trend: 'Trend', flow: 'Order flow', leverage: 'Leverage', liquidity: 'Liquidity' };
/* A direction needs: blended bias ≥ 0.18, at least 2 families pointing that way, ≥ 60 % of the voting
   families agreeing, and no family strongly against (below −0.4). */
E.combine = function (F, mults) {
  if (mults === undefined) mults = E.mults();
  const acc = {};
  for (const f of F) {
    f.fam = FAM[f.group] || 'trend'; if (f.s == null) continue;
    const w = f.w * (mults && mults[f.name] || 1), a = acc[f.fam] = acc[f.fam] || { sum: 0, w: 0 };
    a.sum += f.s * w; a.w += w;
  }
  const fams = {}; let b = 0, bw = 0;
  for (const k in acc) { fams[k] = acc[k].w ? acc[k].sum / acc[k].w : 0; b += fams[k] * FW[k]; bw += FW[k]; }
  const bias = bw ? b / bw : 0, dir = Math.sign(bias), voting = Object.keys(fams).filter(k => Math.abs(fams[k]) > 0.12);
  const famYes = voting.filter(k => Math.sign(fams[k]) === dir).length, famAgainst = voting.filter(k => fams[k] * dir < -0.4).length;
  const agree = voting.length ? famYes / voting.length : 0;
  return { bias, fams, agree, famYes, famVoting: voting.length, famAgainst, ok: Math.abs(bias) >= 0.18 && famYes >= 2 && agree >= 0.6 && !famAgainst };
};

/* ---------- 2. market type ----------
   Efficiency ratio over 20 candles = net move ÷ total path (1 = straight line, 0 = pure chop).
   Volatility = average size of the last 3 candles ÷ the median of the 50 before them. */
E.regime = function (k, i) {
  if (i == null) i = k.length - 1;
  if (i < 56) return { type: 'mixed', dir: 0, er: 0, vol: 1 };
  let path = 0; for (let j = i - 19; j <= i; j++) path += Math.abs(k[j].c - k[j - 1].c);
  const net = k[i].c - k[i - 20].c, er = path ? Math.abs(net) / path : 0, r = [];
  for (let j = i - 52; j <= i - 3; j++) r.push(k[j].h - k[j].l);
  r.sort((a, b) => a - b);
  const vol = ((k[i].h - k[i].l) + (k[i - 1].h - k[i - 1].l) + (k[i - 2].h - k[i - 2].l)) / 3 / (r[r.length >> 1] || 1);
  return { type: vol > 2.5 ? 'chaos' : er > 0.35 ? 'trend' : er < 0.18 ? 'range' : 'mixed', dir: Math.sign(net), er, vol };
};

/* ---------- 3. costs and the gate every setup must pass ---------- */
/* round-trip fee as a share of the risk; a limit entry pays the lower maker fee on the way in (about 0.7× in total) */
E.cost = (q, c) => q.risk ? q.entry * (c || E.cfg()).fee / 100 * (q.eType === 'limit' ? 0.7 : 1) / q.risk : 0;
E.gate = function (plan, reg, why, opts) {
  if (!plan) return null;
  opts = opts || {}; plan.costR = E.cost(plan, opts.cfg);
  if (reg.type === 'chaos') { why.push(`the market is chaotic (candles ${reg.vol.toFixed(1)}× their normal size) — no new trades`); return null; }
  if (reg.type === 'trend' && plan.dir !== reg.dir) { why.push(`the market is trending ${reg.dir > 0 ? 'up' : 'down'} — a ${plan.dir > 0 ? 'long' : 'short'} would be against it`); return null; }
  if (reg.type === 'range' && !opts.sweep && !opts.breakout && plan.eType === 'market' && !(plan.base && plan.base.w >= 2.5)) { why.push('range market — only a limit at a strong zone edge is allowed, not an entry in the middle'); return null; }
  if (plan.costR > 0.2501) { why.push(`fees are ${Math.round(plan.costR * 100)}% of the risk — the stop is too tight for the costs`); return null; }
  if (plan.rr1 - plan.costR < 1.2) { why.push(`only ${(plan.rr1 - plan.costR).toFixed(1)}R to the first target after fees`); return null; }
  return plan;
};

/* ---------- 4. false-breakout filter (last closed candle) ---------- */
E.breakoutOK = function (k, dir, level) {
  const i = k.length - 2, c = k[i], atr = OF.atr(k.slice(0, i + 1)) || c.c * 0.002;
  let v = 0; for (let j = i - 20; j < i; j++) v += k[j].qv; v /= 20;
  const margin = (c.c - level) * dir, d = c.qv ? (2 * c.bqv - c.qv) / c.qv : 0;
  if (margin < atr * 0.15) return { ok: false, why: `it closed only ${OF.fp(Math.max(0, margin))} beyond the level (needs ${OF.fp(atr * 0.15)})` };
  if (c.qv < v * 1.2) return { ok: false, why: `volume was ${(c.qv / v).toFixed(1)}× average (needs 1.2×)` };
  if (d * dir <= 0) return { ok: false, why: `candle delta was ${d >= 0 ? '+' : ''}${Math.round(d * 100)}%, against the break` };
  return { ok: true, why: `closed ${OF.fp(margin)} beyond ${OF.fp(level)} on ${(c.qv / v).toFixed(1)}× volume, delta ${d >= 0 ? '+' : ''}${Math.round(d * 100)}%` };
};

/* ---------- 5. sweep and reclaim ----------
   Long: a candle's low goes through a support zone by ≥ 0.1 ATR, then it closes back above the zone with a
   long lower wick (≥ 40 % of the candle) and delta not negative. Short is the mirror image. */
E.detectSweep = function (c, zones, atr) {
  const rng = c.h - c.l; if (rng < atr * 0.5) return null;
  const d = c.qv ? (2 * c.bqv - c.qv) / c.qv : 0;
  for (const z of zones) {
    if (z.w < 2) continue;
    if (c.l < z.lo - atr * 0.1 && c.c > z.hi && Math.min(c.o, c.c) - c.l >= rng * 0.4 && d > -0.05) return { dir: 1, z, ext: c.l };
    if (c.h > z.hi + atr * 0.1 && c.c < z.lo && c.h - Math.max(c.o, c.c) >= rng * 0.4 && d < 0.05) return { dir: -1, z, ext: c.h };
  }
  return null;
};
E.targets = function (dir, entry, risk, sup, res, atr) {
  const far = dir > 0 ? res : sup, edge = z => dir > 0 ? z.lo - atr * 0.05 : z.hi + atr * 0.05;
  const tz = far.filter(z => (edge(z) - entry) * dir >= risk);
  let tp1z = tz[0] || null, tp1 = tp1z ? edge(tp1z) : entry + dir * risk * 1.5;
  if (Math.abs(tp1 - entry) > risk * 3) { tp1 = entry + dir * risk * 1.5; tp1z = null; }
  let tp2z = tz.find(z => (edge(z) - tp1) * dir > atr * 0.3) || null, tp2 = tp2z ? edge(tp2z) : entry + dir * risk * 3;
  if (Math.abs(tp2 - entry) > risk * 6) { tp2 = entry + dir * risk * 3; tp2z = null; }
  return { tp1, tp2, tp1z, tp2z };
};
E.sweepPlan = function (sw, entry, c, atr, sup, res, fee) {
  let stop = sw.ext - sw.dir * atr * 0.15, risk = Math.abs(entry - stop);
  const floor = Math.max(atr * 0.3, entry * (fee || 0) / 100 / 0.25);   // same fee floor as the zone setup
  if (risk < floor) { stop = entry - sw.dir * floor; risk = floor; }
  if (risk > atr * 2) return null;
  const t = E.targets(sw.dir, entry, risk, sup, res, atr);
  return { dir: sw.dir, entry, eType: 'market', stop, risk, tp1: t.tp1, tp2: t.tp2, rr1: Math.abs(t.tp1 - entry) / risk, rr2: Math.abs(t.tp2 - entry) / risk,
    base: sw.z, tp1z: t.tp1z, tp2z: t.tp2z, blocker: null, trigger: entry, setup: 'sweep', sweepT: c.t };
};
/* live: the last closed 1h candle; ignored if price already ran half the risk away or fell back through the zone */
E.liveSweep = function (k, px, zones, sup, res, atr, bias, fee) {
  const c = k[k.length - 2]; if (!c) return null;
  const sw = E.detectSweep(c, zones, atr); if (!sw || bias * sw.dir < -0.2) return null;
  if ((px - (sw.dir > 0 ? sw.z.lo : sw.z.hi)) * sw.dir < 0) return null;
  if ((px - c.c) * sw.dir > Math.abs(c.c - sw.ext) * 0.5) return null;
  return E.sweepPlan(sw, px, c, atr, sup, res, fee);
};

/* ---------- 6. rules backtest ----------
   Replays every closed 1h candle. Uses only what candles can show: the trend family (4h trend, 1h trend,
   structure, RSI) and the flow family (1h + 4h candle delta), and zones from 1h / 4h swings, the previous
   day's high / low and round numbers. Order-book, futures and options factors cannot be replayed (no free
   history), so this is the base rate of the rules before those live confirmations.
   Fills are conservative: a limit must be touched within 4 candles; if a candle touches the stop and a
   target, the stop counts; fees are subtracted. Each signal is scored under three exit rules. */
const CFG1 = { near: 1.6, buf: 0.25, minR: 0.6, maxR: 2, tp1R: 1.5, tp1Cap: 4, tp2R: 3, tp2Cap: 6, step: 0.3 };
E.backtest = function () {
  const S = OF.S; if (!S || !S.info) return null;
  const live = S.k['1h']; if (!live || live.length < 320) return null;
  const cfg = E.cfg(), oldN = S.kxOld ? S.kxOld.length : 0;
  if (E._bt && E._bt.sym === S.symbol && E._bt.fee === cfg.fee && E._bt.oldN === oldN && Date.now() - E._bt.at < 600000) return E._bt;
  const k = oldN ? S.kxOld.concat(live) : live, N = k.length - 1;
  const e21 = OF.ema(k, 21), e50 = OF.ema(k, 50), rsi = OF.rsi(k, 14), atr = new Float64Array(N);
  const wilder = (arr, out, n) => { let a = null; for (let i = 1; i < n; i++) { const tr = Math.max(arr[i].h - arr[i].l, Math.abs(arr[i].h - arr[i - 1].c), Math.abs(arr[i].l - arr[i - 1].c)); a = a == null ? tr : (a * 13 + tr) / 14; out[i] = a; } };
  wilder(k, atr, N);
  // 4h candles built from the 1h ones; idx4[i] = last 4h candle that is complete at the close of 1h candle i
  const H4 = 144e5, g4 = [], idx4 = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const gt = Math.floor(k[i].t / H4) * H4; let g = g4[g4.length - 1];
    if (!g || g.t !== gt) { g = { t: gt, o: k[i].o, h: k[i].h, l: k[i].l, c: k[i].c, qv: 0, bqv: 0 }; g4.push(g); }
    g.h = Math.max(g.h, k[i].h); g.l = Math.min(g.l, k[i].l); g.c = k[i].c; g.qv += k[i].qv; g.bqv += k[i].bqv;
    idx4[i] = k[i].t + 36e5 >= gt + H4 ? g4.length - 1 : g4.length - 2;
  }
  const e21h = OF.ema(g4, 21), e50h = OF.ema(g4, 50), atr4 = new Float64Array(g4.length); wilder(g4, atr4, g4.length);
  // swing points, each usable only once confirmed (lb candles later)
  const piv = (arr, n, lb) => { const hi = [], lo = []; for (let i = lb; i < n - lb; i++) { let h = true, l = true; for (let j = i - lb; j <= i + lb; j++) { if (j === i) continue; if (arr[j].h >= arr[i].h) h = false; if (arr[j].l <= arr[i].l) l = false; } if (h) hi.push([i + lb, arr[i].h]); if (l) lo.push([i + lb, arr[i].l]); } return { hi, lo }; };
  const p1 = piv(k, N, 3), p4 = piv(g4, g4.length, 2);
  const lastN = (list, at, n) => { let e = list.length; while (e > 0 && list[e - 1][0] > at) e--; return list.slice(Math.max(0, e - n), e); };
  const days = new Map(); for (let i = 0; i < N; i++) { const d = Math.floor(k[i].t / 864e5); let x = days.get(d); if (!x) days.set(d, x = [-Infinity, Infinity]); x[0] = Math.max(x[0], k[i].h); x[1] = Math.min(x[1], k[i].l); }

  const sim = (q, i) => {
    const d = q.dir, lim = q.eType === 'limit'; let fill = lim ? -1 : i;
    if (lim) {
      for (let j = i + 1; j < N && j <= i + 4; j++) {
        if (d > 0 ? k[j].l <= q.entry : k[j].h >= q.entry) { fill = j; break; }
        if (d > 0 ? k[j].h >= q.tp1 : k[j].l <= q.tp1) return { filled: false, end: j };
      }
      if (fill < 0) return { filled: false, end: Math.min(N - 1, i + 4) };
    }
    const R = {}; let end = fill;
    for (const rule of ['half', 'tp1', 'tp2']) {
      let st = 0, stop = q.stop, r = null, j = lim ? fill : fill + 1, first = lim;
      for (; j < N && j <= fill + 72; j++) {
        const c = k[j], hitS = d > 0 ? c.l <= stop : c.h >= stop, up = x => d > 0 ? c.h >= x : c.l <= x;
        if (!st) {
          if (hitS) { r = -1; break; }
          if (first) { first = false; continue; }            // no target credit on the candle that filled the limit
          if (rule === 'tp2') { if (up(q.tp2)) { r = q.rr2; break; } }
          else if (up(q.tp1)) { if (rule === 'tp1') { r = q.rr1; break; } st = 1; stop = q.entry; }
        } else { if (hitS) { r = q.rr1 / 2; break; } if (up(q.tp2)) { r = (q.rr1 + q.rr2) / 2; break; } }
      }
      if (r == null) { const jj = Math.min(j, N - 1), open = (k[jj].c - q.entry) * d / q.risk; r = st ? q.rr1 / 2 + open / 2 : open; }   // still open after 72 candles: mark to market
      R[rule] = r - q.costR; end = Math.max(end, Math.min(j, N - 1));
    }
    return { filled: true, R, end };
  };

  const sigs = [], i0 = 260, CFGF = Object.assign({ fee: cfg.fee }, CFG1), cnt = { bars: 0, agree: 0, rr: 0, sweep: 0, why: {} };
  for (let i = i0; i < N - 1;) {
    const j4 = idx4[i]; if (j4 < 55) { i++; continue; }
    const c = k[i], px = c.c, A = atr[i], A4 = atr4[j4] || A * 2, F = [];
    const fac = (name, w, s, group) => F.push({ name, w, s: clamp1(s), group });
    fac('4h trend', 2, 0.5 * Math.sign(e21h[j4] - e50h[j4]) + 0.5 * clamp1((px - e21h[j4]) / A4), 'Trend');
    fac('1h trend', 1.5, 0.5 * Math.sign(e21[i] - e50[i]) + 0.5 * clamp1((px - e21[i]) / A), 'Trend');
    const H = lastN(p1.hi, i, 8), L = lastN(p1.lo, i, 8);
    if (H.length >= 2 && L.length >= 2) { const hh = H[H.length - 1][1] > H[H.length - 2][1], hl = L[L.length - 1][1] > L[L.length - 2][1]; fac('1h structure', 1, hh && hl ? 1 : !hh && !hl ? -1 : 0, 'Trend'); }
    if (rsi[i] != null) fac('RSI 14 (1h)', 0.5, rsi[i] > 75 ? -0.4 : rsi[i] < 25 ? 0.4 : (rsi[i] - 50) / 50, 'Trend');
    const d1 = c.qv ? (2 * c.bqv - c.qv) / c.qv : 0, g = g4[j4], dh = g.qv ? (2 * g.bqv - g.qv) / g.qv : 0;
    fac('Delta 1h + 4h candles', 1, (clamp1(d1 * 3) + clamp1(dh * 3)) / 2, 'Flow');
    const cmb = E.combine(F, null), reg = E.regime(k, i);
    const lv = [], add = (p, w, src) => { if (p && isFinite(p) && Math.abs(p / px - 1) < 0.06) lv.push({ p, w, src }); };
    H.forEach(x => add(x[1], 1.2, '1h swing high')); L.forEach(x => add(x[1], 1.2, '1h swing low'));
    lastN(p4.hi, j4, 6).forEach(x => add(x[1], 2, '4h swing high')); lastN(p4.lo, j4, 6).forEach(x => add(x[1], 2, '4h swing low'));
    const pd = days.get(Math.floor(c.t / 864e5) - 1); if (pd) { add(pd[0], 1.5, 'prev-day high'); add(pd[1], 1.5, 'prev-day low'); }
    const rs = OF.niceStep(px * 0.01); for (let j = -1; j <= 1; j++) add((Math.round(px / rs) + j) * rs, 0.5, 'round number');
    const { zones, sup, res } = P.makeZones(lv, px, A, 0.25);
    let q = null, setup = 'zone'; cnt.bars++;
    if (cmb.ok) { cnt.agree++; q = P.buildPlan(Math.sign(cmb.bias), px, A, sup, res, CFGF); if (q.rr1 >= 1.3) { cnt.rr++; const w = []; q = E.gate(q, reg, w, { cfg }); if (!q) { const key = w[0].split(' — ')[0].replace(/[0-9.]+/g, '#').slice(0, 40); cnt.why[key] = (cnt.why[key] || 0) + 1; } } else q = null; }
    if (!q) { const sw = E.detectSweep(c, zones, A); if (sw && cmb.bias * sw.dir >= -0.2) { cnt.sweep++; q = E.gate(E.sweepPlan(sw, px, c, A, sup, res, cfg.fee), reg, [], { cfg, sweep: true }); setup = 'sweep'; } }
    if (!q) { i++; continue; }
    const r = sim(q, i);
    sigs.push({ t: c.t, dir: q.dir, setup, filled: r.filled, R: r.R, reg: reg.type });
    i = Math.max(i, r.end) + 1;
  }
  const t0 = k[i0].t, t1 = k[N - 1].t, cut = t0 + (t1 - t0) * 0.6;
  const agg = list => { const f = list.filter(s => s.filled), n = f.length, m = r => n ? f.reduce((x, s) => x + s.R[r], 0) / n : 0; return { n, unfilled: list.length - n, win: n ? f.filter(s => s.R.half > 0).length / n : 0, half: m('half'), tp1: m('tp1'), tp2: m('tp2') }; };
  const rows = [];
  for (const setup of ['zone', 'sweep', 'all']) for (const period of ['older', 'recent']) rows.push(Object.assign({ setup, period }, agg(sigs.filter(s => (setup === 'all' || s.setup === setup) && (period === 'older' ? s.t < cut : s.t >= cut)))));
  const older = rows.find(r => r.setup === 'all' && r.period === 'older'), recent = rows.find(r => r.setup === 'all' && r.period === 'recent');
  let bestExit = 'half'; if (older.n >= 20) for (const r of ['tp1', 'tp2']) if (older[r] > older[bestExit]) bestExit = r;
  E._bt = { at: Date.now(), sym: S.symbol, fee: cfg.fee, oldN, days: (t1 - t0) / 864e5, cut, rows, older, recent, bestExit, n: sigs.length, cnt };
  return E._bt;
};
const EXITNAME = { half: 'half at TP1, rest to TP2', tp1: 'all out at TP1', tp2: 'all out at TP2' };

/* ---------- 7. signal journal ---------- */
E.sigs = () => { const S = OF.S; if (!E._sg || E._sgSym !== S.symbol) { E._sg = LS.get('sig:' + S.symbol, []); E._sgSym = S.symbol; } return E._sg; };
E.saveSigs = () => LS.set('sig:' + OF.S.symbol, E.sigs().slice(-400));
/* Called at every candle close (the idea in the direction the analysis leans, confirmed or not) and whenever
   a trade is created. One open signal per mode and direction, so the samples stay independent. */
E.record = function (mode, p, q0) {
  if (!p || p.wait) return;
  const dir = q0 ? q0.dir : p.plan ? p.plan.dir : Math.abs(p.bias) >= 0.1 ? Math.sign(p.bias) : 0; if (!dir) return;
  const q = q0 || p.plan || (dir > 0 ? p.long : p.short), list = E.sigs(), t = OF.now();
  if (list.some(s => s.mode === mode && s.dir === dir && !P.FINAL[s.state])) return;
  const fac = {}; for (const f of p.factors) if (f.s != null) fac[f.name] = Math.round(f.s * 100) / 100;
  const lim = q.eType === 'limit';
  list.push({ id: t, mode, created: t, dir, entry: q.entry, stop: q.stop, stopNow: q.stop, tp1: q.tp1, tp2: q.tp2, rr1: q.rr1, rr2: q.rr2, risk: q.risk, eType: q.eType,
    costR: q.costR != null ? q.costR : E.cost(q), exit: 'half', confirmed: !!(q0 || p.plan), setup: q.setup || 'zone', reg: p.reg ? p.reg.type : '', fac,
    state: lim ? 'waiting' : 'active', filledAt: lim ? null : t, events: [], lastT: t, expires: t + P.MODES[mode].exp, expLabel: P.MODES[mode].expLabel });
  E.saveSigs();
};
E.track = function () {
  const S = OF.S; if (!S || !S.info || !S.last) return;
  let changed = false;
  for (const s of E.sigs()) { if (P.FINAL[s.state]) continue; const b = s.state; P.advance(s); if (s.state !== b) changed = true; }
  if (changed || !E._svT || Date.now() - E._svT > 60000) { E.saveSigs(); E._svT = Date.now(); if (changed) E.learn(); }
};
E.finished = () => E.sigs().filter(s => P.FINAL[s.state] && s.state !== 'missed' && s.state !== 'expired');
E.factorStats = function (fin) {
  const px = OF.S.last, names = new Set(); fin.forEach(s => Object.keys(s.fac || {}).forEach(n => names.add(n)));
  return [...names].map(name => {
    let na = 0, ra = 0, nb = 0, rb = 0;
    for (const s of fin) { const v = (s.fac[name] || 0) * s.dir, r = P.resultR(s, px); if (v > 0.15) { na++; ra += r; } else if (v < -0.15) { nb++; rb += r; } }
    return { name, na, ra: na ? ra / na : 0, nb, rb: nb ? rb / nb : 0 };
  });
};

/* ---------- 8. learned weights ----------
   After 100 finished signals (and again every 50 more): a factor whose agreement went with better results than
   its disagreement gets up to 1.5× weight, the opposite down to 0.5×. Needs ≥ 15 samples on each side and is
   shrunk toward 1 until 50 samples. Signals after the update are the out-of-sample check. */
E.NEED = 100;
E.learnState = () => LS.get('learn:' + OF.S.symbol, null);
E.mults = function () { if (!OF.S || !E.cfg().learn) return null; const L = E.learnState(); return L ? L.mults : null; };
E.learn = function () {
  const fin = E.finished(), L = E.learnState() || { n: 0 };
  if (fin.length < E.NEED || fin.length < L.n + 50) return;
  const m = {};
  for (const r of E.factorStats(fin)) if (r.na >= 15 && r.nb >= 15) m[r.name] = OF.clamp(1 + (r.ra - r.rb) * 0.5 * Math.min(1, Math.min(r.na, r.nb) / 50), 0.5, 1.5);
  LS.set('learn:' + OF.S.symbol, { at: OF.now(), n: fin.length, mults: m });
};

/* ---------- 9. risk limits ---------- */
E.limits = function (T) {
  const c = E.cfg(), now = new Date(), d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), px = OF.S.last;
  let dayR = 0, n = 0;
  for (const t of T || []) {
    const filled = !['waiting', 'missed', 'expired'].includes(t.state);
    if (filled && (t.filledAt || t.created) >= d0) n++;
    if (filled && P.FINAL[t.state] && (t.closedAt || t.created) >= d0) dayR += P.resultR(t, px);
  }
  const h = now.getHours() + now.getMinutes() / 60, inH = c.h0 === c.h1 || (c.h0 < c.h1 ? h >= c.h0 && h < c.h1 : h >= c.h0 || h < c.h1);
  const block = dayR <= -c.dayLoss ? `daily loss limit reached (${fmtR(dayR)} today, limit −${c.dayLoss}R)` : n >= c.maxTrades ? `${n} trades taken today (limit ${c.maxTrades})` : !inH ? `outside your trading hours (${c.h0}:00–${c.h1}:00)` : null;
  return { dayR, n, block, cfg: c };
};
/* every tracked trade gets its fee cost, exit rule and (in high danger) half size */
E.decorate = function (t, src) {
  const c = E.cfg(), bt = E.backtest();
  t.costR = src.costR != null ? src.costR : E.cost(t, c); t.setup = src.setup || (src.eType === 'manual' ? 'manual' : 'zone');
  t.exit = c.exit === 'auto' ? (bt ? bt.bestExit : 'half') : c.exit;
  if (t.exit !== 'half') t.events.push([t.created, 'Exit rule: ' + EXITNAME[t.exit]]);
  const m = OF.meters();
  if (c.halfDanger && src.eType !== 'manual' && m && m.danger > 66) { t.riskUsd *= 0.5; t.qty *= 0.5; t.events.push([t.created, 'Danger is high — position size halved']); }
  return t;
};

/* ---------- 10. saved recordings ---------- */
E.loadRec = function () {
  const S = OF.S, r = LS.get('rec:' + S.symbol, null), cut = OF.now() - 8 * 36e5;
  S.recW = r && r.w ? r.w.filter(x => x[0] > cut) : []; S.recC = r && r.c ? r.c.filter(x => x[0] > cut) : [];
  S.wallSeen = new Map(r && r.ws && OF.now() - r.at < 600000 ? r.ws : []);   // wall ages only if saved in the last 10 min
};
E.saveRec = function () {
  const S = OF.S; if (!S || !S.info || !S.trades.length || !S.recW) return;
  const tr = S.trades, t0 = tr[0].t, m0 = Math.floor(t0 / 6e4) * 6e4, thr = (S.whaleThr || 1e9) * 0.3, cut = OF.now() - 8 * 36e5;
  const w = S.recW.filter(x => x[0] < t0 && x[0] > cut), cm = S.recC.filter(x => x[0] < m0 && x[0] > cut), mm = new Map();
  for (const t of tr) {
    if (t.n >= thr) w.push([t.t, t.p, Math.round(t.n), t.buy ? 1 : 0]);
    const m = Math.floor(t.t / 6e4) * 6e4; let b = mm.get(m); if (!b) mm.set(m, b = [m, 0, 0]); b[t.buy ? 1 : 2] += t.n;
  }
  for (const b of mm.values()) if (b[0] > cut) cm.push([b[0], Math.round(b[1]), Math.round(b[2])]);
  if (S.synced) {   // first-seen time of the biggest walls
    const mid = OF.mid(), bin = S.wallBin = OF.niceStep(mid * 0.0004), bb = OF.bookBins(1.5, bin), all = [];
    for (const [p, n] of bb.b) all.push([p, n]); for (const [p, n] of bb.a) all.push([p, n]);
    const top = new Set(all.sort((a, b) => b[1] - a[1]).slice(0, 12).map(x => x[0])), now = OF.now();
    for (const p of top) if (!S.wallSeen.has(p)) S.wallSeen.set(p, now);
    for (const p of [...S.wallSeen.keys()]) if (!top.has(p)) S.wallSeen.delete(p);
  }
  LS.set('rec:' + S.symbol, { at: OF.now(), w: w.slice(-6000), c: cm.slice(-600), ws: [...S.wallSeen] });
};
E.wallAge = function (p) {
  const S = OF.S, m = S.wallSeen; if (!m || !m.size) return 0;
  let best = 0; for (const [k, t] of m) if (p >= k && p < k + (S.wallBin || 1)) best = Math.max(best, (OF.now() - t) / 1000);
  return best;
};
/* spot CVD over a span: saved per-minute buckets from before the refresh + live trades */
E.cvdSpan = function (ms) {
  const S = OF.S, now = OF.now(), from = now - ms, tr = S.trades, t0 = tr.length ? tr[0].t : now, f = OF.flow(from);
  let b = f.b, s = f.s, start = Math.max(from, t0);
  for (const c of S.recC || []) if (c[0] >= from && c[0] + 6e4 <= t0) { b += c[1]; s += c[2]; start = Math.min(start, c[0]); }
  return { d: b - s, tot: b + s, hours: (now - start) / 36e5 };
};

/* ---------- small pieces of the Trade plan screen ---------- */
E.limitsHtml = function (T) {
  const r = E.limits(T); if (!r.block) return '';
  return `<div class="plstatus risk"><span class="pli">🛑</span><div><div class="plsh">No new trades right now — ${r.block}</div><div class="plsb">Auto will not open trades until this clears. Change the limits in 📊 Scorecard → Rules and limits.</div></div></div>`;
};
const REGTXT = { trend: 'TREND', range: 'RANGE', chaos: 'CHAOS', mixed: 'MIXED' };
E.contextHtml = function (p) {
  if (!p || !p.fams) return '';
  const reg = p.reg || { type: 'mixed', dir: 0 }, chip = (t, c) => `<span class="fchip ${c || ''}">${t}</span>`;
  const fam = E.FAMS.filter(k => p.fams[k] != null).map(k => { const v = p.fams[k]; return chip(`${E.FAMNAME[k]} ${v > 0.12 ? '▲' : v < -0.12 ? '▼' : '◆'} ${Math.round(Math.abs(v) * 100)}`, v > 0.12 ? 'up' : v < -0.12 ? 'dn' : ''); }).join('');
  const regTxt = REGTXT[reg.type] + (reg.type === 'trend' ? (reg.dir > 0 ? ' up' : ' down') : '');
  const regTip = { trend: 'only trades with the trend are allowed', range: 'only limits at strong zone edges and sweeps are allowed', chaos: 'no new trades', mixed: 'no restriction' }[reg.type];
  return `<div class="ctx"><span class="lbl">Market type</span>${chip(regTxt, reg.type === 'chaos' ? 'dn' : reg.type === 'trend' ? (reg.dir > 0 ? 'up' : 'dn') : 'flat')}<span class="muted sm">${regTip}</span>
    <span class="lbl">Factor families</span>${fam}<span class="muted sm">${p.cmb ? p.cmb.famYes + ' of ' + p.cmb.famVoting + ' agree (2 or more needed)' : ''}</span></div>`;
};
E.btCard = function (pl) {
  const bt = E.backtest(), setup = pl && pl.setup === 'sweep' ? 'sweep' : 'zone';
  if (!bt) return `<div class="plcard"><div class="plh"><b>Rules backtest</b></div><div class="muted sm">Loading 1h history…</div></div>`;
  const r = bt.rows.find(x => x.setup === setup && x.period === 'recent'), o = bt.rows.find(x => x.setup === setup && x.period === 'older');
  const line = (lab, x) => `<div class="plrow"><span>${lab}</span><b class="mono ${x.n ? (x.half > 0.05 ? 'g' : x.half >= 0 ? 'y' : 'r') : ''}">${x.n ? fmtR(x.half) : '—'}</b><span class="muted sm">${x.n ? Math.round(x.win * 100) + '% winners · ' + x.n + ' trades' : 'no trades'}</span></div>`;
  return `<div class="plcard"><div class="plh"><b>Rules backtest · ${setup === 'sweep' ? 'sweep and reclaim' : 'zone setup'}</b><span class="muted sm">after fees</span></div>
    ${line('Recent ' + Math.round(bt.days * 0.4) + ' days', r)}${line('Older ' + Math.round(bt.days * 0.6) + ' days', o)}
    <div class="muted sm">Average result per trade, replaying the candle-based rules on 1h history. Order-book, futures and options checks cannot be replayed. Details in 📊 Scorecard.</div></div>`;
};

/* ---------- Scorecard view ---------- */
E.scoreHtml = function (main, fresh, view) {
  const S = OF.S, c = E.cfg(), el = OF.el;
  if (fresh) {
    main.innerHTML = `<div class="plcard rules"><div class="plh"><b>⚙ Rules and limits</b><span class="muted sm">saved in this browser · used by Auto and by every new plan</span></div><div class="rulerow">
      <label>Market <select data-k="market"><option value="perp">Perpetual futures</option><option value="spot">Spot</option></select></label>
      <label>Fees, round trip % <input type="number" step="0.01" min="0" data-k="fee"></label>
      <label>Daily loss limit, R <input type="number" step="0.5" min="0.5" data-k="dayLoss"></label>
      <label>Max trades per day <input type="number" step="1" min="1" data-k="maxTrades"></label>
      <label>Trading hours <input type="number" step="1" min="0" max="24" data-k="h0"> to <input type="number" step="1" min="0" max="24" data-k="h1"> <span class="muted sm">your local time · 0 to 24 = always</span></label>
      <label>Exit rule <select data-k="exit"><option value="auto">Auto (best in the backtest)</option><option value="half">Half at TP1, rest to TP2</option><option value="tp1">All out at TP1</option><option value="tp2">All out at TP2</option></select></label>
      <label class="ck"><input type="checkbox" data-k="halfDanger"> Half size when Danger is high</label>
      <label class="ck"><input type="checkbox" data-k="learn"> Use learned factor weights</label></div></div><div id="scStats"></div>`;
    main.querySelectorAll('[data-k]').forEach(i => {
      const k = i.dataset.k; if (i.type === 'checkbox') i.checked = !!c[k]; else i.value = c[k];
      i.onchange = () => {
        E.setCfg(k, i.type === 'checkbox' ? i.checked : i.tagName === 'SELECT' ? i.value : +i.value);
        if (k === 'market') { const f = i.value === 'perp' ? 0.1 : 0.2; E.setCfg('fee', f); main.querySelector('[data-k=fee]').value = f; }
        view.an = {}; E.scoreHtml(main, false, view);
      };
    });
  }
  const box = main.querySelector('#scStats'); if (!box) return;
  const px = S.last, lim = E.limits(view.T), bt = E.backtest(), p = view.analysis(view.o.mode), reg = p && p.reg;
  const exitNow = c.exit === 'auto' ? (bt ? bt.bestExit : 'half') : c.exit;
  let h = `<div class="cards">
    <div class="card sm"><div class="ct">Today</div><div class="cv ${lim.dayR >= 0 ? 'g' : 'r'}">${fmtR(lim.dayR)}</div><div class="cs">limit −${c.dayLoss}R</div></div>
    <div class="card sm"><div class="ct">Trades today</div><div class="cv">${lim.n} / ${c.maxTrades}</div></div>
    <div class="card wide ${lim.block ? 'warn' : 'ok'}"><div class="ct">New trades</div><div class="cv sm2">${lim.block ? '🛑 Blocked' : '✅ Allowed'}</div><div class="cs">${lim.block || 'inside your limits and hours'}</div></div>
    <div class="card sm"><div class="ct">Market type (${view.o.mode === 'swing' ? 'daily' : '1h'})</div><div class="cv sm2">${reg ? REGTXT[reg.type] + (reg.type === 'trend' ? (reg.dir > 0 ? ' up' : ' down') : '') : '—'}</div><div class="cs">${reg ? 'efficiency ' + reg.er.toFixed(2) + ' · candles ' + reg.vol.toFixed(1) + '× normal' : ''}</div></div>
    <div class="card wide"><div class="ct">Exit rule in use</div><div class="cv sm2">${EXITNAME[exitNow]}</div><div class="cs">${c.exit === 'auto' ? (bt && bt.older.n >= 20 ? 'chosen on the older backtest period' : 'default until the backtest has 20 trades') : 'set by you'}</div></div></div>`;
  // rules backtest
  h += '<h3>Rules backtest (1h, after fees)</h3>';
  if (OF.demo) h += '<div class="plstatus wait"><span class="pli">⚠</span><div><div class="plsh">Demo data</div><div class="plsb">These candles are random, so the numbers below mean nothing. Open the page without ?demo=1 for the real backtest.</div></div></div>';
  if (!bt) h += '<div class="muted pad">Loading 1h history…</div>';
  else {
    const cell = (v, n) => n ? `<td class="rt mono ${v > 0.05 ? 'g' : v >= 0 ? 'y' : 'r'}">${fmtR(v)}</td>` : '<td class="rt muted">—</td>';
    const best = r => r.n ? ['half', 'tp1', 'tp2'].reduce((a, x) => r[x] > r[a] ? x : a, 'half') : null;
    h += `<table class="tbl"><thead><tr><th>Setup</th><th>Period</th><th class="rt">Trades</th><th class="rt">Winners</th><th class="rt">Half at TP1</th><th class="rt">All at TP1</th><th class="rt">All at TP2</th><th>Best exit</th><th class="rt">Limits never filled</th></tr></thead><tbody>` +
      bt.rows.map(r => `<tr${r.setup === 'all' ? ' class="tot"' : ''}><td>${{ zone: 'Zone setup', sweep: 'Sweep and reclaim', all: 'All setups' }[r.setup]}</td><td>${r.period === 'older' ? 'older ' + Math.round(bt.days * 0.6) + ' days' : 'recent ' + Math.round(bt.days * 0.4) + ' days'}</td><td class="rt mono">${r.n}</td><td class="rt mono">${r.n ? Math.round(r.win * 100) + '%' : '—'}</td>${cell(r.half, r.n)}${cell(r.tp1, r.n)}${cell(r.tp2, r.n)}<td>${best(r) ? EXITNAME[best(r)] : '—'}</td><td class="rt mono muted">${r.unfilled}</td></tr>`).join('') + '</tbody></table>';
    const small = bt.recent.n < 30 || bt.older.n < 30;
    const cw = Object.entries(bt.cnt.why).map(([k2, v]) => v + ' ' + k2.replace(/#/g, 'n').replace('only nR to the first target after fees', 'too little reward after fees').replace('fees are n% of the risk', 'fees too large for the stop').replace('range market', 'range-market rule').replace(/^the market is trending.*/, 'against the trend').replace(/^the market is chaotic.*/, 'chaotic market')).join(', ');
    h += `<div class="muted sm note">Of ${bt.cnt.bars} candles checked: ${bt.cnt.agree} had two factor families agreeing, ${bt.cnt.rr} of those had at least 1.3R to the first target${cw ? ', and the filters then rejected ' + cw : ''}. ${bt.cnt.sweep} sweep-and-reclaim candles were found.</div>`;
    h += `<div class="muted sm note">Average result per trade in R over ${Math.round(bt.days)} days of 1h candles. It replays only what candles can show: the Trend and Order-flow families and zones from swings, the previous day and round numbers. Order-book, futures, options and whale readings are not in it, so live results can differ. A candle that touches both the stop and a target counts as a loss.${small ? ' <b class="y">Fewer than 30 trades in a period is a small sample.</b>' : ''} The exit rule is picked on the older period; the recent period shows how that choice held up.</div>`;
  }
  // journal
  const all = E.sigs(), fin = E.finished(), rs = fin.map(s => P.resultR(s, px)), avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const grp = (lab, f) => { const g = fin.filter(f), r = g.map(s => P.resultR(s, px)); return `<div class="card sm"><div class="ct">${lab}</div><div class="cv ${g.length ? (avg(r) >= 0 ? 'g' : 'r') : ''}">${g.length ? fmtR(avg(r)) : '—'}</div><div class="cs">${g.length} finished${g.length ? ' · ' + Math.round(r.filter(x => x > 0).length / g.length * 100) + '% winners' : ''}</div></div>`; };
  const L = E.learnState(), prog = Math.min(100, Math.round(fin.length / E.NEED * 100));
  h += `<h3>Live signal journal</h3><div class="cards">
    <div class="card sm"><div class="ct">Signals recorded</div><div class="cv">${all.length}</div><div class="cs">${all.filter(s => !P.FINAL[s.state]).length} still open · ${all.length - fin.length - all.filter(s => !P.FINAL[s.state]).length} never filled</div></div>
    ${grp('All finished', () => true)}${grp('Confirmed by the rules', s => s.confirmed)}${grp('Not confirmed', s => !s.confirmed)}
    <div class="card wide"><div class="ct">Learned weights</div><div class="cv sm2">${L ? 'Active since ' + new Date(L.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' (' + L.n + ' signals)' : fin.length + ' of ' + E.NEED + ' signals'}</div><div class="bar plain"><i style="width:${prog}%"></i></div><div class="cs">${L ? (c.learn ? 'in use' : 'switched off') + ' · next update at ' + (L.n + 50) + ' signals' : 'weights stay at their defaults until then'}</div></div></div>
    <div class="muted sm note">One signal is recorded at each 1h and daily candle close (the idea in the direction the analysis leans, whether or not it was confirmed) and each time a trade is created, with every factor reading at that moment. It is then followed to its stop or targets like a real trade. Recording only runs while this page is open.</div>`;
  const st = E.factorStats(fin).sort((a, b) => (b.na + b.nb) - (a.na + a.nb)), M = L && L.mults || {};
  h += `<h3>Which factors helped</h3><table class="tbl"><thead><tr><th>Factor</th><th class="rt">Agreed with the trade</th><th class="rt">Average result</th><th class="rt">Was against it</th><th class="rt">Average result</th><th class="rt">Difference</th><th class="rt">Weight</th></tr></thead><tbody>` +
    (st.length ? st.map(r => { const d = r.na && r.nb ? r.ra - r.rb : null; return `<tr><td>${r.name}</td><td class="rt mono">${r.na}</td><td class="rt mono ${r.na ? (r.ra >= 0 ? 'g' : 'r') : 'muted'}">${r.na ? fmtR(r.ra) : '—'}</td><td class="rt mono">${r.nb}</td><td class="rt mono ${r.nb ? (r.rb >= 0 ? 'g' : 'r') : 'muted'}">${r.nb ? fmtR(r.rb) : '—'}</td><td class="rt mono ${d == null ? 'muted' : d >= 0 ? 'g' : 'r'}">${d == null ? '—' : fmtR(d)}</td><td class="rt mono">${M[r.name] ? '×' + M[r.name].toFixed(2) : '×1.00'}</td></tr>`; }).join('') : '<tr><td colspan="7" class="empty">No finished signals yet. This table fills in as signals reach their stop or targets.</td></tr>') + '</tbody></table>';
  box.innerHTML = h;
};

/* ---------- wiring ---------- */
OF.on('info', () => { E._sg = null; E._bt = null; try { E.loadRec(); } catch (e) { console.error(e); } });
OF.on('klines', tf => { if (tf === '1h') OF.loadOld1h(); });
setInterval(() => { try { E.saveRec(); } catch (e) { console.error(e); } }, 30000);
})();

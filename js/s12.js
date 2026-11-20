/* S1+S2 — "Combined Session 1 & Session 2" (Pine v2), ported to FlowDesk with order-flow confirmation.

   Same rules, lines and colours as the Pine script:
   • Session 1: closeDiff = (HTF close − previous HTF close) / previous HTF close. Green background + green candles
     when closeDiff > 0, red otherwise (bgcolor transp 85, barcolor). BUY label below the bar on crossover(closeDiff, 0),
     SELL label above the bar on crossunder(closeDiff, 0). Optional "S1-Daily Close Diff" debug pane.
   • Session 2: zeroValue = today − closeDiff·today, Weighted Line = sma(zeroValue, 10), Upper / Lower Entry Lines =
     ±0.15 %, shaded zone (transp 88), only drawn while |closeDiff| > (high − low)·0.02 or |closeDiff| > 0.004.
     Touch alerts when the close crosses an entry line.

   What is different (on purpose):
   • FIXED TIMEFRAME. Everything (colour, signals, weighted line, bands) is calculated on the indicator's own candles
     (setting: 1 hour, 4 hours, 1 day, 1430 minutes, 1 week, 1 month) and only then drawn on the chart. Changing the
     chart timeframe changes how it is drawn, never the values or the signals.
   • NO REPAINT. Only closed candles of that timeframe are used; a signal appears on the first chart candle after the
     indicator candle closed and never moves or disappears.
     1430 minutes is built like TradingView builds it on a 24 h crypto session: each UTC day has a 00:00–23:50 candle
     and a short 23:50–24:00 candle. The 00:00–23:50 candle is compared with the previous day's 00:00 close.
   • FINAL SIGNAL. A colour flip is only a candidate. It becomes a FINAL BUY / SELL when FlowDesk's own tools agree:
     – at the time it fired (from candles, never changes): taker delta, volume, close location, EMA 21/50 trend,
       Session-2 weighted line, RSI, market type (Trade-plan regime), HTF S/R weekly bias, size of the move;
     – for a fresh signal, live tools (saved when first seen, never change): Direction bar, Decision panel, Trade plan,
       Key points trend, whales, futures CVD, order book, liquidations, liquidation fuel, funding.
     The score needed is a setting. The status box also shows a backtest: how often raw flips vs FINAL signals were
     right on this coin and timeframe. */
(function () {
'use strict';
const OF = window.OF, LS = OF.LS, el = OF.el;
const Z = OF.s12 = {};

const TFOPT = [['60', '1 hour'], ['240', '4 hours'], ['D', '1 day'], ['1430', '1430 minutes'], ['W', '1 week'], ['M', '1 month']];
const TFNAME = { '60': '1h', '240': '4h', 'D': '1D', '1430': '1430m', 'W': '1W', 'M': '1M' };
const DEF = {
  on: true, tf: '1430',
  s1: true, bg: true, bar: true, sig: true, diffPane: false,
  s2: true, threshold: 0.004, bandOffset: 0.0015, smooth: 10, fill: true,
  up: '#008000', dn: '#FF0000',                       // Pine v2 `green` / `red`
  confirm: true, hideWeak: false, minScore: 60, minLive: 55, hold: 10, box: true, alerts: true
};
Z.cfg = () => Object.assign({}, DEF, LS.get('s12', {}));
Z.save = c => { LS.set('s12', c); Z._c = null; };
Z.toggle = on => { const c = Z.cfg(); c.on = on; Z.save(c); };

const DAY = 864e5, M2350 = 1430 * 6e4;
const alpha = (hex, a) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex; };

/* ---------- higher-timeframe candles: [{ s: start, e: close time, o,h,l,c, qv, bqv }] ---------- */
let monthly = {}, mLoading = {};
function loadMonthly(S) {
  if (monthly[S.symbol] || mLoading[S.symbol]) return monthly[S.symbol] || null;
  if (OF.demo) {
    const d = S.k['1d'] || OF.demoKlines('1d'), out = [];
    for (const c of d) { const dt = new Date(c.t), s = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1), L = out[out.length - 1];
      if (!L || L.t !== s) out.push(Object.assign({}, c, { t: s })); else { L.h = Math.max(L.h, c.h); L.l = Math.min(L.l, c.l); L.c = c.c; L.qv += c.qv; L.bqv += c.bqv; } }
    return (monthly[S.symbol] = out);
  }
  mLoading[S.symbol] = true;
  OF.getJ(`/api/v3/klines?symbol=${S.symbol}&interval=1M&limit=120`).then(r => {
    monthly[S.symbol] = r.map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], qv: +x[7], bv: +x[9], bqv: +x[10] }));
  }).catch(() => {}).finally(() => { mLoading[S.symbol] = false; });
  return null;
}
const monthEnd = t => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

/* 1430-minute candles need the price at 23:50 UTC of each day (one 5-minute candle per day, cached for good). */
const c2350 = {}, c2350Busy = {};
function need2350(S, days) {
  const sym = S.symbol, key = 's12d:' + sym, map = c2350[sym] || (c2350[sym] = LS.get(key, {}));
  if (OF.demo) {
    const d1 = S.k['1d']; if (d1) for (const c of d1) map[c.t] = c.o + (c.c - c.o) * 0.985;   // demo: 23:50 ≈ near the daily close
    return map;
  }
  if (c2350Busy[sym]) return map;
  const now = OF.now(), todo = days.filter(d => map[d] == null && d + M2350 <= now - 6e4).slice(-120);
  if (!todo.length) return map;
  c2350Busy[sym] = true;
  let i = 0, changed = 0;
  const worker = async () => {
    while (i < todo.length) {
      const d = todo[i++];
      try {
        const r = await OF.getJ(`/api/v3/klines?symbol=${sym}&interval=5m&startTime=${d + M2350 - 3e5}&limit=1`);
        if (r && r[0] && +r[0][0] === d + M2350 - 3e5) { map[d] = +r[0][4]; changed++; }
        else map[d] = map[d] == null ? null : map[d];
      } catch (e) { /* retry next time */ }
    }
  };
  Promise.all([worker(), worker(), worker()]).finally(() => {
    c2350Busy[sym] = false;
    if (changed) { const ks = Object.keys(map).sort(); const keep = {}; ks.slice(-400).forEach(k => keep[k] = map[k]); LS.set(key, keep); Z._c = null; }
  });
  return map;
}

function htfBars(S, tf) {
  const now = OF.now();
  const conv = (k, ms) => k.map(c => ({ s: c.t, e: ms === 'M' ? monthEnd(c.t) : c.t + ms, o: c.o, h: c.h, l: c.l, c: c.c, qv: c.qv, bqv: c.bqv }));
  if (tf === '60' || tf === '240' || tf === 'D') {
    const key = tf === '60' ? '1h' : tf === '240' ? '4h' : '1d', k = S.k[key];
    if (!k) { OF.loadKlines(key); return null; }
    return conv(k, OF.tfMs[key]);
  }
  if (tf === 'W') { const k = OF.loadWeekly(); return k ? conv(k, 7 * DAY) : null; }
  if (tf === 'M') { const k = loadMonthly(S); return k ? conv(k, 'M') : null; }
  // 1430 minutes: [day, day+23:50) and [day+23:50, day+24h) per UTC day
  const d1 = S.k['1d']; if (!d1) { OF.loadKlines('1d'); return null; }
  const from = Math.floor(OF.now() / DAY) * DAY - 118 * DAY;   // last ~4 months (fixed: does not depend on the chart)
  const days = d1.filter(c => c.t >= from).map(c => c.t);
  const map = need2350(S, days), out = [];
  for (const c of d1) {
    if (c.t < from) continue;
    const mid = map[c.t], tA = c.t + M2350;
    // the 23:50 price is unknown until fetched; while the day is still running, the 1430 candle is still open
    if (mid != null) out.push({ s: c.t, e: tA, o: c.o, h: c.h, l: c.l, c: mid, qv: c.qv, bqv: c.bqv, part: 'A' });
    else if (tA > now) out.push({ s: c.t, e: tA, o: c.o, h: c.h, l: c.l, c: c.c, qv: c.qv, bqv: c.bqv, part: 'A' });
    else continue;                                      // fetching: skip this day for now
    out.push({ s: tA, e: c.t + DAY, o: mid != null ? mid : c.c, h: c.h, l: c.l, c: c.c, qv: c.qv, bqv: c.bqv, part: 'B' });
  }
  return out;
}

/* last bar with e <= t (strict: e < t) — binary search */
function lastClosed(H, t, strict) {
  let lo = 0, hi = H.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (strict ? H[m].e < t : H[m].e <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

/* ---------- the indicator on its own candles ---------- */
const sma = (a, i, n, f) => { if (i < n - 1) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) { const v = f(a[j]); if (v == null) return null; s += v; } return s / n; };

/* HTF S/R (weekly) bias at a given time, walked like the HTF S/R module does */
function htfBiasAt(sig, t) {
  let b = 0;
  for (let j = 0; j < sig.length && sig[j].at <= t; j++) {
    const both = (sig[j + 1] && sig[j + 1].at === sig[j].at) || (sig[j - 1] && sig[j - 1].at === sig[j].at);
    if (!both) b = sig[j].h ? -1 : 1;
  }
  return b;
}

/* candle-based checks, known when the indicator candle closed (weights in brackets) */
function histChecks(P, j, dir, c, ctx) {
  const x = P[j], out = [], add = (n, w, ok, t) => out.push({ n, w, ok, t });
  const dl = x.qv ? (2 * x.bqv - x.qv) / x.qv : 0;
  add('Taker delta', 1, dl * dir > 0.02, (dir > 0 ? 'buyers ' : 'sellers ') + Math.round((0.5 + dir * dl / 2) * 100) + '% of volume');
  let a = 0, b = 0; for (let q = Math.max(0, j - 20); q < j; q++) { a += P[q].qv; b++; }
  const vr = b && a ? x.qv / (a / b) : 1;
  add('Volume', 0.5, vr >= 0.8, vr.toFixed(2) + '× normal');
  const loc = x.h > x.l ? (x.c - x.l) / (x.h - x.l) : 0.5;
  add('Close location', 0.75, (dir > 0 ? loc : 1 - loc) >= 0.5, 'closed ' + Math.round(loc * 100) + '% up the candle');
  const e21 = ctx.e21[j], e50 = ctx.e50[j];
  if (e21 != null && e50 != null) add('Trend EMA 21/50', 1, (dir > 0 ? x.c > e21 || e21 > e50 : x.c < e21 || e21 < e50), 'close ' + (x.c > e21 ? 'above' : 'below') + ' EMA21, EMA21 ' + (e21 > e50 ? 'above' : 'below') + ' EMA50');
  if (ctx.sm[j] != null) add('Session 2 line', 1, dir > 0 ? x.c > ctx.sm[j] : x.c < ctx.sm[j], 'close ' + (x.c > ctx.sm[j] ? 'above' : 'below') + ' weighted line ' + OF.fp(ctx.sm[j]));
  const r = ctx.rsi[j]; if (r != null) add('RSI not stretched', 0.5, dir > 0 ? r < 70 : r > 30, 'RSI ' + r.toFixed(0));
  if (j >= 56 && OF.edge && OF.edge.regime) { const g = OF.edge.regime(P, j); add('Market type', 0.5, g.type !== 'chaos' && !(g.type === 'trend' && g.dir === -dir), g.type + (g.type === 'trend' ? (g.dir > 0 ? ' up' : ' down') : '')); }
  if (ctx.hsig) { const hb = htfBiasAt(ctx.hsig, x.e); if (hb) add('HTF S/R weekly bias', 1, hb === dir, hb > 0 ? 'SUPPORT mode' : 'RESISTANCE mode'); }
  add('Size of move', 0.75, Math.abs(ctx.d[j]) > c.threshold, (ctx.d[j] * 100).toFixed(2) + '% vs ' + (c.threshold * 100).toFixed(1) + '% threshold');
  return out;
}
/* live FlowDesk tools — only for a signal that is happening now */
function liveChecks(dir) {
  // each tool: agrees (✓ 1), neutral (– ½) or against (✕ 0) the signal direction
  const S = OF.S, out = [], add = (n, w, x, th, t) => { const v = x * dir > th ? 1 : x * dir < -th ? 0 : 0.5; out.push({ n, w, v, ok: v === 1, t }); };
  if (!(OF.demo || (S && S.status === 'LIVE'))) return out;
  const m = OF.meters(), get = k => m && m.list.find(x => x.key === k && x.score != null);
  const mt = OF.mtf(); if (mt && mt.overall != null) add('Direction bar', 1.2, mt.overall, 10, 'overall ' + (mt.overall > 0 ? '+' : '') + mt.overall);
  const dc = OF.lastDecision || OF.decision(); if (dc) add('Decision panel', 1, dc.score, 8, dc.verdict + ' · score ' + Math.round(dc.score));
  try { const tp = OF.tradePlan(); if (tp && tp.bias != null) add('Trade plan analysis', 1, tp.bias, 0.08, 'bias ' + (tp.bias > 0 ? '+' : '') + Math.round(tp.bias * 100) + ' · ' + (tp.verdict || '')); } catch (e) {}
  try { const kr = OF.keyRead('1h'); if (kr && kr.trend) add('Key points trend', 0.8, kr.trend === 'UP' ? 1 : kr.trend === 'DOWN' ? -1 : 0, 0.5, kr.trend + ' · ' + kr.pside); } catch (e) {}
  const wh = get('whale'); if (wh) add('Whales (1 h)', 0.6, wh.score, 10, wh.text);
  const fc = get('fcvd15'); if (fc) add('Futures CVD (15 min)', 0.6, fc.score, 10, fc.text);
  const im = get('imb'); if (im) add('Order book', 0.5, im.score, 10, im.text);
  const lq = get('liq'); if (lq) add('Liquidations (1 h)', 0.4, lq.score, 10, lq.text);
  const fu = get('fuel'); if (fu) add('Liquidation fuel', 0.4, fu.score, 10, fu.text);
  const fd = get('fund'); if (fd) add('Funding (crowd)', 0.4, fd.score, 30, fd.text);
  return out;
}
const pct = L => { let w = 0, p = 0; for (const x of L) { w += x.w; p += x.w * (x.v != null ? x.v : x.ok ? 1 : 0); } return w ? Math.round(p / w * 100) : 0; };
const mark = x => x.v === 0.5 ? '– ' : x.ok ? '✓ ' : '✕ ';

Z.calc = function () {
  const S = OF.S; if (!S || !S.info) return null;
  const c = Z.cfg(), now = OF.now();
  const H = htfBars(S, c.tf); if (!H || H.length < 3) return { wait: true, c };
  const lastH = H[H.length - 1], key = [S.symbol, H.length, lastH.e, JSON.stringify(c), Math.floor(now / 6e4)].join('|');
  if (Z._c && Z._c.key === key) return Z._c;
  // points: closed indicator candles with the close they are compared against
  const P = [];
  for (let i = 1; i < H.length; i++) {
    const x = H[i]; if (x.e > now) break;
    if (c.tf === '1430' && x.part !== 'A') continue;
    P.push(Object.assign({}, x, { prev: H[i - 1].c }));
  }
  if (P.length < 3) return { wait: true, c };
  const n = P.length, d = P.map(x => (x.c - x.prev) / x.prev);
  const zero = P.map((x, i) => x.c - d[i] * x.c), sm = zero.map((_, i) => sma(zero, i, c.smooth, v => v));
  const sig = P.map((x, i) => sm[i] != null && (Math.abs(d[i]) > (x.h - x.l) * 0.02 || Math.abs(d[i]) > c.threshold));
  let hsig = null; try { const hr = OF.htfsr.calc(); if (hr && hr.levels && hr.levels[3]) hsig = hr.sig; } catch (e) {}
  const ctx = { d, sm, e21: OF.ema(P, 21), e50: OF.ema(P, 50), rsi: OF.rsi(P, 14), hsig };
  const frozen = LS.get('s12live', {}); let dirty = false;
  const sigs = [], period = n > 1 ? P[n - 1].e - P[n - 2].e : DAY;
  for (let j = 1; j < n; j++) {
    const dir = d[j] > 0 && d[j - 1] <= 0 ? 1 : d[j] < 0 && d[j - 1] >= 0 ? -1 : 0; if (!dir) continue;
    const hc = histChecks(P, j, dir, c, ctx), hs = pct(hc);
    const fk = S.symbol + '|' + c.tf + '|' + P[j].e + '|' + dir;
    let lc = frozen[fk] || null;
    if (!lc && now - P[j].e < Math.max(period * 1.5, 3 * 36e5)) { const L = liveChecks(dir); if (L.length >= 4) { lc = L; frozen[fk] = L; dirty = true; } }
    const ls = lc ? pct(lc) : null;
    const ok = hs >= c.minScore && (ls == null || ls >= c.minLive);
    sigs.push({ j, e: P[j].e, dir, hc, hs, lc, ls, ok, d: d[j], px: P[j].c });
  }
  if (dirty) { const ks = Object.keys(frozen); if (ks.length > 300) ks.slice(0, ks.length - 300).forEach(x => delete frozen[x]); LS.set('s12live', frozen); }
  // backtest: hold until the opposite flip or `hold` candles, whichever first
  const bt = (list) => {
    let nn = 0, w = 0, sum = 0;
    for (const s of list) {
      const nx = sigs.find(q => q.j > s.j && q.dir === -s.dir), x = Math.min(nx ? nx.j : n - 1, s.j + c.hold);
      if (x <= s.j) continue;
      const r = s.dir * (P[x].c / P[s.j].c - 1); nn++; sum += r; if (r > 0) w++;
    }
    return { n: nn, win: nn ? w / nn : 0, avg: nn ? sum / nn : 0 };
  };
  const btRaw = bt(sigs), btFin = bt(sigs.filter(s => s.ok));
  // now: the current colour checked against live FlowDesk tools
  const dirNow = d[n - 1] > 0 ? 1 : -1, nowL = liveChecks(dirNow), nowS = nowL.length ? pct(nowL) : null;
  const r = { key, at: Date.now(), c, P, d, sm, sig, sigs, btRaw, btFin, dirNow, nowL, nowS };
  Z._c = r; Z.alerts(r);
  return r;
};

/* alertcondition(): one pop-up per new indicator candle with a flip, saying FINAL or not */
Z.alerts = function (r) {
  const c = r.c; if (!c.alerts) return;
  const sk = 's12seen:' + OF.S.symbol + ':' + c.tf, seen = LS.get(sk, 0), last = r.P[r.P.length - 1].e;
  if (!seen) { LS.set(sk, last); return; }
  if (last <= seen) return;
  LS.set(sk, last);
  const s = r.sigs.find(x => x.e > seen && x.e === last); if (!s) return;
  if (c.hideWeak && !s.ok) return;
  OF.notify((s.ok ? 'FINAL ' : '') + (s.dir > 0 ? 'S1-Buy Alert' : 'S1-Sell Alert'),
    (s.dir > 0 ? 'Background GREEN -> BUY' : 'Background RED -> SELL') + ' · ' + (s.ok ? '✓ FINAL — FlowDesk data agrees' : '✕ not confirmed by FlowDesk data') + ` (candles ${s.hs}%${s.ls != null ? ', live tools ' + s.ls + '%' : ''})`);
};

/* project the indicator values onto the chart's candles (state = last indicator candle closed by that chart candle) */
function project(r, k, ms) {
  const n = k.length, now = OF.now(), idx = new Array(n).fill(-1), at = new Map();
  let p = 0;
  for (let i = 0; i < n; i++) {
    const Tc = Math.min(k[i].t + ms, now);
    while (p < r.P.length && r.P[p].e <= Tc) p++;
    idx[i] = p - 1;
  }
  const bySig = new Map(r.sigs.map(s => [s.j, s]));
  for (let i = 0; i < n; i++) {
    const from = i ? idx[i - 1] + 1 : Math.max(0, idx[0]), to = idx[i];
    for (let j = from; j <= to && j >= 0; j++) if (bySig.has(j)) at.set(i, bySig.get(j));   // keep the latest flip inside this chart candle
  }
  return { idx, at };
}

/* background (Session 1) — drawn before the candles */
Z.drawBg = function (ctx, g) {
  const c = Z.cfg(); if (!c.on || !c.s1 || !c.bg) return;
  const r = Z.calc(); if (!r || r.wait) return;
  const pr = g._pr = project(r, g.k, g.ms);
  for (let i = g.i0; i < g.end; i++) {
    const j = pr.idx[i]; if (j < 0) continue;
    ctx.fillStyle = alpha(r.d[j] > 0 ? c.up : c.dn, 0.15);
    ctx.fillRect(Math.floor(g.X(i) - g.bw / 2), g.top, Math.ceil(g.bw) + 1, g.bottom - g.top);
  }
};

/* barcolor + Session 2 lines + signals + status — drawn after the candles */
Z.draw = function (ctx, g) {
  const c = Z.cfg(); if (!c.on) return;
  const r = Z.calc(), k = g.k;
  ctx.save();
  if (!r || r.wait) {
    ctx.font = '600 11px Inter,system-ui,sans-serif'; ctx.fillStyle = '#c4b5fd'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('S1+S2 · loading ' + TFOPT.find(x => x[0] === c.tf)[1] + ' candles…', g.pw - 10, g.top + 40); ctx.restore(); return;
  }
  const pr = g._pr || (g._pr = project(r, k, g.ms)), J = pr.idx; Z._pr = pr;
  if (c.s1 && c.bar) for (let i = g.i0; i < g.end; i++) {
    const j = J[i]; if (j < 0) continue;
    const b = k[i], x = g.X(i), col = r.d[j] > 0 ? c.up : c.dn, w = g.bw * 0.7;
    ctx.strokeStyle = ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, g.Y(b.h)); ctx.lineTo(Math.round(x) + .5, g.Y(b.l)); ctx.stroke();
    const y1 = g.Y(Math.max(b.o, b.c)), y2 = g.Y(Math.min(b.o, b.c));
    ctx.fillRect(Math.round(x - w / 2), y1, Math.max(1, Math.round(w)), Math.max(1, y2 - y1));
  }
  // Session 2: weighted line, dashed entry lines and zone (values change only when an indicator candle closes)
  if (c.s2) {
    const on = i => J[i] >= 0 && r.sig[J[i]];
    const val = (i, m) => r.sm[J[i]] * m;
    if (c.fill) for (let i = Math.max(g.i0, 1); i < g.end; i++) {
      if (!on(i) || !on(i - 1)) continue;
      ctx.fillStyle = alpha(r.d[J[i]] > 0 ? c.up : c.dn, 0.12); ctx.beginPath();
      ctx.moveTo(g.X(i - 1), g.Y(val(i - 1, 1 + c.bandOffset))); ctx.lineTo(g.X(i), g.Y(val(i, 1 + c.bandOffset)));
      ctx.lineTo(g.X(i), g.Y(val(i, 1 - c.bandOffset))); ctx.lineTo(g.X(i - 1), g.Y(val(i - 1, 1 - c.bandOffset))); ctx.closePath(); ctx.fill();
    }
    const seg = (m, width, dash, a) => {
      ctx.lineWidth = width; ctx.setLineDash(dash);
      for (let i = Math.max(g.i0, 1); i < g.end; i++) {
        if (!on(i) || !on(i - 1)) continue;
        ctx.strokeStyle = alpha(r.d[J[i]] > 0 ? c.up : c.dn, a);
        ctx.beginPath(); ctx.moveTo(g.X(i - 1), g.Y(val(i - 1, m))); ctx.lineTo(g.X(i), g.Y(val(i, m))); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineWidth = 1;
    };
    seg(1 + c.bandOffset, 1, [5, 4], 0.7); seg(1 - c.bandOffset, 1, [5, 4], 0.7); seg(1, 2, [], 1);
  }
  // signals: FINAL = full label + ✓ ; raw flip that FlowDesk did not confirm = faded label + ✕
  if (c.s1 && c.sig) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [i, s] of pr.at) {
      if (i < g.i0 || i >= g.end) continue;
      if (c.confirm && c.hideWeak && !s.ok) continue;
      const fin = !c.confirm || s.ok, b = k[i], x = g.X(i), col = s.dir > 0 ? c.up : c.dn;
      const txt = (s.dir > 0 ? 'BUY' : 'SELL') + (c.confirm && fin ? ' ✓' : '');
      ctx.font = `700 ${fin ? 10.5 : 9.5}px Inter,system-ui,sans-serif`;
      const w = ctx.measureText(txt).width + 12, h = fin ? 17 : 15, y = s.dir > 0 ? g.Y(b.l) + 6 : g.Y(b.h) - 6 - h - 5;
      ctx.globalAlpha = fin ? 1 : 0.4;
      ctx.fillStyle = col; ctx.beginPath();
      if (s.dir > 0) { ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 5); ctx.lineTo(x + 5, y + 5); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.roundRect(x - w / 2, y + 5, w, h, 3); }
      else { ctx.moveTo(x, y + h + 5); ctx.lineTo(x - 5, y + h); ctx.lineTo(x + 5, y + h); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.roundRect(x - w / 2, y, w, h, 3); }
      ctx.fill();
      if (fin && c.confirm) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.lineWidth = 1; }
      ctx.fillStyle = '#fff'; ctx.fillText(txt, x, (s.dir > 0 ? y + 5 : y) + h / 2 + .5);
      if (c.confirm && !fin) { ctx.font = '700 9px Inter,system-ui,sans-serif'; ctx.fillStyle = '#cbd5e1'; ctx.fillText('✕', x, s.dir > 0 ? y + 5 + h + 8 : y - 8); }
      ctx.globalAlpha = 1;
    }
  }
  // S1-Daily Close Diff pane
  if (c.s1 && c.diffPane) {
    const ph = 46, top = g.bottom - ph, mid = top + ph / 2; let mx = 0;
    for (let i = g.i0; i < g.end; i++) if (J[i] >= 0) mx = Math.max(mx, Math.abs(r.d[J[i]]));
    ctx.fillStyle = 'rgba(10,6,22,.75)'; ctx.fillRect(0, top, g.pw, ph);
    ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(g.pw, mid); ctx.stroke();
    ctx.lineWidth = 2;
    for (let i = Math.max(g.i0, 1); i < g.end; i++) {
      if (J[i] < 0 || J[i - 1] < 0 || !mx) continue;
      ctx.strokeStyle = r.d[J[i]] > 0 ? c.up : c.dn; ctx.beginPath();
      ctx.moveTo(g.X(i - 1), mid - r.d[J[i - 1]] / mx * (ph / 2 - 4)); ctx.lineTo(g.X(i), mid - r.d[J[i]] / mx * (ph / 2 - 4)); ctx.stroke();
    }
    ctx.lineWidth = 1; ctx.fillStyle = '#cbd5e1'; ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const lj = J[g.end - 1]; ctx.fillText('S1-Daily Close Diff ' + (lj >= 0 ? (r.d[lj] * 100).toFixed(3) + '%' : ''), 6, top + 3);
  }
  if (c.box) drawBox(ctx, g, r, c);
  ctx.restore();
};
const ago = ms => ms < 36e5 ? Math.max(1, Math.round(ms / 6e4)) + 'm' : ms < 2 * DAY ? Math.round(ms / 36e5) + 'h' : Math.round(ms / DAY) + 'd';
function drawBox(ctx, g, r, c) {
  const dv = r.d[r.d.length - 1], last = r.sigs[r.sigs.length - 1], lastF = r.sigs.filter(s => s.ok).pop(), now = OF.now();
  const rows = [];
  rows.push([`S1+S2 · ${TFNAME[c.tf]} (fixed) · ${dv > 0 ? 'GREEN' : 'RED'} ${dv >= 0 ? '+' : ''}${(dv * 100).toFixed(2)}%`, '#fff', 700]);
  if (lastF) rows.push([`FINAL ${lastF.dir > 0 ? 'BUY' : 'SELL'} ✓ ${ago(now - lastF.e)} ago at ${OF.fp(lastF.px)} · candles ${lastF.hs}%${lastF.ls != null ? ' · live ' + lastF.ls + '%' : ''}`, lastF.dir > 0 ? '#86efac' : '#fca5a5', 600]);
  else rows.push(['No FINAL signal on loaded history', '#cbd5e1', 500]);
  if (last && last !== lastF) rows.push([`last flip ${last.dir > 0 ? 'BUY' : 'SELL'} ${ago(now - last.e)} ago ✕ not confirmed (candles ${last.hs}%${last.ls != null ? ', live ' + last.ls + '%' : ''})`, '#94a3b8', 500]);
  if (r.nowS != null) {
    const agree = r.nowS >= c.minLive, side = r.dirNow > 0 ? 'GREEN' : 'RED';
    rows.push([`Now: FlowDesk tools ${r.nowS}% agree with ${side} → ${agree ? (r.dirNow > 0 ? 'BUY side holds' : 'SELL side holds') : 'WAIT / caution'}`, agree ? (r.dirNow > 0 ? '#86efac' : '#fca5a5') : '#fcd34d', 600]);
  }
  const b1 = r.btRaw, b2 = r.btFin;
  if (b1.n) rows.push([`Backtest ${TFNAME[c.tf]}: all flips ${Math.round(b1.win * 100)}% right (${b1.n}) · FINAL ${b2.n ? Math.round(b2.win * 100) + '% right (' + b2.n + ')' : '—'}`, '#c4b5fd', 500]);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let w = 0; for (const [t, , fw] of rows) { ctx.font = `${fw} 10.5px Inter,system-ui,sans-serif`; w = Math.max(w, ctx.measureText(t).width); }
  w += 18; const h = rows.length * 15 + 10, x = g.pw - w - 8, y = g.top + 36, col = dv > 0 ? c.up : c.dn;
  ctx.fillStyle = 'rgba(12,6,26,.92)'; ctx.strokeStyle = alpha(col, .9); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.roundRect(x, y, w, h, 7); ctx.fill(); ctx.stroke();
  rows.forEach(([t, cl, fw], i) => { ctx.font = `${fw} 10.5px Inter,system-ui,sans-serif`; ctx.fillStyle = cl; ctx.fillText(t, x + 9, y + 12 + i * 15); });
  Z._box = { x, y, w, h };
}

/* hover tooltip for a signal: every check */
Z.tip = function (ctx, g, mouse) {
  const r = Z._c, c = Z.cfg(); if (!c.on || !r || r.wait || !mouse || !g._pr) return;
  const B = Z._box, inBox = c.box && B && mouse.x >= B.x && mouse.x <= B.x + B.w && mouse.y >= B.y && mouse.y <= B.y + B.h;
  const i = OF.clamp(Math.floor(mouse.x / g.bw) + g.i0, g.i0, g.end - 1), s = inBox ? null : g._pr.at.get(i);
  if (inBox) {
    const rows = [[`Now: ${r.dirNow > 0 ? 'GREEN' : 'RED'} checked with live FlowDesk tools — ${r.nowS == null ? 'waiting for live data' : r.nowS + '% agree'}`, '#c4b5fd']].concat((r.nowL || []).map(x => [mark(x) + x.n + ' — ' + x.t, x.ok ? '#bbf7d0' : x.v === 0.5 ? '#cbd5e1' : '#94a3b8']));
    return box(ctx, g, rows, B.x + B.w - 470, B.y + B.h + 6);
  }
  if (!s) return;
  const rows = [[(s.dir > 0 ? 'BUY' : 'SELL') + ' · ' + (s.ok ? '✓ FINAL — FlowDesk data agrees' : '✕ only the indicator — FlowDesk data does not agree'), s.ok ? '#86efac' : '#fca5a5'],
    [`When it fired (candles, ${TFNAME[c.tf]}): ${s.hs}% · need ${c.minScore}%`, '#c4b5fd']].concat(s.hc.map(x => [(x.ok ? '✓ ' : '✕ ') + x.n + ' — ' + x.t, x.ok ? '#bbf7d0' : '#94a3b8']));
  if (s.lc) { rows.push([`Live FlowDesk tools when it fired: ${s.ls}% · need ${c.minLive}%`, '#c4b5fd']); s.lc.forEach(x => rows.push([mark(x) + x.n + ' — ' + x.t, x.ok ? '#bbf7d0' : x.v === 0.5 ? '#cbd5e1' : '#94a3b8'])); }
  else rows.push(['Live tools: not recorded (signal is older than this page session)', '#64748b']);
  box(ctx, g, rows, mouse.x + 14, mouse.y + 14, mouse);
};
function box(ctx, g, rows, x, y, mouse) {
  ctx.save(); ctx.font = '11px Inter,system-ui,sans-serif';
  const T = t => t.length > 74 ? t.slice(0, 72) + '…' : t;
  const w = Math.min(460, Math.max(...rows.map(x => ctx.measureText(T(x[0])).width)) + 18), h = rows.length * 15 + 10;
  if (x + w > g.pw) x = mouse ? mouse.x - w - 14 : g.pw - w - 8; x = Math.max(4, x); if (y + h > g.bottom) y = Math.max(g.top, g.bottom - h);
  ctx.fillStyle = 'rgba(12,6,26,.96)'; ctx.strokeStyle = '#a855f7'; ctx.beginPath(); ctx.roundRect(x, y, w, h, 7); ctx.fill(); ctx.stroke();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  rows.forEach(([t, col], j) => { ctx.fillStyle = col; ctx.fillText(T(t), x + 9, y + 6 + j * 15); });
  ctx.restore();
}

/* settings popover */
Z.panel = function (anchor) {
  let pop = document.getElementById('s12Pop'); if (pop) { pop.remove(); return; }
  const c = Z.cfg();
  pop = el('div', 'colspop htfpop s12pop'); pop.id = 's12Pop';
  const r = anchor.getBoundingClientRect(); pop.style.top = Math.max(8, Math.min(r.bottom + 8, window.innerHeight - 640)) + 'px'; pop.style.left = Math.max(8, Math.min(window.innerWidth - 470, r.left - 160)) + 'px';
  const opt = (list, v) => list.map(([a, b]) => `<option value="${a}"${String(a) === String(v) ? ' selected' : ''}>${b}</option>`).join('');
  const ck = (f, t) => `<label class="vrow"><input type="checkbox" data-g="${f}" ${c[f] ? 'checked' : ''}> ${t}</label>`;
  pop.innerHTML = `<div class="cph">S1+S2 · Session 1 &amp; Session 2 <button class="cpx">✕</button></div>
    <div class="htfline"><span>Timeframe</span><select data-g="tf" style="grid-column:span 3">${opt(TFOPT, c.tf)}</select></div>
    <div class="muted sm" style="margin:4px 0 2px">Fixed: the chart timeframe does not change the indicator. Signals appear when a ${TFOPT.find(x => x[0] === c.tf)[1]} candle closes (no repaint).</div>
    <div class="htfsec">Session 1 · Bg &amp; candle colour</div>
    ${ck('s1', 'Show Session 1')}${ck('bg', 'Background colour')}${ck('bar', 'Colour the candles')}${ck('sig', 'BUY / SELL labels')}${ck('diffPane', 'S1-Daily Close Diff pane')}
    <div class="htfsec">Session 2 · Weighted line</div>
    ${ck('s2', 'Show Session 2')}${ck('fill', 'Shade the entry zone')}
    <div class="htfline"><span>Threshold</span><input type="number" step="0.001" min="0" data-g="threshold" value="${c.threshold}"><span>Band offset</span><input type="number" step="0.0001" min="0" data-g="bandOffset" value="${c.bandOffset}"></div>
    <div class="htfline"><span>Smooth (SMA)</span><input type="number" min="1" max="200" data-g="smooth" value="${c.smooth}"><span></span><span></span></div>
    <div class="htfline"><span>Up colour</span><input type="color" data-g="up" value="${c.up}"><span>Down colour</span><input type="color" data-g="dn" value="${c.dn}"></div>
    <div class="htfsec">FINAL signal · FlowDesk tools</div>
    ${ck('confirm', 'Confirm every signal with FlowDesk data (FINAL ✓)')}${ck('hideWeak', 'Show only FINAL signals')}
    <div class="htfline"><span>Candle score needed %</span><input type="number" min="0" max="100" data-g="minScore" value="${c.minScore}"><span>Live score needed %</span><input type="number" min="0" max="100" data-g="minLive" value="${c.minLive}"></div>
    <div class="htfline"><span>Backtest hold (candles)</span><input type="number" min="1" max="100" data-g="hold" value="${c.hold}"><span></span><span></span></div>
    ${ck('box', 'Status box')}${ck('alerts', 'Pop-up alerts')}
    <div class="vbtns"><button data-a="reset">Reset to defaults</button></div>
    <div class="muted sm" style="margin-top:8px">Hover a BUY / SELL label to see every check. Raise the score needed if the backtest shows FINAL signals are not better than all flips.</div>`;
  const read = () => {
    const n = Z.cfg();
    pop.querySelectorAll('[data-g]').forEach(inp => { const f = inp.dataset.g; n[f] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Math.max(0, +inp.value || 0) : inp.value; });
    n.smooth = Math.max(1, Math.round(n.smooth)); n.hold = Math.max(1, Math.round(n.hold)); Z.save(n);
  };
  pop.querySelectorAll('input,select').forEach(i => { i.onchange = read; if (i.type === 'color' || i.type === 'number') i.oninput = read; });
  pop.querySelector('.cpx').onclick = () => pop.remove();
  pop.querySelector('[data-a=reset]').onclick = () => { const on = Z.cfg().on; Z.save(Object.assign({}, DEF, { on })); pop.remove(); Z.panel(anchor); };
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener('pointerdown', function f(e) { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('pointerdown', f); } }), 0);
};

// keep checking for new signals (and alerts) even when the chart tab is not open
setInterval(() => { try { if (OF.S && OF.S.info && Z.cfg().on) Z.calc(); } catch (e) { console.error(e); } }, 30000);
OF.on('info', () => { Z._c = null; OF.loadKlines('1d'); });
})();

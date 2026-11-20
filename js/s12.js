/* S1+S2 — "Combined Session 1 & Session 2" (Pine v2), ported to FlowDesk with order-flow confirmation.

   Same rules, lines and colours as the Pine script:
   • Session 1: closeDiff = (HTF close − previous HTF close) / previous HTF close. Green background + green candles
     when closeDiff > 0, red otherwise (bgcolor transp 85, barcolor). BUY label below the bar on crossover(closeDiff, 0),
     SELL label above the bar on crossunder(closeDiff, 0). Optional "S1-Daily Close Diff" debug pane.
   • Session 2: zeroValue = today − closeDiff·today, Weighted Line = sma(zeroValue, 10), Upper / Lower Entry Lines =
     ±0.15 %, shaded zone (transp 88), only drawn while |closeDiff| > (high − low)·0.02 or |closeDiff| > 0.004.
     Touch alerts when the close crosses an entry line.

   What is different (on purpose, to stop repainting):
   • Timeframe is a setting: 1 hour, 4 hours, 1 day, 1430 minutes, 1 week, 1 month (Pine default '1430').
     1430 minutes is built the way TradingView builds it on a 24 h crypto session: each UTC day has one
     00:00–23:50 candle (1430 min) and one short 23:50–24:00 candle, because bars restart at the session start.
     On "HTF candle close" timing the 00:00–23:50 candle is compared with the close before it (the previous day's
     00:00 close), which is the value the script shows on TradingView history — but known at 23:50, not in advance.
   • "HTF candle close" timing (default) uses ONLY closed higher-timeframe candles, so a signal never changes after
     it appears. "Chart candle close" timing reacts sooner (today = chart close, like the script in real time) and is
     final once the chart candle closes.
   • Every BUY / SELL is checked against FlowDesk data. From candles (known at signal time, never repaints):
     taker delta, volume vs normal, where the candle closed, chart CVD. From live order flow (for a fresh signal,
     frozen the first time it is seen): multi-timeframe direction, order-book imbalance, whale net, futures CVD,
     liquidations. ✓ = confirmed, ✕ = not confirmed (drawn faded, or hidden if you choose). */
(function () {
'use strict';
const OF = window.OF, LS = OF.LS, el = OF.el;
const Z = OF.s12 = {};

const TFOPT = [['60', '1 hour'], ['240', '4 hours'], ['D', '1 day'], ['1430', '1430 minutes'], ['W', '1 week'], ['M', '1 month']];
const TFNAME = { '60': '1h', '240': '4h', 'D': '1D', '1430': '1430m', 'W': '1W', 'M': '1M' };
const DEF = {
  on: true, tf: '1430', timing: 'htf',
  s1: true, bg: true, bar: true, sig: true, diffPane: false,
  s2: true, threshold: 0.004, bandOffset: 0.0015, smooth: 10, fill: true,
  up: '#008000', dn: '#FF0000',                       // Pine v2 `green` / `red`
  confirm: true, hideWeak: false, minHist: 3, box: true, alerts: true
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

function htfBars(S, tf, chartK) {
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
  const from = Math.max(chartK && chartK.length ? Math.floor(chartK[0].t / DAY) * DAY - 15 * DAY : 0, Math.floor(OF.now() / DAY) * DAY - 118 * DAY);   // last ~4 months
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

/* ---------- order-flow checks ---------- */
function histChecks(dir, ev, prevAvg, cvd) {
  const out = [];
  const dl = ev.qv ? (2 * ev.bqv - ev.qv) / ev.qv : 0;
  out.push({ n: 'Taker delta', ok: dl * dir > 0.02, t: (dir > 0 ? 'buyers ' : 'sellers ') + Math.round((0.5 + dir * dl / 2) * 100) + '% of volume' });
  const vr = prevAvg ? ev.qv / prevAvg : 1;
  out.push({ n: 'Volume', ok: vr >= 0.8, t: vr.toFixed(2) + '× normal' });
  const loc = ev.h > ev.l ? (ev.c - ev.l) / (ev.h - ev.l) : 0.5, ld = dir > 0 ? loc : 1 - loc;
  out.push({ n: 'Close location', ok: ld >= 0.5, t: 'closed ' + Math.round(loc * 100) + '% up the range' });
  out.push({ n: 'Chart CVD (5 bars)', ok: cvd * dir > 0, t: OF.fmtUsd(cvd, true) });
  return out;
}
function liveChecks(dir) {
  const S = OF.S, out = [], m = OF.meters(), mt = OF.mtf();
  const get = k => m && m.list.find(x => x.key === k);
  if (mt && mt.overall != null) out.push({ n: 'Direction bar', ok: mt.overall * dir > 10, t: (mt.overall > 0 ? '+' : '') + mt.overall });
  const imb = get('imb'); if (imb && imb.score != null) out.push({ n: 'Order book', ok: imb.score * dir > 0, t: imb.text });
  const wh = get('whale'); if (wh && wh.score != null) out.push({ n: 'Whales (1 h)', ok: wh.score * dir > 0, t: wh.text });
  const fc = get('fcvd15'); if (fc && fc.score != null) out.push({ n: 'Futures CVD', ok: fc.score * dir > 0, t: fc.text });
  const lq = get('liq'); if (lq && lq.score != null && lq.score !== 0) out.push({ n: 'Liquidations', ok: lq.score * dir > 0, t: lq.text });
  const cv = get('cvd5'); if (cv && cv.score != null) out.push({ n: 'Spot CVD (5 min)', ok: cv.score * dir > 0, t: cv.text });
  return S && S.status === 'LIVE' || OF.demo ? out : [];
}

/* ---------- the indicator on the chart's own candles ---------- */
Z.calc = function (k, ms) {
  const S = OF.S; if (!S || !S.info || !k || !k.length) return null;
  const c = Z.cfg(), now = OF.now(), lastK = k[k.length - 1];
  const key = [S.symbol, ms, k.length, k[0].t, lastK.t, c.timing === 'chart' ? lastK.c : 0, JSON.stringify(c)].join('|');
  if (Z._c && Z._c.key === key && Date.now() - Z._c.at < 3000) return Z._c;
  const H = htfBars(S, c.tf, k); if (!H || H.length < 3) return { wait: true, c };
  const n = k.length, d = new Array(n).fill(null), today = new Array(n).fill(null), src = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const Tc = Math.min(k[i].t + ms, now);
    if (c.timing === 'chart') {
      const j = lastClosed(H, Tc, true); if (j < 0) continue;
      const y = H[j].c; today[i] = k[i].c; d[i] = (k[i].c - y) / y; src[i] = j + 1;     // forming HTF candle j+1
    } else {
      let j = lastClosed(H, Tc, false);
      if (j >= 0 && H[j].part === 'B') j--;            // 1430: compare the 00:00–23:50 candle with the close before it
      if (j < 1) continue;
      const y = H[j - 1].c; today[i] = H[j].c; d[i] = (H[j].c - y) / y; src[i] = j;
    }
  }
  // Session 2 lines
  const zero = today.map((t, i) => t == null ? null : t - d[i] * t), sm = new Array(n).fill(null), sig = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (i < c.smooth - 1) continue; let s = 0, ok = true;
    for (let j = i - c.smooth + 1; j <= i; j++) { if (zero[j] == null) { ok = false; break; } s += zero[j]; }
    if (!ok) continue; sm[i] = s / c.smooth;
    sig[i] = Math.abs(d[i]) > (k[i].h - k[i].l) * 0.02 || Math.abs(d[i]) > c.threshold;
  }
  // Session 1 signals + confirmation
  const sigs = [], frozen = LS.get('s12live', {});
  let dirty = false;
  for (let i = 1; i < n; i++) {
    if (d[i] == null || d[i - 1] == null) continue;
    const dir = d[i] > 0 && d[i - 1] <= 0 ? 1 : d[i] < 0 && d[i - 1] >= 0 ? -1 : 0;
    if (!dir) continue;
    const forming = c.timing === 'chart' && i === n - 1 && k[i].t + ms > now;
    let ev, prevAvg = 0;
    if (c.timing === 'chart') {                       // evidence: chart candles of the forming HTF candle so far
      const hs = H[src[i]] ? H[src[i]].s : (H[H.length - 1].e);
      let o = null, h = -Infinity, l = Infinity, qv = 0, bqv = 0, m = 0, a = 0, b = 0;
      for (let j = i; j >= 0 && k[j].t >= hs; j--) { o = k[j].o; h = Math.max(h, k[j].h); l = Math.min(l, k[j].l); qv += k[j].qv; bqv += k[j].bqv; m++; }
      if (!m) { o = k[i].o; h = k[i].h; l = k[i].l; qv = k[i].qv; bqv = k[i].bqv; m = 1; }
      for (let j = Math.max(0, i - m - 20); j < i - m + 1 && j >= 0; j++) { a += k[j].qv; b++; }
      ev = { o, h, l, c: k[i].c, qv: qv / m, bqv: bqv / m }; prevAvg = b ? a / b : 0;
    } else {
      const j = src[i], hb = H[j]; ev = hb; let a = 0, b = 0;
      for (let q = Math.max(0, j - 20); q < j; q++) if (H[q].part === hb.part || !hb.part) { a += H[q].qv; b++; }
      prevAvg = b ? a / b : 0;
      if (hb.part === 'B') prevAvg = ev.qv;            // the 10-minute candle uses its day's volume
    }
    let cvd = 0; for (let j = Math.max(0, i - 4); j <= i; j++) cvd += 2 * k[j].bqv - k[j].qv;
    const hc = histChecks(dir, ev, prevAvg, cvd), hp = hc.filter(x => x.ok).length;
    // live order flow: only for a signal that is happening now; frozen when first seen so it never repaints
    const fk = S.symbol + '|' + c.tf + '|' + c.timing + '|' + k[i].t + '|' + dir;
    let lc = frozen[fk] || null;
    const fresh = now - k[i].t < Math.max(ms * 2, 36e5);
    if (!lc && fresh && !forming) { const L = liveChecks(dir); if (L.length) { lc = L; frozen[fk] = L; dirty = true; } }
    const lp = lc ? lc.filter(x => x.ok).length : 0;
    const ok = hp >= c.minHist && (!lc || lp >= Math.ceil(lc.length / 2));
    sigs.push({ i, t: k[i].t, dir, hc, hp, lc, lp, ok, forming, d: d[i] });
  }
  if (dirty) { const ks = Object.keys(frozen); if (ks.length > 300) ks.slice(0, ks.length - 300).forEach(x => delete frozen[x]); LS.set('s12live', frozen); }
  const r = { key, at: Date.now(), c, d, sm, sig, sigs, H, n };
  Z._c = r; Z.alerts(r, k, ms);
  return r;
};

/* alertcondition(): BUY / SELL and Session-2 entry-line touches, once per closed chart candle */
Z.alerts = function (r, k, ms) {
  const c = r.c; if (!c.alerts || !k.length) return;
  const now = OF.now(); let i = k.length - 1; if (k[i].t + ms > now) i--;   // last CLOSED chart candle
  if (i < 1) return;
  const sk = 's12seen:' + OF.S.symbol + ':' + c.tf + ':' + ms, seen = LS.get(sk, 0);
  if (!seen) { LS.set(sk, k[i].t); return; }
  if (k[i].t <= seen) return;
  LS.set(sk, k[i].t);
  const s = r.sigs.find(x => x.i === i);
  if (s && (!c.hideWeak || s.ok)) OF.notify(s.dir > 0 ? 'S1-Buy Alert' : 'S1-Sell Alert', (s.dir > 0 ? 'Background GREEN -> BUY' : 'Background RED -> SELL') + ' · ' + (s.ok ? '✓ confirmed by order flow' : '✕ not confirmed by order flow') + ` (${s.hp}/4 candle${s.lc ? `, ${s.lp}/${s.lc.length} live` : ''})`);
  if (r.sig[i] && r.sm[i] != null && r.sm[i - 1] != null) {
    const ub = x => r.sm[x] * (1 + c.bandOffset), lb = x => r.sm[x] * (1 - c.bandOffset);
    const cross = (a, b) => (k[i].c - a) * (k[i - 1].c - b) <= 0 && k[i].c !== k[i - 1].c;
    if (cross(ub(i), ub(i - 1))) OF.notify('S2-Price touched Upper Entry Line', 'Price touched Upper Entry Line – check for entry (' + OF.fp(ub(i)) + ')');
    if (cross(lb(i), lb(i - 1))) OF.notify('S2-Price touched Lower Entry Line', 'Price touched Lower Entry Line – check for entry (' + OF.fp(lb(i)) + ')');
  }
};

/* background (Session 1) — drawn before the candles */
Z.drawBg = function (ctx, g) {
  const c = Z.cfg(); if (!c.on || !c.s1 || !c.bg) return;
  const r = Z.calc(g.k, g.ms); if (!r || r.wait) return;
  for (let i = g.i0; i < g.end; i++) {
    if (r.d[i] == null) continue;
    ctx.fillStyle = alpha(r.d[i] > 0 ? c.up : c.dn, 0.15);
    ctx.fillRect(Math.floor(g.X(i) - g.bw / 2), g.top, Math.ceil(g.bw) + 1, g.bottom - g.top);
  }
};
/* barcolor + Session 2 lines + signals + status — drawn after the candles */
Z.draw = function (ctx, g) {
  const c = Z.cfg(); if (!c.on) return;
  const r = Z.calc(g.k, g.ms), k = g.k;
  ctx.save();
  if (!r || r.wait) {
    ctx.font = '600 11px Inter,system-ui,sans-serif'; ctx.fillStyle = '#c4b5fd'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillText('S1+S2 · loading ' + TFOPT.find(x => x[0] === c.tf)[1] + ' candles…', g.pw - 10, g.top + 40); ctx.restore(); return;
  }
  // barcolor: body, border and wick in the state colour
  if (c.s1 && c.bar) for (let i = g.i0; i < g.end; i++) {
    if (r.d[i] == null) continue;
    const b = k[i], x = g.X(i), col = r.d[i] > 0 ? c.up : c.dn, w = g.bw * 0.7;
    ctx.strokeStyle = ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, g.Y(b.h)); ctx.lineTo(Math.round(x) + .5, g.Y(b.l)); ctx.stroke();
    const y1 = g.Y(Math.max(b.o, b.c)), y2 = g.Y(Math.min(b.o, b.c));
    ctx.fillRect(Math.round(x - w / 2), y1, Math.max(1, Math.round(w)), Math.max(1, y2 - y1));
  }
  // Session 2: weighted line, dashed entry lines, shaded zone — only where the move is significant
  if (c.s2) {
    const on = i => r.sig[i] && r.sm[i] != null;
    if (c.fill) for (let i = Math.max(g.i0, 1); i < g.end; i++) {
      if (!on(i) || !on(i - 1)) continue;
      const a = i - 1, col = r.d[i] > 0 ? c.up : c.dn;
      ctx.fillStyle = alpha(col, 0.12); ctx.beginPath();
      ctx.moveTo(g.X(a), g.Y(r.sm[a] * (1 + c.bandOffset))); ctx.lineTo(g.X(i), g.Y(r.sm[i] * (1 + c.bandOffset)));
      ctx.lineTo(g.X(i), g.Y(r.sm[i] * (1 - c.bandOffset))); ctx.lineTo(g.X(a), g.Y(r.sm[a] * (1 - c.bandOffset))); ctx.closePath(); ctx.fill();
    }
    const seg = (mult, width, dash, a) => {
      ctx.lineWidth = width; ctx.setLineDash(dash);
      for (let i = Math.max(g.i0, 1); i < g.end; i++) {
        if (!on(i) || !on(i - 1)) continue;
        ctx.strokeStyle = alpha(r.d[i] > 0 ? c.up : c.dn, a);
        ctx.beginPath(); ctx.moveTo(g.X(i - 1), g.Y(r.sm[i - 1] * mult)); ctx.lineTo(g.X(i), g.Y(r.sm[i] * mult)); ctx.stroke();
      }
      // a single significant bar still shows as a short tick (Pine draws a point)
      for (let i = g.i0; i < g.end; i++) if (on(i) && !(i > 0 && on(i - 1)) && !(i + 1 < g.end && on(i + 1))) {
        ctx.strokeStyle = alpha(r.d[i] > 0 ? c.up : c.dn, a); ctx.beginPath(); ctx.moveTo(g.X(i) - g.bw * 0.4, g.Y(r.sm[i] * mult)); ctx.lineTo(g.X(i) + g.bw * 0.4, g.Y(r.sm[i] * mult)); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineWidth = 1;
    };
    seg(1 + c.bandOffset, 1, [5, 4], 0.7); seg(1 - c.bandOffset, 1, [5, 4], 0.7); seg(1, 2, [], 1);
  }
  // Session 1 signals: BUY label below the bar, SELL label above, ✓ / ✕ order-flow confirmation
  if (c.s1 && c.sig) {
    ctx.font = '700 10px Inter,system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const s of r.sigs) {
      if (s.i < g.i0 || s.i >= g.end) continue;
      if (c.confirm && c.hideWeak && !s.ok) continue;
      const b = k[s.i], x = g.X(s.i), col = s.dir > 0 ? c.up : c.dn, txt = s.dir > 0 ? 'BUY' : 'SELL';
      const w = ctx.measureText(txt).width + 12, h = 16;
      const y = s.dir > 0 ? g.Y(b.l) + 6 : g.Y(b.h) - 6 - h - 5;
      ctx.globalAlpha = c.confirm && !s.ok ? 0.45 : 1;
      ctx.fillStyle = col; ctx.beginPath();
      if (s.dir > 0) { ctx.moveTo(x, y); ctx.lineTo(x - 5, y + 5); ctx.lineTo(x + 5, y + 5); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.roundRect(x - w / 2, y + 5, w, h, 3); }
      else { ctx.moveTo(x, y + h + 5); ctx.lineTo(x - 5, y + h); ctx.lineTo(x + 5, y + h); ctx.closePath(); ctx.fill(); ctx.beginPath(); ctx.roundRect(x - w / 2, y, w, h, 3); }
      ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText(txt, x, (s.dir > 0 ? y + 5 : y) + h / 2 + .5);
      if (c.confirm) {
        const by = s.dir > 0 ? y + 5 + h + 8 : y - 8;
        ctx.beginPath(); ctx.arc(x, by, 6.5, 0, 7); ctx.fillStyle = s.forming ? '#64748b' : s.ok ? '#16a34a' : '#475569'; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '700 9px Inter,system-ui,sans-serif'; ctx.fillText(s.forming ? '…' : s.ok ? '✓' : '✕', x, by + .5);
        ctx.font = '700 10px Inter,system-ui,sans-serif';
      }
      ctx.globalAlpha = 1;
    }
  }
  // S1-Daily Close Diff debug pane (bottom of the price pane)
  if (c.s1 && c.diffPane) {
    const ph = 46, top = g.bottom - ph, mid = top + ph / 2; let mx = 0;
    for (let i = g.i0; i < g.end; i++) if (r.d[i] != null) mx = Math.max(mx, Math.abs(r.d[i]));
    ctx.fillStyle = 'rgba(10,6,22,.75)'; ctx.fillRect(0, top, g.pw, ph);
    ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(g.pw, mid); ctx.stroke();
    ctx.lineWidth = 2;
    for (let i = Math.max(g.i0, 1); i < g.end; i++) {
      if (r.d[i] == null || r.d[i - 1] == null || !mx) continue;
      ctx.strokeStyle = r.d[i] > 0 ? c.up : c.dn; ctx.beginPath();
      ctx.moveTo(g.X(i - 1), mid - r.d[i - 1] / mx * (ph / 2 - 4)); ctx.lineTo(g.X(i), mid - r.d[i] / mx * (ph / 2 - 4)); ctx.stroke();
    }
    ctx.lineWidth = 1; ctx.fillStyle = '#cbd5e1'; ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('S1-Daily Close Diff ' + (r.d[g.end - 1] != null ? (r.d[g.end - 1] * 100).toFixed(3) + '%' : ''), 6, top + 3);
  }
  // status box under the HTF S/R box
  if (c.box) {
    const L = g.end - 1, dv = r.d[L], last = r.sigs[r.sigs.length - 1];
    const l1 = `S1+S2 · ${TFNAME[c.tf]} · ${dv == null ? '—' : (dv > 0 ? 'GREEN ' : 'RED ') + (dv >= 0 ? '+' : '') + (dv * 100).toFixed(2) + '%'}${c.timing === 'htf' ? ' · on HTF close' : ' · on chart close'}`;
    const l2 = last ? `last ${last.dir > 0 ? 'BUY' : 'SELL'} ${ago(OF.now() - last.t)} ago · ${last.forming ? 'forming…' : last.ok ? '✓ confirmed' : '✕ not confirmed'} · candles ${last.hp}/4${last.lc ? ` · live flow ${last.lp}/${last.lc.length}` : ''}` : 'no signal on loaded candles';
    ctx.font = '700 11px Inter,system-ui,sans-serif'; const w1 = ctx.measureText(l1).width; ctx.font = '500 10.5px Inter,system-ui,sans-serif'; const w2 = ctx.measureText(l2).width;
    const w = Math.max(w1, w2) + 18, x = g.pw - w - 8, y = g.top + 36, col = dv == null ? '#64748b' : dv > 0 ? c.up : c.dn;
    ctx.fillStyle = 'rgba(12,6,26,.9)'; ctx.strokeStyle = alpha(col, .9); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.roundRect(x, y, w, 38, 7); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff'; ctx.font = '700 11px Inter,system-ui,sans-serif'; ctx.fillText(l1, x + 9, y + 12);
    ctx.fillStyle = last && last.ok ? '#86efac' : '#cbd5e1'; ctx.font = '500 10.5px Inter,system-ui,sans-serif'; ctx.fillText(l2, x + 9, y + 27);
    Z._box = { x, y, w, h: 38, last };
  }
  ctx.restore();
};
const ago = ms => ms < 36e5 ? Math.max(1, Math.round(ms / 6e4)) + 'm' : ms < 2 * DAY ? Math.round(ms / 36e5) + 'h' : Math.round(ms / DAY) + 'd';

/* hover tooltip for a signal: which checks passed */
Z.tip = function (ctx, g, mouse) {
  const r = Z._c, c = Z.cfg(); if (!c.on || !c.confirm || !r || r.wait || !mouse) return;
  const i = OF.clamp(Math.floor(mouse.x / g.bw) + g.i0, g.i0, g.end - 1), s = r.sigs.find(x => x.i === i); if (!s) return;
  const rows = [[(s.dir > 0 ? 'BUY' : 'SELL') + ' · ' + (s.forming ? 'candle still forming' : s.ok ? '✓ confirmed by order flow' : '✕ not confirmed'), s.ok ? '#86efac' : '#fca5a5'],
    ['Candles at signal time ' + s.hp + '/4 (need ' + c.minHist + ')', '#c4b5fd']].concat(s.hc.map(x => [(x.ok ? '✓ ' : '✕ ') + x.n + ' — ' + x.t, x.ok ? '#bbf7d0' : '#94a3b8']));
  if (s.lc) { rows.push(['Live order flow when it fired ' + s.lp + '/' + s.lc.length, '#c4b5fd']); s.lc.forEach(x => rows.push([(x.ok ? '✓ ' : '✕ ') + x.n + ' — ' + x.t, x.ok ? '#bbf7d0' : '#94a3b8'])); }
  else rows.push(['Live order flow: not recorded (older signal)', '#64748b']);
  ctx.save(); ctx.font = '11px Inter,system-ui,sans-serif';
  const w = Math.min(420, Math.max(...rows.map(x => ctx.measureText(x[0]).width)) + 18), h = rows.length * 15 + 10;
  let x = mouse.x + 14, y = mouse.y + 14; if (x + w > g.pw) x = mouse.x - w - 14; if (y + h > g.bottom) y = Math.max(g.top, mouse.y - h - 14);
  ctx.fillStyle = 'rgba(12,6,26,.96)'; ctx.strokeStyle = '#a855f7'; ctx.beginPath(); ctx.roundRect(x, y, w, h, 7); ctx.fill(); ctx.stroke();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  rows.forEach(([t, col], j) => { ctx.fillStyle = col; ctx.fillText(t.length > 70 ? t.slice(0, 68) + '…' : t, x + 9, y + 6 + j * 15); });
  ctx.restore();
};

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
    <div class="htfline"><span>Signal on</span><select data-g="timing" style="grid-column:span 3">${opt([['htf', 'Higher-timeframe candle close (no repaint)'], ['chart', 'Chart candle close (faster)']], c.timing)}</select></div>
    <div class="htfsec">Session 1 · Bg &amp; candle colour</div>
    ${ck('s1', 'Show Session 1')}${ck('bg', 'Background colour')}${ck('bar', 'Colour the candles')}${ck('sig', 'BUY / SELL labels')}${ck('diffPane', 'S1-Daily Close Diff pane')}
    <div class="htfsec">Session 2 · Weighted line</div>
    ${ck('s2', 'Show Session 2')}${ck('fill', 'Shade the entry zone')}
    <div class="htfline"><span>Threshold</span><input type="number" step="0.001" min="0" data-g="threshold" value="${c.threshold}"><span>Band offset</span><input type="number" step="0.0001" min="0" data-g="bandOffset" value="${c.bandOffset}"></div>
    <div class="htfline"><span>Smooth (SMA)</span><input type="number" min="1" max="200" data-g="smooth" value="${c.smooth}"><span></span><span></span></div>
    <div class="htfline"><span>Up colour</span><input type="color" data-g="up" value="${c.up}"><span>Down colour</span><input type="color" data-g="dn" value="${c.dn}"></div>
    <div class="htfsec">FlowDesk confirmation</div>
    ${ck('confirm', 'Check each signal with order-flow data (✓ / ✕)')}${ck('hideWeak', 'Hide signals that are not confirmed')}
    <div class="htfline"><span>Candle checks needed</span><select data-g="minHist">${opt([[2, '2 of 4'], [3, '3 of 4'], [4, '4 of 4']], c.minHist)}</select><span></span><span></span></div>
    ${ck('box', 'Status box')}${ck('alerts', 'Pop-up alerts (BUY / SELL, entry-line touches)')}
    <div class="vbtns"><button data-a="reset">Reset to defaults</button></div>
    <div class="muted sm" style="margin-top:8px">Hover a BUY / SELL label to see which checks passed. Live order-flow checks are saved the moment a signal appears, so they never change later.</div>`;
  const read = () => {
    const n = Z.cfg();
    pop.querySelectorAll('[data-g]').forEach(inp => { const f = inp.dataset.g; n[f] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Math.max(0, +inp.value || 0) : (f === 'minHist' ? +inp.value : inp.value); });
    n.smooth = Math.max(1, Math.round(n.smooth)); Z.save(n);
  };
  pop.querySelectorAll('input,select').forEach(i => { i.onchange = read; if (i.type === 'color' || i.type === 'number') i.oninput = read; });
  pop.querySelector('.cpx').onclick = () => pop.remove();
  pop.querySelector('[data-a=reset]').onclick = () => { const on = Z.cfg().on; Z.save(Object.assign({}, DEF, { on })); pop.remove(); Z.panel(anchor); };
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener('pointerdown', function f(e) { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('pointerdown', f); } }), 0);
};

OF.on('info', () => { Z._c = null; OF.loadKlines('1d'); });
})();

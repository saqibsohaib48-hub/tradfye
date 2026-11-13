/* FlowDesk metrics — derived readings: walls, whales, volume profile, VWAP, gamma, liquidation map,
   sentiment meters and the decision panel. Everything here is computed from OF.S. */
(function () {
'use strict';
const OF = window.OF;

/* Current book grouped into price bins within ±pct % of mid. */
OF.bookBins = function (pct, bin) {
  const S = OF.S, mid = OF.mid(); bin = bin || S.bin || 1;
  const lo = mid * (1 - pct / 100), hi = mid * (1 + pct / 100), b = new Map(), a = new Map();
  for (const [p, q] of S.bids) if (p >= lo) { const k = Math.floor(p / bin) * bin; b.set(k, (b.get(k) || 0) + p * q); }
  for (const [p, q] of S.asks) if (p <= hi) { const k = Math.floor(p / bin) * bin; a.set(k, (a.get(k) || 0) + p * q); }
  return { b, a, mid, bin };
};

/* Nearest significant wall on each side and how long it has been standing. */
/* Same bins with the other venues' books added. v = how many venues hold a real share (≥ 15 %) of each bin. */
OF.bookBinsAll = function (pct, bin) {
  const S = OF.S, base = OF.bookBins(pct, bin), mid = base.mid, lo = mid * (1 - pct / 100), hi = mid * (1 + pct / 100);
  const per = new Map(), note = (k, i, n) => { let a = per.get(k); if (!a) per.set(k, a = [0, 0, 0]); a[i] += n; };
  for (const [p, n] of base.b) note('b' + p, 0, n); for (const [p, n] of base.a) note('a' + p, 0, n);
  let idx = 0, venues = 1;
  for (const name of ['bybit', 'okx']) {
    idx++; const bk = S.xbook && S.xbook[name]; if (!bk || Date.now() - bk.at > 20000) continue; venues++;
    for (const [p, q] of bk.bids) if (p >= lo && p < mid) { const k = Math.floor(p / base.bin) * base.bin; base.b.set(k, (base.b.get(k) || 0) + p * q); note('b' + k, idx, p * q); }
    for (const [p, q] of bk.asks) if (p <= hi && p > mid) { const k = Math.floor(p / base.bin) * base.bin; base.a.set(k, (base.a.get(k) || 0) + p * q); note('a' + k, idx, p * q); }
  }
  base.venues = venues;
  base.nv = (side, p) => { const a = per.get((side === 'bid' ? 'b' : 'a') + p); if (!a) return 1; const t = a[0] + a[1] + a[2]; return a.filter(x => x >= t * 0.15).length; };
  return base;
};
/* Perpetual-futures trade flow (Bybit) since a time. */
OF.fflow = function (from) {
  const f = OF.S.futFlow; let b = 0, s = 0;
  for (let i = f.length - 1; i >= 0 && f[i].t >= from; i--) { if (f[i].buy) b += f[i].n; else s += f[i].n; }
  return { b, s, tot: b + s, d: b - s };
};

OF.walls = function (pct) {
  const S = OF.S; if (!S || !S.synced || !S.bin) return null;
  const { b, a, mid, bin } = OF.bookBins(pct || 0.25, S.bin);
  const pick = m => { let best = null; for (const [p, n] of m) if (!best || n > best.n) best = { p, n }; return best; };
  const res = { bid: pick(b), ask: pick(a), mid };
  for (const side of ['bid', 'ask']) {
    const w = res[side]; if (!w) continue;
    w.bp = Math.abs(w.p - mid) / mid * 1e4;
    // standing time: walk back through columns while the bin kept ≥ 50 % of today's size
    let since = OF.now();
    for (let i = S.cols.length - 1; i >= 0; i--) {
      const c = S.cols[i], idx = Math.floor(w.p / bin) - c.b0;
      if (idx < 0 || idx >= c.arr.length || c.arr[idx] < w.n * 0.5) break;
      since = c.t;
    }
    w.standSec = (OF.now() - since) / 1000;
    let pulls = 0; const t0 = OF.now() - 300000;
    for (let i = S.events.length - 1; i >= 0 && S.events[i].t > t0; i--) {
      const e = S.events[i]; if (e.type === 'pull' && e.side === side && Math.abs(e.p - w.p) <= bin * 3) pulls++;
    }
    w.pulls = pulls;
  }
  return res;
};

/* ---------- whales ---------- */
/* mode: big (single print), sweep (one taker order across several prices), aggressive (1-second burst), level (large resting add) */
OF.whaleList = function (mode, thr, from) {
  const S = OF.S, out = [];
  if (mode === 'level') {
    for (const e of S.events) if (e.type === 'add' && e.n >= thr && e.t >= from) out.push({ t: e.t, p: e.p, n: e.n, buy: e.side === 'bid' });
    return out;
  }
  const tr = S.trades, i0 = OF.lb(tr, from);
  if (mode === 'big') {
    // whales saved before the last refresh come first, then the live ones
    const t0 = tr.length ? tr[0].t : Infinity; for (const w of S.recW || []) if (w[0] < t0 && w[0] >= from && w[2] >= thr) out.push({ t: w[0], p: w[1], n: w[2], buy: !!w[3], q: w[2] / w[1] });
    for (let i = i0; i < tr.length; i++) if (tr[i].n >= thr) out.push(tr[i]); return out;
  }
  const win = mode === 'sweep' ? 0 : 1000;
  let g = null;
  const flush = () => { if (g && g.n >= thr && (mode !== 'sweep' || g.px.size > 1)) out.push({ t: g.t, p: g.pq / g.n, n: g.n, buy: g.buy }); };
  for (let i = i0; i < tr.length; i++) {
    const x = tr[i];
    const same = g && g.buy === x.buy && (win ? x.t - g.t < win : x.t === g.t);
    if (!same) { flush(); g = { t: x.t, n: 0, pq: 0, buy: x.buy, px: new Set() }; }
    g.n += x.n; g.pq += x.n * x.p; g.px.add(x.p);
  }
  flush();
  return out;
};

/* ---------- session: VWAP + volume profile ---------- */
function profileFrom(candles, bin) {
  const m = new Map(); let tot = 0;
  for (const c of candles) {
    const lo = Math.floor(c.l / bin), hi = Math.floor(c.h / bin), k = hi - lo + 1;
    const buy = c.bqv != null ? c.bqv : c.qv / 2;
    for (let j = lo; j <= hi; j++) {
      const r = m.get(j) || { b: 0, s: 0 }; r.b += buy / k; r.s += (c.qv - buy) / k; m.set(j, r);
    }
    tot += c.qv;
  }
  const rows = [...m.entries()].map(([j, r]) => ({ p: j * bin, b: r.b, s: r.s, v: r.b + r.s })).sort((a, b) => a.p - b.p);
  if (!rows.length) return null;
  let poc = rows[0]; for (const r of rows) if (r.v > poc.v) poc = r;
  // value area: expand from POC until 70 % of volume
  let i = rows.indexOf(poc), lo = i, hi = i, acc = poc.v;
  while (acc < tot * 0.7 && (lo > 0 || hi < rows.length - 1)) {
    const up = hi < rows.length - 1 ? rows[hi + 1].v : -1, dn = lo > 0 ? rows[lo - 1].v : -1;
    if (up >= dn) acc += rows[++hi].v; else acc += rows[--lo].v;
  }
  return { rows, bin, poc: poc.p + bin / 2, vah: rows[hi].p + bin, val: rows[lo].p, tot };
}
OF.profileFrom = profileFrom;
OF.session = function () {
  const S = OF.S; if (!S || !S.day) return null;
  if (S._sess && Date.now() - S._sess.at < 5000) return S._sess;
  // keep today's 1m candles current with live trades
  const k1 = S.k['1m'];
  let today = S.day.today;
  if (k1 && k1.length) {
    const lastT = today.length ? today[today.length - 1].t : S.day.start - 1;
    today = today.concat(k1.filter(c => c.t > lastT && c.t >= S.day.start));
  }
  const all = today.length ? today : S.day.prev.slice(-60);
  let lo = Infinity, hi = -Infinity; for (const c of all) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
  const bin = Math.max(S.info.tick, OF.niceStep((hi - lo) / 120));
  let pv = 0, v = 0, pv2 = 0;
  for (const c of today) { const tp = (c.h + c.l + c.c) / 3; pv += tp * c.qv; v += c.qv; pv2 += tp * tp * c.qv; }
  const vwap = v ? pv / v : null, sd = v ? Math.sqrt(Math.max(0, pv2 / v - vwap * vwap)) : 0;
  const pbin = (() => { let l = Infinity, h = -Infinity; for (const c of S.day.prev) { l = Math.min(l, c.l); h = Math.max(h, c.h); } return Math.max(S.info.tick, OF.niceStep((h - l) / 120)); })();
  S._sess = { at: Date.now(), today: profileFrom(today, bin), prev: profileFrom(S.day.prev, pbin), vwap, sd, prevClose: S.day.prev.length ? S.day.prev[S.day.prev.length - 1].c : null, todayCandles: today };
  return S._sess;
};

/* ---------- gamma exposure from Deribit options ---------- */
function ncdfPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
function bsGamma(S, K, T, iv) { if (T <= 0 || iv <= 0) return 0; const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / (iv * Math.sqrt(T)); return ncdfPdf(d1) / (S * iv * Math.sqrt(T)); }
OF.gammaCalc = function (filter) {
  const S = OF.S, G = S.gamma; if (!G || !G.opts || !G.opts.length) return null;
  const now = Date.now(), maxT = filter.days ? filter.days * 864e5 : Infinity;
  const opts = G.opts.filter(o => o.exp > now && o.exp - now <= maxT && (!filter.expiry || o.expCode === filter.expiry));
  if (!opts.length) return null;
  const spot = OF.mid() || opts[0].und;
  const gexAt = (px) => {
    let tot = 0; const byK = new Map();
    for (const o of opts) {
      const T = (o.exp - now) / (365 * 864e5);
      const g = bsGamma(px, o.K, T, o.iv) * o.oi * px * px * 0.01 * (o.call ? 1 : -1);
      tot += g;
      if (byK) { const r = byK.get(o.K) || { c: 0, p: 0 }; if (o.call) r.c += g; else r.p += g; byK.set(o.K, r); }
    }
    return { tot, byK };
  };
  const base = gexAt(spot);
  const strikes = [...base.byK.entries()].map(([K, r]) => ({ K, c: r.c, p: r.p })).sort((a, b) => a.K - b.K);
  let callWall = null, putWall = null;
  for (const s of strikes) { if (!callWall || s.c > callWall.c) callWall = s; if (!putWall || s.p < putWall.p) putWall = s; }
  // zero-gamma flip: scan ±15 % for the sign change nearest to spot
  let flip = null, prev = null;
  const curve = [];
  for (let i = -60; i <= 60; i++) {
    const px = spot * (1 + i * 0.0025), v = gexAt(px).tot; curve.push({ px, v });
    if (prev && Math.sign(prev.v) !== Math.sign(v)) {
      const x = prev.px + (px - prev.px) * (0 - prev.v) / (v - prev.v);
      if (!flip || Math.abs(x - spot) < Math.abs(flip - spot)) flip = x;
    }
    prev = { px, v };
  }
  // max pain for the nearest expiry in the filter
  const nearest = opts.reduce((m, o) => o.exp < m ? o.exp : m, Infinity);
  const near = opts.filter(o => o.exp === nearest), ks = [...new Set(near.map(o => o.K))].sort((a, b) => a - b);
  let maxPain = null, best = Infinity;
  for (const X of ks) { let pay = 0; for (const o of near) pay += o.oi * (o.call ? Math.max(0, X - o.K) : Math.max(0, o.K - X)); if (pay < best) { best = pay; maxPain = X; } }
  let coi = 0, poi = 0; for (const o of opts) { if (o.call) coi += o.oi; else poi += o.oi; }
  const expiries = [...new Set(G.opts.filter(o => o.exp > now).map(o => o.exp + '|' + o.expCode))].sort().map(s => s.split('|')[1]);
  return { spot, net: base.tot, strikes, callWall: callWall && callWall.K, putWall: putWall && putWall.K, flip, maxPain, maxPainExp: nearest, coi, poi, pcr: coi ? poi / coi : 0, curve, expiries };
};

/* ---------- estimated liquidation clusters ---------- */
OF.liqMap = function () {
  const S = OF.S, f = S.fut, mid = OF.mid(); if (!mid) return null;
  const bin = OF.niceStep(mid * 0.0025), lev = [[10, 0.3], [25, 0.3], [50, 0.25], [100, 0.15]];
  const m = new Map(); const add = (p, n, side) => { const k = Math.floor(p / bin) * bin; const r = m.get(k) || { long: 0, short: 0 }; r[side] += n; m.set(k, r); };
  let src = [];
  if (f.oi5 && f.k5) {
    const kk = new Map(f.k5.map(c => [c.t, c]));
    for (let i = 1; i < f.oi5.length; i++) {
      const d = f.oi5[i].v - f.oi5[i - 1].v, c = kk.get(f.oi5[i].t - 300000) || kk.get(f.oi5[i].t);
      if (d > 0 && c) src.push({ t: c.t, p: c.c, n: d, buyShare: c.v ? c.bv / c.v : 0.5 });
    }
  } else if (f.oiHist.length > 2) {
    for (let i = 1; i < f.oiHist.length; i++) { const d = f.oiHist[i].v - f.oiHist[i - 1].v; if (d > 0) src.push({ t: f.oiHist[i].t, p: f.oiHist[i].p, n: d, buyShare: 0.5 }); }
  }
  if (!src.length) return { rows: [], bin, mid, partial: true };
  // highs / lows after each entry so already-liquidated clusters drop out
  const k5 = f.k5 || [];
  for (const e of src) {
    let hi = -Infinity, lo = Infinity;
    for (const c of k5) if (c.t > e.t) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; }
    for (const [L, w] of lev) {
      const lp = e.p * (1 - 1 / L + 0.004), sp = e.p * (1 + 1 / L - 0.004);
      if (lo > lp) add(lp, e.n * e.buyShare * w, 'long');
      if (hi < sp) add(sp, e.n * (1 - e.buyShare) * w, 'short');
    }
  }
  const rows = [...m.entries()].map(([p, r]) => ({ p, long: r.long, short: r.short })).sort((a, b) => b.p - a.p);
  let up = 0, dn = 0; for (const r of rows) { if (r.p > mid && r.p < mid * 1.03) up += r.short; if (r.p < mid && r.p > mid * 0.97) dn += r.long; }
  return { rows, bin, mid, shortsAbove3: up, longsBelow3: dn };
};

/* ---------- multi-timeframe direction (shown on every tab) ----------
   Per timeframe: trend (close vs EMA21, EMA21 vs EMA50), candle delta (taker buy − sell, current blended
   with previous), momentum (last 3 candles vs ATR); 1m/5m/15m also include live trade flow. */
OF.MTF = ['1m', '5m', '15m', '1h', '4h', '12h'];
OF.mtf = function () {
  const S = OF.S; if (!S || !S.info) return null;
  if (S._mtf && Date.now() - S._mtf.at < 1000) return S._mtf;
  const now = OF.now(), rows = [], W = { '1m': 0.5, '5m': 0.8, '15m': 1, '1h': 1.2, '4h': 1.2, '12h': 1 };
  let sum = 0, sw = 0, up = 0, dn = 0;
  for (const tf of OF.MTF) {
    const k = S.k[tf];
    if (!k || k.length < 55) { rows.push({ tf, score: null }); continue; }
    const i = k.length - 1, c = k[i], p = k[i - 1], ms = OF.tfMs[tf], done = OF.clamp((now - c.t) / ms, 0, 1);
    const dc = c.qv ? (2 * c.bqv - c.qv) / c.qv : 0, dp = p.qv ? (2 * p.bqv - p.qv) / p.qv : 0;
    const delta = OF.clamp((dc * (0.3 + 0.7 * done) + dp * (0.7 - 0.7 * done)) * 3, -1, 1);
    const e21 = OF.ema(k, 21), e50 = OF.ema(k, 50), a = OF.atr(k) || c.c * 0.001;
    const trend = OF.clamp(0.5 * Math.sign(e21[i] - e50[i]) + 0.5 * (c.c - e21[i]) / a, -1, 1);
    const mom = OF.clamp((c.c - k[Math.max(0, i - 3)].c) / (a * 1.5), -1, 1);
    let flow = null;
    if (ms <= 9e5) { const f = OF.flow(now - ms); flow = f.tot ? OF.clamp(f.d / f.tot * 2, -1, 1) : 0; }
    const sc = flow == null ? 0.4 * trend + 0.35 * delta + 0.25 * mom : 0.3 * trend + 0.25 * delta + 0.2 * mom + 0.25 * flow;
    const score = Math.round(sc * 100);
    rows.push({ tf, score, trend, delta, mom, flow, ema21: e21[i] });
    sum += sc * W[tf]; sw += W[tf]; if (score > 15) up++; else if (score < -15) dn++;
  }
  S._mtf = { at: Date.now(), rows, overall: sw ? Math.round(sum / sw * 100) : null, up, dn };
  return S._mtf;
};

/* ---------- sentiment meters ---------- */
const lab = s => { const a = Math.abs(s); const d = s > 0 ? 'bullish' : 'bearish'; return a < 15 ? 'Neutral' : a < 55 ? d[0].toUpperCase() + d.slice(1) : 'Strongly ' + d; };
OF.label = lab;
function flow(from) {
  const tr = OF.S.trades; let b = 0, s = 0;
  for (let i = tr.length - 1; i >= 0 && tr[i].t >= from; i--) { if (tr[i].buy) b += tr[i].n; else s += tr[i].n; }
  return { b, s, tot: b + s, d: b - s };
}
OF.flow = flow;
OF.meters = function () {
  const S = OF.S; if (!S || !S.info) return null;
  if (S._met && Date.now() - S._met.at < 1000) return S._met;
  const now = OF.now(), mid = OF.mid(), M = [];
  const add = (group, key, name, score, text, extra) => M.push(Object.assign({ group, key, name, score: score == null ? null : Math.round(OF.clamp(score, -100, 100)), text }, extra || {}));

  // order flow now
  const f10 = flow(now - 10000), f60 = flow(now - 60000), f300 = flow(now - 300000);
  add('flow', 'momentum', 'Momentum (10 s)', f10.tot ? f10.d / f10.tot * 140 : 0, f10.tot ? (f10.d >= 0 ? 'Buying' : 'Selling') + ' burst in the last 10 s' : 'Quiet');
  const share = f60.tot ? f60.b / f60.tot : 0.5;
  add('flow', 'aggr', 'Aggression (1 min)', (share - 0.5) * 300, (share >= 0.5 ? 'Buyers' : 'Sellers') + ' took ' + Math.round(Math.max(share, 1 - share) * 100) + '% of 1-min volume');
  add('flow', 'cvd5', 'CVD trend (5 min)', f300.tot ? f300.d / f300.tot * 200 : 0, 'Net ' + (f300.d >= 0 ? 'buying ' : 'selling ') + OF.fmtUsd(Math.abs(f300.d)) + ' over 5 min');
  const thr = S.whaleThr || 1e9; let lb = 0, ls = 0;
  for (let i = S.trades.length - 1; i >= 0 && S.trades[i].t >= now - 60000; i--) { const t = S.trades[i]; if (t.n >= thr * 0.3) { if (t.buy) lb += t.n; else ls += t.n; } }
  add('flow', 'large', 'Large prints (1 min)', (lb + ls) ? (lb - ls) / (lb + ls) * 100 * Math.min(1, (lb + ls) / (thr * 2)) : 0, (lb + ls) ? 'Large traders net ' + (lb >= ls ? 'buying' : 'selling') : 'No large prints');
  // absorption: heavy one-sided flow with almost no price move
  const p60 = (() => { const i = OF.lb(S.trades, now - 60000); return S.trades[i] ? S.trades[i].p : S.last; })();
  const mv = p60 ? (S.last - p60) / p60 * 1e4 : 0;
  let abs = 0, absTxt = 'No absorption';
  if (f60.tot > thr * 3 && Math.abs(f60.d) / f60.tot > 0.3 && Math.abs(mv) < 2) { abs = f60.d > 0 ? -60 : 60; absTxt = (f60.d > 0 ? 'Buying' : 'Selling') + ' absorbed — price not moving'; }
  add('flow', 'absorb', 'Absorption', abs, absTxt);

  // delta by timeframe (from candles incl. taker-buy volume)
  for (const tf of ['1m', '5m', '15m', '30m', '1h', '4h', '1d']) {
    const k = S.k[tf]; if (!k || k.length < 2) { add('delta', 'd' + tf, tf + ' candle', null, 'loading…'); continue; }
    const c = k[k.length - 1], p = k[k.length - 2], ms = OF.tfMs[tf], done = OF.clamp((now - c.t) / ms, 0, 1);
    const dc = c.qv ? (2 * c.bqv - c.qv) / c.qv : 0, dp = p.qv ? (2 * p.bqv - p.qv) / p.qv : 0;
    const blend = dc * (0.3 + 0.7 * done) + dp * (0.7 - 0.7 * done);
    add('delta', 'd' + tf, tf + ' candle', blend * 300, 'now Δ ' + (dc >= 0 ? '+' : '') + Math.round(dc * 100) + '% (' + Math.round(done * 100) + '% done) · last Δ ' + (dp >= 0 ? '+' : '') + Math.round(dp * 100) + '%', { now: dc, last: dp, done });
  }

  // order book
  if (S.synced && mid) {
    const b1 = OF.bookBins(0.1), sum = m => { let s = 0; for (const v of m.values()) s += v; return s; };
    const bb = sum(b1.b), aa = sum(b1.a);
    add('book', 'imb', 'Book imbalance (±0.1%)', (bb + aa) ? (bb - aa) / (bb + aa) * 150 : 0, (bb >= aa ? 'Bids' : 'Asks') + ' heavier in the book');
    const b5 = OF.bookBins(0.5), wb = sum(b5.b), wa = sum(b5.a);
    add('book', 'walls', 'Walls (±0.5%)', (wb + wa) ? (wb - wa) / (wb + wa) * 120 : 0, 'bid ' + OF.fmtUsd(wb) + ' below vs ask ' + OF.fmtUsd(wa) + ' above');
    let pb = 0, pa = 0, ib = 0, ia = 0;
    for (let i = S.events.length - 1; i >= 0 && S.events[i].t >= now - 300000; i--) {
      const e = S.events[i];
      if (e.type === 'pull') { if (e.side === 'bid') pb++; else pa++; }
      if (e.type === 'iceberg') { if (e.side === 'bid') ib++; else ia++; }
    }
    // many pulled bids = fake support (bearish); many pulled asks = fake resistance (bullish)
    add('book', 'fake', 'Fake walls (pulled, 5 min)', (pb + pa) ? (pa - pb) / (pb + pa) * 120 : 0, pb + ' large bids pulled vs ' + pa + ' asks');
    add('book', 'ice', 'Icebergs (5 min)', (ib + ia) ? (ib - ia) / (ib + ia) * 100 : 0, (ib + ia) ? ib + ' bid / ' + ia + ' ask refills' : 'None detected');
  }

  // big players over the last hour
  const wl = OF.whaleList('big', thr, now - 3600000); let wb = 0, ws = 0; for (const w of wl) { if (w.buy) wb += w.n; else ws += w.n; }
  const f1h = flow(now - 3600000), eb = f1h.b - wb, es = f1h.s - ws;
  add('big', 'whale', 'Whale net (1 h)', (wb + ws) ? (wb - ws) / (wb + ws) * 100 : 0, OF.fmtUsd(wb - ws, true) + ' net · ' + wl.length + ' prints ≥ ' + OF.fmtUsd(thr));
  add('big', 'rest', 'Everyone else (1 h)', (eb + es) ? (eb - es) / (eb + es) * 300 : 0, OF.fmtUsd(eb - es, true) + ' net of ' + OF.fmtUsd(eb + es) + ' traded');

  // value and trend
  const ss = OF.session();
  if (ss && ss.today) {
    const t = ss.today, p = S.last;
    add('value', 'va', 'Session value area', p > t.vah ? 100 : p < t.val ? -100 : ((p - t.poc) / (t.vah - t.val || 1)) * 100, p > t.vah ? 'Above the value area' : p < t.val ? 'Below the value area' : 'Inside value (' + OF.fp(t.val) + '–' + OF.fp(t.vah) + ')');
    if (ss.vwap) { const z = ss.sd ? (p - ss.vwap) / ss.sd : 0; add('value', 'vwap', 'Daily VWAP', z * 50, 'price ' + (z >= 0 ? '+' : '') + z.toFixed(2) + 'σ vs VWAP ' + OF.fp(ss.vwap)); }
  }
  const k1h = S.k['1h'];
  if (k1h && k1h.length > 30) {
    const ema = (arr, n) => { let e = arr[0].c, a = 2 / (n + 1); for (const c of arr) e = c.c * a + e * (1 - a); return e; };
    const e9 = ema(k1h.slice(-60), 9), e21 = ema(k1h.slice(-80), 21), d = (e9 - e21) / e21 * 1e4;
    add('value', 'trend', '1h trend', d * 4, Math.abs(d) < 8 ? '1h range' : (d > 0 ? '1h uptrend' : '1h downtrend'));
  }

  // futures & options
  const F = S.fut;
  if (F.available) {
    if (F.funding != null) add('fut', 'fund', 'Funding (crowd)', -F.funding * 1e4 * 8, (F.funding * 100).toFixed(4) + '% per 8 h — ' + (F.funding >= 0 ? 'longs pay' : 'shorts pay'));
    const h = F.oiHist; if (h.length > 3) {
      const a = h.find(x => x.t >= now - 3600000) || h[0], b = h[h.length - 1];
      const doi = (b.v - a.v) / a.v * 100, dp = a.p ? (b.p - a.p) / a.p * 100 : 0;
      add('fut', 'oi', 'Open interest vs price', Math.abs(doi) < 0.3 ? 0 : Math.sign(dp) * Math.min(100, Math.abs(doi) * 40), 'OI ' + (doi >= 0 ? '+' : '') + doi.toFixed(2) + '%, price ' + (dp >= 0 ? '+' : '') + dp.toFixed(2) + '%');
    }
    let lq = 0, sq = 0; for (const l of S.liqs) if (l.t >= now - 3600000) { if (l.side === 'long') lq += l.n; else sq += l.n; }
    add('fut', 'liq', 'Liquidations (1 h)', (lq + sq) ? (sq - lq) / (lq + sq) * 80 : null, (lq + sq) ? OF.fmtUsd(lq) + ' longs · ' + OF.fmtUsd(sq) + ' shorts' : 'None seen yet');
    let fb = 0, fs = 0; for (let i = S.futFlow.length - 1; i >= 0 && S.futFlow[i].t >= now - 60000; i--) { const x = S.futFlow[i]; if (x.buy) fb += x.n; else fs += x.n; }
    { const ff = OF.fflow(now - 9e5); add('fut', 'fcvd15', 'Futures CVD (15 min)', ff.tot ? ff.d / ff.tot * 250 : 0, ff.tot ? OF.fmtUsd(ff.d, true) + ' net of ' + OF.fmtUsd(ff.tot) + ' on the perpetual' : 'No futures prints'); }
    add('fut', 'faggr', 'Futures aggression (1 min)', (fb + fs) ? (fb - fs) / (fb + fs) * 150 : 0, (fb + fs) ? (fb >= fs ? 'buyers ' : 'sellers ') + Math.round(Math.max(fb, fs) / (fb + fs) * 100) + '% of futures volume' : 'No futures prints');
    if (F.mark && S.last) add('fut', 'basis', 'Basis (futures vs spot)', 0, ((F.mark - S.last) / S.last * 1e4).toFixed(1) + ' bp');
    const lm = OF.liqMap();
    if (lm && lm.shortsAbove3 != null) add('fut', 'fuel', 'Liquidation fuel (±3%)', (lm.shortsAbove3 - lm.longsBelow3) / ((lm.shortsAbove3 + lm.longsBelow3) || 1) * 60, 'est. ' + OF.fmtUsd(lm.shortsAbove3) + ' shorts above vs ' + OF.fmtUsd(lm.longsBelow3) + ' longs below');
  }
  if (S.cb) {
    const h = S.cbHist || [], avg = h.length ? h.reduce((a, x) => a + x.prem, 0) / h.length : S.cb.prem, d = S.cb.prem - avg;
    add('fut', 'cb', 'Coinbase premium', d * 20, S.cb.prem.toFixed(1) + ' bp now vs ' + avg.toFixed(1) + ' bp usual');
  }

  // risk & volatility (direction-free)
  const k1 = S.k['1m'];
  let volRatio = 1;
  if (k1 && k1.length > 61) {
    const rng = c => (c.h - c.l) / c.c * 1e4, last = rng(k1[k1.length - 1]);
    let avg = 0; for (let i = k1.length - 61; i < k1.length - 1; i++) avg += rng(k1[i]); avg /= 60;
    volRatio = avg ? last / avg : 1;
    add('risk', 'vol', 'Volatility vs normal', null, volRatio.toFixed(1) + '× the hour’s norm · ' + last.toFixed(1) + ' bp this minute', { risk: OF.clamp(volRatio * 33, 0, 100) });
  }
  // flow toxicity: share of volume that was one-sided in 10-second buckets (a VPIN-style proxy)
  let imb = 0, totv = 0; const bk = new Map();
  for (let i = S.trades.length - 1; i >= 0 && S.trades[i].t >= now - 300000; i--) { const t = S.trades[i], k = Math.floor(t.t / 10000); const r = bk.get(k) || [0, 0]; r[t.buy ? 0 : 1] += t.n; bk.set(k, r); }
  for (const r of bk.values()) { imb += Math.abs(r[0] - r[1]); totv += r[0] + r[1]; }
  const tox = totv ? imb / totv : 0;
  add('risk', 'tox', 'Flow toxicity', null, Math.round(tox * 100) + '% of 5-min volume was one-sided', { risk: tox * 100 });
  let lq5 = 0; for (const l of S.liqs) if (l.t >= now - 300000) lq5 += l.n;
  add('risk', 'liqp', 'Liquidation pressure (5 min)', null, lq5 ? OF.fmtUsd(lq5) + ' liquidated' : 'none seen', { risk: OF.clamp(lq5 / (thr * 5) * 100, 0, 100) });
  const danger = OF.clamp(Math.max(volRatio * 25, tox * 80, lq5 / (thr * 5) * 100), 0, 100);

  S._met = { at: Date.now(), list: M, danger };
  return S._met;
};

/* Decision panel: weighted consensus of the order-flow meters → BUY / SELL / WAIT plus trigger levels.
   Weights favour what is happening now (flow, book) over slow context (value, futures). */
const WEIGHTS = { momentum: 1.2, aggr: 1.4, cvd5: 1.2, large: 1.0, absorb: 0.8, imb: 1.0, walls: 0.6, fake: 0.8, ice: 0.4, whale: 0.6, va: 0.4, vwap: 0.4, trend: 0.5, faggr: 0.6, fund: 0.2, oi: 0.3, d5m: 0.6, d15m: 0.4 };
OF.verdictFrom = function (score, agree) {
  // A call needs both a strong blended score and most meters pointing the same way.
  if (score >= 30 && agree >= 0.6) return 'BUY';
  if (score <= -30 && agree >= 0.6) return 'SELL';
  return 'WAIT';
};
OF.decision = function () {
  const m = OF.meters(); if (!m) return null;
  let s = 0, w = 0, pos = 0, neg = 0, n = 0;
  const reasons = [];
  for (const x of m.list) {
    const k = WEIGHTS[x.key]; if (!k || x.score == null) continue;
    s += x.score * k; w += k; n++;
    if (x.score > 15) pos++; else if (x.score < -15) neg++;
    if (Math.abs(x.score) >= 40) reasons.push(x);
  }
  const score = w ? s / w : 0, agree = n ? Math.max(pos, neg) / n : 0;
  const verdict = OF.verdictFrom(score, agree);
  reasons.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const wl = OF.walls(0.25), bin = OF.S.bin || 1;
  const plan = wl ? { buyAbove: wl.ask ? wl.ask.p + bin : null, sellBelow: wl.bid ? wl.bid.p - bin : null } : null;
  const all = m.list.filter(x => x.score != null);
  return {
    score, agree, verdict, plan, reasons: reasons.slice(0, 4), danger: m.danger,
    confidence: Math.round(OF.clamp(Math.abs(score) * 0.8 + agree * 40, 0, 99)),
    consensus: { bull: all.filter(x => x.score > 15).length, bear: all.filter(x => x.score < -15).length, neutral: all.filter(x => Math.abs(x.score) <= 15).length,
      score: all.length ? all.reduce((a, x) => a + x.score, 0) / all.length : 0 },
    headline: verdict === 'WAIT' ? 'WAIT' : verdict + ' bias'
  };
};
})();

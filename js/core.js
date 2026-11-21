/* FlowDesk core — shared state, helpers and the live data engine.
   Data: Binance spot (book + trades), Bybit USDT perpetual (funding, OI, liquidations),
   Deribit options (gamma), Coinbase (US premium). All public, no API keys. */
(function () {
'use strict';
const OF = window.OF = { views: {}, S: null, demo: false };

const SPOT_REST = ['https://data-api.binance.vision', 'https://api.binance.com'];
const SPOT_WS = ['wss://data-stream.binance.vision', 'wss://stream.binance.com:9443'];
const BYBIT_WS = 'wss://stream.bybit.com/v5/public/linear';
const FAPI = 'https://fapi.binance.com';
/* Binance USDⓈ-M futures websockets. Since 2026-04-23 market data is split: order book + best bid/ask on /public,
   trades, liquidations and klines on /market (the old /stream and /ws paths no longer carry them). */
const FWS_PUBLIC = 'wss://fstream.binance.com/public', FWS_MARKET = 'wss://fstream.binance.com/market';
OF.SPOT_REST = SPOT_REST; OF.FAPI = FAPI;

/* Gold and silver: Binance TradFi perpetuals (USDⓈ-M, 24/7, settled in USDT). PAXG is a gold-backed spot token. */
OF.METALS = {
  XAUUSDT: { name: 'Gold', sym: 'Au', mkt: 'fut', note: 'Binance gold perpetual (XAU) · 24/7' },
  XAGUSDT: { name: 'Silver', sym: 'Ag', mkt: 'fut', note: 'Binance silver perpetual (XAG) · 24/7' },
  PAXGUSDT: { name: 'Gold token', sym: 'Au', mkt: 'spot', note: 'PAX Gold on Binance spot (1 token = 1 oz gold)' }
};
OF.isFut = sym => !!(OF.METALS[sym] && OF.METALS[sym].mkt === 'fut');

/* ---------- small helpers ---------- */
OF.LS = {
  get(k, d) { try { const v = localStorage.getItem('fd:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('fd:' + k, JSON.stringify(v)); } catch (e) {} }
};
const L = {};
OF.on = (e, f) => { (L[e] = L[e] || []).push(f); };
OF.emit = (e, a) => { (L[e] || []).forEach(f => { try { f(a); } catch (x) { console.error(x); } }); };

OF.fmtUsd = (n, sign) => {
  if (n == null || !isFinite(n)) return '--';
  const a = Math.abs(n); let s;
  if (a >= 1e9) s = (a / 1e9).toFixed(2) + 'B';
  else if (a >= 1e6) s = (a / 1e6).toFixed(2) + 'M';
  else if (a >= 1e3) s = (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
  else s = a.toFixed(0);
  return (n < 0 ? '-' : (sign ? '+' : '')) + '$' + s;
};
OF.fmtN = (n, d = 2) => (n == null || !isFinite(n)) ? '--' : n.toFixed(d);
OF.fp = p => (p == null || !isFinite(p)) ? '--' : p.toFixed(OF.S && OF.S.info ? OF.S.info.dp : 2);
OF.niceStep = x => {
  if (!(x > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(x))), f = x / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
};
OF.clamp = (v, a, b) => v < a ? a : v > b ? b : v;
OF.pctile = (arr, q) => {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
OF.tfMs = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '30m': 18e5, '1h': 36e5, '4h': 144e5, '12h': 432e5, '1d': 864e5 };
OF.hm = (t, sec) => {
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + (sec ? ':' + p(d.getSeconds()) : '');
};
OF.now = () => Date.now() + (OF.S ? OF.S.offset : 0);
OF.mid = () => { const S = OF.S; if (!S) return 0; return (S.bb && S.ba) ? (S.bb + S.ba) / 2 : S.last; };
/* binary search: first index with arr[i].t >= t */
OF.lb = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m + 1; else hi = m; } return lo; };

const toFut = path => path.replace('/api/v3/', '/fapi/v1/').replace(/([?&]limit=)5000\b/, (m, a) => a + '1000').replace(/[?&]type=MINI/, '');   // futures depth max 1000
OF.getJ = async function (path, bases) {
  if (!bases && OF.S && OF.S.mkt === 'fut' && path.startsWith('/api/v3/')) { path = toFut(path); bases = [FAPI]; }
  bases = bases || SPOT_REST; let err;
  for (const b of bases) {
    try { const r = await fetch(b + path); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    catch (e) { err = e; }
  }
  throw err;
};

/* ---------- state ---------- */
function newState(symbol) {
  return {
    symbol, info: null, status: 'LOADING', err: '', lagMs: 0, offset: 0, msgs: 0, msgRate: 0, lastMsg: 0,
    resyncs: 0, reconnects: 0,
    bids: new Map(), asks: new Map(), lastId: 0, synced: false, buffering: true, buf: [],
    bb: 0, ba: 0, last: 0, lastTradeT: 0, firstLiveId: 0,
    trades: [], cvd: 0, histFrom: 0,
    cols: [], colsC: [], colN: 0, bin: 0, bubbles: [], curBub: null,
    events: [], placed: new Map(), tradedAt: new Map(), refill: new Map(), pullCount: new Map(), l3Min: 20000,
    k: {}, kLoading: {}, day: null,
    fut: { available: null, oiHist: [] }, futFlow: [], liqs: [], cb: null,
    gamma: null, whaleThr: 0, fcvd: 0, xbook: {},
    volAt: new Map(), cqc: new Map()   // traded volume per exact price {b,s}; quote-change count per price
  };
}

let gen = 0, ws = null, bws = null, cbws = null, timers = [];
function stopAll() {
  [ws, bws, cbws].concat(xws).forEach(w => { if (w) { w.onclose = null; try { w.close(); } catch (e) {} } });
  xws = [];
  ws = bws = cbws = null; timers.forEach(clearInterval); timers = [];
  if (OF.demoTimer) { clearInterval(OF.demoTimer); OF.demoTimer = null; }
}

OF.start = async function (symbol) {
  gen++; const g = gen; stopAll();
  const S = OF.S = newState(symbol);
  S.mkt = OF.isFut(symbol) ? 'fut' : 'spot';
  OF.emit('reset');
  if (OF.demo) {
    OF.startDemo(S);
    timers.push(setInterval(() => snapshotCol(S), 500));
    timers.push(setInterval(() => housekeeping(S), 5000));
    return;
  }
  try {
    const fut = S.mkt === 'fut';
    const [ex, tm] = await Promise.all([fut ? OF.getJ('/fapi/v1/exchangeInfo', [FAPI]) : OF.getJ('/api/v3/exchangeInfo?symbol=' + symbol), OF.getJ('/api/v3/time')]);
    S.offset = tm.serverTime - Date.now();
    const si = ex.symbols.find(x => x.symbol === symbol); if (!si) throw new Error(symbol + ' is not listed');
    const pf = si.filters.find(f => f.filterType === 'PRICE_FILTER');
    const tick = parseFloat(pf.tickSize);
    S.info = { base: si.baseAsset, quote: si.quoteAsset, tick, dp: Math.max(0, Math.round(-Math.log10(tick))) };
  } catch (e) {
    S.status = 'OFFLINE'; S.err = 'Could not reach Binance (' + e.message + ')'; OF.emit('status'); return;
  }
  if (g !== gen) return;
  OF.emit('info');
  if (S.mkt === 'fut') {
    // a perpetual is its own futures market: funding, open interest and liquidations come from Binance
    S.fut.available = true;
    openFut(g); pollPremium(g);
    timers.push(setInterval(() => pollPremium(g), 15000));
  } else {
    openSpot(g, 0);
    openBybit(g);
    openCoinbase(g);
    openVenues(g);
  }
  pollFutures(g);
  timers.push(setInterval(() => snapshotCol(S), 500));
  timers.push(setInterval(() => housekeeping(S), 5000));
  timers.push(setInterval(() => pollFutures(g), 60000));
  OF.loadDay();
  loadHistTrades(g, 12);
};

/* ---------- Binance spot websocket ---------- */
function openSpot(g, alt) {
  const S = OF.S, s = S.symbol.toLowerCase();
  const url = SPOT_WS[alt % SPOT_WS.length] + '/stream?streams=' + [s + '@depth@100ms', s + '@aggTrade', s + '@bookTicker'].join('/');
  S.status = 'SYNCING'; OF.emit('status');
  let opened = false;
  const w = ws = new WebSocket(url);
  w.onopen = () => { opened = true; resync(g); };
  w.onmessage = ev => {
    if (g !== gen) return;
    const m = JSON.parse(ev.data), d = m.data, st = m.stream;
    S.msgs++; S.lastMsg = Date.now();
    if (st.endsWith('@aggTrade')) onTrade(S, d);
    else if (st.endsWith('@bookTicker')) { S.bb = +d.b; S.ba = +d.a; }
    else onDepth(S, d, g);
  };
  w.onclose = () => {
    if (g !== gen) return;
    S.status = 'OFFLINE'; S.synced = false; S.reconnects++; OF.emit('status');
    setTimeout(() => { if (g === gen) openSpot(g, opened ? alt : alt + 1); }, 2000);
  };
}

/* ---------- Binance USDⓈ-M futures websockets (gold / silver) ---------- */
function openFut(g) {
  const S = OF.S, s = S.symbol.toLowerCase();
  S.status = 'SYNCING'; OF.emit('status');
  const pub = ws = new WebSocket(FWS_PUBLIC + '/stream?streams=' + [s + '@depth@100ms', s + '@bookTicker'].join('/'));
  pub.onopen = () => resync(g);
  pub.onmessage = ev => {
    if (g !== gen) return;
    const m = JSON.parse(ev.data), d = m.data, st = m.stream || '';
    S.msgs++; S.lastMsg = Date.now();
    if (st.endsWith('@bookTicker')) { S.bb = +d.b; S.ba = +d.a; } else if (d && d.e === 'depthUpdate') onDepth(S, d, g);
  };
  pub.onclose = () => {
    if (g !== gen) return;
    S.status = 'OFFLINE'; S.synced = false; S.reconnects++; OF.emit('status');
    setTimeout(() => { if (g === gen) { try { mk.onclose = null; mk.close(); } catch (e) {} openFut(g); } }, 2000);
  };
  const mk = new WebSocket(FWS_MARKET + '/stream?streams=' + [s + '@aggTrade', s + '@forceOrder'].join('/'));
  xws.push(mk);
  mk.onmessage = ev => {
    if (g !== gen) return;
    const m = JSON.parse(ev.data), d = m.data, st = m.stream || '';
    S.msgs++; S.lastMsg = Date.now();
    if (st.endsWith('@aggTrade')) {
      onTrade(S, d);
      const n = +d.p * +d.q, buy = !d.m; S.futFlow.push({ t: d.T, n, buy, p: +d.p }); S.fcvd += buy ? n : -n;
      if (S.futFlow.length > 60000) S.futFlow.splice(0, 15000);
    } else if (st.endsWith('@forceOrder') && d.o) {
      // a SELL liquidation order closes a long, a BUY closes a short
      const o = d.o, p = +(o.ap || o.p), q = +(o.z || o.q);
      S.liqs.unshift({ t: +o.T, side: o.S === 'SELL' ? 'long' : 'short', p, n: p * q });
      if (S.liqs.length > 500) S.liqs.length = 500;
    }
  };
}
async function pollPremium(g) {
  const S = OF.S;
  try {
    const [pi, oi] = await Promise.all([OF.getJ('/fapi/v1/premiumIndex?symbol=' + S.symbol, [FAPI]), OF.getJ('/fapi/v1/openInterest?symbol=' + S.symbol, [FAPI])]);
    if (g !== gen) return;
    const f = S.fut; f.available = true;
    f.mark = +pi.markPrice; f.index = +pi.indexPrice; f.last = S.last || f.mark;
    f.funding = +pi.lastFundingRate; f.nextFunding = +pi.nextFundingTime;
    f.oiValue = +oi.openInterest * (f.mark || S.last);
    const h = f.oiHist, t = OF.now();
    if (!h.length || t - h[h.length - 1].t > 14000) { h.push({ t, v: f.oiValue, p: f.mark || S.last }); if (h.length > 2000) h.shift(); }
    OF.emit('fut');
  } catch (e) { /* funding / OI are optional */ }
}

async function resync(g) {
  const S = OF.S; S.synced = false; S.buffering = true; S.buf = [];
  try {
    const snap = await OF.getJ('/api/v3/depth?symbol=' + S.symbol + '&limit=5000');
    if (g !== gen) return;
    S.bids.clear(); S.asks.clear();
    for (const [p, q] of snap.bids) S.bids.set(+p, +q);
    for (const [p, q] of snap.asks) S.asks.set(+p, +q);
    S.lastId = snap.lastUpdateId; S.buffering = false;
    const buf = S.buf; S.buf = [];
    for (const d of buf) { if (!applyDepth(S, d, g)) break; }
  } catch (e) {
    S.err = 'Order book snapshot failed: ' + e.message;
    setTimeout(() => { if (g === gen) resync(g); }, 3000);
  }
}
function onDepth(S, d, g) {
  if (d.E) S.lagMs = Date.now() + S.offset - d.E;
  if (S.buffering) { S.buf.push(d); return; }
  applyDepth(S, d, g);
}
/* Binance diff-depth rules: drop u <= lastUpdateId; the first applied event must straddle
   lastUpdateId+1; after that every event's U must equal the previous u + 1, or we resync. */
function applyDepth(S, d, g) {
  if (S.mkt === 'fut') {
    /* USDⓈ-M rules: drop u < lastUpdateId; the first event must have U <= lastUpdateId <= u;
       after that each event's pu must equal the previous event's u, or we resync. */
    if (d.u < S.lastId) return true;
    if (!S.synced) {
      if (d.U <= S.lastId && d.u >= S.lastId) { S.synced = true; S.status = 'LIVE'; OF.emit('status'); }
      else { resync(g); return false; }
    } else if (d.pu !== S.lastId) { S.resyncs++; S.status = 'SYNCING'; OF.emit('status'); resync(g); return false; }
    S.lastId = d.u;
    const t = d.E || OF.now();
    upd(S, S.bids, d.b, 'bid', t); upd(S, S.asks, d.a, 'ask', t);
    return true;
  }
  if (d.u <= S.lastId) return true;
  if (!S.synced) {
    if (d.U <= S.lastId + 1 && d.u >= S.lastId + 1) { S.synced = true; S.status = 'LIVE'; OF.emit('status'); }
    else { resync(g); return false; }
  } else if (d.U !== S.lastId + 1) {
    S.resyncs++; S.status = 'SYNCING'; OF.emit('status'); resync(g); return false;
  }
  S.lastId = d.u;
  const t = d.E || OF.now();
  upd(S, S.bids, d.b, 'bid', t);
  upd(S, S.asks, d.a, 'ask', t);
  return true;
}

/* Apply one side's level changes and infer L3-style events (adds, pulls, fills, icebergs). */
function upd(S, book, arr, side, t) {
  const mid = OF.mid(), min = S.l3Min;
  for (let i = 0; i < arr.length; i++) {
    const p = +arr[i][0], q = +arr[i][1], old = book.get(p) || 0;
    if (q === 0) book.delete(p); else book.set(p, q);
    S.cqc.set(p, (S.cqc.get(p) || 0) + 1);
    if (!mid || Math.abs(p - mid) / mid > 0.01) continue;
    const dn = (q - old) * p, key = side + p;
    const tr = S.tradedAt.get(p), recentlyTraded = tr && t - tr < 1500;
    if (dn >= min) {
      S.placed.set(key, { t, n: q * p });
      if (recentlyTraded) {
        const r = S.refill.get(key) || { c: 0, last: 0, flagged: 0 };
        r.c++; r.last = t; S.refill.set(key, r);
        if (r.c >= 3 && t - r.flagged > 60000) { r.flagged = t; pushEv(S, { t, type: 'iceberg', side, p, n: dn, times: r.c }); }
      }
      pushEv(S, { t, type: 'add', side, p, n: dn });
    } else if (dn <= -min) {
      if (recentlyTraded) pushEv(S, { t, type: 'fill', side, p, n: -dn });
      else {
        const pl = S.placed.get(key);
        pushEv(S, { t, type: 'pull', side, p, n: -dn, age: pl ? (t - pl.t) / 1000 : null, untraded: true });
      }
      if (q === 0) S.placed.delete(key);
    }
  }
}
function pushEv(S, e) {
  if (e.type === 'pull') {
    const k = e.side + e.p, list = (S.pullCount.get(k) || []).filter(x => e.t - x < 300000);
    list.push(e.t); S.pullCount.set(k, list); e.times = list.length;
    // layering: 3+ different prices pulled on the same side within 2 s
    const recent = new Set();
    for (let i = S.events.length - 1; i >= 0 && e.t - S.events[i].t < 2000; i--) {
      const x = S.events[i]; if (x.type === 'pull' && x.side === e.side) recent.add(x.p);
    }
    recent.add(e.p);
    if (recent.size >= 3 && e.t - (S.lastLayer || 0) > 10000) {
      S.lastLayer = e.t;
      S.events.push({ t: e.t, type: 'layering', side: e.side, p: e.p, n: e.n, times: recent.size });
    }
    if (e.times >= 3 && e.t - (S['spoof' + k] || 0) > 60000) {
      S['spoof' + k] = e.t;
      S.events.push({ t: e.t, type: 'spoof', side: e.side, p: e.p, n: e.n, times: e.times });
    }
  }
  S.events.push(e);
  if (S.events.length > 8000) S.events.splice(0, 2000);
}

function onTrade(S, d) {
  const p = +d.p, q = +d.q, t = d.T, buy = !d.m, n = p * q;
  if (!S.firstLiveId) S.firstLiveId = d.a;
  if (d.E) S.lagMs = Date.now() + S.offset - d.E;
  S.last = p; S.lastTradeT = t;
  const tr = { t, p, q, n, buy, a: d.a };
  S.trades.push(tr);
  if (S.trades.length > 400000) S.trades.splice(0, 100000);
  S.cvd += buy ? n : -n;
  S.tradedAt.set(p, t);
  addVol(S, tr);
  addBubble(S, tr);
  for (const tf in S.k) {
    const arr = S.k[tf]; if (!arr || !arr.length) continue;
    const ms = OF.tfMs[tf], ot = Math.floor(t / ms) * ms;
    let c = arr[arr.length - 1];
    if (ot > c.t) { c = { t: ot, o: p, h: p, l: p, c: p, v: 0, qv: 0, bv: 0, bqv: 0 }; arr.push(c); if (arr.length > 3000) arr.shift(); }
    else if (ot < c.t) continue;
    if (p > c.h) c.h = p; if (p < c.l) c.l = p; c.c = p; c.v += q; c.qv += n;
    if (buy) { c.bv += q; c.bqv += n; }
  }
  if (OF.onTradeHook) OF.onTradeHook(tr);
}
function addVol(S, tr) { const v = S.volAt.get(tr.p) || { b: 0, s: 0 }; if (tr.buy) v.b += tr.n; else v.s += tr.n; S.volAt.set(tr.p, v); }
function addBubble(S, tr) {
  const bt = Math.floor(tr.t / 500) * 500;
  let b = S.curBub;
  if (!b || b.t !== bt) {
    b = S.curBub = { t: bt, bn: 0, bpq: 0, sn: 0, spq: 0 };
    S.bubbles.push(b);
    if (S.bubbles.length > 40000) S.bubbles.splice(0, 8000);
  }
  if (tr.buy) { b.bn += tr.n; b.bpq += tr.n * tr.p; } else { b.sn += tr.n; b.spq += tr.n * tr.p; }
}

OF._onTrade = onTrade;

/* 0.5-second order-book columns for the heatmap (±2 % around mid, binned). */
function snapshotCol(S) {
  if (!S.synced || !S.info) return;
  const mid = OF.mid(); if (!mid) return;
  if (!S.bin) S.bin = Math.max(S.info.tick, OF.niceStep(mid * 0.00002));
  const bin = S.bin, lo = mid * 0.98, hi = mid * 1.02, b0 = Math.floor(lo / bin), n = Math.ceil((hi - lo) / bin) + 2;
  const arr = new Float32Array(n);
  for (const [p, q] of S.bids) if (p >= lo) { const i = Math.floor(p / bin) - b0; if (i >= 0 && i < n) arr[i] += p * q; }
  for (const [p, q] of S.asks) if (p <= hi) { const i = Math.floor(p / bin) - b0; if (i >= 0 && i < n) arr[i] += p * q; }
  const col = { t: OF.now(), b0, arr, mid, bb: S.bb, ba: S.ba };
  S.cols.push(col); if (S.cols.length > 3600) S.cols.shift();
  if (++S.colN % 10 === 0) { S.colsC.push(col); if (S.colsC.length > 2880) S.colsC.shift(); }
}

function housekeeping(S) {
  const now = OF.now();
  if (S.tradedAt.size > 30000) for (const [p, t] of S.tradedAt) if (now - t > 60000) S.tradedAt.delete(p);
  if (S.cqc.size > 60000) { const mid = OF.mid(); for (const p of S.cqc.keys()) if (Math.abs(p - mid) / mid > 0.03) S.cqc.delete(p); }
  if (S.placed.size > 30000) for (const [k, v] of S.placed) if (now - v.t > 1800000) S.placed.delete(k);
  // adaptive L3 size floor: 95th pct of level notionals within ±0.5 %
  const mid = OF.mid(); if (mid) {
    const v = [];
    for (const [p, q] of S.bids) if (p > mid * 0.995) v.push(p * q);
    for (const [p, q] of S.asks) if (p < mid * 1.005) v.push(p * q);
    S.l3Min = Math.max(2000, OF.pctile(v, 0.95));
  }
  // whale threshold: 99.5th pct of recent trade notionals
  const tr = S.trades, from = Math.max(0, tr.length - 30000), ns = [];
  for (let i = from; i < tr.length; i++) ns.push(tr[i].n);
  if (ns.length > 200) S.whaleThr = Math.max(10000, OF.pctile(ns, 0.995));
  S.msgRate = S.msgs / 5; S.msgs = 0;
  if (S.status === 'LIVE' && Date.now() - S.lastMsg > 15000) { S.status = 'OFFLINE'; OF.emit('status'); }
}

/* ---------- history ---------- */
OF.loadKlines = function (tf, limit) {
  const S = OF.S;
  if (S.k[tf] && S.k[tf].length) return Promise.resolve(S.k[tf]);
  if (S.kLoading[tf]) return S.kLoading[tf];
  if (OF.demo) { S.k[tf] = OF.demoKlines(tf); return Promise.resolve(S.k[tf]); }
  const p = OF.getJ(`/api/v3/klines?symbol=${S.symbol}&interval=${tf}&limit=${limit || 1000}`).then(rows => {
    if (OF.S !== S) return [];
    const arr = rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], qv: +r[7], bv: +r[9], bqv: +r[10] }));
    // merge any candle built live meanwhile
    S.k[tf] = arr; OF.emit('klines', tf); return arr;
  }).catch(e => { delete S.kLoading[tf]; S.err = 'Candles: ' + e.message; return []; });
  S.kLoading[tf] = p; return p;
};

/* Today's (UTC) and yesterday's 1-minute candles → session VWAP, volume profile, prior value area. */
OF.loadDay = async function () {
  const S = OF.S, dayMs = 864e5, start = Math.floor(OF.now() / dayMs) * dayMs;
  try {
    let rows;
    if (OF.demo) rows = OF.demoKlines('1m').filter(c => c.t >= start - dayMs);
    else {
      const get = (st, et) => OF.getJ(`/api/v3/klines?symbol=${S.symbol}&interval=1m&startTime=${st}&endTime=${et}&limit=1000`)
        .then(r => r.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], qv: +r[7], bv: +r[9], bqv: +r[10] })));
      const parts = await Promise.all([
        get(start - dayMs, start - dayMs / 2 - 1), get(start - dayMs / 2, start - 1),
        get(start, start + dayMs / 2 - 1), get(start + dayMs / 2, start + dayMs - 1)]);
      rows = [].concat(...parts);
    }
    if (OF.S !== S) return;
    S.day = { start, prev: rows.filter(c => c.t < start), today: rows.filter(c => c.t >= start), loadedAt: Date.now() };
    OF.emit('day');
  } catch (e) { S.err = 'Session candles: ' + e.message; }
};

/* Recent aggregated trades so footprint / tape / whales have something before the live stream. */
async function loadHistTrades(g, minutes) {
  const S = OF.S, end = OF.now(), start = end - minutes * 60000;
  try {
    let out = [], from = null;
    for (let i = 0; i < 40; i++) {
      const q = from == null ? `startTime=${start}&endTime=${Math.min(end, start + 3599000)}` : `fromId=${from}`;
      const rows = await OF.getJ(`/api/v3/aggTrades?symbol=${S.symbol}&${q}&limit=1000`);
      if (g !== gen) return;
      if (!rows.length) break;
      for (const d of rows) {
        if (S.firstLiveId && d.a >= S.firstLiveId) { i = 99; break; }
        out.push({ t: d.T, p: +d.p, q: +d.q, n: +d.p * +d.q, buy: !d.m, a: d.a });
      }
      from = rows[rows.length - 1].a + 1;
      if (rows.length < 1000) break;
    }
    if (!out.length) return;
    S.trades = out.concat(S.trades.filter(t => !out.length || t.a > out[out.length - 1].a));
    S.histFrom = out[0].t;
    let c = 0; for (const t of out) c += t.buy ? t.n : -t.n; S.cvd += c;
    S.bubbles = []; S.curBub = null; for (const t of S.trades) addBubble(S, t);
    for (const t of out) addVol(S, t);
    OF.emit('hist');
  } catch (e) { /* history is optional */ }
}

/* ---------- Bybit perpetual (funding, OI, liquidations, futures flow) ---------- */
function openBybit(g) {
  const S = OF.S, sym = S.symbol;
  let w;
  try { w = bws = new WebSocket(BYBIT_WS); } catch (e) { S.fut.available = false; return; }
  let ping;
  w.onopen = () => {
    w.send(JSON.stringify({ op: 'subscribe', args: ['tickers.' + sym, 'allLiquidation.' + sym, 'publicTrade.' + sym] }));
    ping = setInterval(() => { try { w.send('{"op":"ping"}'); } catch (e) {} }, 20000);
  };
  w.onmessage = ev => {
    if (g !== gen) return;
    const m = JSON.parse(ev.data);
    if (m.op === 'subscribe' && m.success === false) { S.fut.available = false; OF.emit('fut'); return; }
    if (!m.topic) return;
    if (m.topic.startsWith('tickers.')) {
      const d = m.data, f = S.fut; f.available = true;
      if (d.markPrice) f.mark = +d.markPrice;
      if (d.indexPrice) f.index = +d.indexPrice;
      if (d.lastPrice) f.last = +d.lastPrice;
      if (d.fundingRate) f.funding = +d.fundingRate;
      if (d.nextFundingTime) f.nextFunding = +d.nextFundingTime;
      if (d.openInterestValue) {
        f.oiValue = +d.openInterestValue;
        const h = f.oiHist, t = OF.now();
        if (!h.length || t - h[h.length - 1].t > 15000) { h.push({ t, v: f.oiValue, p: f.mark || S.last }); if (h.length > 2000) h.shift(); }
      }
    } else if (m.topic.startsWith('allLiquidation.')) {
      for (const d of m.data) {
        const p = +d.p, n = p * +d.v;
        S.liqs.unshift({ t: +d.T, side: d.S === 'Buy' ? 'long' : 'short', p, n });
      }
      if (S.liqs.length > 500) S.liqs.length = 500;
    } else if (m.topic.startsWith('publicTrade.')) {
      for (const d of m.data) { const n = +d.p * +d.v, buy = d.S === 'Buy'; S.futFlow.push({ t: +d.T, n, buy, p: +d.p }); S.fcvd += buy ? n : -n; }
      if (S.futFlow.length > 60000) S.futFlow.splice(0, 15000);
    }
  };
  w.onclose = () => { clearInterval(ping); if (g === gen) setTimeout(() => { if (g === gen) openBybit(g); }, 5000); };
}

/* OI history + futures candles for the liquidation estimate (Binance futures REST, optional). */
async function pollFutures(g) {
  const S = OF.S; if (OF.demo) return;
  try {
    const [oi, k] = await Promise.all([
      OF.getJ(`/futures/data/openInterestHist?symbol=${S.symbol}&period=5m&limit=288`, [FAPI]),
      OF.getJ(`/fapi/v1/klines?symbol=${S.symbol}&interval=5m&limit=288`, [FAPI])]);
    if (g !== gen) return;
    S.fut.oi5 = oi.map(r => ({ t: +r.timestamp, oi: +r.sumOpenInterest, v: +r.sumOpenInterestValue }));
    S.fut.k5 = k.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], bv: +r[9] }));
    OF.emit('fut');
  } catch (e) { /* liquidation map falls back to live-only */ }
}

/* ---------- other venues' spot order books (Bybit 200 levels, OKX 400 levels) ----------
   Used only to confirm walls: a wall that also shows on another exchange is more believable.
   Each book is a plain price → size map kept from the venue's snapshot + delta stream. */
let xws = [];
function openVenues(g) {
  const S = OF.S, base = S.info.base, quote = S.info.quote;
  const mk = () => ({ bids: new Map(), asks: new Map(), at: 0 });
  const apply = (m, rows) => { for (const r of rows || []) { const p = +r[0], q = +r[1]; if (q === 0) m.delete(p); else m.set(p, q); } };
  const run = (name, url, onOpen, parse, pingMsg) => {
    if (g !== gen) return; let w, ping, dead = false;
    try { w = new WebSocket(url); } catch (e) { return; }
    xws.push(w);
    w.onopen = () => { onOpen(w); ping = setInterval(() => { try { w.send(pingMsg); } catch (e) {} }, 20000); };
    w.onmessage = ev => {
      if (g !== gen || ev.data === 'pong') return; let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.success === false || m.event === 'error') { dead = true; try { w.close(); } catch (e) {} return; }   // pair not listed there
      const u = parse(m); if (!u) return;
      let bk = S.xbook[name]; if (u.snap || !bk) bk = S.xbook[name] = mk();
      apply(bk.bids, u.b); apply(bk.asks, u.a); bk.at = Date.now();
    };
    w.onclose = () => { clearInterval(ping); delete S.xbook[name]; if (g === gen && !dead) setTimeout(() => run(name, url, onOpen, parse, pingMsg), 8000); };
  };
  run('bybit', 'wss://stream.bybit.com/v5/public/spot',
    w => w.send(JSON.stringify({ op: 'subscribe', args: ['orderbook.200.' + base + quote] })),
    m => m.topic && m.data ? { snap: m.type === 'snapshot', b: m.data.b, a: m.data.a } : null, '{"op":"ping"}');
  run('okx', 'wss://ws.okx.com:8443/ws/v5/public',
    w => w.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'books', instId: base + '-' + quote }] })),
    m => m.arg && m.arg.channel === 'books' && m.data && m.data[0] ? { snap: m.action === 'snapshot', b: m.data[0].bids, a: m.data[0].asks } : null, 'ping');
}

OF._venues = () => openVenues(gen);   // used by tests

/* Older 1h candles (about 5 more months) for the rules backtest. Kept apart from the live candle array. */
OF.loadOld1h = async function () {
  const S = OF.S; if (S.kxOld || S._kxLoading || OF.demo) return;
  const k = S.k['1h']; if (!k || !k.length) return;
  S._kxLoading = true;
  try {
    let end = k[0].t - 1, out = [];
    for (let i = 0; i < 3; i++) {
      const rows = await OF.getJ(`/api/v3/klines?symbol=${S.symbol}&interval=1h&endTime=${end}&limit=1000`);
      if (!rows.length) break;
      out = rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], qv: +r[7], bv: +r[9], bqv: +r[10] })).concat(out);
      end = rows[0][0] - 1; if (rows.length < 1000) break;
    }
    if (OF.S === S) S.kxOld = out;
  } catch (e) { S._kxLoading = false; }
};

/* ---------- Coinbase spot (US demand / premium) ---------- */
function openCoinbase(g) {
  const S = OF.S, base = S.info.base;
  if (!['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC', 'ADA', 'AVAX', 'LINK', 'BCH', 'DOT'].includes(base)) return;
  let w; try { w = cbws = new WebSocket('wss://ws-feed.exchange.coinbase.com'); } catch (e) { return; }
  w.onopen = () => w.send(JSON.stringify({ type: 'subscribe', product_ids: [base + '-USD'], channels: ['ticker'] }));
  w.onmessage = ev => {
    if (g !== gen) return;
    const d = JSON.parse(ev.data);
    if (d.type === 'ticker' && d.price) {
      const p = +d.price, prem = S.last ? (p - S.last) / S.last * 1e4 : 0;
      const h = (S.cbHist = S.cbHist || []); const t = Date.now();
      if (!h.length || t - h[h.length - 1].t > 5000) { h.push({ t, prem }); if (h.length > 400) h.shift(); }
      S.cb = { price: p, prem };
    }
  };
  w.onclose = () => { if (g === gen) setTimeout(() => { if (g === gen) openCoinbase(g); }, 8000); };
}

/* ---------- Deribit options → dealer gamma ---------- */
OF.loadGamma = async function (force) {
  const S = OF.S, base = S.info && S.info.base;
  if (!base) return;
  if (S.gamma && !force && Date.now() - S.gamma.at < 60000) return S.gamma;
  if (S.gammaLoading) return;
  S.gammaLoading = true;
  try {
    const native = base === 'BTC' || base === 'ETH';
    const cur = native ? base : 'USDC';
    if (!native && !['SOL', 'XRP', 'AVAX', 'TRX', 'BNB', 'PAXG'].includes(base)) { S.gamma = { supported: false, at: Date.now() }; return; }
    const r = await fetch(`https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${cur}&kind=option`).then(r => r.json());
    const rows = (r.result || []).filter(x => native || x.instrument_name.startsWith(base + '_USDC'));
    const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const opts = [];
    for (const x of rows) {
      const parts = x.instrument_name.split('-');      // BTC-8NOV26-76000-C
      const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(parts[1]); if (!m) continue;
      const exp = Date.UTC(2000 + +m[3], MON[m[2]], +m[1], 8);
      opts.push({ name: x.instrument_name, exp, expCode: parts[1], K: +parts[2].replace('d', '.'), call: parts[3] === 'C', oi: +x.open_interest || 0, iv: (+x.mark_iv || 0) / 100, und: +x.underlying_price || 0 });
    }
    S.gamma = { supported: true, opts, at: Date.now(), source: 'Deribit ' + (native ? base : base + '_USDC') + ' · ' + opts.length + ' options' };
    OF.emit('gamma');
  } catch (e) { S.gamma = { supported: true, error: e.message, opts: [], at: Date.now() }; }
  finally { S.gammaLoading = false; }
};

/* ---------- market list for the symbol picker ---------- */
OF.loadMetals = async function () {
  const out = [];
  await Promise.all(Object.entries(OF.METALS).map(async ([symbol, m]) => {
    try {
      const r = await OF.getJ((m.mkt === 'fut' ? '/fapi/v1' : '/api/v3') + '/ticker/24hr?symbol=' + symbol, m.mkt === 'fut' ? [FAPI] : SPOT_REST);
      out.push({ symbol, base: symbol.slice(0, -4), name: m.name, metal: m.sym, note: m.note, last: +r.lastPrice, chg: (+r.lastPrice / +r.openPrice - 1) * 100 });
    } catch (e) { out.push({ symbol, base: symbol.slice(0, -4), name: m.name, metal: m.sym, note: m.note, last: null, chg: 0 }); }
  }));
  OF._metals = Object.keys(OF.METALS).map(s => out.find(x => x.symbol === s));
  return OF._metals;
};
OF.loadMarkets = async function () {
  if (OF._markets) return OF._markets;
  const rows = await OF.getJ('/api/v3/ticker/24hr?type=MINI', SPOT_REST);
  OF._markets = rows.filter(r => r.symbol.endsWith('USDT') && +r.quoteVolume > 0)
    .map(r => ({ symbol: r.symbol, base: r.symbol.slice(0, -4), last: +r.lastPrice, chg: (+r.lastPrice / +r.openPrice - 1) * 100, qv: +r.quoteVolume }))
    .sort((a, b) => b.qv - a.qv);
  return OF._markets;
};
})();

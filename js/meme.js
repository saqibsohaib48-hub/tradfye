/* FlowDesk · Meme coins (long-term)
   1. Universe   every meme coin Binance lists. Found from CoinGecko's "meme-token" category and matched to Binance by
                 PRICE (look-alike tickers are dropped), plus a built-in list when CoinGecko is unavailable.
                 Spot pair first; a perpetual-futures pair only when there is no spot pair.
   2. Data       up to 1000 closed daily candles per coin, 24h tickers, futures funding, CoinGecko market cap and ATH.
   3. Score      long-term pump score 0–100 from daily data: trend, momentum vs the other memes, volume growth,
                 buyer share, base / breakout. A separate dump-risk score adds plain red flags.
   4. Plans      three DCA entries at supports, a weekly-close stop, three targets, size from capital and risk.
                 Tracked plans are followed candle by candle in My investments.
   5. Score test the same score replayed every week on history: did high scores really do better afterwards?
   Not advice. Meme coins can fall 90% or more, and the score test only sees coins that still trade (survivorship bias). */
(function () {
'use strict';
const OF = window.OF, C = OF.C, el = OF.el, ui = OF.ui, LS = OF.LS;
const M = OF.meme = {};
const DAY = 864e5;
const clamp = OF.clamp;

/* ---------- settings ---------- */
const DEF = { capital: 1000, riskPct: 1, maxAlloc: 3, minVol: 500000, futures: true, cgKey: '' };
M.cfg = () => Object.assign({}, DEF, LS.get('memecfg', {}));
M.setCfg = (k, v) => { const c = LS.get('memecfg', {}); c[k] = v; LS.set('memecfg', c); };

/* ---------- formatting ---------- */
const fmtP = v => { if (v == null || !isFinite(v)) return '--'; const a = Math.abs(v); if (a >= 1000) return v.toFixed(2); if (a >= 1) return v.toFixed(4); if (a === 0) return '0'; const d = Math.min(12, Math.max(4, -Math.floor(Math.log10(a)) + 3)); return v.toFixed(d); };
const fmtPct = (v, d) => v == null || !isFinite(v) ? '--' : (v >= 0 ? '+' : '') + (v * 100).toFixed(d == null ? (Math.abs(v) >= 10 ? 0 : 1) : d) + '%';
const cls = v => v == null ? 'muted' : v > 0 ? 'g' : v < 0 ? 'r' : 'muted';
M.fmtP = fmtP;

/* ---------- built-in list (used when CoinGecko is unavailable; unlisted ones are dropped automatically) ---------- */
const CURATED = [['DOGE', 'Dogecoin'], ['SHIB', 'Shiba Inu'], ['PEPE', 'Pepe'], ['TRUMP', 'Official Trump'], ['BONK', 'Bonk'], ['FLOKI', 'Floki'], ['WIF', 'dogwifhat'], ['PENGU', 'Pudgy Penguins'],
  ['FARTCOIN', 'Fartcoin'], ['SPX', 'SPX6900'], ['BRETT', 'Brett'], ['POPCAT', 'Popcat'], ['MOG', 'Mog Coin'], ['BOME', 'Book of Meme'], ['MEME', 'Memecoin'], ['PEOPLE', 'ConstitutionDAO'],
  ['TURBO', 'Turbo'], ['NEIRO', 'Neiro'], ['PNUT', 'Peanut the Squirrel'], ['ACT', 'Act I'], ['DOGS', 'Dogs'], ['NOT', 'Notcoin'], ['SATS', 'SATS'], ['CHEEMS', 'Cheems'], ['BABYDOGE', 'Baby Doge'],
  ['CAT', "Simon's Cat"], ['TST', 'Test'], ['MUBARAK', 'Mubarak'], ['BROCCOLI714', 'Broccoli'], ['MOODENG', 'Moo Deng'], ['GOAT', 'Goatseus Maximus'], ['MEW', 'cat in a dogs world'],
  ['RATS', 'Rats'], ['MYRO', 'Myro'], ['CHILLGUY', 'Just a chill guy'], ['PONKE', 'Ponke'], ['BAN', 'Comedian'], ['DEGEN', 'Degen'], ['SLERF', 'Slerf'], ['BANANAS31', 'Banana for Scale']];
const PRE = [['', 1], ['1000', 1000], ['1M', 1e6], ['1000000', 1e6]];

/* ---------- state ---------- */
M.st = { coins: [], byS: new Map(), status: 'idle', done: 0, total: 0, err: '', note: '', at: 0, tAt: 0, ver: 0, kver: 0, btc: null, src: '' };
const bump = () => { M.st.ver++; };
const OK = r => r && r.length;

/* CoinGecko meme category, cached for 6 hours (keyless public API allows ~10–30 calls a minute) */
async function loadCG() {
  const cache = LS.get('cgmeme', null);
  if (cache && Date.now() - cache.at < 6 * 36e5 && OK(cache.rows)) return cache.rows;
  const key = M.cfg().cgKey ? '&x_cg_demo_api_key=' + encodeURIComponent(M.cfg().cgKey) : '';
  const r = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=meme-token&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=7d,30d' + key);
  if (!r.ok) throw new Error('CoinGecko ' + r.status);
  const rows = (await r.json()).map(c => ({ id: c.id, symbol: c.symbol, name: c.name, image: c.image, price: c.current_price, mcap: c.market_cap, rank: c.market_cap_rank, ath: c.ath, athDate: c.ath_date }));
  LS.set('cgmeme', { at: Date.now(), rows });
  return rows;
}
const parseK = rows => {
  const now = Date.now(), k = rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], qv: +r[7], bqv: +r[10] }));
  while (k.length && k[k.length - 1].t + DAY > now) k.pop();       // only closed daily candles
  return k;
};
async function pool(items, n, fn) { let i = 0; const run = async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { it.err = e.message; } M.st.done++; if (M.st.done % 4 === 0) bump(); } }; await Promise.all(Array.from({ length: n }, run)); }

/* Load or refresh everything. Tickers every minute, candles every 30 minutes. */
M.load = function (force) {
  if (M.loading) return M.loading;
  const st = M.st;
  if (!force && st.coins.length && Date.now() - st.at < 30 * 60e3) { if (Date.now() - st.tAt > 60e3) M.refreshTickers(); return Promise.resolve(); }
  M.loading = (async () => {
    st.status = 'loading'; st.err = ''; st.note = ''; st.done = 0; st.total = 0; bump();
    try {
      if (OF.demo) { demoUniverse(); }
      else {
        const cfg = M.cfg();
        const [spotT, futT, prem, cg] = await Promise.all([
          OF.getJ('/api/v3/ticker/24hr', OF.SPOT_REST).catch(e => { st.err = 'Binance spot: ' + e.message; return []; }),
          OF.getJ('/fapi/v1/ticker/24hr', [OF.FAPI]).catch(() => []),
          OF.getJ('/fapi/v1/premiumIndex', [OF.FAPI]).catch(() => []),
          loadCG().catch(e => { st.note = 'CoinGecko unavailable (' + e.message + ') — using the built-in meme list, without market caps.'; return null; })]);
        const spot = new Map(spotT.filter(t => t.symbol.endsWith('USDT') && +t.quoteVolume > 0).map(t => [t.symbol, t]));
        const fut = new Map(futT.filter(t => t.symbol.endsWith('USDT') && +t.quoteVolume > 0).map(t => [t.symbol, t]));
        const fund = new Map(prem.map(x => [x.symbol, +x.lastFundingRate]));
        const cands = [], seen = new Set();
        for (const c of cg || []) { const s = (c.symbol || '').toUpperCase(); if (!s || seen.has(s) || !(c.mcap > 0)) continue; seen.add(s); cands.push({ sym: s, name: c.name, cg: c }); }
        for (const [s, n] of CURATED) if (!seen.has(s)) { seen.add(s); cands.push({ sym: s, name: n, cg: null }); }
        const coins = [], futOnly = {};
        for (const c of cands) {
          let hit = null;
          for (const [pre, mult] of PRE) { const s = pre + c.sym + 'USDT', t = spot.get(s); if (t) { hit = { symbol: s, mkt: 'spot', mult, t }; break; } }
          if (!hit && cfg.futures) for (const [pre, mult] of PRE) { const s = pre + c.sym + 'USDT', t = fut.get(s); if (t) { hit = { symbol: s, mkt: 'fut', mult, t }; break; } }
          if (!hit) continue;
          const last = +hit.t.lastPrice, qv = +hit.t.quoteVolume;
          // same coin? CoinGecko price and Binance price must agree (drops look-alike tickers)
          if (c.cg && c.cg.price > 0) { const ratio = last / hit.mult / c.cg.price; if (ratio < 0.8 || ratio > 1.25) continue; }
          if (qv < cfg.minVol) continue;
          const fr = fund.has(hit.symbol) ? fund.get(hit.symbol) : [c.sym, '1000' + c.sym, '1M' + c.sym].map(s => fund.get(s + 'USDT')).find(v => v != null);
          coins.push({ sym: c.sym, name: c.name, symbol: hit.symbol, mkt: hit.mkt, mult: hit.mult, last, open: +hit.t.openPrice, chg24: +hit.t.priceChangePercent / 100, qv,
            mcap: c.cg ? c.cg.mcap : null, mrank: c.cg ? c.cg.rank : null, ath: c.cg && c.cg.ath ? c.cg.ath * hit.mult : null, athDate: c.cg ? c.cg.athDate : null, image: c.cg ? c.cg.image : null,
            funding: fr == null ? null : fr, k: null });
          if (hit.mkt === 'fut') futOnly[hit.symbol] = 1;
        }
        coins.sort((a, b) => b.qv - a.qv);
        st.coins = coins.slice(0, 90); st.src = cg ? 'CoinGecko meme category + Binance' : 'built-in list + Binance';
        OF.FUTONLY = Object.assign(OF.FUTONLY || {}, futOnly); LS.set('futonly', Object.assign(LS.get('futonly', {}), futOnly));
        st.total = st.coins.length + 1; bump();
        const kpath = c => (c.mkt === 'fut' ? '/fapi/v1/klines' : '/api/v3/klines') + `?symbol=${c.symbol}&interval=1d&limit=1000`;
        const btc = { symbol: 'BTCUSDT', mkt: 'spot' };
        await pool([btc].concat(st.coins), 4, async c => { c.k = parseK(await OF.getJ(kpath(c), c.mkt === 'fut' ? [OF.FAPI] : OF.SPOT_REST)); });
        st.btc = btc.k || null;
      }
      st.byS = new Map(st.coins.map(c => [c.symbol, c]));
      LS.set('memesyms', st.coins.slice(0, 40).map(c => ({ symbol: c.symbol, sym: c.sym, name: c.name, mkt: c.mkt })));
      M.compute(); st.at = st.tAt = Date.now(); st.status = st.coins.length ? 'ready' : 'empty';
      if (!st.coins.length && !st.err) st.err = 'No meme coins found on Binance with enough volume.';
      M.trackAll();
    } catch (e) { st.status = 'error'; st.err = e.message; console.error(e); }
    finally { st.kver++; bump(); M.loading = null; }
  })();
  return M.loading;
};
M.refreshTickers = async function () {
  const st = M.st; if (OF.demo || !st.coins.length || M._tk) return; M._tk = true;
  try {
    const [s, f] = await Promise.all([OF.getJ('/api/v3/ticker/24hr', OF.SPOT_REST).catch(() => []), st.coins.some(c => c.mkt === 'fut') ? OF.getJ('/fapi/v1/ticker/24hr', [OF.FAPI]).catch(() => []) : []]);
    const m = new Map(s.concat(f).map(t => [t.symbol, t]));
    for (const c of st.coins) { const t = m.get(c.symbol); if (t) { c.last = +t.lastPrice; c.chg24 = +t.priceChangePercent / 100; c.qv = +t.quoteVolume; } }
    st.tAt = Date.now(); M.compute(); M.trackAll(); bump();
  } finally { M._tk = false; }
};

/* ---------- features from daily candles (only data up to day i is used) ---------- */
function prep(k) {
  const n = k.length, pc = new Float64Array(n + 1), pq = new Float64Array(n + 1), pb = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { pc[i + 1] = pc[i] + k[i].c; pq[i + 1] = pq[i] + k[i].qv; pb[i + 1] = pb[i] + k[i].bqv; }
  return { k, n, pc, pq, pb, idx: new Map(k.map((c, i) => [c.t, i])) };
}
const mean = (pre, i, n) => (pre[i + 1] - pre[i + 1 - n]) / n;           // average of the n values ending at day i
function feats(D, i, live) {
  const k = D.k, age = i + 1; if (age < 60) return null;
  const p = live || k[i].c, L = Math.min(200, age - 1), sL = mean(D.pc, i, L), s50 = mean(D.pc, i, 50), s50p = age >= 70 ? mean(D.pc, i - 20, 50) : s50;
  const back = n => k[Math.max(0, i - n)].c;
  const r7 = p / back(7) - 1, r30 = p / back(30) - 1, r90 = age > 90 ? p / back(90) - 1 : null;
  const volG = age >= 90 ? mean(D.pq, i, 30) / ((D.pq[i + 1 - 30] - D.pq[i + 1 - 90]) / 60) : mean(D.pq, i, 30) / mean(D.pq, i, age - 1);
  const buy30 = (D.pb[i + 1] - D.pb[i + 1 - 30]) / ((D.pq[i + 1] - D.pq[i + 1 - 30]) || 1);
  let hi30 = 0, lo30 = Infinity, hi90 = 0, lo90 = Infinity, hi365 = 0, lo365 = Infinity, sr = 0, sr2 = 0;
  for (let j = i, m = 0; j >= 0 && m < 365; j--, m++) {
    const c = k[j];
    if (m < 30) { hi30 = Math.max(hi30, c.h); lo30 = Math.min(lo30, c.l); if (j > 0) { const r = Math.log(c.c / k[j - 1].c); sr += r; sr2 += r * r; } }
    if (m < 90) { hi90 = Math.max(hi90, c.h); lo90 = Math.min(lo90, c.l); }
    hi365 = Math.max(hi365, c.h); lo365 = Math.min(lo365, c.l);
  }
  const vol30 = Math.sqrt(Math.max(0, sr2 / 30 - (sr / 30) ** 2));
  const trend = 0.4 * (p > sL ? 1 : -1) + 0.3 * (p > s50 ? 1 : -1) + 0.3 * clamp((s50 / s50p - 1) * 10, -1, 1);
  const base = (hi90 > lo90 ? 1 - (hi30 - lo30) / (hi90 - lo90) : 0) * 0.6 + (p >= hi30 * 0.92 ? 0.4 : 0);
  return { p, age, L, sL, s50, r7, r30, r90, volG, buy30, trend, base, hi30, lo30, hi90, lo90, hi365, lo365, vol30, dd: p / hi365 - 1 };
}

/* ---------- the score ----------
   Weights of the pump score. Momentum, volume, buyers and base are ranked against the other meme coins on the same day
   (0 = weakest, 1 = strongest); trend is absolute. Change these to change how the score thinks. */
const W = { mom90: 0.25, mom30: 0.15, trend: 0.25, volume: 0.15, buyers: 0.10, base: 0.10 };
M.W = W;
function ranker(vals) {
  const v = vals.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  return x => { if (x == null || !isFinite(x) || v.length < 2) return 0.5; let lo = 0, hi = v.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] < x) lo = m + 1; else hi = m; } return lo / (v.length - 1); };
}
function scoreSet(list, liveData) {
  const R = { r90: ranker(list.map(x => x.f.r90 != null ? x.f.r90 : x.f.r30)), r30: ranker(list.map(x => x.f.r30)), volG: ranker(list.map(x => x.f.volG)), buy30: ranker(list.map(x => x.f.buy30)), base: ranker(list.map(x => x.f.base)) };
  for (const x of list) {
    const f = x.f, parts = { mom90: R.r90(f.r90 != null ? f.r90 : f.r30), mom30: R.r30(f.r30), trend: (f.trend + 1) / 2, volume: R.volG(f.volG), buyers: R.buy30(f.buy30), base: R.base(f.base) };
    let s = 0; for (const k in W) s += W[k] * parts[k]; s *= 100;
    const pen = [];
    if (f.r30 > 1.5) { s -= 10; pen.push('already +' + Math.round(f.r30 * 100) + '% in 30 days'); }
    if (f.age < 120) { s -= 5; pen.push('young coin, little history'); }
    if (liveData && x.c.qv < 1e6) { s -= 8; pen.push('thin volume'); }
    if (liveData && x.c.funding > 0.0005) { s -= 6; pen.push('crowded longs (high funding)'); }
    x.parts = parts; x.pen = pen; x.score = clamp(s, 0, 100);
    // dump risk: plain red flags with points
    let d = 0; const flags = [];
    if (f.p < f.sL && f.trend < 0) { d += 25; flags.push(`below its ${f.L}-day average and falling`); }
    if (parts.mom30 < 0.2) { d += 15; flags.push('among the weakest memes over 30 days'); }
    if (f.volG < 0.7 && f.r30 < 0) { d += 15; flags.push('volume drying up while price falls'); }
    if (f.buy30 < 0.47) { d += 15; flags.push(`sellers ${Math.round((1 - f.buy30) * 100)}% of 30-day volume`); }
    if (f.r30 > 1.5) { d += 20; flags.push('pumped hard — pullback risk'); }
    if (liveData && x.c.funding > 0.0005) { d += 10; flags.push('crowded longs (high funding)'); }
    if (f.dd < -0.8 && (f.r90 == null || f.r90 < 0)) { d += 10; flags.push(`down ${Math.round(-f.dd * 100)}% from its 1-year high, no recovery`); }
    x.dump = Math.min(100, d); x.flags = flags;
    x.sig = signal(x);
  }
}
function signal(x) {
  const f = x.f, up = f.p > f.sL && f.trend > 0.2;
  if (x.dump >= 60) return { k: 'dump', t: '⚠ Dump risk — avoid', c: 'r' };
  if (x.score >= 70 && up) return { k: 'strong', t: '🚀 Accumulate', c: 'g' };
  if (x.score >= 58) return { k: 'dip', t: '✅ Buy on dips', c: 'g' };
  if (x.score >= 42) return { k: 'wait', t: '⏸ Wait', c: 'y' };
  return { k: 'weak', t: '↘ Weak — avoid', c: 'r' };
}
const BANDS = [[70, 101, '70+'], [58, 70, '58–69'], [42, 58, '42–57'], [0, 42, 'under 42']];

/* live scores for every coin */
M.compute = function () {
  const st = M.st, list = [];
  for (const c of st.coins) {
    c.x = null; if (!c.k || c.k.length < 60) continue;
    if (!c.D || c.D.k !== c.k) c.D = prep(c.k);
    const f = feats(c.D, c.D.n - 1, c.last); if (!f) continue;
    const x = { c, D: c.D, f }; c.x = x; list.push(x);
  }
  if (list.length >= 3) scoreSet(list, true);
  // meme season: share of memes above their long average, and the median 30-day move against Bitcoin
  const above = list.filter(x => x.f.p > x.f.sL).length, r30 = list.map(x => x.f.r30).sort((a, b) => a - b);
  const btc = st.btc && st.btc.length > 31 ? st.btc[st.btc.length - 1].c / st.btc[st.btc.length - 31].c - 1 : null;
  const breadth = list.length ? above / list.length : null, med = r30.length ? r30[r30.length >> 1] : null;
  st.season = { breadth, med, btc, n: list.length,
    v: breadth == null ? '—' : breadth >= 0.6 && (btc == null || med > btc) ? 'ON' : breadth < 0.35 || (breadth < 0.5 && btc != null && med < btc - 0.15) ? 'OFF' : 'MIXED' };
};

/* ---------- score test: replay the score every week on history ---------- */
M.backtest = function () {
  const st = M.st;
  if (M._bt && M._bt.kver === st.kver) return M._bt;
  const coins = st.coins.filter(c => c.D && c.D.n > 150);
  if (coins.length < 8) return null;
  const cal = (st.btc && st.btc.length > 200 ? st.btc : coins.reduce((a, c) => c.k.length > a.length ? c.k : a, [])).map(c => c.t);
  const obs = [], periods = [];
  for (let d = cal.length - 31; d >= 0; d -= 7) {
    const T = cal[d], list = [];
    for (const c of coins) {
      const i = c.D.idx.get(T); if (i == null || i < 119 || i + 30 >= c.D.n) continue;
      const f = feats(c.D, i); if (!f) continue;
      list.push({ c, D: c.D, f, i, fwd30: c.k[i + 30].c / c.k[i].c - 1, fwd90: i + 90 < c.D.n ? c.k[i + 90].c / c.k[i].c - 1 : null });
    }
    if (list.length < 8) continue;
    scoreSet(list, false);
    list.sort((a, b) => b.score - a.score);
    list.forEach((x, r) => obs.push({ T, q: 4 - Math.min(4, Math.floor(r / list.length * 5)), score: x.score, sig: x.sig.k, fwd30: x.fwd30, fwd90: x.fwd90 }));
    const top = list.slice(0, 5), avg = a => a.reduce((s, x) => s + x.fwd30, 0) / a.length;
    periods.push({ T, top: avg(top), all: avg(list), n: list.length });
  }
  if (!obs.length) return null;
  const stat = arr => {
    const s30 = arr.map(o => o.fwd30).sort((a, b) => a - b), s90 = arr.filter(o => o.fwd90 != null).map(o => o.fwd90).sort((a, b) => a - b);
    const m = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null, md = a => a.length ? a[a.length >> 1] : null, pos = a => a.length ? a.filter(v => v > 0).length / a.length : null;
    return { n: arr.length, mean30: m(s30), med30: md(s30), pos30: pos(s30), n90: s90.length, mean90: m(s90), med90: md(s90), pos90: pos(s90) };
  };
  const quint = [4, 3, 2, 1, 0].map(q => Object.assign({ label: ['Bottom 20%', '20–40%', '40–60%', '60–80%', 'Top 20%'][q] }, stat(obs.filter(o => o.q === q))));
  const bands = BANDS.map(([a, b, label]) => Object.assign({ label, a, b }, stat(obs.filter(o => o.score >= a && o.score < b))));
  const sigs = [['strong', '🚀 Accumulate'], ['dip', '✅ Buy on dips'], ['wait', '⏸ Wait'], ['weak', '↘ Weak'], ['dump', '⚠ Dump risk']].map(([k, label]) => Object.assign({ label, k }, stat(obs.filter(o => o.sig === k))));
  periods.reverse();
  // equity: one 30-day hold every 4 weeks (non-overlapping), top 5 vs all memes equally weighted
  let eqT = 1, eqA = 1; const eq = [];
  for (let j = 0; j < periods.length; j += 4) { eqT *= 1 + periods[j].top; eqA *= 1 + periods[j].all; eq.push({ T: periods[j].T, top: eqT, all: eqA }); }
  const beat = periods.filter(p => p.top > p.all).length / periods.length;
  M._bt = { kver: st.kver, quint, bands, sigs, eq, beat, weeks: periods.length, from: periods[0].T, to: periods[periods.length - 1].T, coins: coins.length, obs: obs.length };
  return M._bt;
};
M.bandOf = s => { const bt = M.backtest(); return bt ? bt.bands.find(b => s >= b.a && s < b.b) : null; };

/* ---------- long-term plan ---------- */
function weeklyRange(k) {
  // average weekly range as a share of price, over the last 12 full weeks (weeks start Monday UTC)
  const w = new Map();
  for (const c of k.slice(-100)) { const d = new Date(c.t), wk = c.t - ((d.getUTCDay() + 6) % 7) * DAY; let x = w.get(wk); if (!x) w.set(wk, x = { h: 0, l: Infinity, c: 0 }); x.h = Math.max(x.h, c.h); x.l = Math.min(x.l, c.l); x.c = c.c; }
  const arr = [...w.values()].slice(-13, -1); if (!arr.length) return 0.2;
  return arr.reduce((s, x) => s + (x.h - x.l) / x.c, 0) / arr.length;
}
M.plan = function (c) {
  const x = c.x; if (!x) return null;
  const f = x.f, p = c.last || f.p, wr = clamp(weeklyRange(c.k), 0.05, 0.6), cfg = M.cfg();
  const sup = [[f.s50, '50-day average'], [f.lo30, '30-day low'], [f.sL, f.L + '-day average'], [f.lo90, '90-day low'], [f.lo365, '1-year low']]
    .filter(([v]) => v > 0 && v < p * 0.995).sort((a, b) => b[0] - a[0]);
  const below = (lvl, gap) => sup.find(([v]) => v < lvl * (1 - gap));
  const strong = x.sig.k === 'strong';
  const s1 = sup.find(([v]) => v > p * 0.75);
  const e1 = strong ? { p, src: 'now — strong trend' } : s1 ? { p: s1[0], src: s1[1] } : { p: p * (1 - Math.max(0.08, wr)), src: 'one weekly range below price' };
  const n2 = below(e1.p, 0.08), e2 = n2 ? { p: n2[0], src: n2[1] } : { p: e1.p * (1 - Math.max(0.1, 1.2 * wr)), src: 'one weekly range below entry 1' };
  const n3 = below(e2.p, 0.08), e3 = n3 ? { p: n3[0], src: n3[1] } : { p: e2.p * (1 - Math.max(0.1, 1.2 * wr)), src: 'one weekly range below entry 2' };
  const ents = [Object.assign(e1, { w: 0.3 }), Object.assign(e2, { w: 0.3 }), Object.assign(e3, { w: 0.4 })];
  const avg = ents.reduce((s, e) => s + e.p * e.w, 0);
  // the 1-year low anchors the stop only when it sits close under buy 3; after a big run-up it is too far away to be useful
  const floor = f.lo365 > 0 && f.lo365 < e3.p && f.lo365 >= e3.p * 0.75 ? f.lo365 : e3.p;
  let stop = floor * (1 - Math.max(0.06, 0.6 * wr)), stopSrc = floor < e3.p ? 'weekly close below the 1-year low' : 'weekly close below buy 3';
  if (stop > e3.p * 0.92) stop = e3.p * 0.92;
  const ath = c.ath && c.ath > 0 ? c.ath : Math.max(...c.k.map(k => k.h));
  const t1 = f.hi90 >= avg * 1.5 ? { p: f.hi90, src: '90-day high' } : { p: avg * 1.5, src: '+50% from the average entry' };
  const t2 = f.hi365 >= t1.p * 1.4 ? { p: f.hi365, src: '1-year high' } : { p: t1.p * 1.4, src: '+40% above target 1' };
  const t3 = ath >= t2.p * 1.15 ? { p: ath, src: c.ath ? 'all-time high' : 'highest price on Binance' } : { p: t2.p * 1.6, src: '+60% above target 2' };
  const risk = avg - stop, lossFrac = risk / avg;
  const invest = Math.min(cfg.capital * cfg.riskPct / 100 / lossFrac, cfg.capital * cfg.maxAlloc / 100);
  const tps = [t1, t2, t3].map(t => Object.assign(t, { rr: (t.p - avg) / risk, pct: t.p / avg - 1 }));
  // a holder's exit plan for coins the score dislikes
  const exitLvl = sup[0] ? sup[0][0] : p * (1 - wr), sellInto = Math.max(f.s50 > p ? f.s50 : 0, f.hi30 > p * 1.05 ? f.hi30 : 0) || p * (1 + wr);
  return { c, x, p, wr, ents, avg, stop, stopSrc, tps, lossFrac, invest, riskUsd: invest * lossFrac, ath, band: M.bandOf(x.score),
    hold: { exit: exitLvl, exitSrc: sup[0] ? sup[0][1] : 'one weekly range below', sellInto }, buyable: x.sig.k === 'strong' || x.sig.k === 'dip' };
};

/* ---------- tracked plans (My investments) ---------- */
const FINAL = { done: 1, stopped: 1, expired: 1, closed: 1 };
M.plans = () => { if (!M._pl) M._pl = LS.get('memeplans', []); return M._pl; };
M.savePlans = () => LS.set('memeplans', M.plans().slice(-100));
M.track = function (pl0) {
  const t = Date.now();
  const pl = { id: t, symbol: pl0.c.symbol, sym: pl0.c.sym, name: pl0.c.name, mkt: pl0.c.mkt, mult: pl0.c.mult, created: t, score: Math.round(pl0.x.score),
    ents: pl0.ents.map(e => ({ p: e.p, w: e.w, src: e.src, fill: null, at: null, now: /now/.test(e.src) })), stop: pl0.stop, stopNow: pl0.stop, stopSrc: pl0.stopSrc,
    tps: pl0.tps.map(x => ({ p: x.p, src: x.src, hit: false, at: null })), invest: pl0.invest, state: 'waiting', base: 0, sold: 0, cash: 0, events: [[t, 'Plan tracked — ' + pl0.ents.length + ' buy orders placed']], lastT: Math.floor(t / DAY) * DAY - DAY, day0: Math.floor(t / DAY) * DAY };
  for (const e of pl.ents) if (e.now) { e.fill = pl0.p; e.at = t; pl.events.push([t, 'Entry 1 bought now at ' + fmtP(pl0.p)]); pl.state = 'building'; }
  M.plans().push(pl); M.savePlans(); bump(); return pl;
};
const qtyOf = pl => pl.ents.reduce((s, e) => s + (e.fill ? pl.invest * e.w / e.fill : 0), 0);
const costOf = pl => pl.ents.reduce((s, e) => s + (e.fill ? pl.invest * e.w : 0), 0);
M.pnl = function (pl, px) {
  const q = qtyOf(pl), cost = costOf(pl), held = q - pl.sold, value = pl.cash + held * (FINAL[pl.state] ? 0 : px || 0);
  return { q, cost, held, value, pnl: value - cost, pct: cost ? (value - cost) / cost : 0, avg: q ? cost / q : null };
};
function step(pl, c0, isWeekClose) {
  if (FINAL[pl.state]) return;
  // the candle of the day the plan was made also holds prices from before it: judge that day on its close only
  const c = c0.t === pl.day0 ? { t: c0.t, o: c0.c, h: c0.c, l: c0.c, c: c0.c } : c0;
  const ev = m => pl.events.push([c.t + DAY - 1, m]);
  // buy orders
  if (!pl.tps[0].hit) pl.ents.forEach((e, i) => { if (!e.fill && c.l <= e.p) { e.fill = Math.min(e.p, c.o); e.at = c.t; ev(`Entry ${i + 1} bought at ${fmtP(e.fill)}`); } });
  const q = qtyOf(pl);
  if (q > 0) {
    pl.tps.forEach((x, i) => {
      if (x.hit || (i && !pl.tps[i - 1].hit) || c.h < x.p) return;
      if (i === 0) { pl.base = q; pl.ents.forEach(e => { if (!e.fill) e.cancel = true; }); pl.stopNow = Math.max(pl.stopNow, costOf(pl) / q); }
      const sell = i === 2 ? pl.base - pl.sold : pl.base / 3; pl.sold += sell; pl.cash += sell * x.p; x.hit = true; x.at = c.t;
      ev(`Target ${i + 1} reached — sold ${i === 2 ? 'the rest' : 'a third'} at ${fmtP(x.p)}${i === 0 ? '; stop moved to break-even, unfilled buys cancelled' : ''}`);
      if (i === 2) { pl.state = 'done'; pl.closedAt = c.t; }
    });
    if (!FINAL[pl.state] && isWeekClose && c.c <= pl.stopNow) {
      const held = q - pl.sold; pl.cash += held * c.c; pl.sold = q; pl.state = 'stopped'; pl.closedAt = c.t;
      ev(`Weekly close ${fmtP(c.c)} below the stop ${fmtP(pl.stopNow)} — sold the rest`);
    }
    if (!FINAL[pl.state]) pl.state = pl.tps[1].hit ? 'tp2' : pl.tps[0].hit ? 'tp1' : pl.ents.every(e => e.fill) ? 'holding' : 'building';
  } else if (c.t - pl.created > 60 * DAY) { pl.state = 'expired'; pl.closedAt = c.t; ev('No buy order filled in 60 days — plan cancelled'); }
}
M.trackAll = function () {
  let ch = false;
  for (const pl of M.plans()) {
    if (FINAL[pl.state]) continue;
    const c = M.st.byS.get(pl.symbol); if (!c || !c.k) continue;
    for (const k of c.k) if (k.t > pl.lastT) { step(pl, k, new Date(k.t).getUTCDay() === 0); pl.lastT = k.t; ch = true; }
  }
  if (ch) M.savePlans();
};
M.closePlan = (pl, px) => { const q = qtyOf(pl), held = q - pl.sold; pl.cash += held * px; pl.sold = q; pl.state = 'closed'; pl.closedAt = Date.now(); pl.events.push([Date.now(), 'Closed by you at ' + fmtP(px)]); M.savePlans(); bump(); };

/* ---------- demo data (?demo=1): a made-up universe so the tab can be previewed offline ---------- */
function demoUniverse() {
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const names = [['DOGE', 'Dogecoin', 0.18, 1000], ['SHIB', 'Shiba Inu', 0.000014, 1000], ['PEPE', 'Pepe', 0.0000095, 900], ['WIF', 'dogwifhat', 0.9, 700], ['BONK', 'Bonk', 0.000021, 800], ['FLOKI', 'Floki', 0.00009, 1000],
    ['TRUMP', 'Official Trump', 9, 560], ['PENGU', 'Pudgy Penguins', 0.012, 600], ['FARTCOIN', 'Fartcoin', 0.7, 500], ['SPX', 'SPX6900', 0.6, 420], ['BOME', 'Book of Meme', 0.002, 900], ['POPCAT', 'Popcat', 0.3, 650],
    ['MEME', 'Memecoin', 0.004, 1000], ['TURBO', 'Turbo', 0.004, 900], ['NEIRO', 'Neiro', 0.0004, 700], ['PNUT', 'Peanut the Squirrel', 0.2, 600], ['DOGS', 'Dogs', 0.00015, 500], ['PEOPLE', 'ConstitutionDAO', 0.02, 1000],
    ['MOODENG', 'Moo Deng', 0.15, 600], ['BRETT', 'Brett', 0.04, 600], ['ACT', 'Act I', 0.05, 600], ['MOG', 'Mog Coin', 0.0000008, 500], ['CHILLGUY', 'Just a chill guy', 0.03, 360], ['NEWPUMP', 'Brand New Pump', 0.01, 90]];
  const now = Math.floor(Date.now() / DAY) * DAY, mk = (p0, n, drift, volume) => {
    const k = []; let p = p0 * Math.exp(-drift * n * 0.6);
    for (let i = n; i >= 1; i--) {
      const regime = Math.sin((n - i) / 70 + drift * 40) * 0.012 + drift, r = regime + (rnd() - 0.5) * 0.09, o = p; p = Math.max(p0 * 0.002, p * Math.exp(r));
      const h = Math.max(o, p) * (1 + rnd() * 0.05), l = Math.min(o, p) * (1 - rnd() * 0.05), qv = volume * (0.5 + rnd()) * (1 + Math.max(0, r) * 6);
      k.push({ t: now - i * DAY, o, h, l, c: p, v: qv / p, qv, bqv: qv * clamp(0.5 + r * 2 + (rnd() - 0.5) * 0.04, 0.3, 0.7) });
    }
    return k;
  };
  M.st.btc = mk(90000, 1000, 0.0006, 5e9);
  M.st.coins = names.map(([sym, name, price, n], j) => {
    const drift = (rnd() - 0.45) * 0.006, k = mk(price, n, drift, 2e6 + rnd() * 2e8), last = k[k.length - 1].c * (1 + (rnd() - 0.5) * 0.04);
    return { sym, name, symbol: sym + 'USDT', mkt: 'spot', mult: 1, last, open: k[k.length - 1].c, chg24: last / k[k.length - 1].c - 1, qv: k[k.length - 1].qv, mcap: Math.round(5e7 * Math.exp(rnd() * 6)),
      mrank: j + 1, ath: Math.max(...k.map(x => x.h)) * (1 + rnd() * 1.5), image: null, funding: (rnd() - 0.3) * 0.0008, k };
  }).sort((a, b) => b.qv - a.qv);
  M.st.src = 'demo data'; M.st.total = M.st.done = M.st.coins.length;
}

/* ================================== the tab ================================== */
const SUBS = [['list', '📋 All meme coins'], ['radar', '🚀 Pump / dump radar'], ['plans', '📈 Long-term plans'], ['mine', '💼 My investments'], ['test', '🧪 Score test']];
OF.views.meme = {
  label: 'Meme coins', title: 'Meme coins — every meme coin on Binance, pump / dump radar, long-term investment plans',
  o: Object.assign({ sub: 'list', sort: 'score', dir: -1, q: '', sel: null, selPlan: null }, LS.get('memeview', {})),
  save() { LS.set('memeview', this.o); },
  noChart() { return !(this.o.sub === 'plans' || this.o.sub === 'mine'); },
  fsLabel() { const c = this.sel().c; return c ? { name: '🐸 ' + c.sym + '/USDT · ' + (this.o.sub === 'mine' ? 'My investment' : 'Long-term plan'), price: fmtP(c.last) } : null; },
  toolbar(tb) {
    const o = this.o, open = M.plans().filter(p => !FINAL[p.state]).length;
    tb.append(ui.seg('', SUBS.map(([k, t]) => [k, k === 'mine' && open ? `${t} (${open})` : t]), o.sub, v => { o.sub = v; this.save(); OF.app.remount(); }));
    const rf = el('button', 'tgl', '↻ Refresh'); rf.title = 'Reload the meme list, candles and prices'; rf.onclick = () => { LS.set('cgmeme', null); M.load(true); }; tb.append(rf);
    const gear = el('button', 'tgl', '⚙ Settings'); gear.onclick = () => this.settings(gear); tb.append(gear);
    tb.append(el('span', 'lbl', 'Long-term (weeks to months) · daily candles · not advice'));
  },
  settings(anchor) {
    let pop = document.getElementById('mmPop'); if (pop) { pop.remove(); return; }
    const c = M.cfg(); pop = el('div', 'colspop mmpop'); pop.id = 'mmPop';
    const r = anchor.getBoundingClientRect(); pop.style.top = (r.bottom + 8) + 'px'; pop.style.left = Math.max(8, Math.min(window.innerWidth - 380, r.left - 100)) + 'px';
    pop.innerHTML = `<div class="cph">Meme coin settings <button class="cpx">✕</button></div>
      <label class="mmf">Investment capital $ <input type="number" data-k="capital" min="10" step="10" value="${c.capital}"></label>
      <label class="mmf">Risk per coin, % of capital <input type="number" data-k="riskPct" min="0.1" step="0.1" value="${c.riskPct}"><span class="muted sm">what you lose if the stop is hit</span></label>
      <label class="mmf">Max per coin, % of capital <input type="number" data-k="maxAlloc" min="0.5" step="0.5" value="${c.maxAlloc}"></label>
      <label class="mmf">Min 24h volume $ <input type="number" data-k="minVol" min="0" step="100000" value="${c.minVol}"></label>
      <label class="vrow"><input type="checkbox" data-k="futures" ${c.futures ? 'checked' : ''}> Include memes listed only on Binance futures</label>
      <label class="mmf">CoinGecko demo API key <input type="text" data-k="cgKey" value="${c.cgKey || ''}" placeholder="optional — free at coingecko.com/api"></label>
      <div class="muted sm">Volume, futures and key changes apply after ↻ Refresh.</div>`;
    pop.querySelectorAll('[data-k]').forEach(i => i.onchange = () => { M.setCfg(i.dataset.k, i.type === 'checkbox' ? i.checked : i.type === 'number' ? +i.value : i.value.trim()); this._v = -1; });
    pop.querySelector('.cpx').onclick = () => pop.remove();
    document.body.appendChild(pop);
    setTimeout(() => document.addEventListener('pointerdown', function f(e) { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('pointerdown', f); } }), 0);
  },
  mount(v) {
    this.root = v; v.classList.add('scroll'); this._v = -1; this.zv = { n: 365, off: 0 };
    const s = this.o.sub;
    if (s === 'plans' || s === 'mine') {
      v.innerHTML = `<div id="mmHead"></div><div class="mmgrid"><div class="mmside" id="mmPick"></div><div class="mmcol"><div id="mmCard"></div><div class="gbox mmchart" id="mmChart"></div><div id="mmLog"></div></div></div>`;
      this.c = ui.canvas(document.getElementById('mmChart')); ui.track(this);
      const cv = this.c.cv; let drag = null;
      cv.onwheel = e => { e.preventDefault(); this.zv.n = clamp(Math.round(this.zv.n * (e.deltaY > 0 ? 1.15 : 0.87)), 30, 1000); };
      cv.onmousedown = e => { drag = { x: e.clientX, off: this.zv.off }; };
      window.addEventListener('mouseup', () => drag = null);
      cv.addEventListener('mousemove', e => { if (drag && this.bw) this.zv.off = Math.max(0, drag.off + Math.round((e.clientX - drag.x) / this.bw)); });
      cv.ondblclick = () => { this.zv = { n: 365, off: 0 }; };
    } else v.innerHTML = '<div id="mmHead"></div><div id="mmBody"></div>';
    M.load();
  },
  unmount() { const p = document.getElementById('mmPop'); if (p) p.remove(); },
  reading() {
    const st = M.st, s = st.season;
    if (st.status === 'loading') return `Loading meme coins… ${st.done}/${st.total || '?'} candle sets`;
    if (!s || s.breadth == null) return st.err || 'Loading…';
    return `<b>${st.coins.length}</b> meme coins (${st.src}). Meme season: <b class="${s.v === 'ON' ? 'g' : s.v === 'OFF' ? 'r' : 'y'}">${s.v}</b> — ${Math.round(s.breadth * 100)}% are above their long average; median meme 30 days ${fmtPct(s.med)} vs Bitcoin ${fmtPct(s.btc)}. Long-term buys work best when the season is ON. Not financial advice.`;
  },
  render() {
    if (Date.now() - M.st.tAt > 60e3 && M.st.status === 'ready') M.refreshTickers();
    if (this._v !== M.st.ver) { this._v = M.st.ver; try { this.html(); } catch (e) { console.error(e); } }
    if (this.c) this.drawChart();
  },
  head() {
    const st = M.st, h = document.getElementById('mmHead'); if (!h) return;
    if (st.status === 'loading' || st.status === 'idle') { const pc = st.total ? Math.round(st.done / st.total * 100) : 3; h.innerHTML = `<div class="mmload"><b>Loading meme coins…</b> ${st.done}/${st.total || '?'} <div class="bar plain"><i style="width:${pc}%"></i></div><span class="muted sm">About 1,000 daily candles per coin — takes a few seconds the first time.</span></div>`; return; }
    const s = st.season || {};
    h.innerHTML = (st.err ? `<div class="plstatus risk"><span class="pli">⚠</span><div><div class="plsh">${st.err}</div><div class="plsb">Check the connection and press ↻ Refresh.</div></div></div>` : '') +
      (st.note ? `<div class="muted sm mmnote">${st.note}</div>` : '') +
      (s.breadth != null ? `<div class="mmseason ${s.v === 'ON' ? 'on' : s.v === 'OFF' ? 'off' : 'mix'}"><div><div class="krh">MEME SEASON</div><div class="mmsv">${s.v}</div></div>
        <div class="mmsb"><div class="krh">ABOVE LONG AVERAGE</div><div class="kbar"><i style="width:${Math.round(s.breadth * 100)}%"></i></div><b>${Math.round(s.breadth * 100)}%</b> of ${s.n} memes</div>
        <div class="mmsb"><div class="krh">30 DAYS · MEMES vs BTC</div><b class="${cls(s.med)}">${fmtPct(s.med)}</b> median meme · BTC <b class="${cls(s.btc)}">${fmtPct(s.btc)}</b></div>
        <div class="mmst muted sm">${s.v === 'ON' ? 'Risk-on for memes: plans can use entry 1.' : s.v === 'OFF' ? 'Risk-off: memes lag Bitcoin. Keep size small and let price come to entries 2 and 3.' : 'Mixed: be selective, prefer the top scores and the lower entries.'}<br>Prices ${OF.hm(st.tAt)} · candles ${OF.hm(st.at)}</div></div>` : '');
  },
  coinCell(c) {
    const img = c.image ? `<img src="${c.image}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<i>${c.sym.slice(0, 1)}</i>`;
    return `<span class="mmcoin">${img}<span><b>${c.sym}</b>${c.mult > 1 ? `<small class="muted"> ×${c.mult >= 1e6 ? '1M' : c.mult}</small>` : ''}${c.mkt === 'fut' ? '<small class="mmfut">PERP</small>' : ''}<br><small class="muted">${c.name}</small></span></span>`;
  },
  spark(c) {
    const k = c.k ? c.k.slice(-90) : []; if (k.length < 5) return '';
    let lo = Infinity, hi = -Infinity; for (const x of k) { lo = Math.min(lo, x.c); hi = Math.max(hi, x.c); }
    const pts = k.map((x, i) => `${(i / (k.length - 1) * 88 + 1).toFixed(1)},${(23 - (x.c - lo) / ((hi - lo) || 1) * 21).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 90 24"><polyline points="${pts}" fill="none" stroke="${k[k.length - 1].c >= k[0].c ? C.buy : C.sell}" stroke-width="1.4"/></svg>`;
  },
  scoreCell(x) { if (!x) return '<span class="muted sm">new</span>'; const s = Math.round(x.score); return `<span class="mmscore"><i style="width:${s}%;background:${s >= 70 ? C.buy : s >= 58 ? '#7dd3a8' : s >= 42 ? C.yellow : C.sell}"></i><b>${s}</b></span>`; },
  html() {
    this.head();
    const st = M.st, sub = this.o.sub;
    if (st.status !== 'ready' && st.status !== 'empty') return;
    if (sub === 'list') this.htmlList();
    else if (sub === 'radar') this.htmlRadar();
    else if (sub === 'plans') this.htmlPlans();
    else if (sub === 'mine') this.htmlMine();
    else this.htmlTest();
  },
  bindRow(box) {
    box.querySelectorAll('[data-plan]').forEach(b => b.onclick = e => { e.stopPropagation(); this.o.sel = b.dataset.plan; this.o.sub = 'plans'; this.save(); OF.app.remount(); });
    box.querySelectorAll('[data-open]').forEach(b => b.onclick = e => { e.stopPropagation(); M.open(b.dataset.open); });
  },
  /* ---- 📋 all meme coins ---- */
  htmlList() {
    const body = document.getElementById('mmBody'); if (!body) return;
    if (!body.querySelector('#mmTbl')) {
      body.innerHTML = `<div class="mmbar"><input id="mmQ" class="mmq" placeholder="Search meme coins…" value="${this.o.q || ''}"><span class="muted sm">Click a column to sort · ▶ opens the coin in every terminal tab (chart, heatmap, footprint…)</span></div><div class="mmtw"><table class="tbl mmtbl" id="mmTbl"></table></div>`;
      body.querySelector('#mmQ').oninput = e => { this.o.q = e.target.value; this.save(); this.tbl(); };
    }
    this.tbl();
  },
  tbl() {
    const t = document.getElementById('mmTbl'); if (!t) return;
    const o = this.o, q = (o.q || '').trim().toUpperCase();
    const val = (c, k) => { const x = c.x, f = x && x.f; switch (k) { case 'score': return x ? x.score : -1; case 'dump': return x ? x.dump : -1; case 'r7': return f ? f.r7 : null; case 'r30': return f ? f.r30 : null; case 'r90': return f ? f.r90 : null; case 'chg24': return c.chg24; case 'qv': return c.qv; case 'volG': return f ? f.volG : null; case 'mcap': return c.mcap; case 'dd': return f ? f.dd : null; case 'funding': return c.funding; case 'sym': return c.sym; default: return 0; } };
    const rows = M.st.coins.filter(c => !q || (c.sym + ' ' + c.name).toUpperCase().includes(q)).sort((a, b) => { const va = val(a, o.sort), vb = val(b, o.sort); if (va == null) return 1; if (vb == null) return -1; return (va > vb ? 1 : va < vb ? -1 : 0) * (o.sort === 'sym' ? -o.dir : o.dir); });
    const H = [['#', ''], ['Coin', 'sym'], ['Price', ''], ['24h', 'chg24'], ['7d', 'r7'], ['30d', 'r30'], ['90d', 'r90'], ['90 days', ''], ['Volume 24h', 'qv'], ['Vol trend', 'volG'], ['Mkt cap', 'mcap'], ['From 1y high', 'dd'], ['Funding', 'funding'], ['Pump score', 'score'], ['Dump risk', 'dump'], ['Signal', ''], ['', '']];
    t.innerHTML = `<thead><tr>${H.map(([l, k]) => `<th${k ? ` data-s="${k}" class="srt${o.sort === k ? ' on' : ''}"` : ''}>${l}${o.sort === k ? (o.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead><tbody>` +
      rows.map((c, i) => { const x = c.x, f = x && x.f; return `<tr data-row="${c.symbol}"><td class="muted">${i + 1}</td><td>${this.coinCell(c)}</td><td class="mono">${fmtP(c.last)}</td>
        <td class="mono ${cls(c.chg24)}">${fmtPct(c.chg24)}</td><td class="mono ${cls(f && f.r7)}">${fmtPct(f && f.r7)}</td><td class="mono ${cls(f && f.r30)}">${fmtPct(f && f.r30)}</td><td class="mono ${cls(f && f.r90)}">${fmtPct(f && f.r90)}</td>
        <td>${this.spark(c)}</td><td class="mono">${OF.fmtUsd(c.qv)}</td><td class="mono ${f ? (f.volG > 1.2 ? 'g' : f.volG < 0.8 ? 'r' : 'muted') : ''}">${f ? (f.volG >= 1 ? '▲ ' : '▼ ') + f.volG.toFixed(2) + '×' : '--'}</td>
        <td class="mono">${c.mcap ? OF.fmtUsd(c.mcap) : '<span class="muted">--</span>'}</td><td class="mono ${f && f.dd > -0.3 ? 'g' : 'muted'}">${f ? fmtPct(f.dd, 0) : '--'}</td>
        <td class="mono ${c.funding > 0.0005 ? 'r' : c.funding < 0 ? 'g' : 'muted'}">${c.funding == null ? '--' : (c.funding * 100).toFixed(3) + '%'}</td><td>${this.scoreCell(x)}</td>
        <td class="mono ${x ? (x.dump >= 60 ? 'r' : x.dump >= 35 ? 'y' : 'g') : ''}">${x ? x.dump : '--'}</td><td class="nowrap"><b class="${x ? x.sig.c : 'muted'}">${x ? x.sig.t : 'not enough history'}</b></td>
        <td class="nowrap"><button class="mmb" data-plan="${c.symbol}" title="Long-term plan">📈 Plan</button><button class="mmb go" data-open="${c.symbol}" title="Open in every terminal tab">▶</button></td></tr>`; }).join('') + '</tbody>';
    t.querySelectorAll('th[data-s]').forEach(th => th.onclick = () => { const k = th.dataset.s; if (o.sort === k) o.dir = -o.dir; else { o.sort = k; o.dir = k === 'sym' ? 1 : -1; } this.save(); this.tbl(); });
    t.querySelectorAll('tr[data-row]').forEach(tr => tr.onclick = () => { this.o.sel = tr.dataset.row; this.o.sub = 'plans'; this.save(); OF.app.remount(); });
    this.bindRow(t);
  },
  /* ---- 🚀 radar ---- */
  htmlRadar() {
    const body = document.getElementById('mmBody'); if (!body) return;
    const xs = M.st.coins.map(c => c.x).filter(Boolean);
    const pump = xs.filter(x => x.sig.k === 'strong' || x.sig.k === 'dip').sort((a, b) => b.score - a.score).slice(0, 10);
    const dump = xs.filter(x => x.dump >= 45).sort((a, b) => b.dump - a.dump || a.score - b.score).slice(0, 10);
    const why = x => { const f = x.f, R = [];
      R.push(f.p > f.sL ? ['g', `above its ${f.L}-day average`] : ['r', `below its ${f.L}-day average`]);
      if (f.trend > 0.5) R.push(['g', '50-day average rising']); else if (f.trend < -0.3) R.push(['r', '50-day average falling']);
      R.push([x.parts.mom90 >= 0.6 ? 'g' : x.parts.mom90 <= 0.4 ? 'r' : 'y', `90 days ${fmtPct(f.r90 != null ? f.r90 : f.r30)} (top ${Math.max(1, Math.round((1 - x.parts.mom90) * 100))}% of memes)`]);
      if (f.volG > 1.3) R.push(['g', `volume up ${Math.round((f.volG - 1) * 100)}% vs the 2 months before`]); else if (f.volG < 0.75) R.push(['r', `volume down ${Math.round((1 - f.volG) * 100)}%`]);
      if (f.buy30 > 0.52) R.push(['g', `buyers ${Math.round(f.buy30 * 100)}% of 30-day volume`]); else if (f.buy30 < 0.48) R.push(['r', `sellers ${Math.round((1 - f.buy30) * 100)}% of 30-day volume`]);
      if (x.parts.base > 0.8 && f.p >= f.hi30 * 0.95) R.push(['g', 'pressing its 30-day high after a tight range']);
      x.pen.forEach(p => R.push(['r', p])); return R; };
    const card = (x, mode) => { const c = x.c, bt = M.bandOf(x.score);
      return `<div class="mmcard ${mode}"><div class="mmch">${this.coinCell(c)}<span class="mmbig ${mode === 'pump' ? 'g' : 'r'}">${mode === 'pump' ? Math.round(x.score) : x.dump}<small>${mode === 'pump' ? 'pump score' : 'dump risk'}</small></span></div>
        <div class="mmrow"><b class="${x.sig.c}">${x.sig.t}</b><span class="mono">${fmtP(c.last)}</span><span class="mono ${cls(x.f.r30)}">30d ${fmtPct(x.f.r30)}</span></div>
        <div class="mmwhy">${(mode === 'pump' ? why(x) : x.flags.map(t => ['r', t]).concat(why(x).filter(r => r[0] === 'g').slice(0, 1))).slice(0, 5).map(([k, t]) => `<div class="${k}">${k === 'g' ? '▲' : k === 'r' ? '▼' : '◆'} ${t}</div>`).join('')}</div>
        ${mode === 'pump' && bt && bt.n90 >= 20 ? `<div class="muted sm">History: coins scoring ${bt.label} had a median ${fmtPct(bt.med90)} over the next 90 days; ${Math.round(bt.pos90 * 100)}% were up (${bt.n90} cases).</div>` : ''}
        <div class="mmacts"><button class="mmb" data-plan="${c.symbol}">📈 ${mode === 'pump' ? 'Long-term plan' : 'Exit plan if you hold'}</button><button class="mmb go" data-open="${c.symbol}">▶ Open in terminal</button></div></div>`; };
    body.innerHTML = `<div class="mmradar"><div><h3>🚀 Most likely to pump <span class="muted sm">(long-term, highest scores in an uptrend)</span></h3>${pump.length ? pump.map(x => card(x, 'pump')).join('') : '<div class="empty">No meme coin passes the buy rules right now. That happens in meme bear markets — waiting is a position.</div>'}</div>
      <div><h3>⚠ Highest dump risk <span class="muted sm">(avoid, or plan your exit)</span></h3>${dump.length ? dump.map(x => card(x, 'dump')).join('') : '<div class="empty">No coin has strong dump flags right now.</div>'}</div></div>
      <div class="muted sm mmnote">“Most likely to pump” means these coins have the strongest trend, momentum, volume and buyer readings among memes today. It is a ranking of evidence, not a promise: check 🧪 Score test to see how well this ranking worked in the past.</div>`;
    this.bindRow(body);
  },
  /* ---- 📈 plans ---- */
  sel() { const st = M.st; if (this.o.sub === 'mine') { const pl = M.plans().find(p => String(p.id) === String(this.o.selPlan)) || M.plans().filter(p => !FINAL[p.state]).slice(-1)[0] || M.plans().slice(-1)[0]; return pl ? { pl, c: st.byS.get(pl.symbol) } : {}; }
    let c = st.byS.get(this.o.sel); if (!c || !c.x) c = st.coins.filter(x => x.x).sort((a, b) => b.x.score - a.x.score)[0]; return { c }; },
  htmlPlans() {
    const pick = document.getElementById('mmPick'), card = document.getElementById('mmCard'), log = document.getElementById('mmLog'); if (!pick) return;
    const { c } = this.sel(); const xs = M.st.coins.filter(x => x.x).sort((a, b) => b.x.score - a.x.score);
    pick.innerHTML = `<div class="sh">Highest scores first</div>` + xs.map(k => `<div class="mmpick${c && k.symbol === c.symbol ? ' on' : ''}" data-s="${k.symbol}">${this.coinCell(k)}<span class="mmpr">${this.scoreCell(k.x)}<small class="${k.x.sig.c}">${k.x.sig.t.split(' ')[0]}</small></span></div>`).join('');
    pick.querySelectorAll('[data-s]').forEach(d => d.onclick = () => { this.o.sel = d.dataset.s; this.save(); this._v = -1; this.zv = { n: 365, off: 0 }; });
    if (!c) { card.innerHTML = '<div class="empty">No coin with enough history.</div>'; return; }
    const P = M.plan(c); this.P = P; log.innerHTML = '';
    if (!P) { card.innerHTML = '<div class="empty">Not enough daily history for a plan.</div>'; return; }
    const cfg = M.cfg(), bt = P.band, x = P.x;
    const head = `<div class="mmph">${this.coinCell(c)}<span class="mono mmlast">${fmtP(P.p)}</span><span class="${x.sig.c} mmsig">${x.sig.t}</span><span class="mmbig g">${Math.round(x.score)}<small>pump score</small></span><span class="mmbig ${x.dump >= 60 ? 'r' : x.dump >= 35 ? 'y' : 'g'}">${x.dump}<small>dump risk</small></span><button class="mmb go" data-open="${c.symbol}">▶ Open in terminal</button></div>`;
    if (!P.buyable) {
      card.innerHTML = head + `<div class="plstatus ${x.sig.k === 'wait' ? 'wait' : 'risk'}"><span class="pli">${x.sig.k === 'wait' ? '⏸' : '⚠'}</span><div><div class="plsh">${x.sig.k === 'wait' ? 'No long-term buy yet — wait' : 'Not a buy — the data points down'}</div><div class="plsb">${(x.flags.length ? x.flags : x.pen.length ? x.pen : ['score ' + Math.round(x.score) + ' is below the buy threshold (58)']).join(' · ')}.</div></div></div>
        <div class="plcards"><div class="plcard short"><div class="plh"><b>If you already hold ${c.sym}</b></div>
          <div class="plrow"><span class="r">Exit if</span><b class="mono r">${fmtP(P.hold.exit)}</b><span class="muted sm">a weekly close below the ${P.hold.exitSrc}</span></div>
          <div class="plrow"><span>Sell into</span><b class="mono">${fmtP(P.hold.sellInto)}</b><span class="muted sm">rallies toward this level reduce risk</span></div></div>
          <div class="plcard"><div class="plh"><b>When it would turn into a buy</b></div><div class="muted sm">Price back above its ${x.f.L}-day average (${fmtP(x.f.sL)}) with a rising 50-day average and the score above 58. The plan below shows the levels it would use.</div></div></div>` + this.planCards(P, cfg, bt, false);
    } else card.innerHTML = head + this.planCards(P, cfg, bt, true);
    // keep the coin header above the chart and move the plan cards under it
    [...card.children].filter(n => !n.classList.contains('mmph')).forEach(n => log.appendChild(n));
    const tr = log.querySelector('.trackbtn'); if (tr) tr.onclick = () => { const pl = M.track(P); this.o.selPlan = pl.id; this.o.sub = 'mine'; this.save(); OF.app.remount(); };
    this.bindRow(card); this.bindRow(log);
  },
  planCards(P, cfg, bt, buy) {
    const row = (l, cl, v, note) => `<div class="plrow"><span class="${cl}">${l}</span><b class="mono ${cl}">${fmtP(v)}</b><span class="muted sm">${note}</span></div>`;
    return `<div class="plcards"><div class="plcard ${buy ? 'long' : 'alt'}"><div class="plh"><b>${buy ? '📈 Long-term plan' : 'Levels it would use'}</b><span class="muted sm">hold 3–12 months · review every weekly close (Sunday UTC)</span></div>
      ${P.ents.map((e, i) => row(`Buy ${i + 1} · ${Math.round(e.w * 100)}%`, 'g', e.p, `${e.src}${/now/.test(e.src) ? '' : ' · ' + fmtPct(e.p / P.p - 1)}`)).join('')}
      ${row('Average entry', '', P.avg, 'if all three buys fill')}
      ${row('Stop', 'r', P.stop, `${P.stopSrc} · ${fmtPct(P.stop / P.avg - 1, 0)}`)}
      ${P.tps.map((t, i) => row(`Target ${i + 1} · sell ⅓`, 'g', t.p, `${t.src} · ${fmtPct(t.pct, 0)} · ${t.rr.toFixed(1)}R`)).join('')}
      ${buy ? `<button class="trackbtn">⭐ Track this plan in My investments</button>` : ''}</div>
      <div class="plcard"><div class="plh"><b>Position size</b><span class="muted sm">from ⚙ Settings</span></div>
      ${`<div class="plrow"><span>Invest</span><b class="mono">${OF.fmtUsd(P.invest)}</b><span class="muted sm">${(P.invest / cfg.capital * 100).toFixed(1)}% of ${OF.fmtUsd(cfg.capital)} · max ${cfg.maxAlloc}% per coin</span></div>
        <div class="plrow"><span class="r">If stopped</span><b class="mono r">−${OF.fmtUsd(P.riskUsd).replace('$', '$')}</b><span class="muted sm">${(P.lossFrac * 100).toFixed(0)}% below the average entry = ${(P.riskUsd / cfg.capital * 100).toFixed(1)}% of capital</span></div>
        <div class="plrow"><span class="g">At target 3</span><b class="mono g">+${OF.fmtUsd(P.invest * (P.tps[0].pct + P.tps[1].pct + P.tps[2].pct) / 3)}</b><span class="muted sm">selling a third at each target</span></div>`}
      <div class="muted sm" style="margin-top:6px">Small size is the point: a meme position should be able to go to zero without hurting you. After target 1 the stop moves to break-even and unfilled buys are cancelled.</div></div>
      <div class="plcard prob"><div class="plh"><b>How this score did in the past</b><span class="muted sm">🧪 Score test</span></div>
      ${bt && bt.n90 >= 10 ? `<div class="pbig ${bt.med90 > 0 ? 'g' : 'r'}">${fmtPct(bt.med90, 0)}</div><div class="muted sm">median move over the next 90 days for memes that scored <b>${bt.label}</b>; <b>${Math.round(bt.pos90 * 100)}%</b> of them were up, average ${fmtPct(bt.mean90, 0)} (${bt.n90} cases). 30 days: median ${fmtPct(bt.med30)}, ${Math.round(bt.pos30 * 100)}% up.</div>` : '<div class="muted sm">Not enough history yet to measure this score band.</div>'}
      <div class="muted sm" style="margin-top:6px">Measured only on memes that still trade — the dead ones are missing, so the past looks better than it was.</div></div></div>`;
  },
  /* ---- 💼 my investments ---- */
  htmlMine() {
    const pick = document.getElementById('mmPick'), card = document.getElementById('mmCard'), log = document.getElementById('mmLog'); if (!pick) return;
    const pls = M.plans().slice().sort((a, b) => (FINAL[a.state] ? 1 : 0) - (FINAL[b.state] ? 1 : 0) || b.created - a.created), { pl } = this.sel();
    const ST = { waiting: ['⏳', 'wait', 'Waiting for buy 1'], building: ['🟢', 'on', 'Buying'], holding: ['🟢', 'on', 'Fully bought'], tp1: ['✅', 'on', 'Target 1 hit'], tp2: ['✅', 'on', 'Target 2 hit'], done: ['🏁', 'on', 'All targets hit'], stopped: ['❌', 'risk', 'Stopped'], expired: ['⌛', 'wait', 'Expired'], closed: ['✋', 'wait', 'Closed by you'] };
    const px = p => { const c = M.st.byS.get(p.symbol); return c ? c.last : null; };
    let tc = 0, tv = 0; pls.forEach(p => { const r = M.pnl(p, px(p)); tc += r.cost; tv += r.value; });
    pick.innerHTML = `<div class="sh">Plans · ${pls.filter(p => !FINAL[p.state]).length} open · total ${tc ? `<b class="${cls(tv - tc)}">${OF.fmtUsd(tv - tc, true)} (${fmtPct((tv - tc) / tc)})</b>` : '—'}</div>` +
      (pls.length ? pls.map(p => { const r = M.pnl(p, px(p)), s = ST[p.state] || ST.waiting; return `<div class="mmpick${pl && p.id === pl.id ? ' on' : ''}" data-id="${p.id}"><span><b>${p.sym}</b> <small class="muted">${new Date(p.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small><br><small>${s[0]} ${s[2]}</small></span><span class="mmpr"><b class="${cls(r.pnl)}">${r.cost ? fmtPct(r.pct) : '—'}</b><small class="muted">${r.cost ? OF.fmtUsd(r.pnl, true) : 'no fill yet'}</small></span></div>`; }).join('')
        : '<div class="empty">No tracked plans yet. Open 📈 Long-term plans and press ⭐ Track.</div>');
    pick.querySelectorAll('[data-id]').forEach(d => d.onclick = () => { this.o.selPlan = d.dataset.id; this.save(); this._v = -1; this.zv = { n: 365, off: 0 }; });
    if (!pl) { card.innerHTML = ''; log.innerHTML = ''; return; }
    const c = M.st.byS.get(pl.symbol), last = c ? c.last : null, r = M.pnl(pl, last), s = ST[pl.state] || ST.waiting;
    card.innerHTML = `<div class="plstatus ${s[1]}"><span class="pli">${s[0]}</span><div><div class="plsh">${pl.sym} · ${s[2]}${r.cost ? ` · <span class="${cls(r.pnl)}">${OF.fmtUsd(r.pnl, true)} (${fmtPct(r.pct)})</span>` : ''}</div>
      <div class="plsb">Invested ${OF.fmtUsd(r.cost)} of ${OF.fmtUsd(pl.invest)} planned${r.avg ? ' · average ' + fmtP(r.avg) : ''} · price ${fmtP(last)} · stop ${fmtP(pl.stopNow)}${pl.stopNow !== pl.stop ? ' (moved to break-even)' : ''} — weekly close rule · score when tracked ${pl.score}${c && c.x ? ', now ' + Math.round(c.x.score) + ' (' + c.x.sig.t + ')' : ''}</div></div>
      <div class="trb"><button data-a="open">▶ Open in terminal</button>${FINAL[pl.state] ? '' : `<button data-a="close">✋ I sold (at ${fmtP(last)})</button>`}<button data-a="del">🗑</button></div></div>
      <div class="plcards two"><div class="plcard"><div class="plh"><b>Buy orders</b></div>${pl.ents.map((e, i) => `<div class="plrow"><span>Buy ${i + 1} · ${Math.round(e.w * 100)}%</span><b class="mono">${fmtP(e.p)}</b><span class="sm ${e.fill ? 'g' : e.cancel ? 'muted' : 'y'}">${e.fill ? '✓ bought at ' + fmtP(e.fill) + ' · ' + new Date(e.at).toLocaleDateString() : e.cancel ? 'cancelled' : 'waiting · ' + fmtPct(e.p / (last || e.p) - 1) + ' away'}</span></div>`).join('')}</div>
      <div class="plcard"><div class="plh"><b>Targets</b></div>${pl.tps.map((t, i) => `<div class="plrow"><span class="g">Target ${i + 1}</span><b class="mono g">${fmtP(t.p)}</b><span class="sm ${t.hit ? 'g' : 'muted'}">${t.hit ? '✓ reached ' + new Date(t.at).toLocaleDateString() : t.src + ' · ' + fmtPct(t.p / (last || t.p) - 1) + ' away'}</span></div>`).join('')}</div></div>`;
    card.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { const a = b.dataset.a; if (a === 'open') M.open(pl.symbol); else if (a === 'close' && last) M.closePlan(pl, last); else if (a === 'del') { M._pl = M.plans().filter(p => p !== pl); M.savePlans(); bump(); } });
    log.innerHTML = ''; [...card.querySelectorAll(':scope > .plcards')].forEach(n => log.appendChild(n));
    log.insertAdjacentHTML('beforeend', `<div class="plev">${pl.events.slice(-8).reverse().map(e => `<span>${new Date(e[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${e[1]}</span>`).join('')}</div>`);
  },
  /* ---- 🧪 score test ---- */
  htmlTest() {
    const body = document.getElementById('mmBody'); if (!body) return;
    const bt = M.backtest();
    if (!bt) { body.innerHTML = '<div class="empty">Not enough history across meme coins to run the score test (needs at least 8 coins with 150+ days).</div>'; return; }
    const d = t => new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    const tr = r => `<tr><td>${r.label}</td><td class="rt mono">${r.n}</td><td class="rt mono ${cls(r.med30)}">${fmtPct(r.med30)}</td><td class="rt mono">${r.pos30 == null ? '--' : Math.round(r.pos30 * 100) + '%'}</td><td class="rt mono ${cls(r.mean30)}">${fmtPct(r.mean30)}</td><td class="rt mono">${r.n90}</td><td class="rt mono ${cls(r.med90)}">${fmtPct(r.med90)}</td><td class="rt mono">${r.pos90 == null ? '--' : Math.round(r.pos90 * 100) + '%'}</td><td class="rt mono ${cls(r.mean90)}">${fmtPct(r.mean90)}</td></tr>`;
    const th = '<thead><tr><th></th><th class="rt">Cases</th><th class="rt">30d median</th><th class="rt">30d up</th><th class="rt">30d average</th><th class="rt">Cases</th><th class="rt">90d median</th><th class="rt">90d up</th><th class="rt">90d average</th></tr></thead>';
    const top = bt.quint[0], bot = bt.quint[4], works = top.med90 != null && bot.med90 != null && top.med90 > bot.med90 && bt.beat > 0.5;
    // equity curve (inline SVG, log scale)
    const e = bt.eq, W2 = 760, H2 = 200; let lo = Infinity, hi = -Infinity; e.forEach(p => { lo = Math.min(lo, p.top, p.all); hi = Math.max(hi, p.top, p.all); });
    const Y = v => H2 - 12 - (Math.log(v) - Math.log(lo)) / ((Math.log(hi) - Math.log(lo)) || 1) * (H2 - 24), X = i => 10 + i / Math.max(1, e.length - 1) * (W2 - 20);
    const line = k => e.map((p, i) => `${X(i).toFixed(1)},${Y(p[k]).toFixed(1)}`).join(' ');
    body.innerHTML = `<div class="plstatus ${works ? 'on' : 'risk'}"><span class="pli">${works ? '✅' : '⚠'}</span><div><div class="plsh">${works ? 'Higher scores did better in the past' : 'The score did NOT separate winners well in this period'}</div>
        <div class="plsb">${bt.weeks} weekly snapshots from ${d(bt.from)} to ${d(bt.to)}, ${bt.coins} coins, ${bt.obs} cases. Top-scored memes ${fmtPct(top.med90)} median over 90 days vs bottom-scored ${fmtPct(bot.med90)}. The top 5 beat the average meme in ${Math.round(bt.beat * 100)}% of weeks over the next 30 days.</div></div></div>
      <h3>By score rank each week</h3><table class="tbl">${th}<tbody>${bt.quint.map(tr).join('')}</tbody></table>
      <h3>By score band <span class="muted sm">(used on the plan cards)</span></h3><table class="tbl">${th}<tbody>${bt.bands.map(tr).join('')}</tbody></table>
      <h3>By signal</h3><table class="tbl">${th}<tbody>${bt.sigs.map(tr).join('')}</tbody></table>
      <h3>Top 5 by score vs all memes <span class="muted sm">(buy the top 5 every 4 weeks, hold 30 days, equal weight, log scale)</span></h3>
      <svg class="mmeq" viewBox="0 0 ${W2} ${H2}"><polyline points="${line('all')}" fill="none" stroke="${C.muted}" stroke-width="1.6" stroke-dasharray="4 3"/><polyline points="${line('top')}" fill="none" stroke="#ff2bd6" stroke-width="2.2"/></svg>
      <div class="sm"><b style="color:#ff2bd6">━ Top 5: ×${e[e.length - 1].top.toFixed(2)}</b> · <span class="muted">┅ All memes: ×${e[e.length - 1].all.toFixed(2)}</span></div>
      <div class="muted sm mmnote">How it works: every week, the score is computed using only the candles up to that day, coins are ranked, and the next 30 and 90 days are measured. No fees, no slippage, entries at the daily close. <b>Survivorship bias:</b> only memes that still trade on Binance are included — the many that died are missing, so real results would have been worse. Live order-book and funding readings are not in the test.</div>`;
  },
  /* ---- daily chart with plan levels ---- */
  drawChart() {
    const S = this.sel(), c = S.c, pl = S.pl, cv = this.c.fit(), ctx = cv.ctx, W = cv.w, H = cv.h;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (M.st.status !== 'ready') { ui.msg(ctx, W, H, M.st.status === 'loading' ? 'Loading daily candles…' : M.st.err || 'No data'); return; }
    if (!c || !c.k || c.k.length < 5) { ui.msg(ctx, W, H, pl ? pl.sym + ': no candles (delisted?)' : 'Pick a coin'); return; }
    const k = c.k, AX = 92, TB = 18, pw = W - AX, ph = H - TB, top = document.body.classList.contains('chartonly') ? 58 : 26;
    const n = Math.min(this.zv.n, k.length), end = Math.max(n, k.length - this.zv.off), i0 = Math.max(0, end - n);
    const bw = pw / (n + Math.max(8, n * 0.12)), X = i => (i - i0 + 0.5) * bw; this.bw = bw;
    const P = !pl && this.o.sub === 'plans' ? this.P : null;
    const lv = []; if (P) { P.ents.forEach(e => lv.push(e.p)); lv.push(P.stop); P.tps.forEach(t => lv.push(t.p)); }
    if (pl) { pl.ents.forEach(e => lv.push(e.p)); lv.push(pl.stopNow); pl.tps.forEach(t => lv.push(t.p)); }
    let lo = Infinity, hi = 0; for (let i = i0; i < end; i++) { lo = Math.min(lo, k[i].l); hi = Math.max(hi, k[i].h); }
    lv.forEach(v => { if (v > 0) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    lo *= 0.92; hi *= 1.08;
    const LL = Math.log(lo), LH = Math.log(hi), Y = v => top + (ph - top * 2) * (1 - (Math.log(v) - LL) / (LH - LL));
    // log price axis
    ctx.font = '11px ui-monospace,Menlo,monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (let j = 0; j <= 7; j++) { const v = Math.exp(LL + (LH - LL) * j / 7), y = Y(v); ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(pw, Math.round(y) + .5); ctx.stroke(); ctx.fillStyle = C.muted; ctx.fillText(fmtP(v), pw + 6, y); }
    { const span = (end - i0) * bw, months = Math.max(1, [1, 2, 3, 6, 12].find(m => (span / (end - i0)) * 30.4 * m >= 70) || 12), MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      ctx.font = '11px ui-monospace,Menlo,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let i = i0; i < end; i++) { const d = new Date(k[i].t); if (d.getUTCDate() !== 1 || d.getUTCMonth() % months) continue; const x = X(i);
        ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, top); ctx.lineTo(Math.round(x) + .5, ph); ctx.stroke();
        ctx.fillStyle = C.muted; ctx.fillText(d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : MO[d.getUTCMonth()], x, ph + 3); } }
    const sma = (len, col) => { if (k.length <= len) return; ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath(); let s = 0, st = false; for (let i = 0; i < end; i++) { s += k[i].c; if (i >= len) s -= k[i - len].c; if (i >= len - 1 && i >= i0) { const y = Y(s / len); st ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y); st = true; } } ctx.stroke(); ctx.lineWidth = 1; };
    sma(200, C.amber); sma(50, C.blue);
    OF.drawCandles(ctx, k, i0, end, X, Y, Math.max(1, bw * 0.65));
    const x0 = pl ? clamp(X(i0 + (pl.created - k[i0].t) / DAY), 0, pw - 40) : X(end - 1) + bw;
    const tags = [];
    const lineAt = (v, col, dash, txt) => {
      const y = Y(v); if (y < top - 4 || y > ph) return;
      ctx.save(); ctx.globalAlpha = 0.35; ctx.strokeStyle = col; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(x0, Math.round(y) + .5); ctx.stroke(); ctx.restore();
      ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + .5); ctx.lineTo(pw, Math.round(y) + .5); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
      tags.push({ y, txt, col, v });
    };
    const lvls = P ? { ents: P.ents.map(e => ({ p: e.p, w: e.w, fill: null })), stop: P.stop, tps: P.tps } : pl ? { ents: pl.ents, stop: pl.stopNow, tps: pl.tps } : null;
    if (lvls) {
      const yS = Y(lvls.stop), yT = Y(lvls.tps[2].p), yE = Y(lvls.ents[0].p);
      ctx.fillStyle = 'rgba(255,59,107,.10)'; ctx.fillRect(x0, Math.min(yE, yS), pw - x0, Math.abs(yS - yE));
      ctx.fillStyle = 'rgba(0,255,163,.07)'; ctx.fillRect(x0, Math.min(yE, yT), pw - x0, Math.abs(yT - yE));
      lvls.tps.forEach((t, i) => lineAt(t.p, C.buy, i === 2 ? [6, 4] : [], `TARGET ${i + 1} · sell ⅓${t.hit ? ' ✓' : ''}`));
      lvls.ents.forEach((e, i) => lineAt(e.p, '#e5e7eb', e.fill ? [] : [5, 4], `BUY ${i + 1}${e.fill ? ' ✓ filled' : e.cancel ? ' (cancelled)' : ' · ' + Math.round((e.w || 0) * 100) + '%'}`));
      lineAt(lvls.stop, C.sell, [], 'STOP · weekly close below');
      if (pl) pl.ents.forEach(e => { if (e.fill && e.at >= k[i0].t) { ctx.beginPath(); ctx.arc(X(i0 + (e.at - k[i0].t) / DAY), Y(e.fill), 5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); } });
    }
    // level labels inside the chart's right edge, pushed apart so they never overlap; matching tags on the price scale
    tags.sort((a, b) => a.y - b.y); let prevY = -1e9; ctx.font = 'bold 11px Inter,system-ui,sans-serif';
    for (const g of tags) {
      const w = ctx.measureText(g.txt).width + 14, ly = Math.max(g.y, prevY + 19); prevY = ly;
      ctx.fillStyle = 'rgba(16,6,36,.92)'; ctx.strokeStyle = g.col; ctx.beginPath(); ctx.roundRect(pw - w - 6, ly - 9, w, 18, 6); ctx.fill(); ctx.stroke();
      ctx.fillStyle = g.col; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(g.txt, pw - w + 1, ly + .5);
      ui.tag(ctx, pw + 1, g.y, fmtP(g.v), g.col, '#05070a');
    }
    if (c.last) { const y = Y(c.last); ui.hline(ctx, 0, pw, y, 'rgba(229,231,235,.5)', [1, 3]); ui.tag(ctx, pw + 1, y, fmtP(c.last), '#e5e7eb', '#000'); }
    ctx.font = '11px ui-monospace,monospace'; ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(`${c.sym}/USDT · daily · log scale · 50-day (blue) and 200-day (amber) averages · scroll = zoom · drag = pan · double-click = reset`, 8, 6);
    const m = this.mouse;
    if (m && m.x < pw && m.y > top && m.y < ph - top) {
      const v = Math.exp(LL + (1 - (m.y - top) / (ph - top * 2)) * (LH - LL));
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, m.y); ctx.lineTo(pw, m.y); ctx.moveTo(m.x, 0); ctx.lineTo(m.x, ph); ctx.stroke(); ctx.setLineDash([]);
      ui.tag(ctx, pw + 1, m.y, fmtP(v), '#2563eb', '#fff');
      if (c.last) { ctx.fillStyle = '#93c5fd'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(fmtPct(v / c.last - 1) + ' from price', pw - 4, m.y - 3); }
    }
  }
};

/* open a meme coin in the whole terminal */
M.open = function (symbol) {
  const c = M.st.byS.get(symbol);
  if (c && c.mkt === 'fut') { OF.FUTONLY = OF.FUTONLY || {}; OF.FUTONLY[symbol] = 1; LS.set('futonly', Object.assign(LS.get('futonly', {}), { [symbol]: 1 })); }
  OF.app.pick(symbol); OF.app.setView('chart');
};
// keep tracked plans moving even when the tab is closed: load quietly once if there are open plans
setTimeout(() => { if (M.plans().some(p => !FINAL[p.state])) M.load(); }, 20000);
})();

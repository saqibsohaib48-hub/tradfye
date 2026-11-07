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
  lv.sort((a, b) => a.p - b.p);
  const zones = [];
  for (const l of lv) {
    const z = zones[zones.length - 1];
    if (z && l.p - z.hi < atr * 0.25) { z.hi = Math.max(z.hi, l.p); z.pw += l.p * l.w; z.w += l.w; z.src.push(l.src); }
    else zones.push({ lo: l.p, hi: l.p, pw: l.p * l.w, w: l.w, src: [l.src] });
  }
  zones.forEach(z => { z.p = z.pw / z.w; z.src = [...new Set(z.src)]; });
  const sup = zones.filter(z => z.hi < px - atr * 0.05).sort((a, b) => b.p - a.p);
  const res = zones.filter(z => z.lo > px + atr * 0.05).sort((a, b) => a.p - b.p);
  const strong = z => z.w >= 2.5;

  /* ---------- 3. plan ---------- */
  const build = dir => {
    const near = dir > 0 ? sup : res, far = dir > 0 ? res : sup;
    let best = null;
    for (const z of near) { const d = Math.abs(z.p - px) / atr; if (d > 1.6) break; const sc = z.w / (1 + d); if (!best || sc > best.sc) best = { z, sc, d }; }
    let entry, eType, base;
    if (best) { base = best.z; entry = dir > 0 ? base.hi : base.lo; eType = Math.abs(entry - px) < atr * 0.2 ? 'market' : 'limit'; if (eType === 'market') entry = px; }
    else { entry = px; eType = 'market'; base = near[0] || null; }
    let stop = base ? (dir > 0 ? base.lo - atr * 0.25 : base.hi + atr * 0.25) : entry - dir * atr * 1.2;
    let risk = Math.abs(entry - stop);
    if (risk < atr * 0.6) { stop = entry - dir * atr * 0.6; risk = atr * 0.6; }
    if (risk > atr * 2) { stop = entry - dir * atr * 2; risk = atr * 2; }
    const tz = far.filter(z => dir > 0 ? z.lo > entry + risk * 0.8 : z.hi < entry - risk * 0.8);
    const edge = z => dir > 0 ? z.lo - atr * 0.05 : z.hi + atr * 0.05;
    const tp1z = tz.find(z => Math.abs(edge(z) - entry) >= risk) || null;
    let tp1 = tp1z ? edge(tp1z) : entry + dir * risk * 1.5;
    if (Math.abs(tp1 - entry) > atr * 4) tp1 = entry + dir * risk * 1.5;
    const tp2z = tz.find(z => (dir > 0 ? edge(z) > tp1 + atr * 0.3 : edge(z) < tp1 - atr * 0.3) && strong(z)) || tz.find(z => dir > 0 ? edge(z) > tp1 + atr * 0.3 : edge(z) < tp1 - atr * 0.3);
    let tp2 = tp2z ? edge(tp2z) : entry + dir * risk * 3;
    if (Math.abs(tp2 - entry) > atr * 6) tp2 = entry + dir * risk * 3;
    const blocker = far.find(z => strong(z) && (dir > 0 ? z.lo > entry && z.lo < tp1 : z.hi < entry && z.hi > tp1));
    return { dir, entry, eType, stop, risk, tp1, tp2, rr1: Math.abs(tp1 - entry) / risk, rr2: Math.abs(tp2 - entry) / risk, base, tp1z, tp2z, blocker,
      trigger: dir > 0 ? (res[0] ? res[0].hi : px + atr) : (sup[0] ? sup[0].lo : px - atr) };
  };
  const long = build(1), short = build(-1);
  let side = 0, why = [];
  if (Math.abs(bias) >= 0.2 && agree >= 0.55) side = Math.sign(bias);
  else why.push(Math.abs(bias) < 0.2 ? 'the factors cancel out (bias ' + (bias * 100).toFixed(0) + ')' : 'only ' + Math.round(agree * 100) + '% of factors agree');
  let plan = side > 0 ? long : side < 0 ? short : null;
  if (plan && plan.rr1 < 1.3) { why.push(`reward to the first target is only ${plan.rr1.toFixed(1)}R — a ${side > 0 ? 'resistance' : 'support'} zone sits too close`); plan = null; }
  if (plan && rsi > 78 && side > 0 && plan.eType === 'market') { why.push('1h RSI is above 78 — wait for the pullback limit instead of buying here'); plan.eType = 'limit'; }
  if (plan && rsi < 22 && side < 0 && plan.eType === 'market') { why.push('1h RSI is below 22 — wait for the bounce limit instead of selling here'); plan.eType = 'limit'; }
  const conf = Math.round(OF.clamp(Math.abs(bias) * 100 * 0.7 + agree * 40 + (plan && plan.base && strong(plan.base) ? 10 : 0), 0, 95));
  return { at: Date.now(), px, atr, atr4, bias, agree, factors: F, zones, sup, res, long, short, side: plan ? side : 0, plan, why, conf, rsi, recH,
    verdict: plan ? (side > 0 ? 'LONG' : 'SHORT') : 'NO TRADE' };
};

/* ===================== TRADE PLAN TAB ===================== */
OF.views.plan = {
  label: 'Trade plan', title: 'Everything combined into one 1h intraday setup — entry, stop, targets',
  o: Object.assign({ acct: 1000, risk: 1 }, LS.get('plan', {})),
  toolbar(tb) {
    const o = this.o;
    const inp = (lab, key, step) => { const w = el('div', 'grp'); w.appendChild(el('span', 'lbl', lab)); const i = el('input', 'num'); i.type = 'number'; i.step = step; i.value = o[key]; i.oninput = () => { o[key] = +i.value || 0; LS.set('plan', o); this.html(); }; w.appendChild(i); return w; };
    tb.append(inp('Account $', 'acct', 100), inp('Risk per trade %', 'risk', 0.25));
    const b = el('button', 'tgl on', '↻ Recalculate'); b.onclick = () => { this.p = OF.tradePlan(); this.html(); }; tb.append(b);
    tb.append(el('span', 'lbl', 'Rule-based setup from public data — a decision aid, not financial advice.'));
  },
  mount(v) {
    v.classList.add('scroll');
    v.innerHTML = '<div id="plTop"></div><div class="plgrid"><div class="gbox plchart" id="plChart"></div><div id="plSide"></div></div><div id="plFactors"></div>';
    this.c = ui.canvas(document.getElementById('plChart')); ui.track(this);
    this.p = null; this.lastHtml = 0;
  },
  reading() {
    const p = this.p; if (!p || p.wait) return 'Collecting data for the plan…';
    return `Bias <b class="${p.bias > 0 ? 'g' : 'r'}">${p.bias > 0 ? 'bullish' : 'bearish'} ${Math.abs(p.bias * 100).toFixed(0)}</b> · ${Math.round(p.agree * 100)}% of factors agree · 1h ATR ${OF.fp(p.atr)} · ${p.zones.length} price zones from ${p.zones.reduce((a, z) => a + z.src.length, 0)} level sources. Plan refreshes every 15 s.`;
  },
  html() {
    const p = this.p, S = OF.S; if (!p) return;
    const top = document.getElementById('plTop'), side = document.getElementById('plSide'), fac = document.getElementById('plFactors'); if (!top) return;
    if (p.wait) { top.innerHTML = '<div class="empty">' + p.wait + '</div>'; return; }
    const o = this.o, fmt = OF.fp, pct = x => ((x / p.px - 1) * 100).toFixed(2) + '%';
    const card = (pl, main) => {
      const qty = pl.risk ? o.acct * o.risk / 100 / pl.risk : 0, dirTxt = pl.dir > 0 ? 'LONG' : 'SHORT';
      return `<div class="plcard ${main ? (pl.dir > 0 ? 'long' : 'short') : 'alt'}">
        <div class="plh"><b>${main ? dirTxt + ' setup' : 'If it flips: ' + dirTxt}</b><span class="muted sm">${pl.eType === 'limit' ? 'limit order' : 'at market'} · 1h intraday</span></div>
        <div class="plrow"><span>Entry</span><b class="mono">${fmt(pl.entry)}</b><span class="muted sm">${pl.eType === 'limit' ? pct(pl.entry) + ' from price' : 'now'}${pl.base ? ' · at ' + pl.base.src.slice(0, 2).join(', ') : ''}</span></div>
        <div class="plrow"><span class="r">Stop loss</span><b class="mono r">${fmt(pl.stop)}</b><span class="muted sm">risk ${fmt(pl.risk)} (${(pl.risk / p.atr).toFixed(1)}× ATR) beyond the zone</span></div>
        <div class="plrow"><span class="g">Take profit 1</span><b class="mono g">${fmt(pl.tp1)}</b><span class="muted sm">${pl.rr1.toFixed(1)}R${pl.tp1z ? ' · ' + pl.tp1z.src.slice(0, 2).join(', ') : ' · no zone, 1.5R'} — close half, stop to entry</span></div>
        <div class="plrow"><span class="g">Take profit 2</span><b class="mono g">${fmt(pl.tp2)}</b><span class="muted sm">${pl.rr2.toFixed(1)}R${pl.tp2z ? ' · ' + pl.tp2z.src.slice(0, 2).join(', ') : ' · no zone, 3R'}</span></div>
        ${main ? `<div class="plrow"><span>Size</span><b class="mono">${qty < 1 ? qty.toFixed(4) : qty.toFixed(3)} ${S.info.base}</b><span class="muted sm">${OF.fmtUsd(qty * pl.entry)} notional · loses ${OF.fmtUsd(o.acct * o.risk / 100)} at the stop</span></div>` : `<div class="muted sm">Only if price ${pl.dir > 0 ? 'closes a 1h candle above' : 'closes a 1h candle below'} <b class="mono">${fmt(pl.trigger)}</b> and the bias turns ${pl.dir > 0 ? 'bullish' : 'bearish'}.</div>`}
        ${pl.blocker ? `<div class="y sm">⚠ Strong zone in the way at ${fmt(pl.blocker.p)} (${pl.blocker.src.slice(0, 2).join(', ')})</div>` : ''}
      </div>`;
    };
    const vcls = p.verdict === 'LONG' ? 'buy' : p.verdict === 'SHORT' ? 'sell' : 'wait';
    top.innerHTML = `<div class="plsum"><span class="verdict ${vcls}">${p.verdict}</span>
      <div><div class="dsc">${p.plan ? (p.side > 0 ? 'Buy' : 'Sell') + ' setup on the 1h chart · confidence ' + p.conf + '%' : 'No clean setup right now'}</div>
      <div class="muted sm">${p.plan ? 'Most factors point ' + (p.side > 0 ? 'up' : 'down') + ' and the levels give at least ' + p.plan.rr1.toFixed(1) + 'R to the first target.' : 'Why: ' + p.why.join('; ') + '. Both conditional plans are below — wait for one to trigger.'}
      Valid for the next ~4 hours; cancel an unfilled limit after that or if a 1h candle closes beyond the stop.</div></div></div>
      <div class="plcards">${p.plan ? card(p.plan, true) + card(p.side > 0 ? p.short : p.long, false) : card(p.long, false) + card(p.short, false)}</div>`;
    const zl = z => `<div class="zr"><b class="mono">${fmt(z.p)}</b><span class="zw" style="width:${Math.min(60, z.w * 9)}px"></span><span class="muted sm">${z.src.join(' · ')}</span></div>`;
    side.innerHTML = `<div class="sh">Resistance above (nearest first)</div>${p.res.slice(0, 7).map(zl).join('') || '<div class="muted pad">none within 6%</div>'}
      <div class="zr now"><b class="mono">${fmt(p.px)}</b><span class="muted sm">price now</span></div>
      <div class="sh">Support below (nearest first)</div>${p.sup.slice(0, 7).map(zl).join('') || '<div class="muted pad">none within 6%</div>'}`;
    const groups = [...new Set(p.factors.map(f => f.group))];
    fac.innerHTML = '<h3>What the plan is based on</h3><table class="tbl"><thead><tr><th>Factor</th><th>Weight</th><th>Vote</th><th>Reading</th></tr></thead><tbody>' +
      groups.map(gp => p.factors.filter(f => f.group === gp).map(f => {
        const v = f.s == null ? '—' : f.s > 0.15 ? '<b class="g">▲ long</b>' : f.s < -0.15 ? '<b class="r">▼ short</b>' : '<span class="muted">neutral</span>';
        return `<tr><td>${f.name}</td><td class="mono muted">${f.w}</td><td>${v} <span class="mono muted sm">${f.s == null ? '' : (f.s * 100).toFixed(0)}</span></td><td class="wrap">${f.text}</td></tr>`;
      }).join('')).join('') + '</tbody></table>';
  },
  render() {
    if (!this.p || Date.now() - this.p.at > 15000 || this.p.wait) { this.p = OF.tradePlan(); this.p.at = this.p.at || Date.now(); this.html(); }
    const p = this.p, c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h, S = OF.S;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (!p || p.wait) { ui.msg(ctx, W, H, p ? p.wait : 'Loading…'); return; }
    const k = S.k['1h'], AX = 80, TB = 18, pw = W - AX, ph = H - TB, n = Math.min(k.length, 72), i0 = k.length - n, bw = pw / (n + 14), X = i => (i - i0 + 0.5) * bw;
    const pl = p.plan || (p.long.rr1 >= p.short.rr1 ? p.long : p.short);
    let lo = Infinity, hi = -Infinity; for (let i = i0; i < k.length; i++) { lo = Math.min(lo, k[i].l); hi = Math.max(hi, k[i].h); }
    [pl.stop, pl.tp1, pl.tp2, pl.entry].forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
    const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
    const Y = v => 6 + (ph - 12) - (v - lo) / (hi - lo) * (ph - 12);
    ui.priceAxis(ctx, 0, pw, 6, ph - 12, lo, hi);
    ui.timeAxis(ctx, 0, n * bw, ph, k[i0].t, k[k.length - 1].t + 36e5, 90);
    // zones
    for (const z of p.zones) {
      if (z.hi < lo || z.lo > hi) continue;
      const a = Math.min(0.32, 0.05 + z.w * 0.035), y1 = Y(z.hi + p.atr * 0.06), y2 = Y(z.lo - p.atr * 0.06);
      ctx.fillStyle = (z.p > p.px ? 'rgba(239,68,68,' : 'rgba(34,197,94,') + a + ')'; ctx.fillRect(0, y1, pw, Math.max(2, y2 - y1));
      if (z.w >= 2) { ctx.font = '10px ui-monospace,monospace'; ctx.fillStyle = '#cbd5e1'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(OF.fp(z.p) + ' · ' + z.src.slice(0, 2).join(', '), pw - 4, (y1 + y2) / 2); }
    }
    OF.drawCandles(ctx, k, i0, k.length, X, Y, bw * 0.65);
    const e21 = OF.ema(k, 21); ctx.strokeStyle = C.blue; ctx.beginPath(); for (let i = i0; i < k.length; i++) i === i0 ? ctx.moveTo(X(i), Y(e21[i])) : ctx.lineTo(X(i), Y(e21[i])); ctx.stroke();
    // plan box on the right of the last candle
    const x0 = X(k.length - 1) + bw, x1 = pw - 4, ye = Y(pl.entry);
    ctx.fillStyle = 'rgba(239,68,68,.18)'; ctx.fillRect(x0, Math.min(ye, Y(pl.stop)), x1 - x0, Math.abs(Y(pl.stop) - ye));
    ctx.fillStyle = 'rgba(34,197,94,.18)'; ctx.fillRect(x0, Math.min(ye, Y(pl.tp2)), x1 - x0, Math.abs(Y(pl.tp2) - ye));
    ui.hline(ctx, 0, pw, ye, '#e5e7eb', [], (p.plan ? '' : 'conditional ') + 'entry ' + OF.fp(pl.entry), x0);
    ui.hline(ctx, 0, pw, Y(pl.stop), C.sell, [5, 3], 'stop ' + OF.fp(pl.stop), x0);
    ui.hline(ctx, 0, pw, Y(pl.tp1), C.buy, [5, 3], 'TP1 ' + OF.fp(pl.tp1) + ' (' + pl.rr1.toFixed(1) + 'R)', x0);
    ui.hline(ctx, 0, pw, Y(pl.tp2), C.buy, [2, 3], 'TP2 ' + OF.fp(pl.tp2) + ' (' + pl.rr2.toFixed(1) + 'R)', x0);
    if (S.last) ui.tag(ctx, pw + 1, Y(S.last), OF.fp(S.last), '#e5e7eb', '#000');
    ctx.font = '11px ui-monospace,monospace'; ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(S.symbol + ' · 1h · shaded = price zones (green support, red resistance; darker = more sources agree)', 8, 8);
    ui.cross(ctx, this.mouse, 0, pw, 6, ph - 12, lo, hi, pw + 1);
  }
};
})();

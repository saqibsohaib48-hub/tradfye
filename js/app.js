/* FlowDesk app shell: header, tabs, right panel (Decision + DOM ladder), render loop, keys, demo mode. */
(function () {
'use strict';
const OF = window.OF, C = OF.C, el = OF.el, ui = OF.ui, LS = OF.LS, $ = id => document.getElementById(id);
const ORDER = ['chart', 'heatmap', 'footprint', 'whales', 'profile', 'tpo', 'gamma', 'tape', 'liquidity', 'futures', 'sentiment', 'plan', 'guide'];
OF.app = { tf: LS.get('tf', '1m'), lines: Object.assign({ plan: true, gamma: false, liq: true, walls: true, key: true }, LS.get('lines', {})), view: LS.get('view', 'heatmap'), panel: LS.get('panel', window.innerWidth > 1000) };
const A = OF.app;

/* ---------- header ---------- */
function buildHeader() {
  const tfs = $('tfSeg'); tfs.innerHTML = '';
  tfs.append(ui.seg('Timeframe', ['1m', '5m', '15m', '30m', '1h', '4h', '1d'].map(t => [t, t === '1d' ? '1D' : t]), A.tf, v => { A.tf = v; LS.set('tf', v); OF.loadKlines(v); }));
  const ls = $('linesSeg'); ls.innerHTML = '';
  const g = el('div', 'grp'); g.appendChild(el('span', 'lbl', 'Lines'));
  const s = el('div', 'seg');
  [['key', '★ Key', 'Auto-highlighted key support / resistance where several sources agree'], ['plan', 'Plan', 'Decision panel trigger levels'], ['walls', 'Walls', 'Biggest resting bid / ask walls in the order book (±3%) with price and size'], ['liq', 'Liq', 'Estimated liquidation clusters with price and size'], ['gamma', 'Γ', 'Options gamma levels (Deribit)']].forEach(([k, t, title]) => {
    const b = el('button', A.lines[k] ? 'on' : '', t); b.title = title;
    b.onclick = () => { A.lines[k] = !A.lines[k]; b.classList.toggle('on', A.lines[k]); LS.set('lines', A.lines); if (k === 'gamma' && A.lines[k]) OF.loadGamma(); };
    s.appendChild(b);
  });
  g.appendChild(s); ls.appendChild(g);
  // symbol picker
  $('symBtn').onclick = async () => {
    const m = $('symMenu'); m.classList.toggle('hidden'); if (m.classList.contains('hidden')) return;
    $('symSearch').value = ''; $('symSearch').focus(); renderSyms();
    try { await OF.loadMarkets(); renderSyms(); } catch (e) { $('symList').innerHTML = '<div class="muted pad">Could not load markets</div>'; }
  };
  $('symSearch').oninput = renderSyms;
  $('symSearch').onkeydown = e => { if (e.key === 'Enter') { const f = $('symList').querySelector('[data-s]'); if (f) pick(f.dataset.s); } if (e.key === 'Escape') $('symMenu').classList.add('hidden'); };
  document.addEventListener('pointerdown', e => { if (!$('symMenu').contains(e.target) && e.target !== $('symBtn')) $('symMenu').classList.add('hidden'); });
}
function renderSyms() {
  const q = $('symSearch').value.trim().toUpperCase(), rec = LS.get('recent', []);
  const list = (OF._markets || []).filter(m => !q || m.base.includes(q)).slice(0, 80);
  $('symList').innerHTML = (rec.length && !q ? '<div class="rec">' + rec.map(s => `<button data-s="${s}">${s.replace(/USDT$/, '')}</button>`).join('') + '</div>' : '') +
    (list.length ? list.map(m => `<div class="srow" data-s="${m.symbol}"><b>${m.base}</b><span class="mono">${m.last}</span><span class="mono ${m.chg >= 0 ? 'g' : 'r'}">${m.chg >= 0 ? '+' : ''}${m.chg.toFixed(2)}%</span></div>`).join('') : '<div class="muted pad">Loading markets…</div>');
  $('symList').querySelectorAll('[data-s]').forEach(x => x.onclick = () => pick(x.dataset.s));
}
function pick(sym) {
  $('symMenu').classList.add('hidden');
  const rec = [sym].concat(LS.get('recent', []).filter(s => s !== sym)).slice(0, 6); LS.set('recent', rec);
  LS.set('symbol', sym); startSymbol(sym);
}
function startSymbol(sym) {
  $('symBtn').textContent = sym.replace(/USDT$/, '/USDT') + ' ▾';
  OF.start(sym).then(() => { if (!OF.S.info) return; ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d'].forEach(tf => OF.loadKlines(tf)); });
  mountView(true);
}

function updateHeader() {
  const S = OF.S; if (!S) return;
  const st = OF.demo ? 'DEMO' : S.status;
  const b = $('status'); b.textContent = st; b.className = 'badge ' + st.toLowerCase();
  b.title = st === 'OFFLINE' ? (S.err || 'Reconnecting…') : `Lag ${Math.round(S.lagMs)} ms · ${S.msgRate.toFixed(0)} msg/s · ${S.resyncs} book resyncs · ${S.reconnects} reconnects`;
  $('lag').textContent = S.lagMs > 500 && !OF.demo ? 'lag ' + Math.round(S.lagMs) + ' ms' : '';
  if (!S.info) return;
  $('qLast').textContent = OF.fp(S.last);
  $('qBid').textContent = OF.fp(S.bb); $('qAsk').textContent = OF.fp(S.ba);
  if (S.bb && S.ba) { const t = Math.round((S.ba - S.bb) / S.info.tick), bp = (S.ba - S.bb) / S.bb * 1e4; $('qSpread').textContent = t + ' tick' + (t === 1 ? '' : 's') + ' · ' + bp.toFixed(bp < 0.1 ? 3 : bp < 10 ? 2 : 1) + ' bp'; }
  const ago = S.lastTradeT ? (OF.now() - S.lastTradeT) / 1000 : 0;
  $('qAgo').textContent = ago > 30 ? 'last trade ' + (ago < 120 ? Math.round(ago) + 's' : Math.round(ago / 60) + 'm') + ' ago' : '';
  const k = S.k[A.tf], c = k && k[k.length - 1];
  $('stCandle').innerHTML = c ? `${A.tf} candle Δ <b class="${2 * c.bv - c.v >= 0 ? 'g' : 'r'}">${(2 * c.bv - c.v).toFixed(c.v < 10 ? 3 : 1)} ${S.info.base}</b>` : '';
  $('stCvd').innerHTML = `CVD <b class="${S.cvd >= 0 ? 'g' : 'r'}">${OF.fmtUsd(S.cvd)}</b>`;
  const ss = OF.session(); $('stPoc').innerHTML = ss && ss.today ? `POC <b class="y">${OF.fp(ss.today.poc)}</b>` : '';
  document.title = OF.fp(S.last) + ' · ' + S.symbol + ' · FlowDesk';
}

/* ---------- tabs & views ---------- */
function buildTabs() {
  const t = $('tabs'); t.innerHTML = '';
  ORDER.forEach((id, i) => {
    const v = OF.views[id], b = el('button', id === A.view ? 'on' : '', v.label);
    b.title = v.title + (i < 10 ? ' (key ' + ((i + 1) % 10) + ')' : '');
    b.onclick = () => setView(id); t.appendChild(b);
  });
}
OF.app.remount = () => mountView();
function setView(id) { A.view = id; LS.set('view', id); buildTabs(); mountView(); }
let cur = null;
function mountView() {
  const v = OF.views[A.view], tb = $('toolbar'), box = $('view');
  if (cur && cur.unmount) cur.unmount();
  tb.innerHTML = ''; box.innerHTML = ''; box.className = 'view';
  if (v.c) v.c = null;
  v.toolbar && v.toolbar(tb); v.mount(box); cur = v;
  $('reading').innerHTML = ''; $('reading').style.display = v.reading ? '' : 'none';
  ui.tip();
  tick(true);
}

/* ---------- right panel ---------- */
function renderDecision() {
  const d = OF.lastDecision, box = $('decision'); if (!d) { box.innerHTML = '<div class="muted pad">Warming up…</div>'; return; }
  const cls = d.verdict === 'BUY' ? 'buy' : d.verdict === 'SELL' ? 'sell' : 'wait';
  $('vtab').textContent = d.verdict; $('vtab').className = 'vtab ' + cls;
  box.innerHTML = `<div class="dhead"><span class="verdict ${cls}">${d.verdict}</span><div><div class="dsc">${OF.label(d.score)} ${Math.round(Math.abs(d.score))}</div><div class="muted sm">confidence ${d.confidence}% · ${Math.round(d.agree * 100)}% of meters agree</div></div></div>
    <div class="sbar"><i style="left:${(d.score + 100) / 2}%"></i></div>
    ${d.plan ? `<div class="plan"><div><span class="g">▲ buy above</span> <b class="mono">${OF.fp(d.plan.buyAbove)}</b></div><div><span class="r">▼ sell below</span> <b class="mono">${OF.fp(d.plan.sellBelow)}</b></div></div>` : ''}
    <div class="why">${d.reasons.map(r => `<div><b class="${r.score > 0 ? 'g' : 'r'}">${r.score > 0 ? '▲' : '▼'}</b> ${r.name}: <span class="muted">${r.text}</span></div>`).join('') || '<div class="muted">No strong readings — nothing to act on.</div>'}</div>
    <div class="muted sm">Danger: <b class="${d.danger > 66 ? 'r' : d.danger > 33 ? 'y' : 'g'}">${d.danger > 66 ? 'high' : d.danger > 33 ? 'elevated' : 'calm'}</b> · Describes now, not advice.</div>`;
}
function renderDom() {
  const S = OF.S, box = $('dom'); if (!S || !S.synced || !S.bin) { box.innerHTML = '<div class="muted pad">Syncing book…</div>'; return; }
  const mid = OF.mid(), bin = Math.max(S.bin, Math.round(OF.niceStep(mid * 0.00004) / S.bin) * S.bin), N = 14;
  const center = Math.floor(mid / bin) * bin, lo = center - N * bin, hi = center + (N + 1) * bin;
  const bids = new Map(), asks = new Map(), traded = new Map(), prev = new Map();
  for (const [p, q] of S.bids) if (p >= lo) { const k = Math.floor(p / bin) * bin; bids.set(k, (bids.get(k) || 0) + p * q); }
  for (const [p, q] of S.asks) if (p < hi) { const k = Math.floor(p / bin) * bin; asks.set(k, (asks.get(k) || 0) + p * q); }
  const now = OF.now(); for (let i = S.trades.length - 1; i >= 0 && S.trades[i].t > now - 60000; i--) { const t = S.trades[i], k = Math.floor(t.p / bin) * bin; traded.set(k, (traded.get(k) || 0) + t.n); }
  const old = S.cols[Math.max(0, S.cols.length - 120)];
  if (old) for (let k = lo; k < hi; k += bin) { let s = 0; const i0 = Math.floor(k / S.bin) - old.b0, n = Math.round(bin / S.bin); for (let j = 0; j < n; j++) s += old.arr[i0 + j] || 0; prev.set(Math.round(k / bin), s); }
  let mx = 0; for (const v of bids.values()) mx = Math.max(mx, v); for (const v of asks.values()) mx = Math.max(mx, v);
  let tm = 0; for (const v of traded.values()) tm = Math.max(tm, v);
  let html = '<table class="dom"><thead><tr><th>Δ 1m</th><th>bid $</th><th>price</th><th>ask $</th><th>traded</th></tr></thead><tbody>';
  for (let k = hi - bin; k >= lo; k -= bin) {
    const kk = Math.round(k / bin) * bin, b = bids.get(kk) || 0, a = asks.get(kk) || 0, tr = traded.get(kk) || 0;
    const pv = prev.get(Math.round(k / bin)), dlt = pv != null ? (a + b) - pv : 0, isMid = S.last >= kk && S.last < kk + bin;
    html += `<tr class="${isMid ? 'midr' : ''}"><td class="mono ${dlt > 0 ? 'g' : dlt < 0 ? 'r' : 'muted'}">${Math.abs(dlt) > mx * 0.02 ? OF.fmtUsd(dlt, true) : ''}</td>
      <td class="bcell">${b ? `<i style="width:${b / mx * 100}%"></i><span>${OF.fmtUsd(b)}</span>` : ''}</td>
      <td class="mono pc">${OF.fp(kk)}</td>
      <td class="acell">${a ? `<i style="width:${a / mx * 100}%"></i><span>${OF.fmtUsd(a)}</span>` : ''}</td>
      <td class="tcell">${tr ? `<i style="width:${tr / tm * 100}%"></i><span>${OF.fmtUsd(tr)}</span>` : ''}</td></tr>`;
  }
  html += '</tbody></table>';
  // mini tape
  const min = Math.max(1000, S.whaleThr * 0.02); let tb = 0, ts = 0, rows = '', n = 0;
  for (let i = S.trades.length - 1; i >= 0 && S.trades[i].t > now - 60000; i--) { const t = S.trades[i]; if (t.buy) tb += t.n; else ts += t.n; if (t.n >= min && n < 18) { n++; rows += `<div class="mt-row ${t.buy ? 'b' : 's'}"><span class="mono muted">${OF.hm(t.t, true)}</span><span class="mono">${OF.fp(t.p)}</span><b class="mono">${OF.fmtUsd(t.n)}</b></div>`; } }
  html += `<div class="mtape"><div class="mth">tape ≥ ${OF.fmtUsd(min)} · last 1 min <span class="g">B ${OF.fmtUsd(tb)}</span> <span class="r">S ${OF.fmtUsd(ts)}</span></div>${rows}</div>`;
  box.innerHTML = html;
}
function applyPanel() { document.body.classList.toggle('nopanel', !A.panel); LS.set('panel', A.panel); }

/* ---------- multi-timeframe direction bar ---------- */
function renderMtf() {
  const m = OF.mtf(), box = $('mtf'); if (!m) return;
  const pc = v => (v >= 0 ? '+' : '') + Math.round(v * 100);
  const chip = r => {
    if (r.score == null) return `<span class="mchip"><b>${r.tf}</b> <span class="muted">loading</span></span>`;
    const c = r.score > 15 ? 'up' : r.score < -15 ? 'dn' : 'flat', arrow = r.score > 15 ? '▲' : r.score < -15 ? '▼' : '◆';
    const word = r.score > 55 ? 'Strong up' : r.score > 15 ? 'Up' : r.score < -55 ? 'Strong down' : r.score < -15 ? 'Down' : 'Sideways';
    const tip = `${r.tf}: score ${r.score}\ntrend ${pc(r.trend)} (price ${OF.S.last > r.ema21 ? 'above' : 'below'} EMA21 ${OF.fp(r.ema21)})\ncandle delta ${pc(r.delta)}\nmomentum ${pc(r.mom)}` + (r.flow != null ? `\nlive trade flow ${pc(r.flow)}` : '');
    return `<span class="mchip ${c}" title="${tip}"><b>${r.tf}</b> ${arrow} ${word} <span class="mono">${Math.abs(r.score)}</span><i style="width:${Math.min(100, Math.abs(r.score))}%"></i></span>`;
  };
  const o = m.overall, oc = o == null ? '' : o > 15 ? 'up' : o < -15 ? 'dn' : 'flat';
  const ow = o == null ? 'loading' : o > 15 ? 'BULLISH' : o < -15 ? 'BEARISH' : 'MIXED';
  const n = m.rows.filter(r => r.score != null).length;
  const msg = o == null ? '' : m.up === n ? 'all timeframes up' : m.dn === n ? 'all timeframes down' : m.up && m.dn ? 'short and long timeframes disagree — trade smaller or wait' : 'leaning ' + (o > 0 ? 'up' : 'down');
  box.innerHTML = `<span class="lbl">Market direction</span>${m.rows.map(chip).join('')}<span class="mchip ov ${oc}" title="Weighted: 1m 0.5 · 5m 0.8 · 15m 1 · 1h 1.2 · 4h 1.2 · 12h 1"><b>Overall</b> ${ow} <span class="mono">${o == null ? '' : Math.abs(o)}</span></span><span class="muted sm">${m.up}▲ ${m.dn}▼ · ${msg}</span>`;
}

/* ---------- key points strip (plain-language read, every tab) ---------- */
function renderKeyRead() {
  const box = $('keyread'), k = OF.keyRead(), open = LS.get('krOpen', true);
  if (!k) { box.innerHTML = '<div class="krmini muted">Key points: collecting candles and order book…</div>'; return; }
  const fp = OF.fp, pct = p => ((p / k.px - 1) * 100).toFixed(2) + '%';
  const tcls = k.trend === 'UP' ? 'up' : k.trend === 'DOWN' ? 'dn' : 'flat', tword = k.trend === 'UP' ? '▲ UPTREND' : k.trend === 'DOWN' ? '▼ DOWNTREND' : '◆ RANGE';
  const pcls = k.pside === 'BUYERS' ? 'up' : k.pside === 'SELLERS' ? 'dn' : 'flat';
  const lvl = (z, kind) => z ? `<div class="krv mono">${fp(z.p)} <small>${pct(z.p)}</small>${z.fake ? ' <span class="y" title="A wall here keeps getting pulled — may be fake">⚠</span>' : ''}</div><div class="krs">${z.src.slice(0, 4).join(' · ')}</div>` : `<div class="krv muted">none nearby</div>`;
  if (!open) {
    box.innerHTML = `<div class="krmini"><button class="krt" title="Show key points">▸ Key points</button> <b class="${tcls}">${tword}</b> · pressure <b class="${pcls}">${k.pside}</b> · <span class="r">R ${k.res ? fp(k.res.p) : '—'}</span> · <span class="g">S ${k.sup ? fp(k.sup.p) : '—'}</span> · <span class="muted">${k.lean}</span></div>`;
  } else {
    box.innerHTML = `<div class="kr">
      <button class="krt" title="Hide key points">▾</button>
      <div class="krc ${tcls}"><div class="krh">${k.trendLabel}</div><div class="krv">${tword}</div><div class="krs">${k.trendWhy.join(' · ')}</div></div>
      <div class="krc ${pcls}"><div class="krh">PRESSURE NOW</div><div class="krv">${k.pside} <small>${Math.round(k.buyShare * 100)}% buys (5 min)</small></div><div class="kbar"><i style="width:${Math.round(k.buyShare * 100)}%"></i></div></div>
      <div class="krc res"><div class="krh">★ KEY RESISTANCE · ${k.tf}</div>${lvl(k.res)}</div>
      <div class="krc sup"><div class="krh">★ KEY SUPPORT · ${k.tf}</div>${lvl(k.sup)}</div>
      <div class="krc wide ${k.leanCls}"><div class="krh">WHAT IT MEANS</div><div class="krl">${k.lean}</div><div class="krs">${k.brk}</div>${k.inside ? `<div class="krs y">⚑ Price is sitting ON a key zone ${fp(k.inside.p)} (${k.inside.src.slice(0, 3).join(', ')}) — expect a reaction here.</div>` : k.where ? `<div class="krs y">${k.where}</div>` : ''}</div>
    </div>`;
  }
  box.querySelector('.krt').onclick = () => { LS.set('krOpen', !open); renderKeyRead(); };
}

/* ---------- loop ---------- */
let n = 0;
function tick(force) {
  n++;
  const S = OF.S; if (!S) return;
  if (force || n % 4 === 0) { try { OF.lastDecision = OF.decision(); } catch (e) { console.error(e); } updateHeader(); try { renderMtf(); } catch (e) { console.error(e); } try { renderKeyRead(); } catch (e) { console.error(e); } }
  const v = cur; if (!v) return;
  const isCanvas = !!v.c;
  if (force || isCanvas || n % 2 === 0) { ui.lblReset(); try { v.render(); } catch (e) { console.error(e); } }
  if (v.reading && (force || n % 4 === 0)) { try { $('reading').innerHTML = v.reading(); } catch (e) {} }
  if (A.panel && (force || n % 2 === 0)) { renderDecision(); renderDom(); }
}

/* ---------- View menu: hide any strip for a bigger chart ---------- */
const HIDE = [['brand', 'Brand bar', '.brandbar'], ['mtf', 'Market direction bar', '#mtf'], ['kr', 'Key points strip', '#keyread'], ['read', 'Explanation line under the toolbar', '#reading'], ['tb', 'Tool bar (span, range, columns…)', '#toolbar'], ['stats', 'Candle Δ / CVD / POC in the tab bar', '.stats .mono']];
function applyHide() { const h = LS.get('hide', {}); HIDE.forEach(([k]) => document.body.classList.toggle('hide-' + k, !!h[k])); setTimeout(() => tick(true), 0); }
function setFull(on) { const h = {}; if (on) HIDE.forEach(([k]) => { if (k !== 'tb') h[k] = true; }); LS.set('hide', h); A.panel = !on; applyPanel(); applyHide(); }
function viewMenu() {
  let pop = $('viewPop'); if (pop) { pop.remove(); return; }
  const h = LS.get('hide', {}); pop = el('div', 'colspop viewpop'); pop.id = 'viewPop';
  const r = $('viewBtn').getBoundingClientRect(); pop.style.top = (r.bottom + 6) + 'px'; pop.style.left = Math.max(8, r.right - 300) + 'px'; pop.style.width = '300px';
  pop.innerHTML = '<div class="cph">Show on screen</div>' + HIDE.map(([k, t]) => `<label class="vrow"><input type="checkbox" data-k="${k}" ${h[k] ? '' : 'checked'}> ${t}</label>`).join('') +
    `<label class="vrow"><input type="checkbox" data-k="panel" ${A.panel ? 'checked' : ''}> Right panel (Decision + DOM) <span class="muted sm">P</span></label>
     <div class="vbtns"><button data-a="full">⛶ Full chart view <span class="muted sm">F</span></button><button data-a="all">Show everything</button></div>`;
  pop.querySelectorAll('input').forEach(i => i.onchange = () => {
    if (i.dataset.k === 'panel') { A.panel = i.checked; applyPanel(); setTimeout(() => tick(true), 0); return; }
    const hh = LS.get('hide', {}); hh[i.dataset.k] = !i.checked; LS.set('hide', hh); applyHide();
  });
  pop.querySelector('[data-a=full]').onclick = () => { setFull(true); pop.remove(); };
  pop.querySelector('[data-a=all]').onclick = () => { setFull(false); pop.remove(); };
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener('pointerdown', function f(e) { if (!pop.contains(e.target) && e.target !== $('viewBtn')) { pop.remove(); document.removeEventListener('pointerdown', f); } }), 0);
}

/* ---------- keys ---------- */
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey || (e.target && e.target.closest && e.target.closest('input,select,textarea'))) return;
  if (e.key === 'p' || e.key === 'P') { A.panel = !A.panel; applyPanel(); setTimeout(() => tick(true), 0); return; }
  if (e.key === 'f' || e.key === 'F') { const h = LS.get('hide', {}); setFull(!(h.mtf && h.kr && h.read)); return; }
  if (/^[0-9]$/.test(e.key)) { const i = e.key === '0' ? 9 : +e.key - 1; if (ORDER[i]) setView(ORDER[i]); }
});

/* ---------- demo mode (synthetic data, for previewing offline) ---------- */
OF.startDemo = function (S) {
  S.info = { base: 'BTC', quote: 'USDT', tick: 0.01, dp: 2 }; S.status = 'LIVE'; S.synced = true; OF.emit('info');
  let mid = 76000, id = 1;
  const rnd = () => Math.random(), walls = new Map();
  for (let i = 0; i < 6; i++) walls.set(Math.round((mid + (rnd() - 0.5) * 120) * 100) / 100, 2 + rnd() * 10);
  const rebuild = () => {
    S.bids.clear(); S.asks.clear();
    for (let i = 1; i < 800; i++) { const pb = Math.round((mid - i * 0.5) * 100) / 100, pa = Math.round((mid + i * 0.5) * 100) / 100; S.bids.set(pb, rnd() * 0.4 * Math.exp(-i / 400)); S.asks.set(pa, rnd() * 0.4 * Math.exp(-i / 400)); }
    for (const [p, q] of walls) (p < mid ? S.bids : S.asks).set(p, q);
    S.bb = Math.round((mid - 0.005) * 100) / 100; S.ba = Math.round((mid + 0.005) * 100) / 100;
  };
  rebuild();
  OF.demoTimer = setInterval(() => {
    const t = OF.now();
    mid += (rnd() - 0.5) * 6 + Math.sin(t / 60000) * 0.6;
    if (rnd() < 0.02) { const k = [...walls.keys()][Math.floor(rnd() * walls.size)]; walls.delete(k); S.events.push({ t, type: 'pull', side: k < mid ? 'bid' : 'ask', p: k, n: 300000, age: 40, times: 1 }); walls.set(Math.round((mid + (rnd() - 0.5) * 150) * 100) / 100, 2 + rnd() * 10); }
    rebuild();
    const k = 1 + Math.floor(rnd() * 6);
    for (let i = 0; i < k; i++) {
      const buy = rnd() < 0.5 + Math.sin(t / 45000) * 0.15, q = Math.exp(rnd() * 5 - 6) * (rnd() < 0.01 ? 40 : 1);
      const d = { p: String(buy ? S.ba : S.bb), q: String(q), T: t, E: t, m: !buy, a: id++ };
      OF._onTrade(S, d);
    }
  }, 100);
  S.whaleThr = 60000; S.l3Min = 50000;
  OF.loadDay();
};
OF.demoKlines = tf => {
  const ms = OF.tfMs[tf], n = 600, out = []; let p = 75500; const now = Math.floor(OF.now() / ms) * ms;
  for (let i = n; i > 0; i--) { const o = p; p += (Math.random() - 0.48) * 75000 * Math.sqrt(ms / 6e4) * 0.0005; const h = Math.max(o, p) + Math.random() * 20, l = Math.min(o, p) - Math.random() * 20, v = 5 + Math.random() * 40; const qv = v * p; out.push({ t: now - i * ms, o, h, l, c: p, v, qv, bv: v * (0.4 + Math.random() * 0.2), bqv: qv * (0.4 + Math.random() * 0.2) }); }
  return out;
};

/* ---------- boot ---------- */
window.addEventListener('DOMContentLoaded', () => {
  OF.demo = /[?&]demo=1/.test(location.search);
  buildHeader(); buildTabs(); applyPanel();
  $('panelBtn').onclick = $('vtab').onclick = () => { A.panel = !A.panel; applyPanel(); };
  applyHide(); $('viewBtn').onclick = viewMenu;
  const sym = (new URLSearchParams(location.search).get('symbol') || LS.get('symbol', 'BTCUSDT')).toUpperCase();
  startSymbol(sym);
  setInterval(tick, 250);
  window.addEventListener('resize', () => tick(true));
  // offer demo data if nothing connects within 12 s
  setTimeout(() => { const S = OF.S; if (S && !S.last && !OF.demo) { $('reading').style.display = ''; $('reading').innerHTML = '<b class="r">No live data yet.</b> ' + (S.err || 'The exchange may be blocked on this network.') + ' <a href="?demo=1">Open demo data</a> to preview the terminal.'; } }, 12000);
});
})();

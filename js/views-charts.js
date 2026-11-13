/* FlowDesk chart views: Heatmap, Chart, Footprint, Whales. */
(function () {
'use strict';
const OF = window.OF, C = OF.C, el = OF.el, ui = OF.ui, LS = OF.LS;

/* ===================== HEATMAP COLUMNS (right of the heatmap, aligned to its price rows) ===================== */
const COLS = {
  delta:    { label: 'Delta',        w: 66,  desc: 'Bought − sold at each price (recorded since the page opened): which side was more aggressive there' },
  book:     { label: 'Book',         w: 128, desc: 'Live resting bid and ask size at each price, as coloured bars and $' },
  tape:     { label: 'Tape',         w: 178, desc: 'Time & sales: newest trades on top, buyers green, sellers red (not price-aligned)' },
  cob:      { label: 'COB',          w: 86,  desc: 'Current order book: resting size at each price as one bar — bids green below, asks red above' },
  superdom: { label: 'SuperDOM',     w: 300, desc: 'Trading-terminal ladder: sold | bid | price | ask | bought' },
  size:     { label: 'Size $',       w: 68,  desc: 'Resting size at each price, in dollars' },
  cum:      { label: 'Cumulative $', w: 72,  desc: 'Resting size added up from the spread outward — how much must trade to reach that price' },
  volume:   { label: 'Volume',       w: 80,  desc: 'Traded at each price (recorded): bought green, sold red' },
  svp:      { label: 'SVP',          w: 74,  desc: 'Session volume profile: traded at each price since 00:00 UTC (from 1-minute candles)' },
  cumd:     { label: 'Cumulative Δ', w: 74,  desc: 'Delta added up from the current price outward' },
  cqc:      { label: 'CQC',          w: 56,  desc: 'Quote-change counter: how many times the resting size at that price changed — busy, flickering levels' }
};
const COL_IDS = Object.keys(COLS);
const PRESETS = [['Book + tape', ['book', 'tape']], ['SuperDOM + tape', ['superdom', 'tape']], ['Depth ladder', ['book', 'size', 'cum']], ['Delta + tape', ['delta', 'tape']],
  ['Order flow', ['delta', 'volume', 'cumd', 'tape']], ['COB + SVP + CQC', ['cob', 'svp', 'cqc']], ['Everything', COL_IDS.slice()]];
const k$ = n => OF.fmtUsd(n).replace('$', '');

function drawColumns(ctx, x0, top, ph, lo, hi, rb, Y, list, o, mouse) {
  const S = OF.S, mid = OF.mid();
  const rh0 = ph * rb / (hi - lo), cb = rb * Math.max(1, Math.ceil(15 / rh0)), ch = ph * cb / (hi - lo);
  const r0 = Math.floor(lo / cb), r1 = Math.ceil(hi / cb), key = p => Math.floor(p / cb);
  // data per row
  const bid = new Map(), ask = new Map(), vb = new Map(), vs = new Map(), svp = new Map(), q = new Map();
  for (const [p, s] of S.bids) if (p >= lo && p <= hi) { const k = key(p); bid.set(k, (bid.get(k) || 0) + p * s); }
  for (const [p, s] of S.asks) if (p >= lo && p <= hi) { const k = key(p); ask.set(k, (ask.get(k) || 0) + p * s); }
  for (const [p, v] of S.volAt) if (p >= lo && p <= hi) { const k = key(p); vb.set(k, (vb.get(k) || 0) + v.b); vs.set(k, (vs.get(k) || 0) + v.s); }
  for (const [p, n] of S.cqc) if (p >= lo && p <= hi) { const k = key(p); q.set(k, (q.get(k) || 0) + n); }
  const ss = OF.session(); if (ss && ss.today) for (const r of ss.today.rows) { const c = r.p + ss.today.bin / 2; if (c >= lo && c <= hi) { const k = key(c); svp.set(k, (svp.get(k) || 0) + r.v); } }
  const mk = key(S.last || mid), bestBid = S.bb ? key(S.bb) : mk, bestAsk = S.ba ? key(S.ba) : mk;
  const cumB = new Map(), cumA = new Map(); let acc = 0;
  for (let k = bestBid; k >= r0; k--) { acc += bid.get(k) || 0; cumB.set(k, acc); } acc = 0;
  for (let k = bestAsk; k <= r1; k++) { acc += ask.get(k) || 0; cumA.set(k, acc); }
  const dl = k => (vb.get(k) || 0) - (vs.get(k) || 0), cumD = new Map(); acc = 0;
  for (let k = mk; k <= r1; k++) { acc += dl(k); cumD.set(k, acc); } acc = 0;
  for (let k = mk; k >= r0; k--) { acc += dl(k); if (k !== mk) cumD.set(k, acc); }
  const max = m => { let x = 0; for (const v of m.values()) x = Math.max(x, Math.abs(v)); return x || 1; };
  const mBook = Math.max(max(bid), max(ask)), mVol = Math.max(max(vb), max(vs)), mSvp = max(svp), mQ = max(q), mCum = Math.max(max(cumB), max(cumA)), mCD = max(cumD);
  let mD = 0; for (let k = r0; k <= r1; k++) mD = Math.max(mD, Math.abs(dl(k))); mD = mD || 1;
  const sum = m => { let s = 0; for (const v of m.values()) s += v; return s; };
  const rowY = k => Y((k + 1) * cb), fs = ch >= 13 ? 10 : 0;
  ctx.font = '10px ui-monospace,Menlo,monospace'; ctx.textBaseline = 'middle';
  const bar = (x, w, y, frac, col, right) => { const bw = Math.max(1, Math.abs(frac) * (w - 4)); ctx.fillStyle = col; ctx.fillRect(right ? x + w - 2 - bw : x + 2, y + 1, bw, Math.max(1, ch - 2)); };
  const txt = (x, w, y, t, col, align) => { if (!fs || !t) return; ctx.fillStyle = col || '#e5e7eb'; ctx.textAlign = align || 'right'; ctx.fillText(t, align === 'left' ? x + 4 : align === 'center' ? x + w / 2 : x + w - 4, y + ch / 2); };
  let x = x0; const hdr = [], hit = [];
  for (const c of list) {
    const w = c.w;
    ctx.fillStyle = '#0c1016'; ctx.fillRect(x, top, w, ph);
    ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(x + .5, top - 30); ctx.lineTo(x + .5, top + ph); ctx.stroke();
    // highlight current price row
    ctx.fillStyle = 'rgba(255,255,255,.06)'; ctx.fillRect(x, rowY(mk), w, ch);
    const sub = [];
    if (c.id === 'tape') {
      const tr = S.trades, ns = []; for (let i = Math.max(0, tr.length - 3000); i < tr.length; i++) ns.push(tr[i].n);
      const min = Math.max(100, OF.pctile(ns, 0.7)), f1 = OF.flow(OF.now() - 60000), rowH = 15;
      let y = top + 2, nrow = 0;
      for (let i = tr.length - 1; i >= 0 && y + rowH <= top + ph; i--) {
        const t = tr[i]; if (t.n < min) continue;
        ctx.fillStyle = t.buy ? 'rgba(34,197,94,' + (0.08 + Math.min(0.4, t.n / (S.whaleThr || 1e6))) + ')' : 'rgba(239,68,68,' + (0.08 + Math.min(0.4, t.n / (S.whaleThr || 1e6))) + ')';
        ctx.fillRect(x + 1, y, w - 2, rowH - 1);
        const wide = w >= 165; ctx.textAlign = 'left';
        if (wide) { ctx.fillStyle = C.muted; ctx.fillText(OF.hm(t.t, true), x + 4, y + rowH / 2); }
        ctx.fillStyle = t.buy ? '#86efac' : '#fca5a5'; ctx.fillText(OF.fp(t.p), x + (wide ? 58 : 4), y + rowH / 2);
        ctx.fillStyle = '#e5e7eb'; ctx.textAlign = 'right'; ctx.fillText('$' + k$(t.n), x + w - 4, y + rowH / 2);
        y += rowH; nrow++;
      }
      hdr.push([x, w, 'tape ≥ $' + k$(min), `<g>B $${k$(f1.b)}</g> <r>S $${k$(f1.s)}</r>`]);
    } else {
      const sw = c.id === 'superdom' ? w / 5 : c.id === 'book' ? w / 2 : w;
      for (let k = r0; k <= r1; k++) {
        const y = rowY(k); if (y + ch < top || y > top + ph) continue;
        const b = bid.get(k) || 0, a = ask.get(k) || 0, d = dl(k), above = k > mk || (k === mk && a && !b);
        if (c.id === 'delta') { if (d) { bar(x, w, y, d / mD, d > 0 ? 'rgba(34,197,94,.45)' : 'rgba(239,68,68,.45)', true); txt(x, w, y, (d > 0 ? '+' : '') + k$(d), d > 0 ? '#86efac' : '#fca5a5'); } }
        else if (c.id === 'book') {
          if (b) { bar(x, sw, y, b / mBook, 'rgba(34,197,94,.55)', true); txt(x, sw, y, k$(b)); }
          if (a) { bar(x + sw, sw, y, a / mBook, 'rgba(239,68,68,.55)', false); txt(x + sw, sw, y, k$(a)); }
        } else if (c.id === 'cob' || c.id === 'size') {
          const v = b || a; if (v) { const col = b ? 'rgba(34,197,94,' : 'rgba(239,68,68,'; if (c.id === 'cob') bar(x, w, y, v / mBook, col + '.6)', false); else { ctx.fillStyle = col + (0.1 + 0.5 * v / mBook) + ')'; ctx.fillRect(x + 1, y + 1, w - 2, ch - 2); } txt(x, w, y, k$(v)); }
        } else if (c.id === 'superdom') {
          const sv = vs.get(k) || 0, bv = vb.get(k) || 0;
          if (sv) { bar(x, sw, y, sv / mVol, 'rgba(239,68,68,.35)', true); txt(x, sw, y, k$(sv), '#fca5a5'); }
          if (b) { bar(x + sw, sw, y, b / mBook, 'rgba(34,197,94,.55)', true); txt(x + sw, sw, y, k$(b)); }
          ctx.fillStyle = k === mk ? '#e5e7eb' : 'rgba(255,255,255,.03)'; ctx.fillRect(x + 2 * sw + 1, y + 1, sw - 2, ch - 2); txt(x + 2 * sw, sw, y, OF.fp(k * cb), k === mk ? '#000' : C.muted, 'center');
          if (a) { bar(x + 3 * sw, sw, y, a / mBook, 'rgba(239,68,68,.55)', false); txt(x + 3 * sw, sw, y, k$(a)); }
          if (bv) { bar(x + 4 * sw, sw, y, bv / mVol, 'rgba(34,197,94,.35)', false); txt(x + 4 * sw, sw, y, k$(bv), '#86efac'); }
        } else if (c.id === 'cum') {
          const v = above ? cumA.get(k) : cumB.get(k); if (v) { bar(x, w, y, v / mCum, above ? 'rgba(239,68,68,.35)' : 'rgba(34,197,94,.35)', false); txt(x, w, y, k$(v) ); }
        } else if (c.id === 'volume') {
          const bv = vb.get(k) || 0, sv = vs.get(k) || 0, t = bv + sv;
          if (t) { const ws = sv / mVol * (w - 4), wb = bv / mVol * (w - 4); ctx.fillStyle = 'rgba(239,68,68,.55)'; ctx.fillRect(x + 2, y + 1, ws, ch - 2); ctx.fillStyle = 'rgba(34,197,94,.55)'; ctx.fillRect(x + 2 + ws, y + 1, wb, ch - 2); txt(x, w, y, k$(t)); }
        } else if (c.id === 'svp') { const v = svp.get(k); if (v) { bar(x, w, y, v / mSvp, 'rgba(56,189,248,.5)', false); txt(x, w, y, k$(v)); } }
        else if (c.id === 'cumd') { const v = cumD.get(k); if (v) { bar(x, w, y, v / mCD, v > 0 ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)', true); txt(x, w, y, (v > 0 ? '+' : '') + k$(v), v > 0 ? '#86efac' : '#fca5a5'); } }
        else if (c.id === 'cqc') { const v = q.get(k); if (v) { bar(x, w, y, v / mQ, 'rgba(167,139,250,.45)', false); txt(x, w, y, String(v)); } }
      }
      if (c.id === 'delta') { let t = 0; for (let k = r0; k <= r1; k++) t += dl(k); hdr.push([x, w, 'Δ sess', `<${t >= 0 ? 'g' : 'r'}>${t >= 0 ? '+' : ''}${k$(t)}</>`]); }
      else if (c.id === 'book') { hdr.push([x, sw, 'bid $', `<g>${k$(sum(bid))}</g>`]); hdr.push([x + sw, sw, 'ask $', `<r>${k$(sum(ask))}</r>`]); }
      else if (c.id === 'superdom') { [['sold', `<r>${k$(sum(vs))}</r>`], ['bid', `<g>${k$(sum(bid))}</g>`], ['price', OF.fp(cb) + '/row'], ['ask', `<r>${k$(sum(ask))}</r>`], ['bought', `<g>${k$(sum(vb))}</g>`]].forEach((h, i) => hdr.push([x + i * sw, sw, h[0], h[1]])); }
      else if (c.id === 'cob') hdr.push([x, w, 'COB', k$(sum(bid) + sum(ask))]);
      else if (c.id === 'size') hdr.push([x, w, 'size $', '']);
      else if (c.id === 'cum') hdr.push([x, w, 'cum $', '']);
      else if (c.id === 'volume') hdr.push([x, w, 'vol', k$(sum(vb) + sum(vs))]);
      else if (c.id === 'svp') hdr.push([x, w, 'SVP day', k$(sum(svp))]);
      else if (c.id === 'cumd') hdr.push([x, w, 'cum Δ', '']);
      else if (c.id === 'cqc') hdr.push([x, w, 'CQC', '']);
    }
    hit.push([x, w, c.id]);
    x += w;
  }
  // headers
  ctx.fillStyle = '#0c1016'; ctx.fillRect(x0, top - 30, x - x0, 30);
  ctx.font = '10px ui-monospace,Menlo,monospace'; ctx.textBaseline = 'middle';
  for (const [hx, hw, a, b] of hdr) {
    ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.fillText(a, hx + 4, top - 21);
    const m = /<(g|r)>(.*?)<\//.exec(b || ''); ctx.fillStyle = m ? (m[1] === 'g' ? '#86efac' : '#fca5a5') : '#cbd5e1';
    if (b && b.includes('<g>') && b.includes('<r>')) {
      const g = /<g>(.*?)<\/g>/.exec(b)[1], r = /<r>(.*?)<\/r>/.exec(b)[1];
      ctx.fillStyle = '#86efac'; ctx.fillText(g, hx + 4, top - 8); ctx.fillStyle = '#fca5a5'; ctx.textAlign = 'right'; ctx.fillText(r, hx + hw - 4, top - 8);
    } else ctx.fillText(m ? m[2] : (b || ''), hx + 4, top - 8);
  }
  // hover readout
  if (mouse && mouse.x >= x0 && mouse.x < x && mouse.y > top && mouse.y < top + ph) {
    const p = lo + (top + ph - mouse.y) / ph * (hi - lo), k = key(p);
    ui.tip(mouse.cx, mouse.cy, `<b>${OF.fp(k * cb)} – ${OF.fp((k + 1) * cb)}</b><br><span class="g">bid ${OF.fmtUsd(bid.get(k) || 0)}</span> · <span class="r">ask ${OF.fmtUsd(ask.get(k) || 0)}</span><br>traded: <span class="g">bought ${OF.fmtUsd(vb.get(k) || 0)}</span> · <span class="r">sold ${OF.fmtUsd(vs.get(k) || 0)}</span><br>delta ${OF.fmtUsd(dl(k), true)} · quote changes ${q.get(k) || 0}${svp.get(k) ? '<br>today’s volume here ' + OF.fmtUsd(svp.get(k)) : ''}`);
  }
  return x;
}

/* Columns panel (popover) */
function colsPanel(view, anchor) {
  let pop = document.getElementById('colsPop');
  if (pop) { pop.remove(); return; }
  const o = view.o, save = () => { LS.set('hm', o); view.updBtn(); };
  pop = el('div', 'colspop'); pop.id = 'colsPop';
  const r = anchor.getBoundingClientRect(); pop.style.top = (r.bottom + 6) + 'px'; pop.style.left = Math.max(8, Math.min(window.innerWidth - 430, r.left - 200)) + 'px';
  const build = () => {
    pop.innerHTML = '<div class="cph">Columns right of the chart <button class="cpx">✕</button></div>';
    pop.querySelector('.cpx').onclick = () => pop.remove();
    const pr = el('div', 'cppre');
    PRESETS.forEach(([name, ids]) => { const b = el('button', '', name); b.onclick = () => { o.colOn = ids.slice(); o.colOrder = ids.concat(o.colOrder.filter(x => !ids.includes(x))); save(); build(); }; pr.appendChild(b); });
    pop.appendChild(pr);
    const list = el('div', 'cplist');
    o.colOrder.forEach((id, i) => {
      const row = el('div', 'cprow'), on = o.colOn.includes(id);
      row.innerHTML = `<label><input type="checkbox" ${on ? 'checked' : ''}> <b>${COLS[id].label}</b> <span>${COLS[id].desc}</span></label><button ${i ? '' : 'disabled'}>↑</button><button ${i < o.colOrder.length - 1 ? '' : 'disabled'}>↓</button>`;
      row.querySelector('input').onchange = e => { o.colOn = e.target.checked ? o.colOn.concat(id) : o.colOn.filter(x => x !== id); save(); };
      const [up, dn] = row.querySelectorAll('button');
      up.onclick = () => { const a = o.colOrder; [a[i - 1], a[i]] = [a[i], a[i - 1]]; save(); build(); };
      dn.onclick = () => { const a = o.colOrder; [a[i + 1], a[i]] = [a[i], a[i + 1]]; save(); build(); };
      list.appendChild(row);
    });
    pop.appendChild(list);
    const cvd = el('div', 'cpbox'); cvd.innerHTML = `<label><input type="checkbox" ${o.cvd ? 'checked' : ''}> <b>CVD strip</b> <span>Cumulative delta line below the chart</span></label>`;
    cvd.querySelector('input').onchange = e => { o.cvd = e.target.checked; save(); }; pop.appendChild(cvd);
    const pl = el('div', 'cpbox');
    pl.innerHTML = `<label><input type="checkbox" ${o.pl.on ? 'checked' : ''}> <b>Current price line</b> <span>Line across the chart at the live price</span></label>
      <div class="cpline"><span>Colour</span><input type="color" value="${o.pl.color}"><span>Line</span><span class="seg">${['dashed', 'dots', 'solid'].map(s => `<button data-s="${s}" class="${o.pl.style === s ? 'on' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</span>
      <span>Opacity</span><input type="range" min="10" max="100" value="${Math.round(o.pl.op * 100)}"><span class="mono">${Math.round(o.pl.op * 100)}%</span></div>`;
    pl.querySelector('input[type=checkbox]').onchange = e => { o.pl.on = e.target.checked; save(); };
    pl.querySelector('input[type=color]').oninput = e => { o.pl.color = e.target.value; save(); };
    pl.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { o.pl.style = b.dataset.s; save(); build(); });
    const rg = pl.querySelector('input[type=range]'); rg.oninput = () => { o.pl.op = rg.value / 100; rg.nextElementSibling.textContent = rg.value + '%'; save(); };
    pop.appendChild(pl);
  };
  build();
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener('pointerdown', function h(e) { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('pointerdown', h); } }), 0);
}

/* ===================== HEATMAP ===================== */
OF.views.heatmap = {
  label: 'Heatmap', title: 'Liquidity heatmap — resting orders over time, with trades as bubbles and order-flow columns',
  o: (() => {
    const o = Object.assign({ span: 120, range: 0, contrast: 1, bubbles: 'auto', marks: 'pulls', colOrder: COL_IDS.slice(), colOn: ['delta', 'book', 'tape'], cvd: false, pl: { on: true, color: '#e5e7eb', style: 'dashed', op: 1 } }, LS.get('hm', {}));
    o.colOrder = o.colOrder.filter(x => COLS[x]).concat(COL_IDS.filter(x => !o.colOrder.includes(x)));
    return o;
  })(),
  updBtn() { if (this.btn) this.btn.textContent = '▥ Columns (' + this.o.colOn.length + ')'; },
  toolbar(tb) {
    const o = this.o, save = () => LS.set('hm', o);
    tb.append(
      ui.seg('Span', [[60, '1m'], [120, '2m'], [300, '5m'], [720, '12m'], [900, '15m'], [1800, '30m'], [3600, '1h'], [14400, '4h']], o.span, v => { o.span = v; save(); }, 'How much history is on screen. Up to 30 min uses 0.5-second columns; 1h/4h use 5-second columns. History starts when you open the page.'),
      ui.seg('Price range', [[0, 'Auto'], [0.1, '±0.1%'], [0.25, '±0.25%'], [0.5, '±0.5%'], [1, '±1%']], o.range, v => { o.range = v; save(); }),
      ui.seg('Contrast', [[0, 'Low'], [1, 'Med'], [2, 'High']], o.contrast, v => { o.contrast = v; save(); }),
      ui.seg('Bubbles', [['auto', 'Auto'], ['all', 'Trades'], ['off', 'Off']], o.bubbles, v => { o.bubbles = v; save(); }, 'Trades are grouped into short time slots (about 14 px wide) so bubbles do not overlap. Auto hides the smallest 60 %; Trades shows all.'),
      ui.seg('Markers', [['pulls', 'Pulls'], ['all', 'Pulls + adds'], ['off', 'Off']], o.marks, v => { o.marks = v; save(); }, '✕ = a large order pulled without trading, + = a large order added. Only the biggest 10 % in view are drawn (max 40).'));
    this.btn = el('button', 'tgl on colsbtn', ''); this.updBtn();
    this.btn.onclick = () => colsPanel(this, this.btn);
    tb.append(this.btn);
  },
  mount(v) { this.c = ui.canvas(v); ui.track(this); },
  unmount() { const p = document.getElementById('colsPop'); if (p) p.remove(); },
  reading() {
    const w = OF.walls(0.25); if (!w) return 'Waiting for the order book…';
    const part = (s, x) => x ? `<b class="${s === 'bid' ? 'g' : 'r'}">${s} wall ${OF.fmtUsd(x.n)}</b> at ${OF.fp(x.p)} (${x.bp.toFixed(1)} bp ${s === 'bid' ? 'below' : 'above'}), standing ${x.standSec < 90 ? Math.round(x.standSec) + 's' : Math.round(x.standSec / 60) + ' min'}` + (x.pulls >= 3 ? ` · <b class="y">${x.pulls}× pulled nearby — may be a bluff</b>` : '') : '';
    return 'Nearest walls: ' + [part('bid', w.bid), part('ask', w.ask)].filter(Boolean).join(' · ') + '. Price often pauses at real walls; a wall that keeps vanishing as price nears it was likely for show.';
  },
  render() {
    const S = OF.S, c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h, o = this.o;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (!S || !S.cols.length) { ui.msg(ctx, W, H, S && S.status === 'OFFLINE' ? 'Offline — ' + (S.err || 'reconnecting…') : 'Building the order book…'); return; }
    // layout: [heatmap | columns | price axis], CVD strip under everything
    let list = o.colOrder.filter(id => o.colOn.includes(id)).map(id => ({ id, w: COLS[id].w }));
    const AX = 74, TB = 20, TOP = list.length ? 30 : 0, CVH = o.cvd ? Math.min(90, Math.round(H * 0.16)) : 0;
    let cw = list.reduce((a, x) => a + x.w, 0); const avail = W - AX - 220;
    if (cw > avail) { const f = Math.max(0.6, avail / cw); list.forEach(x => x.w = Math.floor(x.w * f)); cw = list.reduce((a, x) => a + x.w, 0); while (list.length && cw > avail) cw -= list.pop().w; }
    const pw = W - AX - cw, ph = H - TB - TOP - CVH;
    const now = OF.now(), spanMs = o.span * 1000, t0 = now - spanMs;
    const coarse = o.span > 1800, src = coarse ? S.colsC : S.cols, cols = src.slice(OF.lb(src, t0));
    const mid = OF.mid() || cols[cols.length - 1].mid;
    let lo, hi;
    if (o.range) { lo = mid * (1 - o.range / 100); hi = mid * (1 + o.range / 100); }
    else {
      let mn = Infinity, mx = -Infinity;
      for (const cl of cols) { mn = Math.min(mn, cl.bb || cl.mid); mx = Math.max(mx, cl.ba || cl.mid); }
      const pad = Math.max((mx - mn) * 0.5, mid * 0.00035); lo = mn - pad; hi = mx + pad;
      if (this.lo && Math.abs(this.lo - lo) / mid < 0.001) { lo = this.lo * 0.85 + lo * 0.15; hi = this.hi * 0.85 + hi * 0.15; }
      this.lo = lo; this.hi = hi;
    }
    const bin = S.bin, Y = p => TOP + ph - (p - lo) / (hi - lo) * ph, X = t => (t - t0) / spanMs * pw;
    let rb = OF.niceStep((hi - lo) / (ph / 4)); rb = Math.max(bin, Math.round(rb / bin) * bin);
    const r0 = Math.floor(lo / rb), nR = Math.ceil(hi / rb) - r0 + 1, rh = ph * rb / (hi - lo);
    const step = Math.max(1, Math.floor(cols.length / pw));
    const grid = [], sample = [];
    for (let ci = 0; ci < cols.length; ci += step) {
      const cl = cols[ci], g = new Float32Array(nR);
      const i0 = Math.max(0, Math.floor(lo / bin) - cl.b0), i1 = Math.min(cl.arr.length, Math.ceil(hi / bin) - cl.b0 + 1);
      for (let i = i0; i < i1; i++) { const v = cl.arr[i]; if (v) g[Math.floor((cl.b0 + i) * bin / rb) - r0] += v; }
      grid.push([cl.t, g]);
      if (ci % (step * 4) === 0) for (let r = 0; r < nR; r++) if (g[r]) sample.push(g[r]);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(0, TOP, pw, ph); ctx.clip();
    const ref = OF.pctile(sample, 0.97) || 1, gm = [0.8, 0.55, 0.35][o.contrast];
    const base = (coarse ? 5000 : 500) * step, pxPerMs = pw / spanMs;
    for (let gi = 0; gi < grid.length; gi++) {
      const [t, g] = grid[gi];
      const nt = gi + 1 < grid.length ? grid[gi + 1][0] : t + base;   // stretch to next column (fills throttled-tab gaps), max 10 s
      const x = X(t), w = Math.min(nt - t, 10000) * pxPerMs + 0.6;
      for (let r = 0; r < nR; r++) {
        const v = g[r]; if (!v) continue;
        const f = Math.pow(Math.min(1, v / ref), gm); if (f < 0.03) continue;
        ctx.fillStyle = OF.heatLUT[Math.round(f * 255)];
        ctx.fillRect(x, Y((r0 + r + 1) * rb), w, rh + 0.5);
      }
    }
    if (o.marks !== 'off') {
      const evs = S.events, ei = OF.lb(evs, t0), cand = [];
      for (let i = ei; i < evs.length; i++) { const e = evs[i]; if (e.p < lo || e.p > hi) continue; if (e.type === 'pull' || (o.marks === 'all' && e.type === 'add')) cand.push(e); }
      const floor = Math.max(S.l3Min * 3, OF.pctile(cand.map(e => e.n), 0.9));
      const show = cand.filter(e => e.n >= floor).sort((a, b) => b.n - a.n).slice(0, 40);
      ctx.lineWidth = 1.2; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const e of show) {
        const x = X(e.t), y = Y(e.p), col = e.side === 'bid' ? C.buy : C.sell;
        ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.fillStyle = e.type === 'pull' ? col : 'rgba(0,0,0,.6)'; ctx.fill(); ctx.strokeStyle = '#0a0d12'; ctx.stroke();
        ctx.fillStyle = e.type === 'pull' ? '#fff' : col; ctx.fillText(e.type === 'pull' ? '✕' : '+', x, y + 0.5);
      }
    }
    if (o.bubbles !== 'off') {
      const slotMs = Math.max(500, Math.round(14 / pxPerMs / 500) * 500), slots = new Map(), bs = S.bubbles;
      for (let i = OF.lb(bs, t0); i < bs.length; i++) { const b = bs[i], k = Math.floor(b.t / slotMs) * slotMs; let s = slots.get(k); if (!s) { s = { t: k, bn: 0, bpq: 0, sn: 0, spq: 0 }; slots.set(k, s); } s.bn += b.bn; s.bpq += b.bpq; s.sn += b.sn; s.spq += b.spq; }
      const blist = []; let mx = 0;
      for (const s of slots.values()) for (const side of ['b', 's']) { const n = s[side + 'n']; if (!n) continue; const p = s[side + 'pq'] / n; if (p < lo || p > hi) continue; blist.push({ t: s.t, n, p, buy: side === 'b' }); if (n > mx) mx = n; }
      const min = o.bubbles === 'auto' ? OF.pctile(blist.map(x => x.n), 0.6) : 0, R = OF.clamp(ph / 22, 10, 26);
      blist.sort((a, b) => b.n - a.n);
      for (const b of blist) {
        if (b.n < min) continue;
        const r = Math.max(2.5, Math.sqrt(b.n / mx) * R), x = X(b.t + slotMs / 2), y = Y(b.p);
        ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = b.buy ? 'rgba(34,197,94,.55)' : 'rgba(239,68,68,.55)'; ctx.fill();
        ctx.strokeStyle = b.buy ? '#bbf7d0' : '#fecaca'; ctx.lineWidth = r > 8 ? 1.5 : 1; ctx.stroke();
        if (r >= 14) { ctx.fillStyle = '#fff'; ctx.font = 'bold 10px ui-monospace,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(k$(b.n), x, y); }
      }
      this.bubbleSlot = slotMs;
    }
    ctx.restore();
    // legend
    ctx.fillStyle = 'rgba(10,13,18,.85)'; ctx.fillRect(6, TOP + ph - 36, 270, 30);
    for (let i = 0; i < 120; i++) { ctx.fillStyle = OF.heatLUT[Math.round(i / 119 * 255)]; ctx.fillRect(10 + i, TOP + ph - 32, 1, 8); }
    ctx.font = '10px ui-monospace,monospace'; ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('≤' + OF.fmtUsd(ref * 0.05) + ' … ' + OF.fmtUsd(ref) + '+ resting', 134, TOP + ph - 33);
    ctx.fillText((coarse ? '5-s' : '0.5-s') + ' book columns · bubbles = trades per ' + ((this.bubbleSlot || 500) / 1000) + ' s', 10, TOP + ph - 20);
    const d = OF.lastDecision;
    if (OF.app.lines.plan && d && d.plan) {
      if (d.plan.buyAbove && d.plan.buyAbove < hi) ui.hline(ctx, 0, pw, Y(d.plan.buyAbove), C.buy, [2, 3], '▲ buy above ' + OF.fp(d.plan.buyAbove));
      if (d.plan.sellBelow && d.plan.sellBelow > lo) ui.hline(ctx, 0, pw, Y(d.plan.sellBelow), C.sell, [2, 3], '▼ sell below ' + OF.fp(d.plan.sellBelow), 0);
    }
    if (OF.app.lines.liq) OF.drawLiqLines(ctx, pw, Y, lo, hi);
    if (OF.app.lines.gamma) OF.drawGammaLines(ctx, pw, Y, lo, hi);
    if (OF.app.lines.walls) OF.drawWallLines(ctx, pw, Y, lo, hi);
    // columns
    if (list.length) drawColumns(ctx, pw, TOP, ph, lo, hi, rb, Y, list, o, this.mouse);
    ctx.save(); ctx.beginPath(); ctx.rect(0, TOP, pw + cw, ph); ctx.clip(); OF.drawKeyLevels(ctx, 0, pw + cw, Y, lo, hi); ctx.restore();
    // axes
    ctx.fillStyle = C.bg; ctx.fillRect(pw + cw, 0, AX, TOP);
    ui.priceAxis(ctx, pw + cw, pw + cw, TOP, ph, lo, hi);
    ctx.fillStyle = C.bg; ctx.fillRect(0, TOP + ph, W, TB);
    ui.timeAxis(ctx, 0, pw, TOP + ph, t0, now, 100);
    // CVD strip
    if (CVH) {
      const y0 = TOP + ph + TB, tr = S.trades; ctx.fillStyle = C.panel; ctx.fillRect(0, y0, W, CVH);
      const pts = []; let cum = 0, mn = 0, mx = 0, lastX = -1;
      for (let i = OF.lb(tr, t0); i < tr.length; i++) { const t = tr[i]; cum += t.buy ? t.n : -t.n; const x = Math.round(X(t.t)); if (x !== lastX) { pts.push([x, cum]); lastX = x; } else pts[pts.length - 1][1] = cum; mn = Math.min(mn, cum); mx = Math.max(mx, cum); }
      const YC = v => y0 + 6 + (CVH - 12) - (v - mn) / ((mx - mn) || 1) * (CVH - 12);
      ui.hline(ctx, 0, pw, YC(0), C.faint, [2, 3]);
      ctx.strokeStyle = cum >= 0 ? C.buy : C.sell; ctx.lineWidth = 1.5; ctx.beginPath(); pts.forEach(([x, v], i) => i ? ctx.lineTo(x, YC(v)) : ctx.moveTo(x, YC(v))); ctx.stroke(); ctx.lineWidth = 1;
      ctx.font = '10px ui-monospace,monospace'; ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('CVD (this span)', 6, y0 + 3);
      ui.tag(ctx, pw + cw + 1, YC(cum), OF.fmtUsd(cum, true), cum >= 0 ? C.buy : C.sell, '#000');
    }
    // current price line
    if (S.last && o.pl.on) {
      const y = Y(S.last); ctx.save(); ctx.globalAlpha = o.pl.op;
      ui.hline(ctx, 0, pw + cw, y, o.pl.color, o.pl.style === 'solid' ? [] : o.pl.style === 'dots' ? [1, 3] : [5, 4]); ctx.restore();
    }
    if (S.last) ui.tag(ctx, pw + cw + 1, Y(S.last), OF.fp(S.last), '#e5e7eb', '#000');
    // hover on the heatmap
    const m = this.mouse;
    ui.cross(ctx, m, 0, pw + cw, TOP, ph, lo, hi, pw + cw + 1, x => x < pw ? t0 + x / pw * spanMs : null);
    if (m && m.x < pw && m.y > TOP && m.y < TOP + ph) {
      const p = lo + (TOP + ph - m.y) / ph * (hi - lo), t = t0 + m.x / pw * spanMs;
      let best = null; for (const gr of grid) if (!best || Math.abs(gr[0] - t) < Math.abs(best[0] - t)) best = gr;
      const r = Math.floor(p / rb) - r0, v = best ? best[1][r] : 0;
      ui.tip(m.cx, m.cy, `<b>${OF.fp(Math.floor(p / rb) * rb)}</b> · ${OF.hm(t, true)}<br>resting ${OF.fmtUsd(v || 0)}`);
    } else if (!m || !(m.x >= pw && m.x < pw + cw && m.y > TOP && m.y < TOP + ph)) ui.tip();
  }
};

/* ===================== CHART ===================== */
OF.views.chart = {
  label: 'Chart', title: 'Candles with indicators, drawing tools and overlays',
  o: Object.assign({ ema21: true, ema50: true, rsi: true, vwap: false, whales: true, gamma: false, scale: 'linear' }, LS.get('ch', {})),
  view: { n: 140, off: 0 }, tool: null, draft: null,
  toolbar(tb) {
    const o = this.o, save = () => LS.set('ch', o);
    tb.append(
      ui.select('', [['linear', 'Linear'], ['log', 'Log']], o.scale, v => { o.scale = v; save(); }),
      el('span', 'lbl', 'Indicators'),
      ui.toggle('EMA 21', o.ema21, v => { o.ema21 = v; save(); }), ui.toggle('EMA 50', o.ema50, v => { o.ema50 = v; save(); }),
      ui.toggle('RSI 14', o.rsi, v => { o.rsi = v; save(); }), ui.toggle('VWAP', o.vwap, v => { o.vwap = v; save(); }),
      el('span', 'lbl', 'Overlays'),
      ui.toggle('Whales', o.whales, v => { o.whales = v; save(); }), ui.toggle('Gamma', o.gamma, v => { o.gamma = v; save(); if (v) OF.loadGamma(); }),
      el('span', 'lbl', 'Draw'));
    const tools = el('div', 'seg');
    [['trend', '╱ Line'], ['hline', '— Level'], ['clear', '🗑']].forEach(([k, t]) => {
      const b = el('button', '', t);
      b.onclick = () => {
        if (k === 'clear') { LS.set('draw:' + OF.S.symbol, []); return; }
        this.tool = this.tool === k ? null : k; [...tools.children].forEach(x => x.classList.remove('on')); if (this.tool) b.classList.add('on');
      };
      tools.appendChild(b);
    });
    tb.append(tools);
  },
  mount(v) {
    this.c = ui.canvas(v); const cv = this.c.cv; let drag = null;
    cv.onwheel = e => { e.preventDefault(); this.view.n = OF.clamp(Math.round(this.view.n * (e.deltaY > 0 ? 1.12 : 0.89)), 20, 900); };
    cv.onmousedown = e => {
      const p = this.pt(e);
      if (this.tool && p) {
        if (this.tool === 'hline') { this.addDrawing({ type: 'hline', p: p.p }); this.tool = null; return; }
        if (!this.draft) { this.draft = { type: 'trend', a: p, b: p }; return; }
        this.draft.b = p; this.addDrawing(this.draft); this.draft = null; this.tool = null; return;
      }
      drag = { x: e.clientX, off: this.view.off };
    };
    window.addEventListener('mouseup', () => drag = null);
    cv.onmousemove = e => {
      const r = cv.getBoundingClientRect(); this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.draft) { const p = this.pt(e); if (p) this.draft.b = p; }
      if (drag && this.geo) this.view.off = Math.max(0, drag.off + Math.round((e.clientX - drag.x) / this.geo.bw));
    };
    cv.onmouseleave = () => this.mouse = null;
    cv.ondblclick = () => { this.view = { n: 140, off: 0 }; };
  },
  pt(e) { const g = this.geo; if (!g) return null; const r = this.c.cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; return { t: g.tAt(x), p: g.pAt(y) }; },
  addDrawing(d) { const k = 'draw:' + OF.S.symbol, a = LS.get(k, []); a.push(d); LS.set(k, a); },
  render() {
    const S = OF.S, c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h, o = this.o, tf = OF.app.tf;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (!S || !S.info) { ui.msg(ctx, W, H, 'Loading…'); return; }
    const k = S.k[tf]; if (!k) { OF.loadKlines(tf); ui.msg(ctx, W, H, 'Loading candles…'); return; }
    if (!k.length) { ui.msg(ctx, W, H, 'No candles'); return; }
    const AX = 76, TB = 20, pw = W - AX, rsiH = o.rsi ? Math.round(H * 0.2) : 0, mainH = H - TB - rsiH;
    const n = Math.min(this.view.n, k.length), end = Math.max(n, k.length - this.view.off), i0 = Math.max(0, end - n);
    const bw = pw / (n + 4), X = i => (i - i0 + 0.5) * bw;
    let lo = Infinity, hi = -Infinity; for (let i = i0; i < end; i++) { lo = Math.min(lo, k[i].l); hi = Math.max(hi, k[i].h); }
    const pad = (hi - lo) * 0.08 || hi * 0.001; lo -= pad; hi += pad;
    const lg = o.scale === 'log', f = v => lg ? Math.log(v) : v, fi = v => lg ? Math.exp(v) : v;
    const volH = mainH * 0.16, Y = p => (mainH - volH) - (f(p) - f(lo)) / (f(hi) - f(lo)) * (mainH - volH - 10) ;
    ui.priceAxis(ctx, 0, pw, 10, mainH - volH - 10, lo, hi);
    const ms = OF.tfMs[tf];
    ui.timeAxis(ctx, 0, (end - i0) * bw, H - TB, k[i0].t, k[end - 1].t + ms, 90);
    // volume
    let vmx = 0; for (let i = i0; i < end; i++) vmx = Math.max(vmx, k[i].qv);
    for (let i = i0; i < end; i++) { const h = k[i].qv / vmx * volH; ctx.fillStyle = k[i].c >= k[i].o ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)'; ctx.fillRect(X(i) - bw * 0.35, mainH - h, Math.max(1, bw * 0.7), h); }
    OF.drawCandles(ctx, k, i0, end, X, Y, bw * 0.7);
    const line = (vals, col) => { ctx.strokeStyle = col; ctx.lineWidth = 1.3; ctx.beginPath(); let s = false; for (let i = i0; i < end; i++) { if (vals[i] == null) continue; const y = Y(vals[i]); s ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y); s = true; } ctx.stroke(); ctx.lineWidth = 1; };
    const legend = [];
    if (o.ema21) { line(OF.ema(k, 21), C.blue); legend.push([C.blue, 'EMA 21']); }
    if (o.ema50) { line(OF.ema(k, 50), C.amber); legend.push([C.amber, 'EMA 50']); }
    if (o.vwap) { const ss = OF.session(); if (ss && ss.vwap) { ui.hline(ctx, 0, pw, Y(ss.vwap), C.purple, [6, 3], 'VWAP ' + OF.fp(ss.vwap)); legend.push([C.purple, 'VWAP (day)']); } }
    // overlays
    const tStart = k[i0].t, tEnd = k[end - 1].t + ms, Xt = t => X(i0 + (t - tStart) / ms - 0.5);
    if (o.whales && S.whaleThr) {
      const wl = OF.whaleList('big', S.whaleThr, tStart); let mx = 0; for (const w of wl) mx = Math.max(mx, w.n);
      for (const w of wl) { if (w.p < lo || w.p > hi) continue; ctx.beginPath(); ctx.arc(Xt(w.t), Y(w.p), 3 + Math.sqrt(w.n / mx) * 12, 0, 7); ctx.fillStyle = w.buy ? C.buyA + '.45)' : C.sellA + '.45)'; ctx.fill(); ctx.strokeStyle = w.buy ? C.buy : C.sell; ctx.stroke(); }
    }
    if (o.gamma || OF.app.lines.gamma) OF.drawGammaLines(ctx, pw, Y, lo, hi);
    if (OF.app.lines.plan) OF.drawPlanLines(ctx, pw, Y, lo, hi);
    if (OF.app.lines.liq) OF.drawLiqLines(ctx, pw, Y, lo, hi);
    if (OF.app.lines.walls) OF.drawWallLines(ctx, pw, Y, lo, hi);
    OF.drawKeyLevels(ctx, 0, pw, Y, lo, hi);
    // drawings
    const draws = LS.get('draw:' + S.symbol, []).concat(this.draft ? [this.draft] : []);
    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1.2;
    for (const d of draws) {
      if (d.type === 'hline') ui.hline(ctx, 0, pw, Y(d.p), '#e5e7eb', [], OF.fp(d.p));
      else { ctx.beginPath(); ctx.moveTo(Xt(d.a.t), Y(d.a.p)); ctx.lineTo(Xt(d.b.t), Y(d.b.p)); ctx.stroke(); }
    }
    // last price
    const last = k[end - 1].c; if (!this.view.off) { const y = Y(last); ui.hline(ctx, 0, pw, y, last >= k[end - 1].o ? C.buy : C.sell, [1, 3]); ui.tag(ctx, pw + 1, y, OF.fp(last), last >= k[end - 1].o ? C.buy : C.sell, '#000'); }
    // RSI pane
    if (o.rsi) {
      const top = mainH + 4, h = rsiH - 8, r = OF.rsi(k, 14), RY = v => top + h - v / 100 * h;
      ctx.fillStyle = C.panel; ctx.fillRect(0, mainH, W, rsiH);
      [30, 70].forEach(v => ui.hline(ctx, 0, pw, RY(v), C.faint, [2, 3]));
      ctx.strokeStyle = C.purple; ctx.lineWidth = 1.3; ctx.beginPath(); let s = false;
      for (let i = i0; i < end; i++) { if (r[i] == null) continue; s ? ctx.lineTo(X(i), RY(r[i])) : ctx.moveTo(X(i), RY(r[i])); s = true; } ctx.stroke(); ctx.lineWidth = 1;
      if (r[end - 1] != null) ui.tag(ctx, pw + 1, RY(r[end - 1]), r[end - 1].toFixed(2), C.purple, '#000');
      ctx.fillStyle = C.muted; ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'left'; ctx.fillText('RSI 14', 6, top + 8);
    }
    // header legend
    const hv = this.mouse ? OF.clamp(Math.floor(this.mouse.x / bw) + i0, i0, end - 1) : end - 1, cc = k[hv];
    ctx.font = '11px ui-monospace,monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const chg = (cc.c / cc.o - 1) * 100;
    ctx.fillStyle = '#e5e7eb'; ctx.fillText(S.symbol + ' · ' + tf, 8, 6);
    ctx.fillStyle = chg >= 0 ? C.buy : C.sell;
    ctx.fillText(`O ${OF.fp(cc.o)} H ${OF.fp(cc.h)} L ${OF.fp(cc.l)} C ${OF.fp(cc.c)} ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% · Vol ${OF.fmtUsd(cc.qv)} · Δ ${OF.fmtUsd(2 * cc.bqv - cc.qv, true)}`, 110, 6);
    legend.forEach(([col, t], i) => { ctx.fillStyle = col; ctx.fillRect(10, 26 + i * 15, 8, 8); ctx.fillStyle = C.muted; ctx.fillText(t, 24, 24 + i * 15); });
    if (this.mouse && this.mouse.y < mainH) {
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(this.mouse.x, 0); ctx.lineTo(this.mouse.x, H - TB); ctx.moveTo(0, this.mouse.y); ctx.lineTo(pw, this.mouse.y); ctx.stroke(); ctx.setLineDash([]);
      const p = fi(f(lo) + ((mainH - volH) - this.mouse.y) / (mainH - volH - 10) * (f(hi) - f(lo))); ui.tag(ctx, pw + 1, this.mouse.y, OF.fp(p), '#2563eb', '#fff');
      if (S.last) { const dd = (p / S.last - 1) * 100; ctx.fillStyle = '#93c5fd'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText((dd >= 0 ? '+' : '') + dd.toFixed(2) + '% from price', pw - 4, this.mouse.y - 3); ctx.textAlign = 'left'; ctx.textBaseline = 'top'; }
    }
    if (this.tool) { ctx.fillStyle = C.amber; ctx.fillText(this.tool === 'hline' ? 'Click to place a level' : (this.draft ? 'Click the second point' : 'Click the first point'), pw / 2 - 60, 6); }
    this.geo = { bw, tAt: x => tStart + (x / bw - 0.5 + 0.5) * ms, pAt: y => fi(f(lo) + ((mainH - volH) - y) / (mainH - volH - 10) * (f(hi) - f(lo))) };
  }
};

/* shared overlay lines (Plan / Γ / Liq toggles in the header) */
OF.drawPlanLines = (ctx, pw, Y, lo, hi) => {
  if (OF.drawTradeLines) OF.drawTradeLines(ctx, pw, Y, lo, hi);
  const d = OF.lastDecision; if (!d || !d.plan) return;
  if (d.plan.buyAbove && d.plan.buyAbove < hi && d.plan.buyAbove > lo) ui.hline(ctx, 0, pw, Y(d.plan.buyAbove), C.buy, [2, 3], 'buy above ' + OF.fp(d.plan.buyAbove));
  if (d.plan.sellBelow && d.plan.sellBelow > lo && d.plan.sellBelow < hi) ui.hline(ctx, 0, pw, Y(d.plan.sellBelow), C.sell, [2, 3], 'sell below ' + OF.fp(d.plan.sellBelow));
};
OF.drawGammaLines = (ctx, pw, Y, lo, hi) => {
  OF.loadGamma(); const g = OF.gammaCalc({ days: 30 }); if (!g) return;
  [[g.callWall, C.blue, 'call wall'], [g.putWall, C.amber, 'put wall'], [g.flip, C.purple, 'zero-gamma'], [g.maxPain, C.muted, 'max pain']].forEach(([p, col, t]) => {
    if (p && p > lo && p < hi) ui.hline(ctx, 0, pw, Y(p), col, [6, 4], t + ' ' + OF.fp(p), pw - 160);
  });
};
OF.drawLiqLines = (ctx, pw, Y, lo, hi) => {
  const m = OF.liqMap(); if (!m || !m.rows.length) return;
  // pick the biggest clusters on EACH side so zooming out never hides one side
  const side = (above) => m.rows.filter(r => above ? r.p > m.mid && r.short > 0 : r.p < m.mid && r.long > 0)
    .map(r => ({ p: r.p + m.bin / 2, n: above ? r.short : r.long, above })).sort((a, b) => b.n - a.n);
  for (const above of [true, false]) {
    const all = side(above), vis = all.filter(r => r.p > lo && r.p < hi).slice(0, 3), col = above ? C.buy : C.sell;
    for (const r of vis) ui.hline(ctx, 0, pw, Y(r.p), col, [1, 4], (above ? 'short liq ' : 'long liq ') + OF.fp(r.p) + ' · ' + OF.fmtUsd(r.n), pw - 230);
    if (!vis.length && all.length) {   // biggest cluster is off-screen: say so at the edge
      const r = all[0]; ctx.font = '11px ui-monospace,monospace'; ctx.fillStyle = col; ctx.textAlign = 'right'; ctx.textBaseline = above ? 'top' : 'bottom';
      ctx.fillText((above ? '↑ ' : '↓ ') + (above ? 'short liq ' : 'long liq ') + OF.fp(r.p) + ' · ' + OF.fmtUsd(r.n) + ' (off chart)', pw - 6, above ? Y(hi) + 4 : Y(lo) - 4);
    }
  }
};
/* resting order-book liquidity: biggest bid / ask walls within ±3 % */
OF.drawWallLines = (ctx, pw, Y, lo, hi) => {
  const S = OF.S; if (!S || !S.synced) return;
  const mid = OF.mid(), bb = OF.bookBinsAll(3, OF.niceStep(mid * 0.0008)), out = [];
  for (const [p, n] of bb.b) out.push({ p: p + bb.bin / 2, n, bid: true, v: bb.nv('bid', p) }); for (const [p, n] of bb.a) out.push({ p: p + bb.bin / 2, n, bid: false, v: bb.nv('ask', p) });
  const pick = side => out.filter(w => w.bid === side && w.p > lo && w.p < hi).sort((a, b) => b.n - a.n).slice(0, 4);
  const all = pick(true).concat(pick(false)); let mx = 0; for (const w of all) mx = Math.max(mx, w.n);
  for (const w of all) {
    const y = Y(w.p), col = w.bid ? C.buy : C.sell, len = 30 + w.n / mx * 90;
    ctx.fillStyle = w.bid ? C.buyA + '.55)' : C.sellA + '.55)'; ctx.fillRect(pw - len, y - 2, len, 4);
    ui.hline(ctx, 0, pw, y, col, [8, 3], (w.bid ? 'bid wall ' : 'ask wall ') + OF.fp(w.p) + ' · ' + OF.fmtUsd(w.n) + (bb.venues > 1 ? ' · ' + w.v + '/' + bb.venues + ' venues' : ''), pw * 0.42);
  }
};

/* ===================== FOOTPRINT ===================== */
OF.views.footprint = {
  label: 'Footprint', title: 'Footprint — sell × buy volume at every price inside each candle',
  o: Object.assign({ tf: '5m', show: 'ba', rows: 0, units: '$' }, LS.get('fp', {})),
  toolbar(tb) {
    const o = this.o, save = () => { LS.set('fp', o); this.cache = null; };
    tb.append(
      ui.seg('Candles', [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1h']], o.tf, v => { o.tf = v; save(); }),
      ui.seg('Show', [['ba', 'Bid × Ask'], ['delta', 'Delta'], ['vol', 'Volume'], ['profile', 'Profile']], o.show, v => { o.show = v; save(); }),
      ui.seg('Rows', [[0, 'Auto'], [1, '1×'], [2, '2×'], [5, '5×'], [10, '10×']], o.rows, v => { o.rows = v; save(); }, 'Price height of each row. Auto picks about 12 rows per candle.'),
      ui.seg('Units', [['$', '$'], ['base', 'Coin']], o.units, v => { o.units = v; save(); }));
  },
  mount(v) { this.c = ui.canvas(v); ui.track(this); },
  build() {
    const S = OF.S, o = this.o, ms = OF.tfMs[o.tf], tr = S.trades;
    if (!tr.length) return null;
    const key = o.tf + o.rows + tr.length + (tr[tr.length - 1].t);
    if (this.cache && this.cache.key === key) return this.cache;
    if (this.cache && Date.now() - this.cache.at < 700) return this.cache;
    const m = new Map();
    for (const t of tr) { const ct = Math.floor(t.t / ms) * ms; let c = m.get(ct); if (!c) { c = { t: ct, o: t.p, h: t.p, l: t.p, c: t.p, b: 0, s: 0, bq: 0, sq: 0, tr: [] }; m.set(ct, c); } if (t.p > c.h) c.h = t.p; if (t.p < c.l) c.l = t.p; c.c = t.p; if (t.buy) { c.b += t.n; c.bq += t.q; } else { c.s += t.n; c.sq += t.q; } c.tr.push(t); }
    const cs = [...m.values()].sort((a, b) => a.t - b.t);
    const rngs = cs.map(c => c.h - c.l).filter(x => x > 0).sort((a, b) => a - b);
    const med = rngs.length ? rngs[Math.floor(rngs.length / 2)] : S.last * 0.001;
    const tick = S.info.tick;
    let bin = o.rows ? Math.max(tick, OF.niceStep(S.last * 0.000025) * o.rows) : Math.max(tick, OF.niceStep(med / 10));
    let cum = 0;
    for (const c of cs) {
      c.cells = new Map();
      for (const t of c.tr) { const k = Math.floor(t.p / bin) * bin; const r = c.cells.get(k) || { b: 0, s: 0, bq: 0, sq: 0 }; if (t.buy) { r.b += t.n; r.bq += t.q; } else { r.s += t.n; r.sq += t.q; } c.cells.set(k, r); }
      let poc = null; for (const [p, r] of c.cells) if (!poc || r.b + r.s > poc.v) poc = { p, v: r.b + r.s }; c.poc = poc && poc.p;
      c.d = c.b - c.s; cum += c.d; c.cum = cum; delete c.tr;
    }
    // naked POCs: not traded through by any later candle
    for (let i = 0; i < cs.length; i++) { const p = cs[i].poc + bin / 2; cs[i].naked = !cs.slice(i + 1).some(x => x.l <= p && x.h >= p); }
    this.cache = { key, at: Date.now(), cs, bin };
    return this.cache;
  },
  reading() {
    const b = this.build(); if (!b) return 'Collecting trades…';
    const c = b.cs[b.cs.length - 1], dpc = (c.b + c.s) ? c.d / (c.b + c.s) * 100 : 0;
    const imb = this.lastImb || '';
    return `This candle: Δ <b class="${c.d >= 0 ? 'g' : 'r'}">${OF.fmtUsd(c.d, true)}</b> (${dpc.toFixed(0)}%) — ${Math.abs(dpc) < 10 ? 'balanced so far' : c.d > 0 ? 'buyers lifting offers' : 'sellers hitting bids'}. Most volume at ${OF.fp(c.poc + b.bin / 2)} (POC).${imb}`;
  },
  render() {
    const S = OF.S, c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h, o = this.o;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const b = S && S.info ? this.build() : null; if (!b) { ui.msg(ctx, W, H, 'Collecting trades for the footprint…'); return; }
    const AX = 80, TBL = 96, TOP = 34, pw = W - AX, ph = H - TBL - TOP;
    const colW = OF.clamp(Math.round(pw / 9), 90, 150), nv = Math.max(1, Math.floor(pw / colW)), cs = b.cs.slice(-nv), bin = b.bin;
    let lo = Infinity, hi = -Infinity; for (const x of cs) { lo = Math.min(lo, x.l); hi = Math.max(hi, x.h); }
    lo = Math.floor(lo / bin) * bin - bin; hi = Math.ceil(hi / bin) * bin + bin;
    const rh = ph * bin / (hi - lo), Y = p => TOP + ph - (p - lo) / (hi - lo) * ph;
    ui.priceAxis(ctx, 0, pw, TOP, ph, lo, hi);
    const ss = OF.session(), fmtV = (n, q) => o.units === '$' ? OF.fmtUsd(n).replace('$', '') : (q >= 100 ? q.toFixed(0) : q >= 1 ? q.toFixed(2) : q.toFixed(3));
    if (ss && ss.prev) [['prev day VAH', ss.prev.vah, C.blue], ['prev day VAL', ss.prev.val, C.blue], ['prev day POC', ss.prev.poc, C.yellow]].forEach(([t, p, col]) => { if (p > lo && p < hi) ui.hline(ctx, 0, pw, Y(p), col, [2, 4], t + ' ' + OF.fp(p)); });
    if (OF.app.lines.plan) OF.drawPlanLines(ctx, pw, Y, lo, hi);
    OF.drawKeyLevels(ctx, 0, pw, Y, lo, hi);
    let imbTxt = '';
    ctx.textBaseline = 'middle';
    cs.forEach((cd, i) => {
      const x0 = i * colW + 4, w = colW - 8, cx = x0 + 6;
      // mini candle
      ctx.strokeStyle = ctx.fillStyle = cd.c >= cd.o ? C.buy : C.sell;
      ctx.beginPath(); ctx.moveTo(cx + .5, Y(cd.h)); ctx.lineTo(cx + .5, Y(cd.l)); ctx.stroke();
      ctx.fillRect(cx - 3, Y(Math.max(cd.o, cd.c)), 7, Math.max(1, Math.abs(Y(cd.o) - Y(cd.c))));
      let mx = 0; for (const r of cd.cells.values()) mx = Math.max(mx, r.b + r.s, r.b, r.s);
      const cellX = x0 + 14, cellW = w - 14, half = cellW / 2, fs = Math.min(11, Math.max(8, rh - 3));
      ctx.font = fs + 'px ui-monospace,monospace';
      for (const [p, r] of cd.cells) {
        const y = Y(p + bin), hgt = Math.max(1, rh - 1);
        const below = cd.cells.get(p - bin), above = cd.cells.get(p + bin);
        const buyImb = below && r.b >= 3 * below.s && r.b > mx * 0.05, sellImb = above && r.s >= 3 * above.b && r.s > mx * 0.05;
        if (o.show === 'ba') {
          ctx.fillStyle = C.sellA + (0.12 + 0.6 * r.s / mx) + ')'; ctx.fillRect(cellX, y, half - 1, hgt);
          ctx.fillStyle = C.buyA + (0.12 + 0.6 * r.b / mx) + ')'; ctx.fillRect(cellX + half, y, half - 1, hgt);
          if (rh >= 10) {
            ctx.textAlign = 'right'; ctx.fillStyle = sellImb ? '#fecaca' : '#e5e7eb'; ctx.font = (sellImb ? 'bold ' : '') + fs + 'px ui-monospace,monospace'; ctx.fillText(fmtV(r.s, r.sq), cellX + half - 4, y + hgt / 2);
            ctx.textAlign = 'left'; ctx.fillStyle = buyImb ? '#bbf7d0' : '#e5e7eb'; ctx.font = (buyImb ? 'bold ' : '') + fs + 'px ui-monospace,monospace'; ctx.fillText(fmtV(r.b, r.bq), cellX + half + 3, y + hgt / 2);
          }
        } else if (o.show === 'delta' || o.show === 'vol') {
          const v = o.show === 'delta' ? r.b - r.s : r.b + r.s, a = Math.abs(v) / mx;
          ctx.fillStyle = o.show === 'vol' ? 'rgba(56,189,248,' + (0.1 + 0.6 * a) + ')' : (v >= 0 ? C.buyA : C.sellA) + (0.12 + 0.6 * a) + ')';
          ctx.fillRect(cellX, y, cellW - 1, hgt);
          if (rh >= 10) { ctx.textAlign = 'center'; ctx.fillStyle = '#e5e7eb'; ctx.fillText((o.show === 'delta' && v > 0 ? '+' : '') + fmtV(v, (r.bq + r.sq) * Math.sign(v)), cellX + cellW / 2, y + hgt / 2); }
        } else {
          const wb = r.b / mx * cellW, ws = r.s / mx * cellW;
          ctx.fillStyle = C.sellA + '.6)'; ctx.fillRect(cellX, y, ws, hgt);
          ctx.fillStyle = C.buyA + '.6)'; ctx.fillRect(cellX + ws, y, wb, hgt);
        }
        if (buyImb && i === cs.length - 1) imbTxt = ' Buy imbalance at ' + OF.fp(p) + '.';
        if (sellImb && i === cs.length - 1) imbTxt = ' Sell imbalance at ' + OF.fp(p) + '.';
      }
      if (cd.poc != null) { ctx.strokeStyle = C.yellow; ctx.lineWidth = 1.5; ctx.strokeRect(cellX - 1, Y(cd.poc + bin), cellW, Math.max(2, rh)); ctx.lineWidth = 1; }
      if (cd.naked && i < cs.length - 1) ui.hline(ctx, cellX + cellW, pw, Y(cd.poc + bin / 2), C.yellow, [1, 3], i >= cs.length - 4 ? 'nPOC ' + OF.fp(cd.poc + bin / 2) : '', pw - 110);
      // buy/sell share header
      const tot = cd.b + cd.s; ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'center';
      ctx.fillStyle = C.buy; ctx.fillText('B ' + Math.round(cd.b / tot * 100) + '%', cellX + cellW / 2, 10);
      ctx.fillStyle = C.sell; ctx.fillText('S ' + Math.round(cd.s / tot * 100) + '%', cellX + cellW / 2, 22);
      // table
      const ty = H - TBL + 4, rows = [['Volume', OF.fmtUsd(tot), null], ['Delta', OF.fmtUsd(cd.d, true), cd.d], ['Delta %', (cd.d / tot * 100).toFixed(0) + '%', cd.d], ['Cum Δ', OF.fmtUsd(cd.cum, true), cd.cum], ['Time', OF.hm(cd.t), null]];
      rows.forEach(([, v, s], j) => {
        if (s != null) { ctx.fillStyle = s >= 0 ? C.buyA + '.25)' : C.sellA + '.25)'; ctx.fillRect(cellX, ty + j * 18, cellW - 1, 16); }
        ctx.fillStyle = s == null ? C.text : s >= 0 ? '#86efac' : '#fca5a5'; ctx.fillText(v, cellX + cellW / 2, ty + j * 18 + 8);
      });
    });
    this.lastImb = imbTxt;
    ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'right';
    ['Volume', 'Delta', 'Delta %', 'Cum Δ', 'Time'].forEach((t, j) => { ctx.fillStyle = C.muted; ctx.fillText(t, W - 6, H - TBL + 12 + j * 18); });
    if (S.histFrom && cs[0] && cs[0].t <= S.histFrom) { ctx.fillStyle = C.amber; ctx.textAlign = 'left'; ctx.fillText('◂ trades recorded from ' + OF.hm(S.histFrom), 6, TOP + ph - 6); }
    if (S.last) { const y = Y(S.last); ui.tag(ctx, pw + 1, y, OF.fp(S.last), '#e5e7eb', '#000'); }
    ui.cross(ctx, this.mouse, 0, pw, TOP, ph, lo, hi, pw + 1);
    ctx.font = '10px ui-monospace,monospace'; ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.fillText('rows ' + OF.fp(bin) + ' · ' + o.tf + ' candles · ' + (o.units === '$' ? '$ volume' : S.info.base), pw - 6, 12);
  }
};

/* ===================== WHALES ===================== */
OF.views.whales = {
  label: 'Whales', title: 'Whale candles — large participants as bubbles on price',
  o: Object.assign({ mode: 'big', size: 'auto', tf: '5m', avg: true, zones: true, vp: false }, LS.get('wh', {})),
  toolbar(tb) {
    const o = this.o, save = () => LS.set('wh', o);
    tb.append(
      ui.seg('Detect', [['sweep', 'Sweep'], ['aggr', 'Aggressive'], ['level', 'Level'], ['big', 'Big print']], o.mode, v => { o.mode = v; save(); },
        'Big print: one trade above the size. Sweep: one taker order that hit several prices in the same millisecond. Aggressive: one side adding up past the size within 1 second. Level: a large resting order placed in the book.'),
      ui.select('Size ≥', [['auto', 'Auto'], [25000, '$25K'], [50000, '$50K'], [100000, '$100K'], [250000, '$250K'], [1000000, '$1M']], o.size, v => { o.size = v; save(); }),
      ui.seg('', [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1h'], ['4h', '4h']], o.tf, v => { o.tf = v; save(); }),
      el('span', 'lbl', ''),
      ui.toggle('Whale avg', o.avg, v => { o.avg = v; save(); }), ui.toggle('Zones', o.zones, v => { o.zones = v; save(); }), ui.toggle('Vol profile', o.vp, v => { o.vp = v; save(); }));
    this.sizeSpan = el('span', 'lbl mono', ''); tb.append(this.sizeSpan);
  },
  mount(v) { this.c = ui.canvas(v); ui.track(this); },
  thr() { const S = OF.S; return this.o.size === 'auto' ? (S.whaleThr || 50000) : +this.o.size; },
  data() {
    const S = OF.S, from = Math.min(S.trades.length ? S.trades[0].t : OF.now(), S.recW && S.recW.length ? S.recW[0][0] : Infinity);
    const list = OF.whaleList(this.o.mode, this.thr(), from);
    let b = 0, s = 0, bpq = 0, spq = 0; for (const w of list) { if (w.buy) { b += w.n; bpq += w.n * w.p; } else { s += w.n; spq += w.n * w.p; } }
    return { list, b, s, bAvg: b ? bpq / b : null, sAvg: s ? spq / s : null, from };
  },
  reading() {
    const S = OF.S; if (!S || !S.trades.length) return 'Collecting trades…';
    const d = this.data(), p0 = S.trades[0].p, chg = (S.last - p0) / p0 * 100, net = d.b - d.s;
    if (this.sizeSpan) this.sizeSpan.innerHTML = `size ${OF.fmtUsd(this.thr())} · <span class="g">buy ${OF.fmtUsd(d.b)}</span> / <span class="r">sell ${OF.fmtUsd(d.s)}</span>`;
    const tone = Math.abs(net) < (d.b + d.s) * 0.15 ? 'whales are two-sided — no clear big-player direction' : net > 0 ? 'whales are net buyers' : 'whales are net sellers';
    return `Since ${OF.hm(d.from)}: price ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% · whales net <b class="${net >= 0 ? 'g' : 'r'}">${OF.fmtUsd(net, true)}</b> (${d.list.length} bubbles) — ${tone}. Context, not a signal.`;
  },
  render() {
    const S = OF.S, c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h, o = this.o;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (!S || !S.info) { ui.msg(ctx, W, H, 'Loading…'); return; }
    const k = S.k[o.tf]; if (!k) { OF.loadKlines(o.tf); ui.msg(ctx, W, H, 'Loading candles…'); return; }
    if (!k.length) return;
    const AX = 76, VP = o.vp ? 70 : 0, TB = 20, netH = Math.round(H * 0.17), volH = Math.round(H * 0.1), mainH = H - TB - netH - volH, pw = W - AX - VP;
    const n = Math.min(k.length, Math.floor(pw / 7)), i0 = k.length - n, bw = pw / (n + 3), X = i => (i - i0 + 0.5) * bw, ms = OF.tfMs[o.tf];
    let lo = Infinity, hi = -Infinity; for (let i = i0; i < k.length; i++) { lo = Math.min(lo, k[i].l); hi = Math.max(hi, k[i].h); }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad; const Y = p => 8 + (mainH - 16) - (p - lo) / (hi - lo) * (mainH - 16);
    ui.priceAxis(ctx, 0, pw + VP, 8, mainH - 16, lo, hi);
    ui.timeAxis(ctx, 0, n * bw, H - TB, k[i0].t, k[k.length - 1].t + ms, 90);
    const d = this.data(), tStart = k[i0].t, Xt = t => X(i0 + (t - tStart) / ms - 0.5);
    // "recorded from" marker
    if (d.from > tStart) { const x = Xt(d.from); ctx.strokeStyle = 'rgba(245,158,11,.5)'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, mainH); ctx.stroke(); ctx.fillStyle = C.amber; ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'right'; ctx.fillText('no trades recorded before ▸', x - 4, 12); }
    // zones: price bins with most whale notional
    if (o.zones && d.list.length) {
      const zb = OF.niceStep((hi - lo) / 40), zm = new Map(); for (const w of d.list) { const kk = Math.floor(w.p / zb) * zb; zm.set(kk, (zm.get(kk) || 0) + w.n); }
      const top = [...zm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      for (const [p, v] of top) { ctx.fillStyle = 'rgba(239,68,68,.08)'; ctx.fillRect(0, Y(p + zb), pw, Y(p) - Y(p + zb)); ctx.fillStyle = C.muted; ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'right'; ctx.fillText(OF.fmtUsd(v) + ' whale volume here', pw - 4, Y(p + zb / 2)); }
    }
    // volume
    let vmx = 0; for (let i = i0; i < k.length; i++) vmx = Math.max(vmx, k[i].qv);
    for (let i = i0; i < k.length; i++) { const h = k[i].qv / vmx * (volH - 4); ctx.fillStyle = k[i].c >= k[i].o ? 'rgba(34,197,94,.45)' : 'rgba(239,68,68,.45)'; ctx.fillRect(X(i) - bw * 0.35, mainH + volH - h, Math.max(1, bw * 0.7), h); }
    OF.drawCandles(ctx, k, i0, k.length, X, Y, bw * 0.65);
    const e1 = OF.ema(k, 21), e2 = OF.ema(k, 50);
    [[e1, C.yellow], [e2, C.purple]].forEach(([v, col]) => { ctx.strokeStyle = col; ctx.beginPath(); for (let i = i0; i < k.length; i++) i === i0 ? ctx.moveTo(X(i), Y(v[i])) : ctx.lineTo(X(i), Y(v[i])); ctx.stroke(); });
    // bubbles aggregated per candle & side
    const agg = new Map(); for (const w of d.list) { const ct = Math.floor(w.t / ms) * ms, kk = ct + (w.buy ? 'b' : 's'); const a = agg.get(kk) || { t: ct, buy: w.buy, n: 0, pq: 0, c: 0 }; a.n += w.n; a.pq += w.n * w.p; a.c++; agg.set(kk, a); }
    let mx = 0; for (const a of agg.values()) mx = Math.max(mx, a.n);
    const R = Math.min(40, Math.max(14, mainH / 9));
    const bubbles = [...agg.values()].sort((a, b) => b.n - a.n);
    for (const a of bubbles) {
      const p = a.pq / a.n; if (p < lo || p > hi) continue;
      const x = Xt(a.t + ms / 2), y = Y(p), r = 4 + Math.sqrt(a.n / mx) * R;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = a.buy ? C.buyA + '.35)' : C.sellA + '.35)'; ctx.fill(); ctx.strokeStyle = a.buy ? C.buy : C.sell; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(a.buy ? '▲' : '▼', x, y);
      if (a.n >= mx * 0.25) { ctx.font = 'bold 11px ui-monospace,monospace'; ctx.fillStyle = '#e5e7eb'; ctx.fillText(OF.fmtUsd(a.n), x, y - r - 7); }
    }
    if (o.avg) {
      if (d.bAvg) ui.hline(ctx, 0, pw, Y(d.bAvg), '#e5e7eb', [6, 3], '🐋 buyers’ avg ' + OF.fp(d.bAvg) + ' (price ' + ((S.last / d.bAvg - 1) * 100).toFixed(2) + '%)', pw * 0.18);
      if (d.sAvg) ui.hline(ctx, 0, pw, Y(d.sAvg), C.muted, [2, 3], '🐋 sellers’ avg ' + OF.fp(d.sAvg) + ' (price ' + ((S.last / d.sAvg - 1) * 100).toFixed(2) + '%)', pw * 0.18);
    }
    if (OF.app.lines.plan) OF.drawPlanLines(ctx, pw, Y, lo, hi);
    if (OF.app.lines.gamma) OF.drawGammaLines(ctx, pw, Y, lo, hi);
    if (OF.app.lines.liq) OF.drawLiqLines(ctx, pw, Y, lo, hi);
    if (OF.app.lines.walls) OF.drawWallLines(ctx, pw, Y, lo, hi);
    OF.drawKeyLevels(ctx, 0, pw, Y, lo, hi);
    // whale volume by price on the right
    if (o.vp) {
      const zb = OF.niceStep((hi - lo) / 50), zm = new Map(); for (const w of d.list) { const kk = Math.floor(w.p / zb) * zb; const r = zm.get(kk) || [0, 0]; r[w.buy ? 0 : 1] += w.n; zm.set(kk, r); }
      let m2 = 0; for (const r of zm.values()) m2 = Math.max(m2, r[0] + r[1]);
      for (const [p, r] of zm) { const wb = r[0] / m2 * (VP - 4), ws = r[1] / m2 * (VP - 4); ctx.fillStyle = C.buyA + '.7)'; ctx.fillRect(pw + 2, Y(p + zb), wb, Y(p) - Y(p + zb) - 1); ctx.fillStyle = C.sellA + '.7)'; ctx.fillRect(pw + 2 + wb, Y(p + zb), ws, Y(p) - Y(p + zb) - 1); }
    }
    if (S.last) ui.tag(ctx, pw + VP + 1, Y(S.last), OF.fp(S.last), '#e5e7eb', '#000');
    ui.cross(ctx, this.mouse, 0, pw + VP, 8, mainH - 16, lo, hi, pw + VP + 1, x => tStart + (x / bw) * ms);
    // bottom: bubble net per candle + everyone-else cumulative
    const top = mainH + volH; ctx.fillStyle = C.panel; ctx.fillRect(0, top, W, netH);
    const nets = new Map(); for (const a of agg.values()) nets.set(a.t, (nets.get(a.t) || 0) + (a.buy ? a.n : -a.n));
    let nm = 0; for (const v of nets.values()) nm = Math.max(nm, Math.abs(v));
    const mid0 = top + netH / 2;
    for (const [t, v] of nets) { const h = v / (nm || 1) * (netH / 2 - 6); ctx.fillStyle = v >= 0 ? C.buy : C.sell; ctx.fillRect(Xt(t + ms / 2) - bw * 0.35, h >= 0 ? mid0 - h : mid0, Math.max(1, bw * 0.7), Math.abs(h)); }
    // everyone else: cumulative non-whale delta per candle
    const tr = S.trades, thr = this.thr(); let cum = 0; const pts = []; let curT = null;
    for (let i = OF.lb(tr, tStart); i < tr.length; i++) { const t = tr[i]; if (t.n >= thr) continue; cum += t.buy ? t.n : -t.n; const ct = Math.floor(t.t / ms) * ms; if (ct !== curT) { pts.push([ct, cum]); curT = ct; } else pts[pts.length - 1][1] = cum; }
    let cm = 0; for (const p of pts) cm = Math.max(cm, Math.abs(p[1]));
    ctx.strokeStyle = C.blue; ctx.setLineDash([4, 3]); ctx.beginPath(); pts.forEach(([t, v], i) => { const x = Xt(t + ms / 2), y = mid0 - v / (cm || 1) * (netH / 2 - 6); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = C.muted;
    ctx.fillText('bubble net (bought − sold in bubbles): ' + OF.fmtUsd(d.b - d.s, true) + ' · bars per candle', 6, top + 4);
    ctx.fillStyle = C.blue; ctx.fillText('- - everyone else: ' + OF.fmtUsd(cum, true) + ' (own scale)', 380, top + 4);
  }
};
})();

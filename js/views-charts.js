/* FlowDesk chart views: Heatmap, Chart, Footprint, Whales. */
(function () {
'use strict';
const OF = window.OF, C = OF.C, el = OF.el, ui = OF.ui, LS = OF.LS;

/* ===================== HEATMAP ===================== */
OF.views.heatmap = {
  label: 'Heatmap', title: 'Liquidity heatmap — resting orders over time, with trades as bubbles',
  o: Object.assign({ span: 120, range: 0, contrast: 1, bubbles: 'auto' }, LS.get('hm', {})),
  toolbar(tb) {
    const o = this.o, save = () => LS.set('hm', o);
    tb.append(
      ui.seg('Span', [[60, '1m'], [120, '2m'], [300, '5m'], [720, '12m'], [900, '15m'], [1800, '30m'], [3600, '1h'], [14400, '4h']], o.span, v => { o.span = v; save(); }, 'How much history is on screen. Up to 30 min uses 0.5-second columns; 1h/4h use 5-second columns. History starts when you open the page.'),
      ui.seg('Price range', [[0, 'Auto'], [0.1, '±0.1%'], [0.25, '±0.25%'], [0.5, '±0.5%'], [1, '±1%']], o.range, v => { o.range = v; save(); }),
      ui.seg('Contrast', [[0, 'Low'], [1, 'Med'], [2, 'High']], o.contrast, v => { o.contrast = v; save(); }),
      ui.seg('Bubbles', [['auto', 'Auto'], ['all', 'Trades'], ['off', 'Off']], o.bubbles, v => { o.bubbles = v; save(); }, 'Auto shows only the larger 0.5-second trade clusters; Trades shows all of them.'));
  },
  mount(v) {
    this.c = ui.canvas(v);
    this.c.cv.onmousemove = e => { const r = this.c.cv.getBoundingClientRect(); this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY }; };
    this.c.cv.onmouseleave = () => { this.mouse = null; ui.tip(); };
  },
  reading() {
    const w = OF.walls(0.25); if (!w) return 'Waiting for the order book…';
    const part = (s, x) => x ? `<b class="${s === 'bid' ? 'g' : 'r'}">${s} wall ${OF.fmtUsd(x.n)}</b> at ${OF.fp(x.p)} (${x.bp.toFixed(1)} bp ${s === 'bid' ? 'below' : 'above'}), standing ${x.standSec < 90 ? Math.round(x.standSec) + 's' : Math.round(x.standSec / 60) + ' min'}` + (x.pulls >= 3 ? ` · <b class="y">${x.pulls}× pulled nearby — may be a bluff</b>` : '') : '';
    return 'Nearest walls: ' + [part('bid', w.bid), part('ask', w.ask)].filter(Boolean).join(' · ') + '. Price often pauses at real walls; a wall that keeps vanishing as price nears it was likely for show.';
  },
  render() {
    const S = OF.S, c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h, o = this.o;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    if (!S || !S.cols.length) { ui.msg(ctx, W, H, S && S.status === 'OFFLINE' ? 'Offline — ' + (S.err || 'reconnecting…') : 'Building the order book…'); return; }
    const AX = 74, BK = 84, TB = 20, pw = W - AX - BK, ph = H - TB;
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
    const bin = S.bin, Y = p => ph - (p - lo) / (hi - lo) * ph, X = t => (t - t0) / spanMs * pw;
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
    const ref = OF.pctile(sample, 0.97) || 1, gm = [0.8, 0.55, 0.35][o.contrast];
    const colPx = (coarse ? 5000 : 500) * step / spanMs * pw + 0.6;
    for (const [t, g] of grid) {
      const x = X(t);
      for (let r = 0; r < nR; r++) {
        const v = g[r]; if (!v) continue;
        const f = Math.pow(Math.min(1, v / ref), gm); if (f < 0.03) continue;
        ctx.fillStyle = OF.heatLUT[Math.round(f * 255)];
        ctx.fillRect(x, Y((r0 + r + 1) * rb), colPx, rh + 0.5);
      }
    }
    this.geo = { lo, hi, t0, spanMs, pw, ph, rb, r0, grid };
    // legend
    ctx.fillStyle = 'rgba(10,13,18,.85)'; ctx.fillRect(6, 6, 250, 30);
    for (let i = 0; i < 120; i++) { ctx.fillStyle = OF.heatLUT[Math.round(i / 119 * 255)]; ctx.fillRect(10 + i, 10, 1, 8); }
    ctx.font = '10px ui-monospace,monospace'; ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('≤' + OF.fmtUsd(ref * 0.05) + ' … ' + OF.fmtUsd(ref) + '+', 134, 9);
    ctx.fillText((coarse ? '5-second' : '0.5-second') + ' book columns · trades at their price', 10, 22);
    // L3 markers
    const evs = S.events, ei = OF.lb(evs, t0), mk = S.l3Min * 2;
    ctx.lineWidth = 1.5; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = ei; i < evs.length; i++) {
      const e = evs[i]; if (e.n < mk || e.p < lo || e.p > hi) continue;
      if (e.type !== 'pull' && e.type !== 'add') continue;
      const x = X(e.t), y = Y(e.p), col = e.side === 'bid' ? C.buy : C.sell;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fillStyle = e.type === 'pull' ? col : 'rgba(0,0,0,0)'; ctx.fill(); ctx.strokeStyle = col; ctx.stroke();
      ctx.fillStyle = e.type === 'pull' ? '#fff' : col; ctx.fillText(e.type === 'pull' ? '✕' : '+', x, y + 0.5);
    }
    // trade bubbles
    if (o.bubbles !== 'off') {
      const bs = S.bubbles, bi = OF.lb(bs, t0); let mx = 0; const sz = [];
      for (let i = bi; i < bs.length; i++) { const b = bs[i]; mx = Math.max(mx, b.bn, b.sn); sz.push(b.bn + b.sn); }
      const min = o.bubbles === 'auto' ? OF.pctile(sz, 0.75) : 0, R = Math.min(24, Math.max(10, ph / 28));
      for (let i = bi; i < bs.length; i++) {
        const b = bs[i], x = X(b.t + 250);
        for (const side of ['b', 's']) {
          const n = b[side + 'n']; if (!n || n < min) continue;
          const p = b[side + 'pq'] / n; if (p < lo || p > hi) continue;
          const r = Math.max(2, Math.sqrt(n / mx) * R);
          ctx.beginPath(); ctx.arc(x, Y(p), r, 0, 7);
          ctx.fillStyle = side === 'b' ? C.buyA + '.75)' : C.sellA + '.75)'; ctx.fill();
          ctx.strokeStyle = side === 'b' ? '#86efac' : '#fca5a5'; ctx.lineWidth = 1; ctx.stroke();
        }
      }
    }
    // plan lines
    const d = OF.lastDecision;
    if (OF.app.lines.plan && d && d.plan) {
      if (d.plan.buyAbove && d.plan.buyAbove < hi) ui.hline(ctx, 0, pw, Y(d.plan.buyAbove), C.buy, [2, 3], '▲ buy above ' + OF.fp(d.plan.buyAbove));
      if (d.plan.sellBelow && d.plan.sellBelow > lo) ui.hline(ctx, 0, pw, Y(d.plan.sellBelow), C.sell, [2, 3], '▼ sell below ' + OF.fp(d.plan.sellBelow), 0);
    }
    // book on the right
    ctx.fillStyle = C.panel; ctx.fillRect(pw, 0, BK, ph);
    const bk = OF.bookBins(Math.max(0.05, (hi - lo) / mid * 60), rb); let bmx = 0;
    for (const v of bk.b.values()) bmx = Math.max(bmx, v); for (const v of bk.a.values()) bmx = Math.max(bmx, v);
    const top = [];
    for (const [m, col] of [[bk.b, C.buyA], [bk.a, C.sellA]]) for (const [p, v] of m) {
      if (p < lo || p > hi) continue; const w = v / bmx * (BK - 4);
      ctx.fillStyle = col + '.55)'; ctx.fillRect(pw + BK - w, Y(p + rb), w, Math.max(1, rh - 0.5)); top.push([p, v]);
    }
    top.sort((a, b) => b[1] - a[1]); ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const [p, v] of top.slice(0, 4)) { ctx.fillStyle = '#e5e7eb'; ctx.fillText(OF.fmtUsd(v), pw + BK - 3, Y(p + rb / 2)); }
    // axes
    ui.priceAxis(ctx, pw + BK, pw + BK, 0, ph, lo, hi);
    ctx.fillStyle = C.bg; ctx.fillRect(0, ph, W, TB);
    ui.timeAxis(ctx, 0, pw, ph, t0, now, 100);
    // last price
    if (S.last) { const y = Y(S.last); ui.hline(ctx, 0, pw + BK, y, '#e5e7eb', [3, 3]); ui.tag(ctx, pw + BK + 1, y, OF.fp(S.last), '#e5e7eb', '#000'); }
    // hover
    if (this.mouse && this.mouse.x < pw && this.mouse.y < ph) {
      const m = this.mouse, p = lo + (ph - m.y) / ph * (hi - lo), t = t0 + m.x / pw * spanMs;
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(m.x, 0); ctx.lineTo(m.x, ph); ctx.moveTo(0, m.y); ctx.lineTo(pw, m.y); ctx.stroke(); ctx.setLineDash([]);
      let best = null; for (const gr of grid) if (!best || Math.abs(gr[0] - t) < Math.abs(best[0] - t)) best = gr;
      const r = Math.floor(p / rb) - r0, v = best ? best[1][r] : 0;
      ui.tip(m.cx, m.cy, `<b>${OF.fp(Math.floor(p / rb) * rb)}</b> · ${OF.hm(t, true)}<br>resting ${OF.fmtUsd(v || 0)}`);
    }
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
      const p = fi(f(lo) + ((mainH - volH) - this.mouse.y) / (mainH - volH - 10) * (f(hi) - f(lo))); ui.tag(ctx, pw + 1, this.mouse.y, OF.fp(p), '#374151', '#fff');
    }
    if (this.tool) { ctx.fillStyle = C.amber; ctx.fillText(this.tool === 'hline' ? 'Click to place a level' : (this.draft ? 'Click the second point' : 'Click the first point'), pw / 2 - 60, 6); }
    this.geo = { bw, tAt: x => tStart + (x / bw - 0.5 + 0.5) * ms, pAt: y => fi(f(lo) + ((mainH - volH) - y) / (mainH - volH - 10) * (f(hi) - f(lo))) };
  }
};

/* shared overlay lines (Plan / Γ / Liq toggles in the header) */
OF.drawPlanLines = (ctx, pw, Y, lo, hi) => {
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
  const top = m.rows.filter(r => r.p > lo && r.p < hi).sort((a, b) => (b.long + b.short) - (a.long + a.short)).slice(0, 4);
  for (const r of top) ui.hline(ctx, 0, pw, Y(r.p + m.bin / 2), r.p > m.mid ? C.buy : C.sell, [1, 4], 'est. liq ' + OF.fmtUsd(r.long + r.short), pw - 140);
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
  mount(v) { this.c = ui.canvas(v); this.c.cv.onmousemove = e => { const r = this.c.cv.getBoundingClientRect(); this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; }; this.c.cv.onmouseleave = () => this.mouse = null; },
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
    ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.fillText('rows ' + OF.fp(bin) + ' · ' + o.tf + ' candles · ' + (o.units === '$' ? '$ volume' : S.info.base), pw - 6, 12);
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
  mount(v) { this.c = ui.canvas(v); },
  thr() { const S = OF.S; return this.o.size === 'auto' ? (S.whaleThr || 50000) : +this.o.size; },
  data() {
    const S = OF.S, from = S.trades.length ? S.trades[0].t : OF.now();
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
      if (d.bAvg) ui.hline(ctx, 0, pw, Y(d.bAvg), '#e5e7eb', [6, 3], '🐋 buyers’ avg ' + OF.fp(d.bAvg) + ' (price ' + ((S.last / d.bAvg - 1) * 100).toFixed(2) + '%)');
      if (d.sAvg) ui.hline(ctx, 0, pw, Y(d.sAvg), C.muted, [2, 3], '🐋 sellers’ avg ' + OF.fp(d.sAvg) + ' (price ' + ((S.last / d.sAvg - 1) * 100).toFixed(2) + '%)');
    }
    if (OF.app.lines.plan) OF.drawPlanLines(ctx, pw, Y, lo, hi);
    if (OF.app.lines.gamma) OF.drawGammaLines(ctx, pw, Y, lo, hi);
    if (OF.app.lines.liq) OF.drawLiqLines(ctx, pw, Y, lo, hi);
    // whale volume by price on the right
    if (o.vp) {
      const zb = OF.niceStep((hi - lo) / 50), zm = new Map(); for (const w of d.list) { const kk = Math.floor(w.p / zb) * zb; const r = zm.get(kk) || [0, 0]; r[w.buy ? 0 : 1] += w.n; zm.set(kk, r); }
      let m2 = 0; for (const r of zm.values()) m2 = Math.max(m2, r[0] + r[1]);
      for (const [p, r] of zm) { const wb = r[0] / m2 * (VP - 4), ws = r[1] / m2 * (VP - 4); ctx.fillStyle = C.buyA + '.7)'; ctx.fillRect(pw + 2, Y(p + zb), wb, Y(p) - Y(p + zb) - 1); ctx.fillStyle = C.sellA + '.7)'; ctx.fillRect(pw + 2 + wb, Y(p + zb), ws, Y(p) - Y(p + zb) - 1); }
    }
    if (S.last) ui.tag(ctx, pw + VP + 1, Y(S.last), OF.fp(S.last), '#e5e7eb', '#000');
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

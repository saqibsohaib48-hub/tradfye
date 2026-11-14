/* FlowDesk views: Vol profile, TPO, Gamma, Tape, L3 events, Futures, Sentiment, Guide. */
(function () {
'use strict';
const OF = window.OF, C = OF.C, el = OF.el, ui = OF.ui, LS = OF.LS;

/* ===================== VOLUME PROFILE ===================== */
/* Buy / sell split of the volume profile.
   Bought = volume traded by aggressive buyers (market buys lifting the ask), sold = aggressive sellers.
   Each candle's taker-buy share is spread over the prices it traded, so per-row values are estimates; zones are steadier. */
const share = (b, s) => { const t = b + s; return t ? { b, s, t, buy: b / t, d: (b - s) / t } : { b: 0, s: 0, t: 0, buy: .5, d: 0 }; };
function bsStats(p) {
  const sum = rows => { let b = 0, s = 0; for (const r of rows) { b += r.b; s += r.s; } return share(b, s); };
  const pi = p.rows.findIndex(r => p.poc >= r.p && p.poc < r.p + p.bin), R = p.rows;
  return {
    pocRow: sum(R.slice(pi, pi + 1)),
    pocZone: sum(R.slice(Math.max(0, pi - 2), pi + 3)),                       // POC row ± 2 rows
    va: sum(R.filter(r => r.p >= p.val && r.p < p.vah)),
    above: sum(R.filter(r => r.p >= p.poc)), below: sum(R.filter(r => r.p + p.bin <= p.poc)),
    vah: sum(R.filter(r => r.p >= p.vah - 2 * p.bin && r.p < p.vah + p.bin)), val: sum(R.filter(r => r.p >= p.val - p.bin && r.p < p.val + 2 * p.bin)),
    all: sum(R)
  };
}
const pct = x => Math.round(x * 100) + '%';
const side = (x, strong) => x.d >= (strong || .1) ? 'buyers' : x.d <= -(strong || .1) ? 'sellers' : 'balanced';
/* plain-language verdict: who was stronger at the POC, and what that means given where price is now */
function pocVerdict(p, px) {
  const z = p.bs.pocZone, above = px > p.poc, who = side(z);
  if (who === 'buyers') return { cls: 'g', head: `Buyers stronger at the POC (${pct(z.buy)} buys)`, txt: above ? 'Price is above the POC and buyers defended it — the POC tends to act as support while price stays above it.' : 'Buyers were stronger at the POC but price is now below it — a move back up to the POC is likely to meet buying; a failure there turns it into resistance.' };
  if (who === 'sellers') return { cls: 'r', head: `Sellers stronger at the POC (${pct(1 - z.buy)} sells)`, txt: !above ? 'Price is below the POC and sellers defended it — the POC tends to act as resistance while price stays below it.' : 'Sellers were stronger at the POC but price is now above it — a pullback to the POC may meet selling; holding above it would show buyers absorbed them.' };
  return { cls: 'y', head: `Balanced at the POC (${pct(z.buy)} buys / ${pct(1 - z.buy)} sells)`, txt: 'Neither side dominated at the POC — expect two-way trade around it; wait for price to leave the value area with one side in control.' };
}

OF.views.profile = {
  label: 'Vol profile', title: 'Volume profile — traded volume by price, with value area',
  o: Object.assign({ range: 'day', split: true }, LS.get('vp', {})),
  toolbar(tb) {
    const o = this.o, save = () => LS.set('vp', o);
    tb.append(ui.seg('Range', [['1h', 'Last 1h'], ['4h', 'Last 4h'], ['day', 'Today (UTC)'], ['prev', 'Yesterday'], ['2d', 'Yesterday + today']], o.range, v => { o.range = v; save(); }),
      ui.toggle('Buy / sell split', o.split, v => { o.split = v; save(); }));
  },
  mount(v) { this.c = ui.canvas(v); ui.track(this); },
  prof() {
    const S = OF.S, ss = OF.session(); if (!ss) return null;
    const now = OF.now(), t = ss.todayCandles, p = S.day.prev;
    let cs = this.o.range === 'day' ? t : this.o.range === 'prev' ? p : this.o.range === '2d' ? p.concat(t) : p.concat(t).filter(c => c.t >= now - (this.o.range === '1h' ? 36e5 : 144e5));
    if (!cs.length) return null;
    let lo = Infinity, hi = -Infinity; for (const c of cs) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
    const prof = OF.profileFrom(cs, Math.max(S.info.tick, OF.niceStep((hi - lo) / 90)));
    if (prof) prof.bs = bsStats(prof);
    return prof;
  },
  reading() {
    const p = this.prof(), S = OF.S; if (!p) return 'Loading session candles…';
    const where = S.last > p.vah ? 'above the value area — buyers are pushing into new prices' : S.last < p.val ? 'below the value area — sellers are pushing into new prices' : 'inside the value area — two-way, balanced trade';
    const v = pocVerdict(p, S.last), z = p.bs.pocZone;
    return `POC <b class="y">${OF.fp(p.poc)}</b> · <b class="g">buy ${pct(z.buy)}</b> / <b class="r">sell ${pct(1 - z.buy)}</b> · value area ${OF.fp(p.val)}–${OF.fp(p.vah)} (70% of ${OF.fmtUsd(p.tot)}). Price is ${where}. <b class="${v.cls}">${v.head}.</b> ${v.txt} This shows who was more aggressive, not a guarantee.`;
  },
  /* "Who controls" card, top right of the profile */
  drawCard(ctx, p, pw, H, Y) {
    const B = p.bs, S = OF.S, v = pocVerdict(p, S.last), W = 330, x = pw - W - 12; let y = 12;
    const rows = [['At the POC (±2 rows)', B.pocZone, true], ['POC row only', B.pocRow], ['Value area (70%)', B.va], ['Above the POC', B.above], ['Below the POC', B.below], ['Whole range', B.all]];
    // wrap the verdict first so the card is tall enough for it
    ctx.save(); ctx.font = '11px Inter,system-ui,sans-serif';
    const lines = []; { let line = ''; for (const w of v.txt.split(' ')) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > W - 28) { lines.push(line); line = w; } else line = t; } if (line) lines.push(line); }
    const Hh = 58 + rows.length * 26 + lines.length * 14 + 30;
    // keep the POC, VAH and VAL labels visible: use whichever corner (top or bottom) covers fewer of them
    const keys = [p.poc, p.vah, p.val].map(Y), hits = top => keys.filter(k => k > top - 34 && k < top + Hh + 10).length;
    const yb = H - Hh - 58; if (hits(12) > hits(yb) || (hits(12) && hits(12) === hits(yb) && Math.abs(keys[0] - 12) < Math.abs(keys[0] - yb))) y = yb;
    ctx.fillStyle = 'rgba(16,6,36,.93)'; ctx.strokeStyle = 'rgba(255,43,214,.45)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x, y, W, Hh, 14); ctx.fill(); ctx.stroke();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = 'bold 11px Inter,system-ui,sans-serif'; ctx.fillStyle = '#ff8ae9'; ctx.fillText('WHO CONTROLS · BUY vs SELL', x + 14, y + 18);
    ctx.font = 'bold 13px Inter,system-ui,sans-serif'; ctx.fillStyle = v.cls === 'g' ? C.buy : v.cls === 'r' ? C.sell : C.yellow; ctx.fillText(v.head, x + 14, y + 40);
    rows.forEach(([name, z, main], i) => {
      const ry = y + 62 + i * 26, bx = x + 146, bwid = 92;
      ctx.font = (main ? 'bold ' : '') + '11.5px Inter,system-ui,sans-serif'; ctx.fillStyle = main ? '#fff' : C.muted; ctx.textAlign = 'left'; ctx.fillText(name, x + 14, ry);
      ctx.fillStyle = C.sell; ctx.beginPath(); ctx.roundRect(bx, ry - 4, bwid, 8, 4); ctx.fill();
      ctx.fillStyle = C.buy; ctx.beginPath(); ctx.roundRect(bx, ry - 4, Math.max(4, bwid * z.buy), 8, 4); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillRect(bx + bwid / 2 - .5, ry - 6, 1, 12);
      ctx.font = 'bold 11.5px Inter,system-ui,sans-serif'; ctx.textAlign = 'right';
      ctx.fillStyle = z.d >= .1 ? C.buy : z.d <= -.1 ? C.sell : C.yellow; ctx.fillText(`${pct(z.buy)} / ${pct(1 - z.buy)}`, x + W - 14, ry);
    });
    // the verdict text, wrapped
    ctx.font = '11px Inter,system-ui,sans-serif'; ctx.fillStyle = '#d8c8f0'; ctx.textAlign = 'left';
    lines.forEach((l, i) => ctx.fillText(l, x + 14, y + 62 + rows.length * 26 + 4 + i * 14));
    ctx.font = '10px Inter,system-ui,sans-serif'; ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.fillText('green = buy %  ·  red = sell %  ·  white tick = 50%', x + W - 14, y + Hh - 10);
    ctx.restore();
  },
  render() {
    const c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h, S = OF.S;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const p = S && S.day ? this.prof() : null; if (!p) { ui.msg(ctx, W, H, 'Loading session candles…'); return; }
    const AX = 80, pw = W - AX, lo = p.rows[0].p - p.bin, hi = p.rows[p.rows.length - 1].p + 2 * p.bin;
    const Y = x => 10 + (H - 20) - (x - lo) / (hi - lo) * (H - 20), rh = (H - 20) * p.bin / (hi - lo);
    ui.priceAxis(ctx, 0, pw, 10, H - 20, lo, hi);
    let mx = 0; for (const r of p.rows) mx = Math.max(mx, r.v);
    const bw = pw * 0.8;
    ctx.fillStyle = 'rgba(56,189,248,.06)'; ctx.fillRect(0, Y(p.vah), pw, Y(p.val) - Y(p.vah));
    for (const r of p.rows) {
      const y = Y(r.p + p.bin), h = Math.max(1, rh - 1), inVA = r.p >= p.val && r.p < p.vah;
      if (this.o.split) {
        const ws = r.s / mx * bw, wb = r.b / mx * bw;
        ctx.fillStyle = inVA ? 'rgba(239,68,68,.75)' : 'rgba(239,68,68,.4)'; ctx.fillRect(0, y, ws, h);
        ctx.fillStyle = inVA ? 'rgba(34,197,94,.75)' : 'rgba(34,197,94,.4)'; ctx.fillRect(ws, y, wb, h);
      } else { ctx.fillStyle = inVA ? 'rgba(56,189,248,.75)' : 'rgba(56,189,248,.35)'; ctx.fillRect(0, y, r.v / mx * bw, h); }
    }
    const B = p.bs;
    ui.hline(ctx, 0, pw, Y(p.vah), C.blue, [4, 3], `VAH ${OF.fp(p.vah)} · B ${pct(B.vah.buy)} / S ${pct(1 - B.vah.buy)}`, pw * 0.70);
    ui.hline(ctx, 0, pw, Y(p.val), C.blue, [4, 3], `VAL ${OF.fp(p.val)} · B ${pct(B.val.buy)} / S ${pct(1 - B.val.buy)}`, pw * 0.70);
    // POC: thicker line, a big label with the buy / sell split and a split bar
    { const y = Y(p.poc), z = B.pocZone, t = `POC ${OF.fp(p.poc)}   BUY ${pct(z.buy)}  ·  SELL ${pct(1 - z.buy)}`;
      ctx.save(); ctx.strokeStyle = C.yellow; ctx.lineWidth = 2; ctx.shadowColor = C.yellow; ctx.shadowBlur = 8; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(pw, y); ctx.stroke(); ctx.restore();
      ctx.font = 'bold 12px Inter,system-ui,sans-serif'; const tw = ctx.measureText(t).width + 18, lx = OF.clamp(pw * 0.70 - 4, 4, pw - tw - 4), ly = OF.clamp(y - 30, 6, H - 40);
      ctx.fillStyle = 'rgba(16,6,36,.94)'; ctx.strokeStyle = C.yellow; ctx.beginPath(); ctx.roundRect(lx, ly, tw, 26, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.yellow; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(`POC ${OF.fp(p.poc)}`, lx + 9, ly + 10);
      const w1 = ctx.measureText(`POC ${OF.fp(p.poc)}   `).width; ctx.fillStyle = C.buy; ctx.fillText(`BUY ${pct(z.buy)}`, lx + 9 + w1, ly + 10);
      const w2 = ctx.measureText(`BUY ${pct(z.buy)}  ·  `).width; ctx.fillStyle = C.sell; ctx.fillText(`SELL ${pct(1 - z.buy)}`, lx + 9 + w1 + w2, ly + 10);
      ctx.fillStyle = C.sell; ctx.fillRect(lx + 9, ly + 19, tw - 18, 3); ctx.fillStyle = C.buy; ctx.fillRect(lx + 9, ly + 19, (tw - 18) * z.buy, 3); }
    this.drawCard(ctx, p, pw, H, Y);
    const ss = OF.session(); if (ss && ss.vwap && ss.vwap > lo && ss.vwap < hi) ui.hline(ctx, 0, pw, Y(ss.vwap), C.purple, [6, 3], 'VWAP ' + OF.fp(ss.vwap), pw * 0.62);
    if (S.last) { ui.hline(ctx, 0, pw, Y(S.last), '#e5e7eb', [2, 2]); ui.tag(ctx, pw + 1, Y(S.last), OF.fp(S.last), '#e5e7eb', '#000'); }
    const cp = ui.cross(ctx, this.mouse, 0, pw, 10, H - 20, lo, hi, pw + 1);
    if (cp != null) { const r = p.rows.find(x => cp >= x.p && cp < x.p + p.bin); ui.tip(this.mouse.cx, this.mouse.cy, r ? `<b>${OF.fp(r.p)}</b><br>volume ${OF.fmtUsd(r.v)}<br><span class="g">bought ${OF.fmtUsd(r.b)} (${pct(r.b / (r.v || 1))})</span> · <span class="r">sold ${OF.fmtUsd(r.s)} (${pct(r.s / (r.v || 1))})</span>` : ''); } else ui.tip();
  }
};

/* ===================== TPO ===================== */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXabcdefghijklmnopqrstuvwx';
OF.views.tpo = {
  label: 'TPO', title: 'TPO market profile — one letter per period at each price traded',
  o: Object.assign({ period: '30m', days: 5, style: 'letters', ib: 2, mult: 1 }, LS.get('tpo', {})),
  toolbar(tb) {
    const o = this.o, save = () => LS.set('tpo', o);
    tb.append(ui.seg('Period', [['30m', '30m'], ['1h', '1h']], o.period, v => { o.period = v; save(); }),
      ui.seg('Days', [[1, '1'], [3, '3'], [5, '5'], [10, '10']], o.days, v => { o.days = v; save(); }),
      ui.seg('', [['letters', 'Letters'], ['blocks', 'Blocks']], o.style, v => { o.style = v; save(); }),
      ui.seg('Rows', [[0.5, '×0.5'], [1, '×1'], [2, '×2'], [4, '×4']], o.mult, v => { o.mult = v; save(); }),
      ui.seg('IB', [[1, '1 period'], [2, '2 periods']], o.ib, v => { o.ib = v; save(); }, 'Initial balance: the range of the first periods of the day.'));
  },
  mount(v) { this.c = ui.canvas(v); ui.track(this); },
  build() {
    const S = OF.S, o = this.o, k = S.k[o.period]; if (!k) { OF.loadKlines(o.period); return null; }
    const dayMs = 864e5, start = (Math.floor(OF.now() / dayMs) - o.days + 1) * dayMs, cs = k.filter(c => c.t >= start);
    if (!cs.length) return null;
    let lo = Infinity, hi = -Infinity; for (const c of cs) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); }
    const bin = Math.max(S.info.tick, OF.niceStep((hi - lo) / 160) * o.mult);
    const days = new Map();
    for (const c of cs) {
      const d = Math.floor(c.t / dayMs) * dayMs; let D = days.get(d); if (!D) { D = { t: d, rows: new Map(), n: 0, o: c.o, c: c.c, h: c.h, l: c.l, per: [] }; days.set(d, D); }
      const idx = Math.round((c.t - d) / OF.tfMs[o.period]); D.per.push(c); D.c = c.c; D.h = Math.max(D.h, c.h); D.l = Math.min(D.l, c.l);
      for (let j = Math.floor(c.l / bin); j <= Math.floor(c.h / bin); j++) { const r = D.rows.get(j) || []; r.push(idx); D.rows.set(j, r); D.n++; }
    }
    for (const D of days.values()) {
      const rows = [...D.rows.entries()].sort((a, b) => a[0] - b[0]); let poc = rows[0];
      for (const r of rows) if (r[1].length > poc[1].length) poc = r;
      let i = rows.indexOf(poc), a = i, b = i, acc = poc[1].length;
      while (acc < D.n * 0.7 && (a > 0 || b < rows.length - 1)) { const up = b < rows.length - 1 ? rows[b + 1][1].length : -1, dn = a > 0 ? rows[a - 1][1].length : -1; if (up >= dn) acc += rows[++b][1].length; else acc += rows[--a][1].length; }
      D.poc = poc[0]; D.vah = rows[b][0]; D.val = rows[a][0];
      const ibc = D.per.slice(0, o.ib); D.ibH = Math.max(...ibc.map(c => c.h)); D.ibL = Math.min(...ibc.map(c => c.l));
      D.poorHigh = (rows[rows.length - 1][1].length >= 2); D.poorLow = rows[0][1].length >= 2;
      const ext = D.h > D.ibH * 1.0005 ? 'up' : D.l < D.ibL * 0.9995 ? 'down' : null;
      D.type = !ext ? 'Normal' : (D.h > D.ibH && D.l < D.ibL) ? 'Neutral' : 'Normal variation';
    }
    return { days: [...days.values()].sort((a, b) => a.t - b.t), lo, hi, bin };
  },
  reading() { const b = this.build(); if (!b) return 'Loading periods…'; const D = b.days[b.days.length - 1]; return `Today so far: POC ${OF.fp(D.poc * b.bin)}, value ${OF.fp(D.val * b.bin)}–${OF.fp((D.vah + 1) * b.bin)}, IB ${OF.fp(D.ibL)}–${OF.fp(D.ibH)}${D.poorHigh ? ' · <b class="y">poor high</b> (unfinished auction above)' : ''}${D.poorLow ? ' · <b class="y">poor low</b>' : ''}.`; },
  render() {
    const c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h, S = OF.S;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const b = S && S.info ? this.build() : null; if (!b) { ui.msg(ctx, W, H, 'Loading TPO periods…'); return; }
    const AX = 80, pw = W - AX, top = 34, ph = H - top - 22, lo = b.lo - b.bin, hi = b.hi + b.bin;
    const Y = p => top + ph - (p - lo) / (hi - lo) * ph, rh = ph * b.bin / (hi - lo), dw = pw / b.days.length;
    ui.priceAxis(ctx, 0, pw, top, ph, lo, hi);
    const cw = Math.max(3, Math.min(9, (dw - 30) / 26)), fs = Math.min(10, Math.max(6, rh));
    b.days.forEach((D, i) => {
      const x0 = i * dw + 8;
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(i * dw + .5, top - 20); ctx.lineTo(i * dw + .5, H); ctx.stroke();
      ctx.font = '11px ui-monospace,monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = '#e5e7eb';
      const dd = new Date(D.t); ctx.fillText((dd.getUTCMonth() + 1) + '-' + dd.getUTCDate() + ' Day (UTC)', x0, 4);
      ctx.fillStyle = i === b.days.length - 1 ? C.blue : C.muted; ctx.fillText((i === b.days.length - 1 ? 'Developing' : D.type) + ' · ' + D.n + ' TPO', x0, 18);
      // value area band
      ctx.fillStyle = 'rgba(245,158,11,.07)'; ctx.fillRect(x0, Y((D.vah + 1) * b.bin), dw - 14, Y(D.val * b.bin) - Y((D.vah + 1) * b.bin));
      // IB bar
      ctx.fillStyle = C.purple; ctx.fillRect(x0 - 5, Y(D.ibH), 3, Y(D.ibL) - Y(D.ibH));
      for (const [j, idxs] of D.rows) {
        const y = Y((j + 1) * b.bin), single = idxs.length === 1, inVA = j >= D.val && j <= D.vah, isPoc = j === D.poc;
        idxs.forEach((idx, q) => {
          const x = x0 + q * cw;
          const col = isPoc ? C.blue : single ? C.amber : inVA ? '#f59e0b' : '#6b7280';
          if (this.o.style === 'blocks' || rh < 6) { ctx.fillStyle = col; ctx.globalAlpha = inVA || isPoc ? 0.9 : 0.6; ctx.fillRect(x, y, cw - 1, Math.max(1, rh - 1)); ctx.globalAlpha = 1; }
          else { ctx.fillStyle = col; ctx.font = fs + 'px ui-monospace,monospace'; ctx.textBaseline = 'top'; ctx.fillText(LETTERS[idx % LETTERS.length], x, y); }
        });
      }
      if (D.poorHigh) { ctx.fillStyle = C.amber; ctx.font = '10px sans-serif'; ctx.fillText('poor high', x0 + 40, Y(D.h) - 14); }
      // open / close markers
      ctx.fillStyle = '#e5e7eb'; ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText('›', x0 - 12, Y(D.o)); ctx.fillText('‹', x0 - 12, Y(D.c));
    });
    if (S.last) { ui.hline(ctx, 0, pw, Y(S.last), '#e5e7eb', [3, 3]); ui.tag(ctx, pw + 1, Y(S.last), OF.fp(S.last), '#e5e7eb', '#000'); }
    ui.cross(ctx, this.mouse, 0, pw, top, ph, lo, hi, pw + 1);
    ctx.fillStyle = C.muted; ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('Letters = periods (A first) · orange = value area · blue = POC · purple bar = initial balance · amber = single prints · › open ‹ close', 6, H - 4);
  }
};

/* ===================== GAMMA ===================== */
OF.views.gamma = {
  label: 'Gamma', title: 'Options gamma — call wall, put wall, zero-gamma flip, max pain (Deribit)',
  o: Object.assign({ days: 30, expiry: '' }, LS.get('gm', {})),
  toolbar(tb) {
    const o = this.o, save = () => LS.set('gm', o);
    tb.append(ui.seg('', [[7, '≤ 7 days'], [30, '≤ 30 days'], [0, 'All']], o.days, v => { o.days = v; o.expiry = ''; save(); this.rebuildExp(); }));
    this.expWrap = el('span'); tb.append(this.expWrap);
    const r = el('button', 'tgl', 'Refresh'); r.onclick = () => OF.loadGamma(true); tb.append(r);
    this.src = el('span', 'lbl mono', ''); tb.append(this.src);
    this.rebuildExp();
  },
  rebuildExp() {
    const g = OF.S && OF.S.gamma; if (!this.expWrap) return; this.expWrap.innerHTML = '';
    const ex = g && g.opts ? [...new Set(g.opts.filter(x => x.exp > Date.now() && (!this.o.days || x.exp - Date.now() <= this.o.days * 864e5)).sort((a, b) => a.exp - b.exp).map(x => x.expCode))] : [];
    this.expWrap.append(ui.select('', [['', 'All expiries in range']].concat(ex.map(e => [e, e])), this.o.expiry, v => { this.o.expiry = v; LS.set('gm', this.o); }));
    this.expN = ex.length;
  },
  mount(v) { this.root = v; v.classList.add('scroll'); OF.loadGamma(); this.c = null; },
  render() {
    const S = OF.S, G = S && S.gamma, v = this.root;
    if (G && G.opts && this.expN == null || (G && G.opts && G.opts.length && !this.expN)) this.rebuildExp();
    if (this.src) this.src.textContent = G && G.source ? G.source + ' · updated ' + Math.round((Date.now() - G.at) / 1000) + 's ago' : '';
    if (!G) { v.innerHTML = '<div class="empty">Loading the options chain…</div>'; OF.loadGamma(); return; }
    if (!G.supported) { v.innerHTML = '<div class="empty">Gamma levels need an options market — this coin has none on Deribit. Try BTC or ETH.</div>'; return; }
    if (G.error) { v.innerHTML = '<div class="empty">Could not load Deribit options: ' + G.error + '</div>'; return; }
    if (Date.now() - G.at > 60000) OF.loadGamma();
    const g = OF.gammaCalc({ days: this.o.days, expiry: this.o.expiry }); if (!g) { v.innerHTML = '<div class="empty">No options in this range.</div>'; return; }
    if (!this.c) {
      v.innerHTML = '';
      this.cards = el('div', 'cards'); v.appendChild(this.cards);
      const box = el('div', 'gbox'); v.appendChild(box); this.c = ui.canvas(box); ui.track(this);
    }
    const pct = x => ((x / g.spot - 1) * 100).toFixed(2) + '%', neg = g.net < 0;
    this.cards.innerHTML = `
      <div class="card ${neg ? 'warn' : 'ok'}"><div class="ct">${neg ? 'Negative gamma' : 'Positive gamma'} <span class="mono">net ${OF.fmtUsd(g.net)} / 1%</span></div><div class="cs">${neg ? 'Dealer hedging follows the move: dips get sold and rallies bought, so moves tend to extend.' : 'Dealer hedging leans against the move: dips get bought and rallies sold, so ranges tend to hold.'}</div></div>
      <div class="card"><div class="ct">Zero-gamma flip</div><div class="cv" style="color:${C.purple}">${OF.fp(g.flip)}</div><div class="cs">${g.flip ? pct(g.flip) : ''}</div></div>
      <div class="card"><div class="ct">Call wall</div><div class="cv" style="color:${C.blue}">${OF.fp(g.callWall)}</div><div class="cs">${pct(g.callWall)}</div></div>
      <div class="card"><div class="ct">Put wall</div><div class="cv" style="color:${C.amber}">${OF.fp(g.putWall)}</div><div class="cs">${pct(g.putWall)}</div></div>
      <div class="card"><div class="ct">Max pain</div><div class="cv">${OF.fp(g.maxPain)}</div><div class="cs">${pct(g.maxPain)} · ${new Date(g.maxPainExp).toUTCString().slice(0, 11)}</div></div>
      <div class="card"><div class="ct">Put / call OI</div><div class="cv">${g.pcr.toFixed(2)}</div><div class="cs">${Math.round(g.coi).toLocaleString()} C / ${Math.round(g.poi).toLocaleString()} P</div></div>`;
    const c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const AX = 80, CV = 160, pw = W - AX - CV, ks = g.strikes.filter(s => Math.abs(s.K / g.spot - 1) < 0.12);
    if (!ks.length) return;
    const lo = Math.min(ks[0].K, g.spot * 0.95), hi = Math.max(ks[ks.length - 1].K, g.spot * 1.05), Y = p => 10 + (H - 20) - (p - lo) / (hi - lo) * (H - 20);
    ui.priceAxis(ctx, 0, pw + CV, 10, H - 20, lo, hi);
    let mx = 0; for (const s of ks) mx = Math.max(mx, Math.abs(s.c), Math.abs(s.p));
    const cx = pw * 0.45, bh = Math.max(3, Math.min(14, (H - 20) / ks.length * 0.7));
    ctx.font = '10px ui-monospace,monospace'; ctx.textBaseline = 'middle';
    for (const s of ks) {
      const y = Y(s.K), wc = s.c / mx * (pw - cx - 50), wp = -s.p / mx * (cx - 50);
      ctx.fillStyle = 'rgba(56,189,248,.8)'; ctx.fillRect(cx, y - bh / 2, wc, bh);
      ctx.fillStyle = 'rgba(234,128,52,.85)'; ctx.fillRect(cx - wp, y - bh / 2, wp, bh);
      if (Math.abs(s.c) > mx * 0.35) { ctx.fillStyle = '#e5e7eb'; ctx.textAlign = 'left'; ctx.fillText(OF.fmtUsd(s.c), cx + wc + 4, y); }
      if (Math.abs(s.p) > mx * 0.35) { ctx.fillStyle = '#e5e7eb'; ctx.textAlign = 'right'; ctx.fillText(OF.fmtUsd(-s.p), cx - wp - 4, y); }
    }
    ctx.strokeStyle = C.faint; ctx.beginPath(); ctx.moveTo(cx + .5, 0); ctx.lineTo(cx + .5, H); ctx.stroke();
    ui.hline(ctx, 0, pw, Y(g.callWall), C.blue, [3, 3], 'call wall ' + OF.fp(g.callWall));
    ui.hline(ctx, 0, pw, Y(g.putWall), C.amber, [3, 3], 'put wall ' + OF.fp(g.putWall));
    if (g.flip && g.flip > lo && g.flip < hi) ui.hline(ctx, 0, pw + CV, Y(g.flip), C.purple, [6, 3], 'zero-gamma flip ' + OF.fp(g.flip));
    if (g.maxPain > lo && g.maxPain < hi) ui.hline(ctx, 0, pw, Y(g.maxPain), C.muted, [1, 3], 'max pain ' + OF.fp(g.maxPain));
    ui.hline(ctx, 0, pw + CV, Y(g.spot), '#e5e7eb', [], 'price ' + OF.fp(g.spot));
    ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.fillText('Dealer gamma by strike, $ per 1% move   ◂ puts | calls ▸', 6, 8);
    // net gamma curve "if price were here"
    const x0 = pw + 4; ctx.fillStyle = C.panel; ctx.fillRect(x0, 10, CV - 8, H - 20);
    let cm = 0; for (const p of g.curve) cm = Math.max(cm, Math.abs(p.v)); const mxX = x0 + (CV - 8) / 2;
    ctx.beginPath(); g.curve.forEach((p, i) => { if (p.px < lo || p.px > hi) return; const x = mxX + p.v / cm * (CV / 2 - 10), y = Y(p.px); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.strokeStyle = '#e5e7eb'; ctx.stroke();
    ctx.strokeStyle = C.faint; ctx.beginPath(); ctx.moveTo(mxX, 10); ctx.lineTo(mxX, H - 10); ctx.stroke();
    ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText('net gamma if price were here', x0 + (CV - 8) / 2, 18);
    ui.cross(ctx, this.mouse, 0, pw + CV, 10, H - 20, lo, hi, pw + CV + 1);
  }
};

/* ===================== TAPE ===================== */
OF.views.tape = {
  label: 'Tape', title: 'Time & sales',
  o: Object.assign({ win: 60, min: 0 }, LS.get('tp', {})),
  toolbar(tb) {
    const o = this.o, save = () => LS.set('tp', o);
    tb.append(ui.seg('Time', [[60, '1M'], [300, '5M'], [900, '15M'], [3600, '1H']], o.win, v => { o.win = v; save(); }),
      ui.seg('Show', [[0, 'All'], [1000, '$1K+'], [10000, '$10K+'], [100000, '$100K+'], ['w', 'Whales']], o.min, v => { o.min = v; save(); }));
  },
  mount(v) {
    v.classList.add('scroll');
    v.innerHTML = '<div class="cards" id="tpCards"></div><table class="tbl"><thead><tr><th>Time</th><th>Side</th><th class="rt">Price</th><th class="rt">Size</th><th>Notional</th></tr></thead><tbody id="tpBody"></tbody></table>';
  },
  render() {
    const S = OF.S; if (!S) return; const o = this.o, now = OF.now(), from = now - o.win * 1000, tr = S.trades, i0 = OF.lb(tr, from);
    const min = o.min === 'w' ? S.whaleThr : o.min;
    let b = 0, s = 0, big = 0; for (let i = i0; i < tr.length; i++) { const t = tr[i]; if (t.buy) b += t.n; else s += t.n; big = Math.max(big, t.n); }
    const rate = (tr.length - i0) / Math.max(1, Math.min(o.win, (now - (tr[i0] ? tr[i0].t : now)) / 1000));
    document.getElementById('tpCards').innerHTML = `<div class="card sm"><div class="ct">Trades / sec</div><div class="cv">${rate.toFixed(1)}</div></div>
      <div class="card sm"><div class="ct">Bought</div><div class="cv g">${OF.fmtUsd(b)}</div></div><div class="card sm"><div class="ct">Sold</div><div class="cv r">${OF.fmtUsd(s)}</div></div>
      <div class="card sm wide"><div class="ct">Buy share ${Math.round(b / (b + s || 1) * 100)}%</div><div class="bar"><i style="width:${b / (b + s || 1) * 100}%"></i></div></div>
      <div class="card sm"><div class="ct">Largest</div><div class="cv">${OF.fmtUsd(big)}</div></div>`;
    let html = '', n = 0, prev = null; const mx = Math.max(big, 1);
    for (let i = tr.length - 1; i >= i0 && n < 300; i--) {
      const t = tr[i]; if (t.n < min) continue; n++;
      const arrow = i > 0 ? (t.p > tr[i - 1].p ? '↑ ' : t.p < tr[i - 1].p ? '↓ ' : '') : '';
      html += `<tr><td class="mono">${OF.hm(t.t, true)}</td><td><span class="pill ${t.buy ? 'b' : 's'}">${t.buy ? 'BUY' : 'SELL'}</span></td><td class="rt mono ${t.buy ? 'g' : 'r'}">${arrow}${OF.fp(t.p)}</td><td class="rt mono">${t.q < 1 ? t.q.toFixed(5) : t.q.toFixed(3)}</td><td class="mono"><span class="nbar ${t.buy ? 'b' : 's'}" style="width:${Math.max(2, Math.sqrt(t.n / mx) * 100)}px"></span>${OF.fmtUsd(t.n)}</td></tr>`;
      prev = t;
    }
    document.getElementById('tpBody').innerHTML = html || '<tr><td colspan="5" class="empty">No trades match.</td></tr>';
  }
};

/* ===================== L3 EVENTS ===================== */
const EVN = { pull: ['✕ Pulled', 'pull'], add: ['+ Large add', 'add'], fill: ['● Large fill', 'fill'], iceberg: ['◆ Iceberg', 'ice'], spoof: ['⚠ Spoof', 'warn'], layering: ['⚠ Layering', 'warn'] };
OF.views.liquidity = {
  label: 'L3 events', title: 'Liquidity events inferred from the book — pulls, large adds, icebergs, spoofing, layering',
  o: Object.assign({ size: 0, hide: { add: true } }, LS.get('l3', {})),
  toolbar(tb) {
    const o = this.o, save = () => LS.set('l3', o);
    this.counts = el('div', 'evcounts'); tb.append(this.counts);
    tb.append(ui.seg('Size', [[0, 'All'], ['q', 'Top 25%'], [50000, '$50K+'], [100000, '$100K+'], [250000, '$250K+'], [1000000, '$1M+']], o.size, v => { o.size = v; save(); },
      'Public data has no order IDs, so these are inferred: a level that shrinks with no trade at that price was pulled; one that refills right after trading is an iceberg; the same level pulled 3+ times in 5 min is flagged as spoofing; 3+ prices pulled together is layering.'));
  },
  mount(v) { v.classList.add('scroll'); v.innerHTML = '<div id="l3hot" class="hot"></div><table class="tbl"><thead><tr><th>Time</th><th>Event</th><th>Times</th><th>Where · what</th><th class="rt">Size</th></tr></thead><tbody id="l3Body"></tbody></table>'; },
  render() {
    const S = OF.S; if (!S) return; const o = this.o, now = OF.now(), ev = S.events, i0 = OF.lb(ev, now - 300000);
    const cnt = { iceberg: 0, pull: 0, add: 0, fill: 0, spoof: 0, layering: 0 }, sizes = [];
    for (let i = i0; i < ev.length; i++) { cnt[ev[i].type]++; sizes.push(ev[i].n); }
    this.counts.innerHTML = ['iceberg', 'pull', 'add', 'fill', 'spoof', 'layering'].map(k => `<button class="evc ${o.hide[k] ? 'off' : ''}" data-k="${k}"><span>${EVN[k][0]}</span><b>${cnt[k]}</b> / 5 min</button>`).join('');
    this.counts.querySelectorAll('button').forEach(b => b.onclick = () => { o.hide[b.dataset.k] = !o.hide[b.dataset.k]; LS.set('l3', o); });
    const min = o.size === 'q' ? OF.pctile(sizes, 0.75) : o.size;
    // hot levels
    const hot = []; for (const [k, list] of S.pullCount) { const l = list.filter(t => now - t < 300000); if (l.length >= 3) hot.push([k, l.length]); }
    hot.sort((a, b) => b[1] - a[1]);
    document.getElementById('l3hot').innerHTML = hot.length ? 'Hot levels (5 min): ' + hot.slice(0, 4).map(([k, n]) => { const side = k.startsWith('bid') ? 'bid' : 'ask'; return `<span class="chip">${side} ${OF.fp(+k.slice(3))} · pulled ${n}×</span>`; }).join('') : '<span class="muted">No level pulled 3+ times in the last 5 min.</span>';
    let html = '', n = 0;
    for (let i = ev.length - 1; i >= 0 && n < 250; i--) {
      const e = ev[i]; if (o.hide[e.type] || e.n < min) continue; n++;
      const what = e.type === 'pull' ? `pulled ${e.age != null ? e.age.toFixed(1) + 's after placing' : '(placed before we connected)'}, untraded`
        : e.type === 'add' ? 'large order placed' : e.type === 'fill' ? 'traded through' : e.type === 'iceberg' ? `refilled ${e.times}× after trading — hidden size` : e.type === 'spoof' ? `pulled ${e.times}× in 5 min without trading` : `${e.times} ${e.side}s pulled together`;
      html += `<tr><td class="mono">${OF.hm(e.t, true)}</td><td><span class="ev ${EVN[e.type][1]}">${EVN[e.type][0]}</span></td><td class="mono y">${e.times > 1 && e.type === 'pull' ? '×' + e.times : ''}</td><td><span class="${e.side === 'bid' ? 'g' : 'r'} mono">${e.side} ${OF.fp(e.p)}</span> · ${what}</td><td class="rt mono">${OF.fmtUsd(e.n)}</td></tr>`;
    }
    document.getElementById('l3Body').innerHTML = html || `<tr><td colspan="5" class="empty">No events yet. Size floor right now: ${OF.fmtUsd(S.l3Min)} (adapts to this market).</td></tr>`;
  }
};

/* ===================== FUTURES ===================== */
OF.views.futures = {
  label: 'Futures', title: 'Perpetual futures — funding, open interest, basis, liquidations',
  toolbar(tb) { const m = OF.METALS[OF.S.symbol]; tb.append(el('span', 'lbl', m && m.mkt === 'fut' ? `Binance ${m.name.toLowerCase()} perpetual (live): funding, open interest and liquidations · basis vs the ${m.name.toLowerCase()} index · trades 24/7, the index pauses when the metal market is closed` : 'Bybit USDT perpetual (live) · liquidation map estimated from Binance futures open interest')); },
  mount(v) { v.classList.add('scroll'); v.innerHTML = '<div class="cards" id="fuCards"></div><div class="fuwrap"><div class="gbox" id="fuMap"></div><div class="fuside"><div class="sh">Latest liquidations</div><div id="fuLiq"></div></div></div>'; this.c = ui.canvas(document.getElementById('fuMap')); ui.track(this); },
  render() {
    const S = OF.S; if (!S) return; const F = S.fut, now = OF.now();
    if (F.available === false) { document.getElementById('fuCards').innerHTML = '<div class="empty">No USDT perpetual for this coin on Bybit.</div>'; }
    else {
      const h = F.oiHist, a1 = h.find(x => x.t >= now - 36e5) || h[0], a4 = h.find(x => x.t >= now - 144e5) || h[0], b = h[h.length - 1];
      const ch = a => a && b ? ((b.v - a.v) / a.v * 100).toFixed(2) + '%' : '--';
      let l5 = 0, s5 = 0, l1 = 0, s1 = 0, n1 = 0; for (const l of S.liqs) { if (l.t >= now - 36e5) { n1++; if (l.side === 'long') l1 += l.n; else s1 += l.n; } if (l.t >= now - 3e5) { if (l.side === 'long') l5 += l.n; else s5 += l.n; } }
      const ref = S.mkt === 'fut' ? F.index : S.last, basis = F.mark && ref ? (F.mark - ref) / ref * 1e4 : null, mins = F.nextFunding ? Math.round((F.nextFunding - Date.now()) / 6e4) : null;
      document.getElementById('fuCards').innerHTML = `
        <div class="card"><div class="ct">Funding (per 8 h)</div><div class="cv">${F.funding != null ? (F.funding >= 0 ? '+' : '') + (F.funding * 100).toFixed(4) + '%' : '--'}</div><div class="cs">${F.funding != null ? (F.funding * 3 * 365 * 100).toFixed(1) + '% / yr' : ''}${mins != null ? ' · next in ' + mins + ' min' : ''}</div></div>
        <div class="card"><div class="ct">Open interest</div><div class="cv">${OF.fmtUsd(F.oiValue)}</div><div class="cs">1 h ${ch(a1)} · 4 h ${ch(a4)} <span class="muted">(since page open)</span></div></div>
        <div class="card"><div class="ct">Basis (mark vs ${S.mkt === 'fut' ? 'index' : 'spot'})</div><div class="cv">${basis != null ? basis.toFixed(1) + ' bp' : '--'}</div><div class="cs">${basis == null ? '' : Math.abs(basis) < 8 ? 'in line with spot' : basis > 0 ? 'futures at a premium — leveraged longs keen' : 'futures at a discount — leveraged shorts keen'}</div></div>
        <div class="card"><div class="ct">Liquidations (live)</div><div class="cv sm2">5 m: <span class="r">${OF.fmtUsd(l5)} L</span> · <span class="g">${OF.fmtUsd(s5)} S</span></div><div class="cs">1 h: ${OF.fmtUsd(l1)} longs · ${OF.fmtUsd(s1)} shorts (${n1})</div></div>`;
    }
    document.getElementById('fuLiq').innerHTML = S.liqs.length ? S.liqs.slice(0, 40).map(l => `<div class="lq"><span class="mono">${OF.hm(l.t, true)}</span> <span class="${l.side === 'long' ? 'r' : 'g'}">${l.side}</span> <span class="mono">${OF.fp(l.p)}</span> <b class="mono">${OF.fmtUsd(l.n)}</b></div>`).join('') : '<div class="muted pad">None yet — they come in bursts when price runs into crowded positions.</div>';
    const c = this.c.fit(), ctx = c.ctx, W = c.w, H = c.h; ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const m = OF.liqMap(); if (!m || !m.rows.length) { ui.msg(ctx, W, H, 'Estimating liquidation clusters… (needs open-interest history)'); return; }
    const AX = 80, pw = W - AX, lo = m.mid * 0.94, hi = m.mid * 1.06, Y = p => 16 + (H - 26) - (p - lo) / (hi - lo) * (H - 26), rows = m.rows.filter(r => r.p > lo && r.p < hi);
    ui.priceAxis(ctx, 0, pw, 16, H - 26, lo, hi);
    let mx = 0; for (const r of rows) mx = Math.max(mx, r.long, r.short);
    const rh = Math.max(2, (H - 26) * m.bin / (hi - lo) - 1);
    for (const r of rows) { const v = r.p > m.mid ? r.short : r.long; if (!v) continue; ctx.fillStyle = r.p > m.mid ? 'rgba(34,197,94,.75)' : 'rgba(239,68,68,.75)'; ctx.fillRect(0, Y(r.p + m.bin), v / mx * (pw - 110), rh); if (v > mx * 0.4) { ctx.fillStyle = '#e5e7eb'; ctx.font = '10px ui-monospace,monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(OF.fmtUsd(v) + ' · ' + ((r.p / m.mid - 1) * 100).toFixed(1) + '%', v / mx * (pw - 110) + 4, Y(r.p + m.bin / 2)); } }
    ui.hline(ctx, 0, pw, Y(m.mid), '#e5e7eb', [], 'price ' + OF.fp(m.mid));
    ctx.fillStyle = C.muted; ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('Estimated liquidations by price — longs below (forced selling), shorts above (forced buying). Model: new OI × 10/25/50/100× leverage mix.', 6, 2);
    ui.cross(ctx, this.mouse, 0, pw, 16, H - 26, lo, hi, pw + 1);
  }
};

/* ===================== SENTIMENT ===================== */
const GROUPS = [['flow', 'Order flow now', 'Who is hitting the market in the last seconds and minutes'], ['delta', 'Delta by timeframe', 'Aggressive buying − selling in the current candle of each timeframe (blended with the previous one while it is young)'], ['book', 'Order book', 'Resting liquidity: which side is heavier, where the walls are, which side keeps faking it'], ['big', 'Big players', 'Large prints over the last hour vs everyone else'], ['value', 'Value and trend', 'Where price sits against today’s volume and the higher timeframe'], ['fut', 'Futures and options', 'Leverage: funding, open interest, liquidations, futures flow, basis, US demand'], ['risk', 'Risk and volatility', 'Not a direction: how fast and dangerous the tape is right now']];
function gauge(score, label, sub) {
  const a = Math.PI * (1 - (score + 100) / 200), x = 60 + 46 * Math.cos(a), y = 60 - 46 * Math.sin(a);
  return `<svg viewBox="0 0 120 72" class="gauge"><path d="M10 60 A50 50 0 0 1 43 13" stroke="#b91c1c" stroke-width="8" fill="none"/><path d="M45 12 A50 50 0 0 1 75 12" stroke="#475569" stroke-width="8" fill="none"/><path d="M77 13 A50 50 0 0 1 110 60" stroke="#15803d" stroke-width="8" fill="none"/><line x1="60" y1="60" x2="${x}" y2="${y}" stroke="#fff" stroke-width="2.5"/><circle cx="60" cy="60" r="4" fill="#fff"/></svg><div class="gl ${score > 15 ? 'g' : score < -15 ? 'r' : ''}">${label}</div><div class="gs">${sub}</div>`;
}
const meterHtml = m => {
  const s = m.score, pos = s == null ? (m.risk != null ? m.risk : 50) : (s + 100) / 2, lb = s == null ? (m.risk != null ? (m.risk > 66 ? 'High' : m.risk > 33 ? 'Elevated' : 'Calm') + ' ' + Math.round(m.risk) : 'info') : OF.label(s) + (Math.abs(s) >= 15 ? ' ' + Math.abs(s) : '');
  const cls = s == null ? (m.risk > 66 ? 'r' : m.risk > 33 ? 'y' : 'g') : s > 15 ? 'g' : s < -15 ? 'r' : 'muted';
  return `<div class="meter"><div class="mh"><span>${m.name}</span><b class="${cls}">${lb}</b></div><div class="mbar ${m.risk != null ? 'risk' : ''}"><i style="left:${OF.clamp(pos, 1, 99)}%"></i></div><div class="mt">${m.text}</div></div>`;
};
OF.views.sentiment = {
  label: 'Sentiment', title: 'Every reading as a meter, and their consensus',
  toolbar(tb) { tb.append(el('span', 'lbl', 'Describes the market now — not a forecast or advice. Updates every second.')); },
  mount(v) { v.classList.add('scroll'); v.innerHTML = '<div id="snTop" class="sntop"></div><div id="snBody"></div>'; },
  render() {
    const m = OF.meters(), d = OF.lastDecision; if (!m || !d) return;
    const regime = Math.abs(d.consensus.score) < 15 ? 'Mixed' : d.consensus.score > 0 ? 'Risk-on' : 'Risk-off';
    document.getElementById('snTop').innerHTML = `<div class="badges"><span class="chip">Regime: <b>${regime}</b></span><span class="chip">Danger: <b class="${m.danger > 66 ? 'r' : m.danger > 33 ? 'y' : 'g'}">${m.danger > 66 ? 'high' : m.danger > 33 ? 'elevated' : 'calm'}</b></span></div>
      <div class="gauges"><div class="gw">${gauge(d.score, OF.label(d.score) + ' ' + Math.round(Math.abs(d.score)), 'Order-flow engine (Decision panel)<br>' + d.verdict + ' · confidence ' + d.confidence + '%')}</div>
      <div class="gw">${gauge(d.consensus.score, OF.label(d.consensus.score), 'All meters (equal-weight consensus)<br>' + d.consensus.bull + ' bullish · ' + d.consensus.bear + ' bearish · ' + d.consensus.neutral + ' neutral')}</div>
      <div class="drivers"><div class="sh">Strongest readings</div>${d.reasons.map(r => `<div class="drv"><span>${r.name}</span><b class="${r.score > 0 ? 'g' : 'r'}">${OF.label(r.score)} ${Math.abs(r.score)}</b><div class="mt">${r.text}</div></div>`).join('') || '<div class="muted">Nothing strong right now.</div>'}</div></div>`;
    document.getElementById('snBody').innerHTML = GROUPS.map(([g, t, sub]) => {
      const list = m.list.filter(x => x.group === g); if (!list.length) return '';
      const sc = list.filter(x => x.score != null), avg = sc.length ? sc.reduce((a, x) => a + x.score, 0) / sc.length : null;
      return `<div class="sgrp"><div class="sh2">${t} ${avg != null && g !== 'risk' ? `<b class="${avg > 15 ? 'g' : avg < -15 ? 'r' : 'muted'}">${OF.label(avg)} ${Math.round(Math.abs(avg))}</b>` : ''} <span class="muted">${sub}</span></div><div class="meters">${list.map(meterHtml).join('')}</div></div>`;
    }).join('');
  }
};

/* ===================== GUIDE ===================== */
OF.views.guide = {
  label: 'Guide', title: 'How to read each view',
  toolbar(tb) { tb.append(el('span', 'lbl', 'Keys 1–9 and 0 switch tabs · P shows / hides the right panel')); },
  mount(v) {
    v.classList.add('scroll');
    const sec = (t, items) => `<h3>${t}</h3><div class="guide">${items.map(([h, p]) => `<div class="gcard"><b>${h}</b><p>${p}</p></div>`).join('')}</div>`;
    v.innerHTML = '<div class="gwrap">' +
      sec('Views', [
        ['Heatmap', 'Every half-second the whole order book is photographed and drawn as one column; brighter = more money resting at that price. Horizontal bright bands are walls. Bubbles are trades (green = buyer hit the ask, red = seller hit the bid). ✕ marks a large order that vanished without trading.'],
        ['Chart', 'Normal candles with EMA 21/50, RSI and session VWAP. Scroll to zoom, drag to pan, double-click to reset. Draw lines and levels; they are saved per coin in your browser.'],
        ['Gold and silver', 'Symbol menu → Metals. Gold (XAUUSDT) and silver (XAGUSDT) are Binance perpetual futures that trade 24/7, so the order book, trades, funding, open interest and liquidations all come from that one market. The metal market itself closes at weekends; the index price then stays at its last value. PAXG is a gold-backed spot token.'],
        ['HTF S/R + Weekly Bias', 'On the Chart tab (HTF S/R, ⚙ for settings). The latest pivot high and low on 4h, 12h, daily and weekly candles, counted only after the candle len bars later has closed. A new weekly pivot low puts it in SUPPORT mode and Levels 1–3 then show only support; a new weekly pivot high puts it in RESISTANCE mode. W SUP / W RES mark the bar where the weekly pivot was confirmed. Port of the TradingView script by BigBeluga, CC BY-NC-SA 4.0.'],
        ['Footprint', 'Inside each candle: sold × bought volume at every price row. Bold numbers are 3:1 diagonal imbalances. The yellow box is the candle’s POC; dotted yellow lines are naked POCs not yet revisited.'],
        ['Whales', 'Only the big participants. Pick how a whale is detected and the size floor; bubbles are summed per candle. Buyers’/sellers’ average shows where whales are in profit or loss.'],
        ['Vol profile', 'Volume traded at each price. POC = most traded price; value area = the 70% of volume around it. Price outside value is either being accepted (stays) or rejected (snaps back).'],
        ['TPO', 'Market profile: each 30-minute period prints a letter at every price it touched. Wide rows = accepted prices; thin single letters = fast, unfair prices. The purple bar is the initial balance.'],
        ['Gamma', 'From Deribit options open interest. Negative net gamma: dealers hedge with the move, so moves extend. Positive: they hedge against it, so ranges hold. Walls are strikes with the most gamma.'],
        ['L3 events', 'Order-level behaviour inferred from book changes: pulled orders, large adds, fills, icebergs (refilling hidden size), spoofing (same level pulled repeatedly) and layering (several levels pulled together).'],
        ['Futures', 'Funding (who pays to hold), open interest (new money in or out), basis (futures vs spot) and live liquidations from Bybit, plus a modelled map of where leveraged positions would be force-closed.'],
        ['Sentiment', 'About 30 readings each scored −100 (bearish) to +100 (bullish). The Decision panel weighs the fast order-flow ones; the consensus gauge is a plain average. They describe now, they do not predict.']]) +
      sec('Profile shapes', [
        ['Time spent at one level', 'The widest row is the POC — the market accepted that price the longest.'],
        ['Moving quickly through a level', 'Thin rows with one letter: price was rejected or ran through.'],
        ['Back inside value', 'Price leaves the value area, fails and returns — it often travels to the POC.'],
        ['Building above VAH', 'Letters stacking above the value area high show acceptance of higher prices.'],
        ['Building below VAL', 'Letters stacking below the value area low show acceptance of lower prices.'],
        ['Range extension', 'Trading outside the initial balance means one side took control after the open.'],
        ['Single prints', 'One-letter rows inside the range mark a fast move; they often get revisited.'],
        ['Poor high / low', 'Two or more periods stopping at the same extreme — an unfinished auction that tends to be retested.']]) +
      sec('Honest limits', [
        ['Mostly one exchange', 'Trades, the heatmap and the DOM are Binance spot. Walls are also checked against the Bybit and OKX spot books, and futures flow comes from the Bybit perpetual. Other venues trade too, so treat walls and whales as a sample of the market.'],
        ['The backtest covers candles only', 'The rules backtest in Trade plan → Scorecard replays only what candles can show. Order-book, futures, options and whale readings have no free history, so they are measured going forward by the signal journal instead.'],
        ['History starts when you open the page', 'Heatmap columns, L3 events and live whales are recorded in your browser only. Refreshing clears them. Candles and profiles load history from the exchange.'],
        ['Inference, not fact', 'Pulls, icebergs and spoofing are inferred from public data without order IDs. Liquidation clusters are a model. Use them as context.'],
        ['Not advice', 'Nothing here is a recommendation to trade.']]) + '</div>';
  },
  render() {}
};
})();

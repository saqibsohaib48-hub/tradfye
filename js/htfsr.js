/* HTF Support/Resistance + Weekly Bias Filter — JavaScript port of the TradingView (Pine v5) indicator.
   This work is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
   https://creativecommons.org/licenses/by-nc-sa/4.0/
   © BigBeluga (original) · Modified: Level 4 (weekly) bias filter · Ported to FlowDesk (same rules, same defaults).

   Rules, as in the Pine script:
   • Four levels, each a pivot high / pivot low on a higher timeframe (defaults 240 len 4, 720 len 5, D len 5, W len 5).
   • Non-repainting: a pivot only counts once the HTF candle `len` bars after it has CLOSED (the forming candle is ignored).
   • Only the latest pivot high and latest pivot low of each level are drawn, extended across the chart, with a wide
     transparent "shadow" line, a right-side label "<tf> Pivot High (price)" and a small marker on the most recent bar
     that touched the level.
   • Level 4 (weekly) sets the bias: a new weekly pivot low → SUPPORT mode, a new weekly pivot high → RESISTANCE mode.
     With the filter on, Levels 1–3 show only support lines in support mode and only resistance lines in resistance mode
     (both before the first signal). Level 4 always shows both.
   • "W SUP" / "W RES" signals on the bar where a new weekly pivot is confirmed, optional background tint, a status box,
     and an alert (pop-up) when a new weekly support or resistance is confirmed. */
(function () {
'use strict';
const OF = window.OF, LS = OF.LS, el = OF.el, ui = OF.ui;
const H = OF.htfsr = {};

/* Pine colour constants */
const PC = { green: '#4CAF50', blue: '#2962FF', purple: '#9C27B0', orange: '#FF9800', lime: '#00E676', red: '#FF5252' };
const TF = { '60': '1h', '240': '4h', '720': '12h', 'D': '1d', 'W': '1w' };          // Pine timeframe → candle set
const TFOPT = [['60', '1 hour'], ['240', '4 hours'], ['720', '12 hours'], ['D', '1 day'], ['W', '1 week']];
const DEF = {
  on: true,
  lv: [
    { on: true, len: 4, tf: '240', style: 'Solid', color: PC.green },
    { on: true, len: 5, tf: '720', style: 'Solid', color: PC.blue },
    { on: true, len: 5, tf: 'D', style: 'Solid', color: PC.purple },
    { on: true, len: 5, tf: 'W', style: 'Solid', color: PC.orange }
  ],
  useFilter: true, showSig: true, showBg: false, showTable: true, supCol: PC.lime, resCol: PC.red,
  sWidth: 5, sTnsp: 85, offset: 15, tSize: 'Small'
};
H.cfg = () => { const c = LS.get('htfsr', null); if (!c) return JSON.parse(JSON.stringify(DEF)); const o = Object.assign(JSON.parse(JSON.stringify(DEF)), c); o.lv = DEF.lv.map((d, i) => Object.assign({}, d, (c.lv || [])[i] || {})); return o; };
H.save = c => { LS.set('htfsr', c); H._cache = null; };

/* candles for a Pine timeframe, closed candles only (non-repainting) */
function closed(tf) {
  const S = OF.S, key = TF[tf]; let k;
  if (key === '1w') k = OF.loadWeekly(); else { k = S.k[key]; if (!k) { OF.loadKlines(key); return null; } }
  if (!k || !k.length) return null;
  const ms = key === '1w' ? 7 * 864e5 : OF.tfMs[key], now = OF.now();
  let n = k.length; while (n > 0 && k[n - 1].t + ms > now) n--;
  return { k: k.slice(0, n), ms };
}
/* ta.pivothigh / ta.pivotlow(len, len): centre higher (lower) than the `len` bars on each side.
   Each event carries the time it becomes known: the close of the candle `len` bars later. */
function pivotEvents(k, ms, len) {
  const hi = [], lo = [];
  for (let i = len; i < k.length - len; i++) {
    let h = true, l = true;
    for (let j = i - len; j <= i + len && (h || l); j++) {
      if (j === i) continue;
      if (j < i ? k[j].h >= k[i].h : k[j].h > k[i].h) h = false;
      if (j < i ? k[j].l <= k[i].l : k[j].l < k[i].l) l = false;
    }
    const at = k[i + len].t + ms;
    if (h) hi.push({ at, p: k[i].h, t: k[i].t });
    if (l) lo.push({ at, p: k[i].l, t: k[i].t });
  }
  // a "new" pivot is one whose value differs from the previous one (p_H != p_H[1])
  const dedupe = a => a.filter((e, i) => !i || e.p !== a[i - 1].p);
  return { hi: dedupe(hi), lo: dedupe(lo) };
}

/* everything the drawing needs, recalculated at most every 5 s */
H.calc = function () {
  const S = OF.S; if (!S || !S.info) return null;
  const c = H.cfg(), key = JSON.stringify(c) + S.symbol;
  if (H._cache && H._cache.key === key && Date.now() - H._cache.at < 5000) return H._cache;
  const levels = [];
  for (let i = 0; i < 4; i++) {
    const L = c.lv[i], d = closed(L.tf);
    if (!d || d.k.length < L.len * 2 + 2) { levels.push(null); continue; }
    const ev = pivotEvents(d.k, d.ms, L.len);
    levels.push({ i, L, ev, ph: ev.hi[ev.hi.length - 1] || null, pl: ev.lo[ev.lo.length - 1] || null });
  }
  // Level 4 bias, walked in time order exactly like the Pine `var int bias`
  let bias = 0; const sig = [];
  const w = levels[3];
  if (w) {
    const all = w.ev.hi.map(e => ({ at: e.at, p: e.p, h: 1 })).concat(w.ev.lo.map(e => ({ at: e.at, p: e.p, h: 0 }))).sort((a, b) => a.at - b.at);
    for (let j = 0; j < all.length; j++) {
      const both = (all[j + 1] && all[j + 1].at === all[j].at) || (all[j - 1] && all[j - 1].at === all[j].at);
      sig.push(all[j]);
      if (!both) bias = all[j].h ? -1 : 1;
    }
  }
  H._cache = { key, at: Date.now(), c, levels, bias, sig };
  H.alerts(H._cache);
  return H._cache;
};

/* alertcondition(): pop-up when a new weekly pivot is confirmed while the page is open */
H.alerts = function (r) {
  const w = r.levels[3]; if (!w) return;
  const k = 'htfsrSeen:' + OF.S.symbol, seen = LS.get(k, null), last = Math.max(w.ph ? w.ph.at : 0, w.pl ? w.pl.at : 0);
  if (seen == null) { LS.set(k, last); return; }        // first run: remember, do not alert on old signals
  if (last > seen) {
    LS.set(k, last);
    if (w.pl && w.pl.at === last) OF.notify('Level 4 Support Confirmed', 'Weekly support confirmed at ' + OF.fp(w.pl.p) + ' — Levels 1-3 now show SUPPORT only');
    if (w.ph && w.ph.at === last) OF.notify('Level 4 Resistance Confirmed', 'Weekly resistance confirmed at ' + OF.fp(w.ph.p) + ' — Levels 1-3 now show RESISTANCE only');
  }
};

const alpha = (hex, a) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex); return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex; };
const dash = s => s === 'Dashed' ? [7, 5] : s === 'Dotted' ? [2, 3] : [];
const fmt = p => String(Number(p.toFixed(1)));        // Pine "(#.#)"

/* Draw on a candle chart. g = { k, i0, end, X, Y, lo, hi, pw, bw, ms, top, bottom } (chart candles and mapping). */
H.draw = function (ctx, g) {
  const r = H.calc(); if (!r || !r.c.on) return;
  const c = r.c, showRes = !c.useFilter || r.bias !== 1, showSup = !c.useFilter || r.bias !== -1;
  const k = g.k, last = g.end - 1, top = g.top || 0, bottom = g.bottom;
  const barAt = t => { if (t < k[0].t) return -1; let lo = 0, hi = k.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (k[m].t <= t) lo = m; else hi = m - 1; } return lo; };
  ctx.save();
  // background tint by bias
  if (c.showBg && r.bias) { ctx.fillStyle = alpha(r.bias === 1 ? c.supCol : c.resCol, 0.08); ctx.fillRect(0, top, g.pw, bottom - top); }
  const fs = c.tSize === 'Tiny' ? 9.5 : c.tSize === 'Normal' ? 12 : 10.5;
  const labels = [];
  for (const lv of r.levels) {
    if (!lv || !lv.L.on) continue;
    const isW = lv.i === 3, sh = isW || showRes, sl = isW || showSup;
    for (const [e, kind, show] of [[lv.ph, 'High', sh], [lv.pl, 'Low', sl]]) {
      if (!e || !show) continue;
      const y = g.Y(e.p); if (y < top - 2 || y > bottom + 2) continue;
      // shadow + line, extended both ways
      ctx.strokeStyle = alpha(lv.L.color, 1 - c.sTnsp / 100); ctx.lineWidth = c.sWidth; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(g.pw, y); ctx.stroke();
      ctx.strokeStyle = lv.L.color; ctx.lineWidth = 1; ctx.setLineDash(dash(lv.L.style));
      ctx.beginPath(); ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(g.pw, Math.round(y) + .5); ctx.stroke(); ctx.setLineDash([]);
      // touch marker: most recent chart bar (before the current one) that touched the level
      for (let i = last - 1; i >= Math.max(0, last - 4000); i--) {
        const b = k[i];
        const hit = kind === 'High' ? (b.h * 1.0009 >= e.p && b.h * 0.9999 <= e.p) : (b.l * 1.0009 >= e.p && b.l * 0.999 <= e.p);
        if (!hit) continue;
        if (i >= g.i0) {
          const x = g.X(i); ctx.fillStyle = lv.L.color; ctx.beginPath();
          if (kind === 'High') { ctx.moveTo(x - 4, y - 9); ctx.lineTo(x + 4, y - 9); ctx.lineTo(x, y - 2); } else { ctx.moveTo(x - 4, y + 9); ctx.lineTo(x + 4, y + 9); ctx.lineTo(x, y + 2); }
          ctx.closePath(); ctx.fill();
        }
        break;
      }
      labels.push({ y, text: `${lv.L.tf} Pivot ${kind} (${fmt(e.p)})`, col: lv.L.color });
    }
  }
  // labels to the right of the last bar (bar_index + offset), pushed apart if they overlap
  ctx.font = `600 ${fs}px Inter,system-ui,sans-serif`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  labels.sort((a, b) => a.y - b.y);
  let prev = -1e9;
  for (const L of labels) {
    const w = ctx.measureText(L.text).width + 12, hgt = fs + 7;
    let x = g.X(last) + c.offset * g.bw; x = Math.min(x, g.pw - w - 2); x = Math.max(4, x);
    let y = Math.max(L.y, prev + hgt + 1); prev = y;
    ctx.fillStyle = 'rgba(12,6,26,.92)'; ctx.strokeStyle = L.col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - 6, L.y); ctx.lineTo(x, y - hgt / 2); ctx.lineTo(x + w, y - hgt / 2); ctx.lineTo(x + w, y + hgt / 2); ctx.lineTo(x, y + hgt / 2); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#f5ecff'; ctx.fillText(L.text, x + 6, y + .5);
  }
  // W SUP / W RES signals on the bar where the weekly pivot is confirmed
  if (c.showSig) {
    ctx.font = `700 ${Math.max(9.5, fs - .5)}px Inter,system-ui,sans-serif`; ctx.textAlign = 'center';
    for (const s of r.sig) {
      const i = barAt(s.at); if (i < g.i0 || i > last) continue;
      const b = k[i], x = g.X(i), col = s.h ? c.resCol : c.supCol, txt = s.h ? 'W RES' : 'W SUP', w = ctx.measureText(txt).width + 10, hgt = 16;
      const y = s.h ? g.Y(b.h) - 8 - hgt : g.Y(b.l) + 8;
      ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(x - w / 2, y, w, hgt, 3); ctx.fill();
      ctx.beginPath(); if (s.h) { ctx.moveTo(x - 4, y + hgt); ctx.lineTo(x + 4, y + hgt); ctx.lineTo(x, y + hgt + 5); } else { ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.lineTo(x, y - 5); } ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(txt, x, y + hgt / 2 + .5);
    }
  }
  // status box (top right)
  if (c.showTable) {
    const tfw = c.lv[3].tf, txt = r.bias === 1 ? `L4 ${tfw}: SUPPORT mode` : r.bias === -1 ? `L4 ${tfw}: RESISTANCE mode` : `L4 ${tfw}: no signal yet`;
    const col = r.bias === 1 ? c.supCol : r.bias === -1 ? c.resCol : '#787B86';
    ctx.font = '700 11.5px Inter,system-ui,sans-serif'; ctx.textAlign = 'left';
    const w = ctx.measureText(txt).width + 18, x = g.pw - w - 8, y = top + 8;
    ctx.fillStyle = alpha(col, 0.8); ctx.beginPath(); ctx.roundRect(x, y, w, 22, 6); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(txt, x + 9, y + 11.5);
  }
  ctx.restore();
};

/* settings popover (same inputs as the Pine script) */
H.panel = function (anchor, onChange) {
  let pop = document.getElementById('htfPop'); if (pop) { pop.remove(); return; }
  const c = H.cfg();
  pop = el('div', 'colspop htfpop'); pop.id = 'htfPop';
  const r = anchor.getBoundingClientRect(); pop.style.top = (r.bottom + 8) + 'px'; pop.style.left = Math.max(8, Math.min(window.innerWidth - 470, r.left - 120)) + 'px';
  const opt = (list, v) => list.map(([a, b]) => `<option value="${a}"${String(a) === String(v) ? ' selected' : ''}>${b}</option>`).join('');
  pop.innerHTML = `<div class="cph">HTF Support / Resistance · Weekly Bias <button class="cpx">✕</button></div>
    <div class="htfgrp">${c.lv.map((L, i) => `<div class="htfrow" data-i="${i}"><label class="ck"><input type="checkbox" data-f="on" ${L.on ? 'checked' : ''}> <b>Levels ${i + 1}</b></label>
      <input type="number" min="1" max="50" data-f="len" value="${L.len}" title="Pivot length"><select data-f="tf">${opt(TFOPT, L.tf)}</select>
      <select data-f="style">${opt([['Solid', 'Solid'], ['Dashed', 'Dashed'], ['Dotted', 'Dotted']], L.style)}</select><input type="color" data-f="color" value="${L.color}"></div>`).join('')}</div>
    <div class="htfsec">Level 4 Bias Filter</div>
    <label class="vrow"><input type="checkbox" data-g="useFilter" ${c.useFilter ? 'checked' : ''}> Filter Levels 1-3 by Level 4 signal</label>
    <label class="vrow"><input type="checkbox" data-g="showSig" ${c.showSig ? 'checked' : ''}> Show Level 4 signals on chart</label>
    <label class="vrow"><input type="checkbox" data-g="showBg" ${c.showBg ? 'checked' : ''}> Tint background by bias</label>
    <label class="vrow"><input type="checkbox" data-g="showTable" ${c.showTable ? 'checked' : ''}> Show bias status box</label>
    <div class="htfline"><span>Support</span><input type="color" data-g="supCol" value="${c.supCol}"><span>Resistance</span><input type="color" data-g="resCol" value="${c.resCol}"></div>
    <div class="htfsec">Shadow · Labels</div>
    <div class="htfline"><span>Levels width</span><input type="number" min="1" max="20" data-g="sWidth" value="${c.sWidth}"><span>Transparent</span><input type="number" min="0" max="100" data-g="sTnsp" value="${c.sTnsp}"></div>
    <div class="htfline"><span>Offset</span><input type="number" min="0" max="100" data-g="offset" value="${c.offset}"><span>Size</span><select data-g="tSize">${opt([['Tiny', 'Tiny'], ['Small', 'Small'], ['Normal', 'Normal']], c.tSize)}</select></div>
    <div class="vbtns"><button data-a="reset">Reset to defaults</button></div>
    <div class="muted sm" style="margin-top:8px">Port of “HTF Support/Resistance + Weekly Bias Filter” · © BigBeluga · CC BY-NC-SA 4.0</div>`;
  const read = () => {
    const n = H.cfg();
    pop.querySelectorAll('.htfrow').forEach(row => { const i = +row.dataset.i; row.querySelectorAll('[data-f]').forEach(inp => { const f = inp.dataset.f; n.lv[i][f] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Math.max(1, +inp.value || 1) : inp.value; }); });
    pop.querySelectorAll('[data-g]').forEach(inp => { const f = inp.dataset.g; n[f] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? +inp.value : inp.value; });
    H.save(n); onChange && onChange();
  };
  pop.querySelectorAll('input,select').forEach(i => { i.onchange = read; if (i.type === 'color' || i.type === 'number') i.oninput = read; });
  pop.querySelector('.cpx').onclick = () => pop.remove();
  pop.querySelector('[data-a=reset]').onclick = () => { const on = H.cfg().on; const d = JSON.parse(JSON.stringify(DEF)); d.on = on; H.save(d); pop.remove(); H.panel(anchor, onChange); onChange && onChange(); };
  document.body.appendChild(pop);
  setTimeout(() => document.addEventListener('pointerdown', function f(e) { if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('pointerdown', f); } }), 0);
};
H.toggle = on => { const c = H.cfg(); c.on = on; H.save(c); };

// keep the HTF candles loaded and check for new weekly signals even when the chart is not open
setInterval(() => { try { if (OF.S && OF.S.info && H.cfg().on) { H._cache = null; H.calc(); } } catch (e) { console.error(e); } }, 60000);
OF.on('info', () => { H._cache = null; ['4h', '12h', '1d'].forEach(t => OF.loadKlines(t)); OF.loadWeekly && OF.loadWeekly(); });
})();

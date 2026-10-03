/** Horloge Betclic, fenêtres de temps et montants. Pur, sans DOM. */
(function (root) {
  const norm = (s) => String(s == null ? '' : s).replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
  const PERIOD_END = { 'MT 1': 2700, 'MT 2': 5400 };

  function parseClock(text) {
    const t = norm(text);
    const out = { elapsedSec: null, remainingSec: null, period: null, running: false };
    const p = t.match(/\bMT\s*([12])\b/i) || null;
    const q = t.match(/\bQ\s*([1-4])\b/i);
    if (p && !/^fin\b/i.test(t)) out.period = `MT ${p[1]}`;
    else if (q && !/^fin\b/i.test(t)) out.period = `Q${q[1]}`;
    const add = t.match(/(\d+)\s*\+\s*(\d+)\s*['\u2019\u2032]/);
    const min = t.match(/(\d+)\s*['\u2019\u2032]/);
    const cd = t.match(/(\d+):(\d{2})/);
    if (add) out.elapsedSec = (+add[1] + +add[2]) * 60;
    else if (min) out.elapsedSec = +min[1] * 60;
    else if (cd) out.remainingSec = +cd[1] * 60 + +cd[2];
    out.running = out.elapsedSec !== null || out.remainingSec !== null;
    return out;
  }

  function parseWindow(text) {
    const m = norm(text).match(/(\d+):(\d{2})\s*[-–—]\s*(\d+):(\d{2})/);
    if (!m) return null;
    const w = { startSec: +m[1] * 60 + +m[2], endSec: +m[3] * 60 + +m[4] };
    return w.startSec > w.endSec ? null : w;
  }

  function leadSeconds(clock, win) {
    if (!clock || !clock.running) return null;
    if (win) return clock.elapsedSec !== null ? win.startSec - clock.elapsedSec : null;
    if (clock.remainingSec !== null) return clock.remainingSec;
    const end = PERIOD_END[clock.period];
    return end !== undefined && clock.elapsedSec !== null ? end - clock.elapsedSec : null;
  }

  function parseMoney(text) {
    const n = norm(text);
    if (n.includes('.')) return null;
    const m = n.replace(/ /g, '').match(/(\d+(?:[.,]\d+)?)/);
    if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  }

  const api = { parseClock, parseWindow, leadSeconds, parseMoney };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Clock = api;
})(globalThis);

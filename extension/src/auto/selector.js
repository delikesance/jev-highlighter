/** Sélection d'événement et de paris (spec §3/§4). Fonctions pures : aucun clic, aucun événement DOM. */
(function (root) {
  const SPORTS = ['football', 'basketball'];
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const norm = (s) =>
    String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const asList = (m) => (m instanceof Map ? [...m.values()] : Array.isArray(m) ? m : []);

  function pickEvent(events, tried, quickCount) {
    if (!Array.isArray(events) || typeof quickCount !== 'function') return null;
    const seen = tried instanceof Set ? tried : new Set();
    const rows = [];
    for (const e of events) {
      if (!e || typeof e !== 'object' || e.mainSuspended || !SPORTS.includes(e.sport)) continue;
      if (!e.clock || e.clock.running !== true || seen.has(e.href)) continue;
      const n = quickCount(e);
      if (!isNum(n) || n <= 0) continue;
      rows.push({ e, n, t: isNum(e.clock.elapsedSec) ? e.clock.elapsedSec : Infinity, i: isNum(e.index) ? e.index : Infinity });
    }
    rows.sort((a, b) => b.n - a.n || (a.t === b.t ? 0 : a.t < b.t ? -1 : 1) || (a.i === b.i ? 0 : a.i < b.i ? -1 : 1));
    return rows.length ? rows[0].e : null;
  }

  function quickMarkets(markets, sport, cfg) {
    const pats = cfg && cfg.quickMarkets && Object.prototype.hasOwnProperty.call(cfg.quickMarkets, sport)
      ? cfg.quickMarkets[sport] : null;
    if (!Array.isArray(pats) || !pats.length) return [];
    return asList(markets).filter((m) => {
      if (!m || typeof m.title !== 'string') return false;
      const raw = m.title.toLowerCase();
      const n = norm(m.title);
      return pats.some((p) => {
        if (p instanceof RegExp) { p.lastIndex = 0; const a = p.test(raw); p.lastIndex = 0; return a || p.test(n); }
        return typeof p === 'string' && p !== '' && n.includes(norm(p));
      });
    });
  }

  // `sport` (4e paramètre) OBLIGATOIRE : l'appelant doit passer `event.sport`.
  // Sans sport (ou sport inconnu) : aucun pari (fail-closed).
  function pickSelections(answers, markets, cfg, sport) {
    if (!Array.isArray(answers) || !cfg || typeof sport !== 'string' || !SPORTS.includes(sport)) return [];
    const allowed = new Map(quickMarkets(markets, sport, cfg).map((m) => [m.id, m]));
    const out = [];
    const done = new Set();
    for (const a of answers) {
      if (!a || typeof a !== 'object' || typeof a.marketId !== 'string' || typeof a.choice !== 'string') continue;
      const m = allowed.get(a.marketId);
      if (done.has(a.marketId)) continue;
      if (!m || !Array.isArray(m.options)) continue;
      if (!isNum(a.confidence) || !isNum(cfg.minConfidence) || a.confidence < cfg.minConfidence) continue;
      const want = norm(a.choice);
      const o = m.options.find((x) => x && norm(x.name) === want);
      if (!o || o.available === false || !isNum(o.odds)) continue;
      if (!isNum(cfg.minOdds) || !isNum(cfg.maxOdds) || o.odds < cfg.minOdds || o.odds > cfg.maxOdds) continue;
      done.add(a.marketId);
      out.push({ marketId: m.id, label: o.name, odds: o.odds, confidence: a.confidence, window: m.window == null ? null : m.window });
    }
    return out;
  }

  const api = { pickEvent, quickMarkets, pickSelections };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Selector = api;
})(globalThis);

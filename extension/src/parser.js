/**
 * Parser DOM -> marchés internes. Les références DOM (`element`) restent côté extension.
 */
(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const J = isNode ? Object.assign({}, require('./config'), require('./utils')) : root.JEV;
  const { CONFIG, cleanText, normalizeText, slugify, hash, parseOdds, warn } = J;
  const S = CONFIG.selectors;

  const textOf = (el) => (el ? cleanText(el.textContent) : '');

  function isUnavailable(line, button, suspended) {
    if (suspended) return true;
    if (line.closest(S.strikethrough) || line.querySelector(S.strikethrough)) return true;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  function parseMarketBox(container) {
    const box = container.matches(S.marketBox) ? container : container.querySelector(S.marketBox) || container;
    const title = textOf(box.querySelector(S.titleText) || box.querySelector(S.title));
    if (!title) return { skip: 'no-title' };

    const suspended = !!(box.closest(S.suspended) || box.querySelector(S.suspended));
    const options = [];
    const seen = new Map();
    for (const line of box.querySelectorAll(S.line)) {
      const name = textOf(line.querySelector(S.label));
      const button = line.querySelector(S.button);
      if (!name || !button) continue; // option sans nom ou sans bouton : non highlightable
      const oddsText = textOf(button.querySelector(S.odds) || button);
      const odds = parseOdds(oddsText);
      // clé unique par marché (deux options homonymes ne doivent pas se confondre)
      const n = (seen.get(normalizeText(name)) || 0) + 1;
      seen.set(normalizeText(name), n);
      const key = n === 1 ? name : `${name} (${n})`;
      options.push({
        name,
        key,
        normalizedKey: normalizeText(key),
        odds,
        oddsText,
        available: odds != null && !isUnavailable(line, button, suspended),
        element: button
      });
    }
    if (!options.length) return { skip: 'no-options' };

    const fingerprint = hash(
      [title, ...options.map((o) => `${o.key}:${o.odds}:${o.available ? 1 : 0}`)].join('|')
    );
    return { market: { title, options, suspended, fingerprint, element: box } };
  }

  /**
   * @returns {{markets: Map<string, object>, list: object[], fingerprint: string, stats: object}}
   */
  function parseMarkets(doc) {
    const rootNode = doc || document;
    let containers = [...rootNode.querySelectorAll(S.market)];
    if (!containers.length) containers = [...rootNode.querySelectorAll(S.marketBox)];

    const markets = new Map();
    const skipped = [];
    for (const c of containers) {
      const r = parseMarketBox(c);
      if (r.skip) {
        skipped.push(r.skip);
        warn(`market skipped (${r.skip})`);
        continue;
      }
      const m = r.market;
      // ID déterministe depuis le titre ; en cas de doublon : empreinte des options, puis compteur.
      let id = slugify(m.title);
      if (markets.has(id)) id = `${id}_${hash(m.options.map((o) => o.key).join('|')).slice(0, 4)}`;
      for (let i = 2; markets.has(id); i++) id = `${id.replace(/_\d+$/, '')}_${i}`;
      m.id = id;
      markets.set(id, m);
    }

    const list = [...markets.values()];
    const selections = list.reduce((n, m) => n + m.options.length, 0);
    const available = list.reduce((n, m) => n + m.options.filter((o) => o.available).length, 0);
    return {
      markets,
      list,
      fingerprint: hash(list.map((m) => `${m.id}:${m.fingerprint}`).join('\n')),
      stats: {
        markets: list.length,
        selections,
        availableSelections: available,
        skipped: skipped.length
      }
    };
  }

  const api = { parseMarkets };
  if (isNode) module.exports = api;
  else Object.assign(root.JEV, api);
})(globalThis);

/**
 * Matching réponse JEV -> marché/option DOM.
 * `jevScore` = poids/préférence donné par JEV, PAS une probabilité réelle. Aucun calcul d'EV.
 */
(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const J = isNode ? Object.assign({}, require('./config'), require('./utils'), require('./jev')) : root.JEV;
  const { CONFIG, normalizeText, warn, findYesNo } = J;

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  /** Lookup normalisé dans un objet { nom: valeur }. */
  function lookupNormalized(obj, name) {
    if (!obj || typeof obj !== 'object') return undefined;
    const target = normalizeText(name);
    for (const [k, v] of Object.entries(obj)) if (normalizeText(k) === target) return v;
    return undefined;
  }

  /** Résout une réponse en { option, score, confidence, probabilities } ou { reason }. */
  function resolveAnswer(market, answer) {
    if (!answer || typeof answer !== 'object') return { reason: 'invalid-answer' };

    if (answer.type === 'noul') {
      const yn = findYesNo(market);
      if (!yn || !isNum(answer.noul)) return { reason: 'invalid-noul' };
      const yesWins = answer.noul >= 0.5;
      return {
        option: yesWins ? yn.yes : yn.no,
        score: yesWins ? answer.noul : 1 - answer.noul,
        confidence: isNum(answer.confidence) ? answer.confidence : null,
        probabilities: { [yn.yes.key]: answer.noul, [yn.no.key]: 1 - answer.noul }
      };
    }

    if (typeof answer.choice !== 'string') return { reason: 'invalid-answer' };
    const wanted = normalizeText(answer.choice);
    const option = market.options.find((o) => o.normalizedKey === wanted);
    if (!option) return { reason: 'choice-not-in-dom' };
    const p = lookupNormalized(answer.probabilities, answer.choice);
    return {
      option,
      score: isNum(p) ? p : null,
      confidence: isNum(answer.confidence) ? answer.confidence : null,
      probabilities: answer.probabilities || {}
    };
  }

  /**
   * @param {Map<string, object>} markets marchés FRAIS (éléments DOM actuels)
   * @param {object} answers  `answers` de la réponse JEV
   * @param {{expectedIds?: string[], minScore?: number}} opts
   */
  function matchAnswers(markets, answers, opts = {}) {
    const minScore = opts.minScore ?? CONFIG.minScore;
    const recommendations = [];
    const unmatched = [];

    for (const [marketId, answer] of Object.entries(answers || {})) {
      const market = markets.get(marketId);
      if (!market) {
        unmatched.push({ marketId, reason: 'market-gone' });
        continue;
      }
      const r = resolveAnswer(market, answer);
      if (r.reason) {
        unmatched.push({ marketId, reason: r.reason });
        continue;
      }
      if (!r.option.available) {
        unmatched.push({ marketId, reason: 'option-unavailable' });
        continue;
      }
      if (isNum(r.score) && r.score < minScore) {
        unmatched.push({ marketId, reason: 'below-threshold' });
        continue;
      }
      recommendations.push({
        marketId,
        marketTitle: market.title,
        choice: r.option.name,
        jevScore: r.score,
        confidence: r.confidence,
        odds: r.option.odds,
        oddsText: r.option.oddsText,
        probabilities: r.probabilities,
        // poids JEV de toutes les options disponibles du marché (pour la carte de survol)
        distribution: market.options
          .filter((o) => o.available)
          .map((o) => {
            const v = lookupNormalized(r.probabilities, o.key);
            return { name: o.name, score: isNum(v) ? v : null };
          }),
        element: r.option.element,
        container: market.container
      });
    }
    for (const id of opts.expectedIds || []) {
      if (!(answers && id in answers) && markets.has(id)) unmatched.push({ marketId: id, reason: 'missing-answer' });
    }
    for (const u of unmatched) warn(`${u.marketId}: ${u.reason}`);

    // Meilleur pari global : plus haut score JEV parmi les sélections disponibles.
    let best = null;
    for (const rec of recommendations) {
      if (!isNum(rec.jevScore)) continue;
      if (
        !best ||
        rec.jevScore > best.jevScore ||
        (rec.jevScore === best.jevScore && (rec.confidence ?? 0) > (best.confidence ?? 0))
      )
        best = rec;
    }
    return { recommendations, best, unmatched };
  }

  /** Version sérialisable (sans DOM) pour le popup. */
  function toPlain(rec) {
    if (!rec) return null;
    const { element, container, ...rest } = rec;
    return rest;
  }

  const api = { matchAnswers, resolveAnswer, toPlain };
  if (isNode) module.exports = api;
  else Object.assign(root.JEV, api);
})(globalThis);

/** Générateur de requête JEV (pur, utilisé côté content). Le client HTTP vit dans transport.js. */
(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const J = isNode ? Object.assign({}, require('./config'), require('./utils')) : root.JEV;
  const { CONFIG, normalizeText } = J;

  // ---------------------------------------------------------------- construction de la requête

  /** Si le marché a exactement deux options disponibles Oui/Non, renvoie { yes, no }. */
  function findYesNo(market) {
    const avail = market.options.filter((o) => o.available);
    if (avail.length !== 2) return null;
    const yes = avail.find((o) => CONFIG.yesNames.includes(o.normalizedKey));
    const no = avail.find((o) => CONFIG.noNames.includes(o.normalizedKey));
    return yes && no ? { yes, no } : null;
  }

  /** Question JEV pour un marché, ou null si non évaluable (< 2 options disponibles). */
  function buildQuestion(market) {
    const avail = market.options.filter((o) => o.available);
    if (avail.length < 2) return null;
    const T = CONFIG.templates;

    const yn = CONFIG.useNoulForYesNo ? findYesNo(market) : null;
    if (yn) {
      return {
        type: 'noul',
        instructions: T.instructions(market.title),
        criteria: {
          true: T.criterion(market.title, yn.yes.name),
          false: T.criterion(market.title, yn.no.name)
        }
      };
    }
    const criteria = {};
    for (const o of avail) criteria[o.key] = T.criterion(market.title, o.name);
    return { type: 'choice', instructions: T.instructions(market.title), criteria };
  }

  /**
   * Construit le corps de requête. Aucune référence DOM n'y figure (strings/numbers uniquement).
   * @returns {{body: object, questionCount: number, sentIds: string[]}}
   */
  function buildRequest(parsed, ctx = {}) {
    const questions = {};
    for (const m of parsed.list) {
      const q = buildQuestion(m);
      if (q) questions[m.id] = q;
    }
    const body = {
      state: {
        source: 'bookmaker_page',
        page_title: ctx.pageTitle || '',
        page_path: ctx.pagePath || '',
        ...(ctx.matchContext ? { match_context: ctx.matchContext } : {})
      },
      questions
    };
    if (CONFIG.JEV.model) body.model = CONFIG.JEV.model;
    const sentIds = Object.keys(questions);
    return { body, questionCount: sentIds.length, sentIds };
  }

  // ---------------------------------------------------------------- erreurs

  class JevError extends Error {
    constructor(code, message, extra = {}) {
      super(message);
      this.name = 'JevError';
      this.code = code;
      Object.assign(this, extra);
    }
  }

  const api = { findYesNo, buildQuestion, buildRequest, JevError };
  if (isNode) module.exports = api;
  else Object.assign(root.JEV, api);
})(globalThis);

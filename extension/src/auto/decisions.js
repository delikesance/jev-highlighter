/** Décisions Auto : live et sélection ici (objectif profit) ; mise via suggestStake sur le ticket ouvert. */
(function (root) {
  const MAX_OPTIONS = 250; // limite d'une question `choice` : 255 options
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const pct = (odds) => Math.round((1000 / odds)) / 10;

  const GOAL = 'Tu gères une bankroll et ton seul objectif est de la faire croître. ';

  // Aucune option « ne rien choisir » : JEV désigne toujours une ligne tant qu'il en existe au moins une.
  async function decide(task, id, rows, instructions, ask, state) {
    if (!rows.length) return null;
    const list = rows.slice(0, MAX_OPTIONS);
    const criteria = Object.fromEntries(list.map((r) => [r.key, r.description]));
    const answers = await ask({ state: { task, ...state }, questions: { [id]: { type: 'choice', instructions, criteria } } });
    const answer = answers && answers[id];
    if (!answer || typeof answer.choice !== 'string') throw new Error('Réponse JEV Auto absente ou invalide');
    const row = list.find((r) => r.key === answer.choice);
    if (!row) throw new Error('Choix JEV Auto inconnu');
    return { row, answer };
  }

  const mainOdds = (event) => (Array.isArray(event.mainOdds) ? event.mainOdds : null);

  async function chooseEvent(events, ask, context) {
    const rows = events.map((event, i) => ({ key: `live_${i}`, value: event,
      description: `${event.name} (${event.sport}), score ${JSON.stringify(event.score)}, horloge ${JSON.stringify(event.clock)} : ce live offre l’occasion de profit la plus intéressante.` }));
    const result = await decide('auto_choose_live', 'auto_live', rows,
      GOAL + 'Choisis obligatoirement le live visible où il est le plus utile d’aller chercher un pari rentable, d’après le score, la minute, l’équilibre des cotes principales et la situation de la session. ' +
      'Utilise uniquement les informations fournies. Le choix du live ne place aucun pari.', ask,
      { events: rows.map((r) => ({ id: r.key, name: r.value.name, sport: r.value.sport, score: r.value.score, clock: r.value.clock, main_odds: mainOdds(r.value) })),
        ...(context && context.session ? { session: context.session } : {}) });
    return result ? result.row.value : null;
  }

  /** Marge du bookmaker du marché en % (somme des probabilités implicites − 100), ou null si non calculable. */
  function marketMargin(market) {
    const odds = (market.options || []).filter((o) => o.available && isNum(o.odds) && o.odds > 1).map((o) => o.odds);
    if (odds.length < 2) return null;
    return Math.round((odds.reduce((s, o) => s + 1 / o, 0) - 1) * 1000) / 10;
  }

  // `bounds` { minOdds, maxOdds } : seules les cotes que le guard peut accepter sont proposées, sinon le pari choisi serait refusé après coup.
  async function choosePick(markets, context, ask, bounds) {
    const lo = bounds && isNum(bounds.minOdds) ? bounds.minOdds : 1;
    const hi = bounds && isNum(bounds.maxOdds) ? bounds.maxOdds : Infinity;
    const rows = [];
    for (const market of markets) {
      const margin = marketMargin(market);
      for (const option of market.options || []) {
        if (!option.available || !Number.isFinite(option.odds) || option.odds <= 1) continue;
        if (option.odds < lo || option.odds > hi) continue;
        const value = { marketId: market.id, marketTitle: market.title, choice: option.name, odds: option.odds, window: market.window || null };
        rows.push({ key: `pick_${rows.length}`, value, margin,
          description: `${market.title}${market.window ? ' (' + market.window + ')' : ''} : ${option.name}, cote ${option.odds} (probabilité implicite ${pct(option.odds)} %) : c’est le meilleur pari pour gagner de l’argent.` });
      }
    }
    const result = await decide('auto_choose_bet', 'auto_pick', rows,
      GOAL + 'Un pari doit être placé sur ce live : choisis obligatoirement la sélection au meilleur profit attendu, celle dont la cote paie le plus par rapport au risque réel compte tenu du score, de la minute, des statistiques et du contexte du match. ' +
      'Une cote basse n’est pas un avantage en soi : ne retiens pas le résultat le plus probable s’il est déjà payé à son prix, ni une grosse cote sans raison concrète. ' +
      'La probabilité implicite est ce que la cote suppose ; la marge du marché est le coût que le bookmaker prélève. Aucun gain n’est garanti.', ask,
      { ...context, selections: rows.slice(0, MAX_OPTIONS).map((r) => ({ id: r.key, ...r.value, implied_probability_pct: pct(r.value.odds), market_margin_pct: r.margin })) });
    if (!result) return [];
    const a = result.answer;
    return [{ ...result.row.value, confidence: Number.isFinite(a.confidence) ? a.confidence : null,
      jevScore: a.probabilities && Number.isFinite(a.probabilities[result.row.key]) ? a.probabilities[result.row.key] : null }];
  }
  const api = { chooseEvent, choosePick, marketMargin };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Decisions = api;
})(globalThis);

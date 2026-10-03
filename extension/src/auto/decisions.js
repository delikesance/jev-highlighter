/** Trois décisions Auto : live et sélection ici ; mise via suggestStake sur le ticket ouvert. */
(function (root) {
  async function decide(task, id, rows, instructions, ask, state) {
    if (!rows.length) return null;
    const criteria = Object.fromEntries(rows.map((r) => [r.key, r.description]));
    criteria.none = 'Aucun choix actuellement pertinent : attendre et réexaminer.';
    const answers = await ask({ state: { task, ...state }, questions: { [id]: { type: 'choice', instructions, criteria } } });
    const answer = answers && answers[id];
    if (!answer || typeof answer.choice !== 'string') throw new Error('Réponse JEV Auto absente ou invalide');
    if (answer.choice === 'none') return null;
    const row = rows.find((r) => r.key === answer.choice);
    if (!row) throw new Error('Choix JEV Auto inconnu');
    return { row, answer };
  }

  async function chooseEvent(events, ask) {
    const rows = events.map((event, i) => ({ key: `live_${i}`, value: event,
      description: `${event.name} (${event.sport}), score ${JSON.stringify(event.score)}, horloge ${JSON.stringify(event.clock)}` }));
    const result = await decide('auto_choose_live', 'auto_live', rows,
      'Choisis le live visible le plus pertinent à examiner pour trouver un pari. Utilise uniquement les informations fournies. Le choix du live ne place aucun pari.', ask,
      { events: rows.map((r) => ({ id: r.key, name: r.value.name, sport: r.value.sport, score: r.value.score, clock: r.value.clock })) });
    return result ? result.row.value : null;
  }

  async function choosePick(markets, context, ask) {
    const rows = [];
    for (const market of markets) for (const option of market.options || []) {
      if (!option.available || !Number.isFinite(option.odds) || option.odds <= 1) continue;
      const value = { marketId: market.id, marketTitle: market.title, choice: option.name, odds: option.odds, window: market.window || null };
      rows.push({ key: `pick_${rows.length}`, value, description: `${market.title}${market.window ? ' (' + market.window + ')' : ''} : ${option.name}, cote ${option.odds}` });
    }
    const result = await decide('auto_choose_bet', 'auto_pick', rows,
      'Choisis une seule sélection parmi les marchés de ce live : celle que tu préfères compte tenu du contexte, de la cote et de l’incertitude. Les cotes et préférences ne garantissent aucun gain. Ne choisis aucune sélection si les informations sont insuffisantes.', ask,
      { ...context, selections: rows.map((r) => ({ id: r.key, ...r.value })) });
    if (!result) return [];
    const a = result.answer;
    return [{ ...result.row.value, confidence: Number.isFinite(a.confidence) ? a.confidence : null,
      jevScore: a.probabilities && Number.isFinite(a.probabilities[result.row.key]) ? a.probabilities[result.row.key] : null }];
  }
  const api = { chooseEvent, choosePick };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Decisions = api;
})(globalThis);

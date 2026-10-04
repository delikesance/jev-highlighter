/**
 * Suggestion de mise. Lecture du solde + du ticket de pari, puis affinage par tranches successives :
 * JEV choisit une tranche parmi plusieurs (ex. 0-1 €, 1-2 €, …), puis on redécoupe la tranche choisie, etc.
 * Pur (aucun accès réseau ici : `ask` est injecté). L'extension ne remplit jamais le champ de mise.
 */
(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const J = isNode ? Object.assign({}, require('./config'), require('./utils')) : root.JEV;
  const { CONFIG, cleanText, normalizeText, parseOdds, hash } = J;

  const NONE_KEY = 'Ne pas miser';
  const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const r2 = (x) => Math.round(x * 100) / 100;
  const fmtMoney = (x) => r2(x).toFixed(2).replace('.', ',');
  const text = (el) => (el ? cleanText(el.textContent) : '');

  // ------------------------------------------------------------------ lecture du DOM

  function readWallet(doc) {
    const el = doc.querySelector(CONFIG.selectors.wallet);
    return el ? parseOdds(el.textContent) : null; // "5,90 €" -> 5.9 ; 0 -> null (rien à miser)
  }

  function readSlip(doc) {
    const S = CONFIG.selectors.slip;
    const selections = [...doc.querySelectorAll(S.card)]
      .map((c) => ({
        event: text(c.querySelector(S.event)),
        selection: text(c.querySelector(S.label)),
        market: text(c.querySelector(S.market)),
        odds: parseOdds(text(c.querySelector(S.odds)))
      }))
      .filter((s) => s.selection && s.odds);
    const footerOdds = parseOdds(text(doc.querySelector(S.footerOdds)));
    const product = selections.reduce((p, s) => p * s.odds, 1);
    return {
      selections,
      totalOdds: footerOdds || (selections.length ? r2(product) : null),
      stakeInput: doc.querySelector(S.stakeInput)
    };
  }

  function slipFingerprint(wallet, slip) {
    return hash(JSON.stringify([wallet, slip.totalOdds, slip.selections]));
  }

  // ------------------------------------------------------------------ tranches

  function niceStep(range, cells) {
    const raw = range / cells;
    return STEPS.find((s) => s >= raw - 1e-9) || STEPS[STEPS.length - 1];
  }

  /** Découpe [lo, hi] en ≤ `cells` tranches de largeur « ronde ». */
  function buildLadder(lo, hi, cells) {
    if (hi - lo <= 0.0099) return [{ lo, hi, key: `${fmtMoney(lo)} à ${fmtMoney(hi)} €` }];
    const step = niceStep(hi - lo, cells);
    const out = [];
    for (let a = lo; a < hi - 1e-9; a = r2(a + step)) {
      const b = Math.min(r2(a + step), hi);
      out.push({ lo: a, hi: b, key: `${fmtMoney(a)} à ${fmtMoney(b)} €` });
    }
    return out;
  }

  function buildStakeBody(ctx, cells, { round, lo, hi, includeNone, previous, mandatory }) {
    const criteria = {};
    if (includeNone) criteria[NONE_KEY] = 'Il vaut mieux ne rien miser sur ce pari.';
    for (const c of cells)
      criteria[c.key] = `La mise raisonnable est comprise entre ${fmtMoney(c.lo)} € et ${fmtMoney(c.hi)} €.`;

    const body = {
      state: {
        task: 'stake_sizing',
        currency: 'EUR',
        wallet_eur: ctx.wallet,
        total_odds: ctx.totalOdds,
        selections: ctx.selections,
        ...(ctx.matchContext ? { match_context: ctx.matchContext } : {}),
        stake_range_eur: [lo, hi],
        round,
        previous_choice: previous || null
      },
      questions: {
        [`stake_round_${round}`]: {
          type: 'choice',
          instructions:
            `Tu gères une bankroll et ton objectif est de la faire croître sur la durée. Solde disponible : ${fmtMoney(ctx.wallet)} €. ` +
            `Cote totale du ticket : ${ctx.totalOdds}. Quelle tranche de mise est la plus raisonnable pour ce pari, compte tenu du solde, de la cote, ` +
            `de la préférence et de la confiance du modèle pour la sélection, et du contexte du match ? ` +
            `Mise davantage quand l'avantage est net et la situation claire, très peu quand le pari est incertain ou que la cote paie à peine son risque. ` +
            (mandatory ? `Une mise est obligatoire : choisis la tranche la plus adaptée, petite si le pari est incertain. ` : `Si le pari ne vaut pas le risque, choisis de ne pas miser. `) +
            `Jamais tout le solde.`,
          criteria
        }
      }
    };
    if (CONFIG.JEV.model) body.model = CONFIG.JEV.model;
    return body;
  }

  function pickCell(cells, answer, includeNone) {
    if (!answer || typeof answer.choice !== 'string') return null;
    const wanted = normalizeText(answer.choice);
    if (includeNone && wanted === normalizeText(NONE_KEY)) return { none: true };
    const cell = cells.find((c) => normalizeText(c.key) === wanted);
    return cell ? { cell, confidence: typeof answer.confidence === 'number' ? answer.confidence : null } : null;
  }

  /**
   * @param {{wallet:number, totalOdds:number, selections:object[]}} ctx
   * @param {(body:object)=>Promise<object>} ask  envoie la requête JEV et renvoie `answers`
   * @returns {Promise<{none:true,reason?:string}|{amount:number, potentialWinnings:number, range:number[], rounds:object[]}>}
   */
  async function suggestStake(ctx, ask) {
    const { cells: cellCount, maxRounds, maxFractionOfWallet, oddsRiskRef, minStake } = CONFIG.stake;
    const riskFactor = oddsRiskRef > 0 && ctx.totalOdds > oddsRiskRef ? oddsRiskRef / ctx.totalOdds : 1;
    const allowNone = ctx.allowNone !== false;
    const cap = r2(Math.min(ctx.wallet * maxFractionOfWallet * riskFactor, ctx.wallet));
    if (!(cap >= minStake)) return { none: true, reason: 'wallet-too-low' };

    let lo = 0;
    let hi = cap;
    let previous = null;
    const rounds = [];
    for (let round = 1; round <= maxRounds; round++) {
      const cells = buildLadder(lo, hi, cellCount);
      const includeNone = allowNone && round === 1;
      const body = buildStakeBody(ctx, cells, { round, lo, hi, includeNone, previous, mandatory: !allowNone });
      const id = `stake_round_${round}`;
      const answers = await ask(body);
      const pick = pickCell(cells, answers && answers[id], includeNone);
      if (!pick) throw new Error(`Réponse de mise invalide (tour ${round})`);
      if (pick.none) return { none: true, reason: 'jev-says-no', rounds };
      rounds.push({ cells, index: cells.indexOf(pick.cell), lo: pick.cell.lo, hi: pick.cell.hi, confidence: pick.confidence });
      lo = pick.cell.lo;
      hi = pick.cell.hi;
      previous = pick.cell.key;
      if (hi - lo <= 0.0111) break; // précision au centime atteinte
    }
    const amount = Math.min(cap, Math.max(minStake, r2((lo + hi) / 2)));
    return { amount, potentialWinnings: r2(amount * ctx.totalOdds), range: [lo, hi], rounds };
  }

  const api = { NONE_KEY, fmtMoney, readWallet, readSlip, slipFingerprint, buildLadder, buildStakeBody, pickCell, suggestStake };
  if (isNode) module.exports = api;
  else Object.assign(root.JEV, api);
})(globalThis);

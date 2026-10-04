/** Garde-fous du mode Auto (spec §4). Pur, sans DOM. Fail-closed : tout doute => NON/ARRET. */
(function (root) {
  // Plafonds durs : constantes du code, jamais lues depuis la config.
  const HARD = Object.freeze({
    maxStakeFraction: 0.1,
    maxLossFraction: 0.5,
    maxBets: 5,
    maxLosses: 3,
    minOddsFloor: 1.2,
    maxOddsCeil: 6,
    maxDriftPct: 5,
    minLeadSec: 60,
    minConfidence: 0.5,
    confirmTimeoutMs: 15000,
    hiddenTabMs: 10000
  });

  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const E = 1e-9;
  // Montant -> centimes entiers, ou null si ce n'est pas un nombre entier de centimes (aucun arrondi vers le haut toléré).
  const exactCents = (x) => {
    if (!num(x)) return null;
    const c = Math.round(x * 100);
    return Math.abs(x * 100 - c) < 1e-6 ? c : null;
  };

  function validateConfig(cfg) {
    const errors = [];
    if (!cfg || typeof cfg !== 'object') return { ok: false, errors: ['config absente'] };
    const need = (k, min, max, label) => {
      const v = cfg[k];
      if (!num(v) || v < 0) { errors.push(`${k} : nombre positif requis`); return; }
      if (min !== undefined && v < min) errors.push(`${k} : ${v} < minimum ${min}`);
      if (max !== undefined && v > max) errors.push(`${k} : ${v} > plafond ${max}`);
    };
    need('maxStakeFraction', Number.MIN_VALUE, HARD.maxStakeFraction);
    need('maxLossFraction', Number.MIN_VALUE, HARD.maxLossFraction);
    need('maxBets', 1, HARD.maxBets);
    need('maxLosses', 1, HARD.maxLosses);
    if (num(cfg.maxBets) && !Number.isInteger(cfg.maxBets)) errors.push('maxBets : entier requis');
    if (num(cfg.maxLosses) && !Number.isInteger(cfg.maxLosses)) errors.push('maxLosses : entier requis');
    need('minOdds', HARD.minOddsFloor);
    need('maxOdds', undefined, HARD.maxOddsCeil);
    if (num(cfg.minOdds) && num(cfg.maxOdds) && cfg.minOdds >= cfg.maxOdds) errors.push('minOdds doit être < maxOdds');
    need('maxDriftPct', undefined, HARD.maxDriftPct);
    need('minLeadSec', HARD.minLeadSec);
    need('minConfidence', HARD.minConfidence, 1);
    need('confirmTimeoutMs', 1, HARD.confirmTimeoutMs);
    need('hiddenTabMs', 0, HARD.hiddenTabMs);
    need('slipWaitMs', 1, 10000);
    need('pollMs', 50, 1000);
    need('identifyRetries', 1, 5);
    if (num(cfg.identifyRetries) && !Number.isInteger(cfg.identifyRetries)) errors.push('identifyRetries : entier requis');
    need('pauseMs', 1000, 60000);
    need('stepMs', 500, 10000);
    need('maxCycles', 1, 200);
    if (num(cfg.maxCycles) && !Number.isInteger(cfg.maxCycles)) errors.push('maxCycles : entier requis');
    need('myBetsWaitMs', 1, 20000);
    const mp = cfg.myBetsPath;
    if ((typeof mp !== 'string' || !mp.startsWith('/') || mp.includes('//') || mp.includes('\\') || mp.includes(':'))) {
      errors.push('myBetsPath : chemin relatif « /… » requis (sans //, \\ ni :)');
    }
    const qm = cfg.quickMarkets;
    if (!qm || typeof qm !== 'object' || Array.isArray(qm)) errors.push('quickMarkets : objet requis');
    else {
      for (const k of Object.keys(qm)) {
        const l = qm[k];
        if (!Array.isArray(l) || !l.every((m) => m instanceof RegExp || (typeof m === 'string' && m === m.toLowerCase() && m.length > 0))) {
          errors.push(`quickMarkets.${k} : tableau de RegExp ou de chaînes en minuscules requis`);
        }
      }
    }
    return { ok: errors.length === 0, errors };
  }

  /**
   * Contrat des réservations : reserve(stake) au début d'un pari (compte la mise comme perdue et une tentative « en vol ») ;
   * recordPlaced() quand le pari est confirmé (placed+1, la tentative en vol est consommée, la réserve reste) ;
   * release(stake) quand le résultat est vérifié ; release(stake, true) pour un pari abandonné avant confirmation.
   * check refuse si placed + enVol >= maxBets.
   */
  // Instantané des compteurs (persisté par le contrôleur) : validation stricte, sinon exception.
  function checkSnapshot(s) {
    if (!s || typeof s !== 'object') throw new Error('instantané du guard invalide');
    const ints = ['placed', 'inFlight', 'consecutiveLosses'];
    for (const k of ints) if (!Number.isInteger(s[k]) || s[k] < 0) throw new Error(`instantané du guard : ${k} invalide`);
    if (!num(s.reserved) || s.reserved < 0) throw new Error('instantané du guard : reserved invalide');
    return { placed: s.placed, inFlight: s.inFlight, consecutiveLosses: s.consecutiveLosses, reserved: s.reserved };
  }

  function create(cfg, startBalance, snapshot) {
    const v = validateConfig(cfg);
    if (!v.ok) throw new Error('Config auto invalide : ' + v.errors.join(' ; '));
    if (!num(startBalance) || startBalance <= 0) throw new Error('Solde de départ invalide');
    // Snapshot figé : muter cfg après coup n'a aucun effet ; HARD s'applique à chaque valeur.
    const c = Object.freeze({
      stakeFrac: Math.min(cfg.maxStakeFraction, HARD.maxStakeFraction),
      lossFrac: Math.min(cfg.maxLossFraction, HARD.maxLossFraction),
      maxBets: Math.min(cfg.maxBets, HARD.maxBets),
      maxLosses: Math.min(cfg.maxLosses, HARD.maxLosses),
      minOdds: Math.max(cfg.minOdds, HARD.minOddsFloor),
      maxOdds: Math.min(cfg.maxOdds, HARD.maxOddsCeil),
      maxDriftPct: Math.min(cfg.maxDriftPct, HARD.maxDriftPct),
      minLeadSec: Math.max(cfg.minLeadSec, HARD.minLeadSec),
      minConfidence: Math.max(cfg.minConfidence, HARD.minConfidence)
    });
    const startC = Math.floor(startBalance * 100 + E);
    if (startC <= 0) throw new Error('Solde de départ invalide');
    const stakeCapC = Math.floor(startC * c.stakeFrac + E);
    const lossCapC = Math.floor(startC * c.lossFrac + E);
    const st = { startBalance, placed: 0, reserved: 0, consecutiveLosses: 0 };
    let inFlight = 0;
    if (snapshot !== undefined && snapshot !== null) {
      const r = checkSnapshot(snapshot);
      st.placed = r.placed; st.reserved = r.reserved; st.consecutiveLosses = r.consecutiveLosses; inFlight = r.inFlight;
    }

    function maxStake(suggested) {
      if (!num(suggested) || suggested <= 0) return 0;
      return Math.min(stakeCapC, Math.floor(suggested * 100 + E)) / 100;
    }

    const no = (reason) => ({ verdict: 'NON', reason });

    function check(p) {
      if (!(st.consecutiveLosses < c.maxLosses)) return { verdict: 'ARRET', reason: `${c.maxLosses} défaites consécutives` };
      if (!p || typeof p !== 'object') return no('proposition absente');
      if (!(st.placed + inFlight < c.maxBets)) return no(`${c.maxBets} paris Auto atteints ou en vol`);
      if (!num(p.balance) || p.balance < 0) return no('solde illisible');
      const stakeC = exactCents(p.stake);
      if (stakeC === null || stakeC <= 0) return no('mise invalide (centimes entiers > 0)');
      if (!(stakeC <= stakeCapC)) return no('mise > plafond de la mise');
      // perte arrondie vers le haut : jamais en faveur de l'utilisateur
      const lossC = Math.ceil((startBalance - p.balance + st.reserved) * 100 - 1e-6);
      if (!Number.isFinite(lossC)) return no('perte incalculable');
      if (!(lossC + stakeC <= lossCapC)) return no('perte de session + mise > plafond');
      if (!num(p.odds) || !num(p.analysedOdds) || !(p.analysedOdds > 0)) return no('cote illisible');
      if (!(p.odds >= c.minOdds && p.odds <= c.maxOdds)) return no('cote hors bornes');
      const drift = (Math.abs(p.odds - p.analysedOdds) / p.analysedOdds) * 100;
      if (!(drift <= c.maxDriftPct)) return no('dérive de cote trop forte');
      if (p.suspended !== false) return no('marché suspendu ou état inconnu');
      if (!(num(p.leadSec) && p.leadSec >= c.minLeadSec)) return no('temps restant trop court');
      if (!(num(p.confidence) && p.confidence >= c.minConfidence)) return no('confiance JEV insuffisante');
      return { verdict: 'OUI', reason: 'ok' };
    }

    return {
      maxStake,
      check,
      reserve(stake) { if (num(stake) && stake > 0) { st.reserved += stake; inFlight += 1; } },
      release(stake, unplaced) {
        if (num(stake) && stake > 0) st.reserved = Math.max(0, st.reserved - stake);
        if (unplaced === true) inFlight = Math.max(0, inFlight - 1);
      },
      recordPlaced() { st.placed += 1; inFlight = Math.max(0, inFlight - 1); },
      recordResult(r) {
        if (r === 'won') st.consecutiveLosses = 0;
        else if (r === 'lost') st.consecutiveLosses += 1;
        else throw new Error('résultat inconnu : ' + r);
      },
      snapshot() { return Object.freeze({ placed: st.placed, reserved: st.reserved, inFlight, consecutiveLosses: st.consecutiveLosses }); },
      get state() { return Object.freeze({ ...st }); }
    };
  }

  const api = { HARD, validateConfig, create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Guard = api;
})(globalThis);

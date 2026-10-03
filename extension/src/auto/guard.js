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
  const cents = (x) => Math.round(x * 100);
  const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;

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
    return { ok: errors.length === 0, errors };
  }

  function create(cfg, startBalance) {
    const v = validateConfig(cfg);
    if (!v.ok) throw new Error('Config auto invalide : ' + v.errors.join(' ; '));
    if (!num(startBalance) || startBalance <= 0) throw new Error('Solde de départ invalide');
    const start = startBalance;
    const state = { startBalance: start, placed: 0, reserved: 0, consecutiveLosses: 0 };
    const stakeCap = () => floor2(start * Math.min(cfg.maxStakeFraction, HARD.maxStakeFraction));
    const lossCap = () => start * Math.min(cfg.maxLossFraction, HARD.maxLossFraction);
    const maxBets = Math.min(cfg.maxBets, HARD.maxBets);
    const maxLosses = Math.min(cfg.maxLosses, HARD.maxLosses);

    function maxStake(suggested) {
      if (!num(suggested) || suggested <= 0) return 0;
      return Math.min(stakeCap(), floor2(suggested));
    }

    const no = (reason) => ({ verdict: 'NON', reason });

    function check(p) {
      if (state.consecutiveLosses >= maxLosses) return { verdict: 'ARRET', reason: `${maxLosses} défaites consécutives` };
      if (!p || typeof p !== 'object') return no('proposition absente');
      if (state.placed >= maxBets) return no(`${maxBets} paris Auto atteints`);
      if (!num(p.balance) || p.balance < 0) return no('solde illisible');
      if (!num(p.stake) || p.stake <= 0) return no('mise invalide');
      if (cents(p.stake) > cents(stakeCap())) return no('mise > plafond de la mise');
      const loss = start - p.balance + state.reserved;
      if (!num(loss)) return no('perte incalculable');
      if (cents(loss) + cents(p.stake) > cents(lossCap())) return no('perte de session + mise > plafond');
      if (!num(p.odds) || !num(p.analysedOdds) || p.analysedOdds <= 0) return no('cote illisible');
      if (p.odds < cfg.minOdds || p.odds > cfg.maxOdds) return no('cote hors bornes');
      const drift = (Math.abs(p.odds - p.analysedOdds) / p.analysedOdds) * 100;
      if (!(drift <= Math.min(cfg.maxDriftPct, HARD.maxDriftPct))) return no('dérive de cote trop forte');
      if (p.suspended !== false) return no('marché suspendu ou état inconnu');
      if (!num(p.leadSec) || p.leadSec < cfg.minLeadSec) return no('temps restant trop court');
      if (!num(p.confidence) || p.confidence < cfg.minConfidence) return no('confiance JEV insuffisante');
      return { verdict: 'OUI', reason: 'ok' };
    }

    return {
      maxStake,
      check,
      reserve(stake) { if (num(stake) && stake > 0) state.reserved += stake; },
      release(stake) { if (num(stake) && stake > 0) state.reserved = Math.max(0, state.reserved - stake); },
      recordPlaced() { state.placed += 1; },
      recordResult(r) {
        if (r === 'won') state.consecutiveLosses = 0;
        else if (r === 'lost') state.consecutiveLosses += 1;
        else throw new Error('résultat inconnu : ' + r);
      },
      state
    };
  }

  const api = { HARD, validateConfig, create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Guard = api;
})(globalThis);

/** Suivi des paris Auto (spec §7). LECTURE SEULE : ne navigue jamais, ne clique jamais. Toute donnée douteuse -> valeur sûre. */
(function (root) {
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  function createTracker(deps) {
    const { readers, getMyBetsDoc } = deps;
    const readBalanceRaw = deps.readBalance;
    const cfg = deps.cfg || {};
    const sleep = deps.sleep || (() => Promise.resolve());
    const log = deps.log || (() => {});
    const retries = Number.isInteger(cfg.identifyRetries) && cfg.identifyRetries >= 1 ? cfg.identifyRetries : 3;
    const pollMs = isNum(cfg.pollMs) ? cfg.pollMs : 250;

    const balance = () => {
      try { const b = readBalanceRaw(); return isNum(b) ? b : null; } catch (e) { log('tracker: solde illisible', e && e.message); return null; }
    };
    const bets = async (filter) => {
      const doc = await getMyBetsDoc(filter);
      const l = readers.readMyBets(doc);
      if (!Array.isArray(l)) throw new Error('lecture Mes paris invalide');
      return l;
    };
    const refs = (l) => l.map((b) => (b && b.reference != null ? String(b.reference) : null)).filter((r) => r);

    async function snapshotOngoing() {
      try { return refs(await bets('ongoing')); } catch (e) { log('tracker: snapshot impossible', e && e.message); return []; }
    }

    async function identify(before) {
      const prev = new Set((Array.isArray(before) ? before : []).map(String));
      let fresh = [];
      for (let i = 0; i < retries; i++) {
        if (i > 0) { try { await sleep(pollMs); } catch (e) { /* ignore */ } }
        try {
          fresh = [...new Set(refs(await bets('ongoing')).filter((r) => !prev.has(r)))];
        } catch (e) { log('tracker: relecture impossible', e && e.message); fresh = []; }
        if (fresh.length >= 2) break;
        if (fresh.length === 1) return { method: 'reference', reference: fresh[0] };
      }
      return balance() !== null ? { method: 'balance' } : { method: 'none' };
    }

    async function resolve(reference) {
      try {
        const ref = String(reference);
        for (const filter of ['ended', 'ongoing']) {
          const b = (await bets(filter)).find((x) => x && String(x.reference) === ref);
          if (!b) continue;
          return b.status === 'won' || b.status === 'lost' ? b.status : 'pending';
        }
      } catch (e) { log('tracker: résolution impossible', e && e.message); }
      return 'pending';
    }

    function resolveByBalance(prevBalance, pendingStakes) {
      try {
        const bal = balance();
        if (bal === null || !isNum(prevBalance) || !isNum(pendingStakes) || pendingStakes <= 0) return 'unknown';
        return bal <= prevBalance - pendingStakes + 0.005 ? 'lost' : 'unknown';
      } catch (e) { return 'unknown'; }
    }

    return { snapshotOngoing, identify, resolve, resolveByBalance };
  }
  const api = { createTracker };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Tracker = api;
})(globalThis);

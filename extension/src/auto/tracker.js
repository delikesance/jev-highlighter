/** Dépendance injectée : getMyBetsDoc(filter 'ongoing'|'ended') -> Promise<Document>.
 * Suivi des paris Auto (spec §7). LECTURE SEULE : ne navigue jamais, ne clique jamais. Toute donnée douteuse -> valeur sûre. */
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
    // Clé de chaque carte : référence, sinon clé de repli stable « id:<data-qa> », sinon null (illisible).
    const keyOf = (b) => (b && b.reference != null && b.reference !== '' ? String(b.reference) : (b && b.id ? 'id:' + b.id : null));
    const refs = (l) => l.map(keyOf);

    async function snapshotOngoing() {
      try {
        const k = refs(await bets('ongoing'));
        return k.includes(null) ? null : k;
      } catch (e) { log('tracker: snapshot impossible', e && e.message); return null; }
    }

    async function identify(before) {
      if (!Array.isArray(before)) return balance() !== null ? { method: 'balance' } : { method: 'none' };
      const prev = new Set((Array.isArray(before) ? before : []).map(String));
      let fresh = [];
      for (let i = 0; i < retries; i++) {
        if (i > 0) { try { await sleep(pollMs); } catch (e) { /* ignore */ } }
        try {
          const keys = refs(await bets('ongoing'));
          fresh = [...new Set(keys.filter((r) => r === null || !prev.has(r)))];
        } catch (e) { log('tracker: relecture impossible', e && e.message); fresh = []; }
        if (fresh.length >= 2 || (fresh.length === 1 && (fresh[0] === null || fresh[0].startsWith('id:')))) break;
        if (fresh.length === 1 && fresh[0] !== null && !fresh[0].startsWith('id:')) return { method: 'reference', reference: fresh[0] };
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

    // Le solde seul ne permet pas de distinguer un pari en cours (mise déjà débitée) d'un pari perdu, ni de conclure 'won' :
    // ce secours ne conclut donc JAMAIS. Signature conservée ; toujours 'unknown'.
    function resolveByBalance(prevBalance, pendingStakes) {
      return 'unknown';
    }

    return { snapshotOngoing, identify, resolve, resolveByBalance };
  }
  const api = { createTracker };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Tracker = api;
})(globalThis);

/**
 * Journal des décisions Auto : ce que JEV a choisi (live, pari, cote, mise) et ce qui s'est passé (placé, refusé, gagné, perdu).
 * Sert uniquement à mesurer après coup si les choix de JEV valent quelque chose. Ne décide rien et n'influence jamais un pari.
 * Stockage injecté (area.get/set) ; écritures sérialisées ; borné aux `max` dernières entrées.
 */
(function (root) {
  const KEY = 'jevAutoJournal';

  function createJournal(opts) {
    const { area } = opts;
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : 200;
    let chain = Promise.resolve();

    const read = async () => {
      const r = await area.get(KEY);
      return Array.isArray(r && r[KEY]) ? r[KEY] : [];
    };
    const enqueue = (fn) => {
      const p = chain.then(fn);
      chain = p.catch(() => {});
      return p;
    };

    function record(entry) {
      return enqueue(async () => {
        const list = await read();
        list.push({ ...entry, at: now(), outcome: entry.outcome || 'decided' });
        await area.set({ [KEY]: list.slice(-max) });
      });
    }

    // Met à jour la dernière entrée portant cet execId ; sans effet si elle a été purgée.
    function update(execId, patch) {
      if (execId == null) return Promise.resolve();
      return enqueue(async () => {
        const list = await read();
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].execId === execId) { list[i] = { ...list[i], ...patch, updatedAt: now() }; await area.set({ [KEY]: list }); return; }
        }
      });
    }

    const list = () => enqueue(read);

    // Bilan simple : paris réglés, gagnés, perdus, mises, gain net estimé (mise × (cote − 1) si gagné, − mise si perdu).
    async function summary() {
      const l = await list();
      const s = { decided: l.length, won: 0, lost: 0, staked: 0, net: 0 };
      for (const e of l) {
        if (e.outcome !== 'won' && e.outcome !== 'lost') continue;
        const stake = Number.isFinite(e.stake) ? e.stake : 0;
        const odds = e.pick && Number.isFinite(e.pick.odds) ? e.pick.odds : 0;
        s.staked += stake;
        if (e.outcome === 'won') { s.won++; s.net += stake * (odds - 1); } else { s.lost++; s.net -= stake; }
      }
      s.net = Math.round(s.net * 100) / 100;
      s.staked = Math.round(s.staked * 100) / 100;
      return s;
    }

    return { record, update, list, summary };
  }

  const api = { createJournal, KEY };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Journal = api;
})(globalThis);

/**
 * Assemblage du mode Auto (spec §3, §5 bis, §7) : store de session, horloge unique, garde-fous, exécuteur, suivi.
 * Aucune logique de pari ici, aucun clic (le seul clic « Mes paris » est délégué à Executor.selectMyBetsFilter).
 * Ne navigue jamais l'onglet principal : « Mes paris » est lu dans une iframe cachée de même origine.
 */
(function (root) {
  const KEY = 'jevAuto';
  const STOP_KEY = 'jevAutoStop';

  /**
   * Store sur chrome.storage.session. Écritures sérialisées (chaîne de promesses, FIFO, aucune perte) ;
   * get() lit après les écritures en attente. set({ stopped: false }) (réarmement) efface aussi la demande d'arrêt.
   * stopFlag() : vrai si state.stopped, si jevAutoStop est posé, ou si le storage échoue (fail-closed).
   */
  function makeSessionStore(chromeApi, tabId, now) {
    const area = chromeApi && chromeApi.storage && chromeApi.storage.session;
    let chain = Promise.resolve();
    const read = async () => {
      const r = await area.get(KEY);
      const v = r && r[KEY];
      return v && typeof v === 'object' ? v : {};
    };
    const enqueue = (fn) => {
      const p = chain.then(fn);
      chain = p.catch(() => {});
      return p;
    };
    function set(patch) {
      return enqueue(async () => {
        const cur = await read();
        await area.set({ [KEY]: { ...cur, ...(patch || {}) } });
        if (patch && patch.stopped === false) await area.remove(STOP_KEY);
      });
    }
    const get = () => enqueue(read);
    async function stopFlag() {
      try {
        const r = await area.get([KEY, STOP_KEY]);
        return !!(r && (r[STOP_KEY] || (r[KEY] && r[KEY].stopped)));
      } catch (e) { return true; }
    }
    // Pose d'abord la clé séparée (non sérialisée : effet immédiat pour l'exécuteur), puis l'état collant.
    async function requestStop(reason) {
      const why = String(reason || 'STOP');
      try { await area.set({ [STOP_KEY]: { reason: why, at: now(), tabId } }); } finally {
        await set({ stopped: true, phase: 'STOPPED', reason: why });
      }
    }
    return { get, set, stopFlag, requestStop, now };
  }

  function defaultIframeFactory(doc, url) {
    const el = doc.createElement('iframe');
    el.src = url;
    return el;
  }

  /** getMyBetsDoc(filter) : nouvelle iframe cachée à chaque appel (l'ancienne retirée avant) ; échec/timeout => rejet. */
  function makeMyBetsDoc(o) {
    const { doc, cfg, sleep, now } = o;
    const factory = o.iframeFactory || defaultIframeFactory;
    const selectFilter = o.selectFilter;
    const waitMs = Number.isFinite(cfg.myBetsWaitMs) ? Math.min(cfg.myBetsWaitMs, 20000) : 10000;
    const pollMs = Number.isFinite(cfg.pollMs) ? cfg.pollMs : 250;
    let current = null;

    const dispose = () => {
      if (current) { try { current.remove(); } catch (e) { /* déjà retirée */ } }
      current = null;
    };
    async function waitFor(fn, t0, what) {
      for (;;) {
        const v = fn();
        if (v) return v;
        if (now() - t0 > waitMs) throw new Error('Mes paris : délai dépassé (' + what + ')');
        await sleep(pollMs);
      }
    }
    async function getMyBetsDoc(filter) {
      if (filter !== 'ongoing' && filter !== 'ended') throw new Error('filtre Mes paris invalide');
      const path = cfg.myBetsPath;
      if (typeof path !== 'string' || !path.startsWith('/') || /\/\/|\\|:/.test(path)) throw new Error('myBetsPath invalide');
      dispose();
      const url = new URL(path, doc.location.href).href;
      const el = factory(doc, url);
      current = el;
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('tabindex', '-1');
      el.style.display = 'none';
      (doc.body || doc.documentElement).appendChild(el);
      try {
        const t0 = now();
        const page = () => {
          if (current !== el) throw new Error('Mes paris : iframe remplacée');
          const d = el.contentDocument;
          return d && d.querySelector('my-bets-page') ? d : null;
        };
        const d = await waitFor(page, t0, 'page');
        if (!(await selectFilter(d, filter))) throw new Error('Mes paris : filtre introuvable');
        await sleep(pollMs);
        // Cartes, ou état vide reconnu (filtre actif et marqueur vide explicite). Sinon rejet.
        await waitFor(() => page() && (d.querySelector('my-bets-page bet-card') || d.querySelector('my-bets-page [data-qa="my-bets-empty"]')), t0, 'cartes');
        return d;
      } catch (e) {
        if (current === el) dispose();
        throw e;
      }
    }
    return { getMyBetsDoc, dispose };
  }

  function createRuntime(opts) {
    const { chromeApi, doc, tabId, settings, cfg, modules, now, sleep } = opts;
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const M = modules;
    const store = makeSessionStore(chromeApi, tabId, now);
    const readers = M.Readers;
    const myBets = makeMyBetsDoc({ doc, cfg, sleep, now, iframeFactory: opts.iframeFactory, selectFilter: M.Executor.selectMyBetsFilter });
    const tracker = M.Tracker.createTracker({
      readers, getMyBetsDoc: myBets.getMyBetsDoc, readBalance: () => readers.readWallet(doc), sleep, cfg, log
    });
    const controller = M.Controller.createController({
      store, scanner: M.Scanner, selector: M.Selector, readers, tracker, cfg, tabId, settings, doc,
      analyze: opts.analyze, stakeFor: opts.stakeFor, navigate: opts.navigate, parseMarkets: opts.parseMarkets,
      sleep, now, log,
      makeGuard: (startBalance, snapshot) => M.Guard.create(cfg, startBalance, snapshot),
      makeExecutor: (guard) => M.Executor.createExecutor({ doc, readers, guard, store, sleep, now, cfg, log }),
      quickCountFor: opts.quickCountFor || (() => 1)
    });
    async function stop(reason) {
      myBets.dispose();
      try { await store.requestStop(reason); } catch (e) { log('stop : écriture impossible', e && e.message); }
      await controller.stop(reason);
    }
    return { controller, store, stop };
  }

  const api = { createRuntime, makeSessionStore, makeMyBetsDoc };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Wiring = api;
})(globalThis);

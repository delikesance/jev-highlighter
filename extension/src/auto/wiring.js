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
   * get() lit après les écritures en attente. set({ stopped: false }) (réarmement) efface la demande d'arrêt si antérieure.
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
      const t = now();
      return enqueue(async () => {
        const cur = await read();
        await area.set({ [KEY]: { ...cur, ...(patch || {}) } });
        // Réarmement : n'efface qu'une demande d'arrêt strictement antérieure (un STOP posé pendant la file reste actif).
        if (patch && patch.stopped === false) {
          const r = await area.get(STOP_KEY);
          const s = r && r[STOP_KEY];
          if (s && Number.isFinite(s.at) && s.at < t) await area.remove(STOP_KEY);
        }
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

  const ACTIVE_RE = /(^|\s)(is-active|isActive|active)(\s|$)/;
  const LOADER_SEL = '[class*=loader], [class*=skeleton], [class*=spinner], bcdk-loader';
  const EMPTY_SEL = 'my-bets-page [data-qa="my-bets-empty"]';

  /**
   * getMyBetsDoc(filter) : nouvelle iframe cachée (technique de context.js) à chaque appel, l'ancienne retirée avant.
   * Lecture acceptée seulement après un SIGNAL POSITIF (bouton du filtre actif) puis une liste STABLE
   * (2 lectures identiques avec cartes ; 3 lectures à 0 carte sans chargement, ou 2 avec marqueur vide). Sinon rejet.
   */
  function makeMyBetsDoc(o) {
    const { doc, cfg, sleep, now } = o;
    const factory = o.iframeFactory || defaultIframeFactory;
    const selectFilter = o.selectFilter;
    let current = null;

    const dispose = () => {
      if (current) { try { current.remove(); } catch (e) { /* déjà retirée */ } }
      current = null;
    };
    const filterActive = (d, filter) => {
      const b = d.querySelector(`my-bets-page [data-qa="my-bets-filter-${filter}"]`);
      return !!b && (ACTIVE_RE.test(b.className || '') || b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-selected') === 'true');
    };

    async function getMyBetsDoc(filter) {
      if (filter !== 'ongoing' && filter !== 'ended') throw new Error('filtre Mes paris invalide');
      const path = cfg.myBetsPath;
      if (typeof path !== 'string' || !path.startsWith('/') || /\/\/|\\|:/.test(path)) throw new Error('myBetsPath invalide');
      const waitMs = cfg.myBetsWaitMs;
      const pollMs = cfg.pollMs;
      if (!(Number.isFinite(waitMs) && waitMs >= 1 && waitMs <= 20000)) throw new Error('myBetsWaitMs invalide');
      if (!(Number.isFinite(pollMs) && pollMs >= 50 && pollMs <= 1000)) throw new Error('pollMs invalide');
      dispose();
      const url = new URL(path, doc.location.href).href;
      const el = factory(doc, url);
      current = el;
      el.setAttribute('data-jev-host', '');
      el.setAttribute('aria-hidden', 'true');
      el.tabIndex = -1;
      el.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0;opacity:0;pointer-events:none;';
      doc.documentElement.appendChild(el);
      const t0 = now();
      const expired = () => now() - t0 > waitMs;
      const page = () => {
        if (current !== el) throw new Error('Mes paris : iframe remplacée');
        const d = el.contentDocument;
        return d && d.querySelector('my-bets-page') ? d : null;
      };
      try {
        let d;
        while (!(d = page())) { if (expired()) throw new Error('Mes paris : délai dépassé (page)'); await sleep(pollMs); }
        if (!filterActive(d, filter) && !(await selectFilter(d, filter))) throw new Error('Mes paris : filtre introuvable');
        let prev = null;
        let same = 0;
        for (;;) {
          d = page();
          if (d && filterActive(d, filter) && !d.querySelector(LOADER_SEL)) {
            const cards = Array.from(d.querySelectorAll('my-bets-page bet-card'));
            const sig = cards.map((c) => (c.getAttribute('data-qa') || '') + '/' + (c.className || '')).join('|');
            same = sig === prev ? same + 1 : 1;
            prev = sig;
            const need = cards.length ? 2 : d.querySelector(EMPTY_SEL) ? 2 : 3;
            if (same >= need) return d;
          } else { prev = null; same = 0; }
          if (expired()) throw new Error('Mes paris : filtre non confirmé ou liste instable');
          await sleep(pollMs);
        }
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
    // L'iframe « Mes paris » est retirée dès que le contrôleur passe en STOPPED.
    const step = async () => {
      const r = await controller.step();
      if (r === 'STOPPED') myBets.dispose();
      return r;
    };
    const init = async () => {
      const r = await controller.init();
      if (r === 'STOPPED') myBets.dispose();
      return r;
    };
    return { controller: { ...controller, step, init }, store, stop, myBets };
  }

  const api = { createRuntime, makeSessionStore, makeMyBetsDoc };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Wiring = api;
})(globalThis);

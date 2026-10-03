/**
 * Contrôleur du mode Auto (spec §3, §5 bis, §6). Machine à états pilotée de l'extérieur : step() = UNE transition.
 * Tout l'état vit dans le store (survit au rechargement de la page). ARRÊT (STOPPED) collant.
 * Ce module ne clique jamais : seul l'exécuteur le fait. Toute exception d'une dépendance => stop, sans nouvel essai.
 */
(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const Parser = isNode ? require('../parser') : root.JEV;
  const PHRASE = 'PARIER AUTO';
  const STATES = ['IDLE', 'ARMED', 'SCAN', 'CHOIX', 'ANALYSE', 'GARDE', 'EXEC', 'ATTENTE', 'PAUSE', 'STOPPED'];
  // Construit dynamiquement : le mot littéral ne doit pas apparaître dans un content script.
  const SECRET_RE = new RegExp('api' + '[_-]?key', 'i');
  const LIVE_HREF = '/live';

  function createController(deps) {
    const { store, scanner, selector, readers, tracker, cfg, tabId, settings, doc } = deps;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const sleep = deps.sleep;
    const pauseMs = Number.isFinite(cfg && cfg.pauseMs) ? cfg.pauseMs : 5000;
    const maxCycles = Number.isInteger(cfg && cfg.maxCycles) ? cfg.maxCycles : 60;
    const maxBets = Math.min(Number.isInteger(cfg && cfg.maxBets) ? cfg.maxBets : 5, 5);
    // Mémoire locale (aucune donnée de session) : onglet étranger, verrou de ré-entrance, objets reconstruits depuis le store.
    let foreign = false;
    let running = false;
    let lastPhase = 'IDLE';
    let guard = null;
    let executor = null;

    const msg = (e) => String((e && e.message) || e);
    const secretLeaked = () => !!settings && typeof settings === 'object' && Object.keys(settings).some((k) => SECRET_RE.test(k));
    const set = (p) => store.set(p);
    const isOther = (st) => st.ownerTabId != null && st.ownerTabId !== tabId;

    function buildGuard(startBalance, snap) {
      guard = deps.makeGuard(startBalance, snap == null ? null : snap);
      executor = typeof deps.makeExecutor === 'function' ? deps.makeExecutor(guard) : deps.executor;
    }
    const saveGuard = () => set({ guardSnap: guard.snapshot() });

    async function stop(reason, extra) {
      log('ARRÊT', reason);
      lastPhase = 'STOPPED';
      if (foreign) return;
      try {
        await set({ ...(extra || {}), phase: 'STOPPED', stopped: true, reason: String(reason) });
      } catch (e) { log('stop: écriture impossible', msg(e)); }
    }

    async function init() {
      let st;
      try {
        st = await store.get();
        if (isOther(st)) { foreign = true; log('ARRÊT', 'session Auto armée dans un autre onglet'); return (lastPhase = 'STOPPED'); }
        if (secretLeaked()) { await stop('clé secrète présente dans la page'); return 'STOPPED'; }
        const sb = st.session && st.session.startBalance;
        if (sb != null) buildGuard(sb, st.guardSnap);
        else if (st.phase && !['IDLE', 'STOPPED'].includes(st.phase)) { await stop('session sans solde de départ'); return 'STOPPED'; }
        if (st.pending) {
          if (!guard) { await stop('pari incertain sans session'); return 'STOPPED'; }
          // counted : déjà compté ; reservedInSnap : l'instantané contient la réserve mais pas le +1.
          if (!st.pending.counted) {
            if (!st.pending.reservedInSnap) guard.reserve(st.pending.stake);
            guard.recordPlaced();
          }
          const message = 'Pari incertain (« validation en cours ») : vérifier Mes paris + solde avant de réarmer';
          log(message, st.pending);
          await stop('pari incertain à la reprise', { message, guardSnap: guard.snapshot(), pending: { ...st.pending, counted: true } });
          return 'STOPPED';
        }
        if (st.stopped) return (lastPhase = 'STOPPED');
        return (lastPhase = STATES.includes(st.phase) ? st.phase : 'IDLE');
      } catch (e) {
        await stop('init : ' + msg(e));
        return 'STOPPED';
      }
    }

    async function arm(phrase, opts) {
      try {
        const o = opts || {};
        if (foreign) { log('armement refusé : autre onglet'); return; }
        if (phrase !== PHRASE) { log('armement refusé : phrase incorrecte'); return; }
        if (o.noManualBets !== true) { log('armement refusé : rappel « aucun pari manuel » non confirmé'); return; }
        if (typeof o.dryRun !== 'boolean') { log('armement refusé : dryRun requis'); return; }
        const st = await store.get();
        if (isOther(st)) { foreign = true; log('armement refusé : autre onglet'); return; }
        if (secretLeaked()) { await stop('clé secrète présente dans la page'); return; }
        if (st.pending && o.manualCheckDone !== true) { log('armement refusé : vérification manuelle requise'); return; }
        // Le pari incertain reste compté par endRules : il passe dans bets (« unverified ») avant d'effacer pending.
        const bets = Array.isArray(st.bets) ? st.bets : [];
        const uncertain = st.pending ? [{ ref: null, status: 'unverified', stake: st.pending.stake, event: st.pending.marketTitle || null, execId: st.pending.execId || null }] : [];
        const patch = { phase: 'ARMED', bets: [...bets, ...uncertain], stopped: false, reason: null, message: null, dryRun: o.dryRun, ownerTabId: tabId,
          pending: null, event: null, pick: null, before: null };
        let sb = st.session && st.session.startBalance;
        if (sb == null) {
          // Lu UNE seule fois par session, jamais relu.
          sb = await readers.readWalletStable(doc, sleep);
          if (!(typeof sb === 'number' && Number.isFinite(sb) && sb > 0)) { log('armement refusé : solde illisible'); return; }
          patch.session = { startBalance: sb };
          patch.cycles = 0;
        }
        if (!guard) buildGuard(sb, st.guardSnap);
        patch.guardSnap = guard.snapshot();
        if (!Array.isArray(st.tried)) patch.tried = [];
        await set(patch);
        lastPhase = 'ARMED';
        log('armé', { dryRun: o.dryRun });
      } catch (e) { await stop('arm : ' + msg(e)); }
    }

    // URL absolue normalisée si même origine (https, ou http en local uniquement), sinon null.
    function safeUrl(href) {
      if (typeof href !== 'string' || href === '') return null;
      try {
        const base = new URL(doc.location.href);
        const u = new URL(href, base);
        const local = base.protocol === 'http:' && (base.hostname === 'localhost' || base.hostname === '127.0.0.1');
        if (!(u.protocol === 'https:' || (local && u.protocol === 'http:'))) return null;
        return u.origin === base.origin ? u.href : null;
      } catch (e) { return null; }
    }

    async function go(href) {
      const url = safeUrl(href);
      if (!url) { await stop('navigation refusée (hôte non vérifié) : ' + href); return false; }
      deps.navigate(url);
      return true;
    }

    const markTried = (st, href) => set({ tried: [...(st.tried || []), href] });

    async function resolveBets(st) {
      const bets = Array.isArray(st.bets) ? st.bets : [];
      const open = bets.filter((b) => b.status === 'pending');
      if (!open.length) return;
      const stakes = open.map((b) => b.stake);
      const out = [];
      for (const b of bets) {
        if (b.status !== 'pending') { out.push(b); continue; }
        const r = b.ref ? await tracker.resolve(b.ref) : tracker.resolveByBalance(b.prevBalance, stakes);
        if (r === 'won' || r === 'lost') {
          guard.recordResult(r);
          if (!b.released) guard.release(b.stake);
          out.push({ ...b, status: r, released: true });
        } else out.push(b);
      }
      await set({ bets: out, guardSnap: guard.snapshot() });
    }

    // Règles de fin ; vrai si la session s'arrête.
    async function endRules(st) {
      const v = guard.check(null);
      if (v.verdict === 'ARRET') { await stop(v.reason); return true; }
      const n = (Array.isArray(st.bets) ? st.bets.length : 0) + (st.pending ? 1 : 0);
      if (guard.state.placed >= maxBets || n >= maxBets) { await stop('limite de session atteinte'); return true; }
      if ((st.cycles || 0) >= maxCycles) { await stop('limite de cycles atteinte'); return true; }
      return false;
    }

    const quickCountFor = typeof deps.quickCountFor === 'function'
      ? deps.quickCountFor
      : (e) => (e && (e.sport === 'football' || e.sport === 'basketball') ? 1 : 0);

    function readMarkets() {
      const parsed = deps.parseMarkets(doc);
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.markets) ? parsed.markets : [];
      const dedupe = typeof deps.dedupeMarkets === 'function' ? deps.dedupeMarkets : Parser.dedupeMarkets;
      return dedupe(list).filter((m) => m && m.suspended !== true);
    }

    const playKey = (e, p) => [e.href, p.marketTitle, p.window == null ? '' : p.window, p.label].join('|');

    // Reprise d'un pari confirmé (lastPlaced) dont la suite n'a pas été écrite : on l'adopte au lieu de rejouer.
    async function adoptLastPlaced(st) {
      const lp = st.lastPlaced;
      log('reprise : pari déjà placé adopté', lp);
      if (Array.isArray(st.before)) { await set({ phase: 'ATTENTE', placedStake: lp.stake }); return 'ATTENTE'; }
      const prevBalance = await readers.readWalletStable(doc, sleep);
      if (typeof prevBalance !== 'number') { await stop('pari repris sans référence et solde illisible : vérifier Mes paris + solde'); return 'STOPPED'; }
      const bet = { ref: null, method: 'balance', stake: lp.stake, status: 'pending', event: lp.event, prevBalance };
      await set({ phase: 'PAUSE', bets: [...(st.bets || []), bet], before: null, pick: null, event: null });
      return 'PAUSE';
    }

    async function giveUp(st, href) {
      await markTried(st, href);
      await set({ phase: 'SCAN', event: null, pick: null });
      return 'SCAN';
    }

    const phases = {
      async IDLE() { return 'IDLE'; },
      async ARMED() { await set({ phase: 'SCAN' }); return 'SCAN'; },
      async SCAN(st) {
        if (doc.location.pathname !== LIVE_HREF) return (await go(LIVE_HREF)) ? 'SCAN' : 'STOPPED';
        await resolveBets(st);
        if (await endRules(st)) return 'STOPPED';
        const tried = new Set(st.tried || []);
        const events = (scanner.scanLive(doc) || []).filter((e) => e && !tried.has(e.href));
        await set({ phase: 'CHOIX', events, cycles: (st.cycles || 0) + 1 });
        return 'CHOIX';
      },
      async CHOIX(st) {
        const event = selector.pickEvent(st.events || [], new Set(st.tried || []), quickCountFor);
        if (!event) { await set({ phase: 'PAUSE', events: null }); return 'PAUSE'; }
        const url = safeUrl(event.href);
        if (!url) { await stop('navigation refusée (hôte non vérifié) : ' + event.href); return 'STOPPED'; }
        await set({ phase: 'ANALYSE', event, events: null });
        deps.navigate(url);
        return 'ANALYSE';
      },
      async ANALYSE(st) {
        const event = st.event;
        const markets = selector.quickMarkets(readMarkets(), event.sport, cfg);
        const matches = markets.length ? await deps.analyze(markets, { event }) : [];
        const picks = selector.pickSelections(matches, markets, cfg, event.sport);
        const p = picks[0];
        const m = p && markets.find((x) => x.id === p.marketId);
        if (!p || !m || typeof m.title !== 'string') return giveUp(st, event.href);
        await set({ phase: 'GARDE', pick: { ...p, marketTitle: m.title } });
        return 'GARDE';
      },
      async GARDE(st) {
        if (await endRules(st)) return 'STOPPED';
        const key = playKey(st.event, st.pick);
        if ((st.playedKeys || []).includes(key)) { log('déjà joué dans la session', key); return giveUp(st, st.event.href); }
        const stake = guard.maxStake(await deps.stakeFor({ event: st.event, pick: st.pick }));
        if (!(stake > 0)) return giveUp(st, st.event.href);
        // Avant tout appel à l'exécuteur : événement tried et clé jouée persistés, lastPlaced remis à zéro.
        const tried = st.tried || [];
        // execId : identifiant d'exécution persistant (compteur), recopié par l'exécuteur dans pending et lastPlaced.
        const execSeq = (Number.isInteger(st.execSeq) ? st.execSeq : 0) + 1;
        await set({ phase: 'EXEC', stake, execSeq, execId: `exec-${execSeq}`, lastPlaced: null, before: null,
          tried: tried.includes(st.event.href) ? tried : [...tried, st.event.href], playedKeys: [...(st.playedKeys || []), key] });
        return 'EXEC';
      },
      async EXEC(st) {
        if (st.pending) { await stop('pari incertain en cours : vérifier Mes paris + solde'); return 'STOPPED'; }
        // GARDE→EXEC remet lastPlaced à null : tout lastPlaced présent ici est un pari déjà placé, adopté, jamais rejoué.
        // Aucune comparaison d'horloge (Date.now n'est pas monotone).
        if (st.lastPlaced) {
          if (st.lastPlaced.execId !== st.execId) log('reprise : lastPlaced d\'une autre exécution, adopté par sécurité', st.lastPlaced.execId);
          return adoptLastPlaced(st);
        }
        const pk = st.pick;
        const before = st.dryRun ? null : await tracker.snapshotOngoing();
        if (!st.dryRun && !Array.isArray(before)) { await stop('suivi des paris indisponible'); return 'STOPPED'; }
        if (!st.dryRun) await set({ before });
        const decision = { marketTitle: pk.marketTitle, window: pk.window, label: pk.label, event: st.event.name,
          analysedOdds: pk.odds, suggestedStake: st.stake, confidence: pk.confidence, dryRun: st.dryRun, execId: st.execId };
        let r;
        try {
          r = await executor.place(decision);
        } finally {
          // L'exécuteur modifie le guard : on persiste l'instantané quoi qu'il arrive. Un pending restant contient sa réserve.
          const after = await store.get();
          const patch = { guardSnap: guard.snapshot() };
          if (after.pending && !after.pending.counted) patch.pending = { ...after.pending, reservedInSnap: true };
          await set(patch);
        }
        if (r && r.status === 'placed') { await set({ phase: 'ATTENTE', placedStake: r.stake }); return 'ATTENTE'; }
        if (!r || r.status === 'halt') { await stop((r && r.reason) || 'arrêt de l\'exécuteur'); return 'STOPPED'; }
        await set({ phase: 'PAUSE', pick: null, event: null });
        log(r.status === 'dry' ? 'pari à blanc' : 'pari refusé', r.reason);
        return 'PAUSE';
      },
      async ATTENTE(st) {
        const id = await tracker.identify(st.before || []);
        if (!id || id.method === 'none') { await stop('pari placé non identifié : vérifier Mes paris + solde'); return 'STOPPED'; }
        const bet = { ref: id.reference || null, method: id.method, stake: st.placedStake, status: 'pending', event: st.event.name };
        if (!bet.ref) {
          bet.prevBalance = await readers.readWalletStable(doc, sleep);
          if (typeof bet.prevBalance !== 'number') { await stop('pari sans référence et solde illisible : vérifier Mes paris + solde'); return 'STOPPED'; }
        }
        await set({ phase: 'PAUSE', bets: [...(st.bets || []), bet], before: null, pick: null, event: null });
        return 'PAUSE';
      },
      async PAUSE() {
        await sleep(pauseMs);
        await set({ phase: 'SCAN' });
        return 'SCAN';
      }
    };

    async function step() {
      if (foreign) return 'STOPPED';
      if (running) return lastPhase;
      running = true;
      let st;
      try {
        st = await store.get();
        if (st.stopped || st.phase === 'STOPPED') return (lastPhase = 'STOPPED');
        if (isOther(st)) { foreign = true; return (lastPhase = 'STOPPED'); }
        lastPhase = STATES.includes(st.phase) ? st.phase : 'IDLE';
        if (lastPhase === 'IDLE') return 'IDLE';
        if (!guard) { await stop('session sans garde-fous (init manquant)'); return 'STOPPED'; }
        lastPhase = await phases[lastPhase](st);
        return lastPhase;
      } catch (e) {
        await stop(`${(st && st.phase) || '?'} : ${msg(e)}`);
        return 'STOPPED';
      } finally {
        running = false;
      }
    }

    return { init, arm, step, stop: (reason) => stop(reason), STATES };
  }

  const api = { createController, PHRASE };
  if (isNode) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Controller = api;
})(globalThis);

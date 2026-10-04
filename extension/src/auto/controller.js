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
    const sports = Array.isArray(deps.sports) && deps.sports.length ? deps.sports : ['football', 'basketball'];
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
    // Le journal ne décide rien et ne doit jamais interrompre un pari : toute erreur est seulement journalisée.
    const note = async (fn) => {
      if (!deps.journal) return;
      try { await fn(deps.journal); } catch (e) { log('journal: écriture impossible', msg(e)); }
    };
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
        log('controller: init', { phase: st.phase || 'IDLE', stopped: !!st.stopped, ownerTabId: st.ownerTabId, tabId, pending: !!st.pending, hasSession: !!st.session });
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
        // Migration des anciennes simulations qui bloquaient leurs clés comme de vrais paris.
        if (st.dryRun === true && !st.pending && !st.lastPlaced && !bets.length && (!st.guardSnap || st.guardSnap.placed === 0)) {
          patch.playedKeys = [];
          patch.tried = [];
          patch.retryAfter = {};
        }
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

    const cooldown = (st, href) => ({
      tried: Array.from(new Set([...(st.tried || []), href])),
      retryAfter: { ...(st.retryAfter || {}), [href]: deps.now() + 30000 }
    });
    const markTried = (st, href) => set(cooldown(st, href));

    async function resolveBets(st) {
      const bets = Array.isArray(st.bets) ? st.bets : [];
      const open = bets.filter((b) => b.status === 'pending');
      if (!open.length) return;
      const out = [];
      for (const b of bets) {
        if (b.status !== 'pending') { out.push(b); continue; }
        const r = b.ref ? await tracker.resolve(b.ref) : 'pending';
        if (r === 'won' || r === 'lost') {
          guard.recordResult(r);
          await note((j) => j.update(b.execId, { outcome: r }));
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
      : (e) => (e && sports.includes(e.sport) ? 1 : 0);

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
      const bet = { ref: null, method: 'balance', stake: lp.stake, status: 'unverified', event: lp.event, prevBalance };
      await set({ bets: [...(st.bets || []), bet], before: null, pick: null, event: null });
      await stop('suivi impossible : vérifier Mes paris + solde');
      return 'STOPPED';
    }

    async function giveUp(st, href, reason = 'JEV : aucune nouvelle sélection exploitable') {
      await markTried(st, href);
      const message = `${reason}. Nouvelle recherche après la pause.`;
      log(message);
      await set({ phase: 'PAUSE', event: null, pick: null, message });
      return 'PAUSE';
    }

    const phases = {
      async IDLE() { return 'IDLE'; },
      async ARMED() { await set({ phase: 'SCAN' }); return 'SCAN'; },
      async SCAN(st) {
        if (doc.location.pathname !== LIVE_HREF) return (await go(LIVE_HREF)) ? 'SCAN' : 'STOPPED';
        await resolveBets(st);
        if (await endRules(st)) return 'STOPPED';
        // `tried` devient un délai de réanalyse, jamais une exclusion à vie.
        // Les clés de paris exécutés restent séparées et ne sont jamais effacées ici.
        const retryAfter = { ...(st.retryAfter || {}) };
        const time = deps.now();
        const tried = new Set((st.tried || []).filter((href) => {
          if (!Number.isFinite(retryAfter[href])) retryAfter[href] = time + 30000;
          return retryAfter[href] > time;
        }));
        const all = (scanner.scanLive(doc, sports) || []).filter(Boolean);
        const bet = new Set(st.betHrefs || []);
        const scanSummary = { total: all.length, tried: 0, sport: 0, paused: 0, bet: 0 };
        for (const e of all) {
          if (bet.has(e.href)) scanSummary.bet++;
          else if (!sports.includes(e.sport)) scanSummary.sport++;
          else if (!e.clock || !e.clock.running) scanSummary.paused++;
          else if (tried.has(e.href)) scanSummary.tried++;
        }
        // Un live sur lequel un pari est placé n'est plus jamais proposé pendant la session : on cherche un autre live.
        const events = all.filter((e) => !tried.has(e.href) && !bet.has(e.href));
        log('controller: scan', { summary: scanSummary, candidates: events.map(({ name, sport, clock }) => ({ name, sport, clock })) });
        await set({ phase: 'CHOIX', events, tried: [...tried], retryAfter, scanSummary, message: null, cycles: (st.cycles || 0) + 1 });
        return 'CHOIX';
      },
      async CHOIX(st) {
        const candidates = (st.events || []).filter((e) => sports.includes(e.sport) && e.clock && e.clock.running && safeUrl(e.href));
        const event = typeof deps.chooseEvent === 'function'
          ? (candidates.length ? await deps.chooseEvent(candidates) : null)
          : selector.pickEvent(st.events || [], new Set(st.tried || []), quickCountFor);
        log('controller: live chosen', { candidates: candidates.length, event: event && { name: event.name, sport: event.sport, clock: event.clock } });
        if (await store.stopFlag()) return 'STOPPED';
        if (deps.chooseEvent && event && !candidates.some((e) => e.href === event.href)) { await stop('JEV : live absent de la liste'); return 'STOPPED'; }
        if (!event) {
          const summary = st.scanSummary;
          const message = summary
            ? `Recherche : ${summary.total} détecté(s), ${summary.tried} déjà tenté(s) en attente de réanalyse, ${summary.paused} en pause/non démarré(s), ${summary.sport} hors sport Auto (${sports.join(', ')}), ${summary.bet || 0} déjà parié(s). Nouvelle recherche après la pause.`
            : 'Aucun événement en cours éligible : nouvelle recherche après la pause.';
          log(message);
          await set({ phase: 'PAUSE', events: null, message });
          return 'PAUSE';
        }
        const url = safeUrl(event.href);
        if (!url) { await stop('navigation refusée (hôte non vérifié) : ' + event.href); return 'STOPPED'; }
        await set({ phase: 'ANALYSE', event, events: null, message: null });
        deps.navigate(url);
        return 'ANALYSE';
      },
      async ANALYSE(st) {
        const event = st.event;
        const readEligible = () => deps.chooseEvent ? readMarkets() : selector.quickMarkets(readMarkets(), event.sport, cfg);
        let markets = readEligible();
        // Une navigation peut reprendre avant que les composants Angular aient rendu les marchés.
        const waitMs = Number.isFinite(cfg.slipWaitMs) ? cfg.slipWaitMs : 3000;
        const pollMs = Number.isFinite(cfg.pollMs) ? cfg.pollMs : 250;
        for (let waited = 0; !markets.length && waited < waitMs; waited += pollMs) {
          if (await store.stopFlag()) return 'STOPPED';
          await sleep(pollMs);
          markets = readEligible();
        }
        if (await store.stopFlag()) return 'STOPPED';
        const matches = markets.length ? await deps.analyze(markets, { event }) : [];
        log('controller: analysis', { markets: markets.length, matches });
        if (await store.stopFlag()) return 'STOPPED';
        const ranked = [...matches].sort((a, b) => {
          const score = (m) => Number.isFinite(m.jevScore) ? m.jevScore : Number.isFinite(m.confidence) ? m.confidence : -1;
          return score(b) - score(a);
        });
        const picks = deps.chooseEvent ? ranked.flatMap((match) => {
          const market = markets.find((m) => m.id === match.marketId);
          const option = market && market.options.find((o) => o.available && o.name === match.choice && Number.isFinite(o.odds));
          return option ? [{ marketId: market.id, label: option.name, odds: option.odds, confidence: match.confidence, jevScore: Number.isFinite(match.jevScore) ? match.jevScore : null, window: market.window || null }] : [];
        }) : selector.pickSelections(ranked, markets, cfg, event.sport);
        const p = picks.find((pick) => {
          const market = markets.find((m) => m.id === pick.marketId);
          return market && !(st.playedKeys || []).includes(playKey(event, { ...pick, marketTitle: market.title }));
        });
        const m = p && markets.find((x) => x.id === p.marketId);
        if (!p || !m || typeof m.title !== 'string') return giveUp(st, event.href);
        await set({ phase: 'GARDE', pick: { ...p, marketTitle: m.title } });
        return 'GARDE';
      },
      async GARDE(st) {
        if (await endRules(st)) return 'STOPPED';
        const key = playKey(st.event, st.pick);
        if ((st.playedKeys || []).includes(key)) { log('déjà joué dans la session', key); return giveUp(st, st.event.href); }
        const stake = deps.ticketSizing ? guard.maxStake(Number.MAX_SAFE_INTEGER) : guard.maxStake(await deps.stakeFor({ event: st.event, pick: st.pick }));
        if (!(stake > 0)) return giveUp(st, st.event.href, 'Aucune mise disponible');
        // Avant tout appel à l'exécuteur : événement tried et clé jouée persistés, lastPlaced remis à zéro.
        // execId : identifiant d'exécution persistant (compteur), recopié par l'exécuteur dans pending et lastPlaced.
        const execSeq = (Number.isInteger(st.execSeq) ? st.execSeq : 0) + 1;
        await set({ phase: 'EXEC', stake, execSeq, execId: `exec-${execSeq}`, lastPlaced: null, before: null,
          ...cooldown(st, st.event.href), playedKeys: [...(st.playedKeys || []), key] });
        await note((j) => j.record({ execId: `exec-${execSeq}`, dryRun: !!st.dryRun, stake,
          event: { name: st.event.name, sport: st.event.sport, score: st.event.score || null, clock: st.event.clock || null },
          pick: { marketTitle: st.pick.marketTitle, window: st.pick.window, label: st.pick.label, odds: st.pick.odds, confidence: st.pick.confidence, jevScore: st.pick.jevScore == null ? null : st.pick.jevScore } }));
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
        log('controller: tracking snapshot', { dryRun: st.dryRun, available: Array.isArray(before), count: Array.isArray(before) ? before.length : null });
        if (!st.dryRun && !Array.isArray(before)) {
          await stop('suivi des paris indisponible', { message: 'Aucun pari validé : la page Mes paris ne devient pas lisible. Vérifier sa page chargée avant de réarmer.' });
          return 'STOPPED';
        }
        if (!st.dryRun) await set({ before });
        const decision = { marketTitle: pk.marketTitle, window: pk.window, label: pk.label, event: st.event.name,
          analysedOdds: pk.odds, suggestedStake: st.stake, confidence: pk.confidence, jevScore: pk.jevScore == null ? null : pk.jevScore, dryRun: st.dryRun, execId: st.execId };
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
        await note((j) => j.update(st.execId, { outcome: !r ? 'halt' : r.status === 'refused' ? 'refused' : r.status, stake: r && Number.isFinite(r.stake) ? r.stake : st.stake, reason: (r && r.reason) || null }));
        if (r && r.status === 'placed') { await set({ phase: 'ATTENTE', placedStake: r.stake }); return 'ATTENTE'; }
        if (!r || r.status === 'halt') { await stop((r && r.reason) || 'arrêt de l\'exécuteur'); return 'STOPPED'; }
        const patch = { phase: 'PAUSE', pick: null, event: null, ...cooldown(st, st.event.href) };
        // Une simulation unique suffit : aucune nouvelle exécution sans réarmement explicite.
        if (r.status === 'dry') {
          patch.playedKeys = (st.playedKeys || []).filter((key) => key !== playKey(st.event, st.pick));
          patch.message = `Simulation terminée : mise ${r.stake} €, aucun pari payé. Le mode réel nécessite de décocher « À blanc » puis de réarmer.`;
          await stop('simulation à blanc terminée', patch);
          return 'STOPPED';
        }
        patch.message = `Pari non placé : ${r.reason || 'refus sans motif'}. Nouvelle recherche après la pause.`;
        await set(patch);
        log('pari refusé', r.reason);
        return 'PAUSE';
      },
      async ATTENTE(st) {
        const id = await tracker.identify(st.before || []);
        log('controller: identification', id);
        if (!id || id.method === 'none') { await stop('pari placé non identifié : vérifier Mes paris + solde'); return 'STOPPED'; }
        if (id.method !== 'reference' || !id.reference) {
          // Pas de référence : le pari n'est pas suivable. Il reste compté (réserve bloquée), la session s'arrête.
          const prevBalance = await readers.readWalletStable(doc, sleep);
          const ub = { ref: null, method: id.method, stake: st.placedStake, status: 'unverified', event: st.event.name, prevBalance: typeof prevBalance === 'number' ? prevBalance : null };
          await set({ bets: [...(st.bets || []), ub], before: null, pick: null, event: null });
          await stop('suivi impossible : vérifier Mes paris + solde');
          return 'STOPPED';
        }
        const bet = { ref: id.reference, method: id.method, stake: st.placedStake, status: 'pending', event: st.event.name, execId: st.execId || null };
        // Pari identifié : le live est marqué parié et on repart tout de suite chercher un autre live (SCAN navigue vers /live), sans pause.
        await set({ phase: 'SCAN', bets: [...(st.bets || []), bet], betHrefs: Array.from(new Set([...(st.betHrefs || []), st.event.href])), before: null, pick: null, event: null,
          message: `Pari placé sur « ${st.event.name} ». Recherche d'un autre live sans pari.` });
        log('controller: pari placé, retour à la recherche de live', { event: st.event.name });
        return 'SCAN';
      },
      async PAUSE() {
        log('controller: pause', { pauseMs });
        await sleep(pauseMs);
        if (await store.stopFlag()) return 'STOPPED';
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
        const from = lastPhase, started = deps.now();
        log('controller: step', { phase: from, cycles: st.cycles, dryRun: st.dryRun, event: st.event && st.event.name, pick: st.pick && st.pick.label, pending: !!st.pending, guard: guard.snapshot() });
        lastPhase = await phases[lastPhase](st);
        log('controller: transition', { from, to: lastPhase, elapsedMs: deps.now() - started });
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

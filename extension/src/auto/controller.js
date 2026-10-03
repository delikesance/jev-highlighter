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
    const { store, scanner, selector, executor, guard, tracker, cfg, tabId, settings } = deps;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const sleep = deps.sleep;
    const pauseMs = Number.isFinite(cfg && cfg.pauseMs) ? cfg.pauseMs : 5000;
    // Seule mémoire locale : cet onglet n'est pas le propriétaire de la session (on ne doit pas écrire dans l'état de l'autre).
    let foreign = false;

    const secretLeaked = () => !!settings && typeof settings === 'object' && Object.keys(settings).some((k) => SECRET_RE.test(k));

    async function stop(reason, extra) {
      log('ARRÊT', reason);
      if (foreign) return;
      try {
        await store.set({ ...(extra || {}), phase: 'STOPPED', stopped: true, reason: String(reason) });
      } catch (e) { log('stop: écriture impossible', String(e)); }
    }

    async function init() {
      try {
        if (secretLeaked()) { await stop('clé secrète présente dans la page'); return 'STOPPED'; }
        const st = await store.get();
        if (st.ownerTabId != null && st.ownerTabId !== tabId) {
          foreign = true;
          log('ARRÊT', 'session Auto armée dans un autre onglet');
          return 'STOPPED';
        }
        if (st.pending) {
          const stake = st.pending.stake;
          guard.reserve(stake);
          guard.recordPlaced();
          const message = 'Pari incertain (« validation en cours ») : vérifier Mes paris + solde avant de réarmer';
          log(message, st.pending);
          await stop('pari incertain à la reprise', { message });
          return 'STOPPED';
        }
        if (st.stopped) return 'STOPPED';
        return STATES.includes(st.phase) ? st.phase : 'IDLE';
      } catch (e) {
        await stop('init : ' + String(e && e.message || e));
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
        if (secretLeaked()) { await stop('clé secrète présente dans la page'); return; }
        const st = await store.get();
        if (st.pending && o.manualCheckDone !== true) { log('armement refusé : vérification manuelle requise'); return; }
        const patch = { phase: 'ARMED', stopped: false, reason: null, message: null, dryRun: o.dryRun, ownerTabId: tabId,
          pending: null, event: null, pick: null, before: null };
        if (!Array.isArray(st.tried)) patch.tried = [];
        if (!Array.isArray(st.bets)) patch.bets = [];
        await store.set(patch);
        log('armé', { dryRun: o.dryRun });
      } catch (e) { await stop('arm : ' + String(e && e.message || e)); }
    }

    function safeHref(href) {
      if (typeof href !== 'string' || href === '') return false;
      if (href.startsWith('/')) return !href.startsWith('//') && !href.startsWith('/\\');
      try {
        const loc = deps.doc.location;
        return new URL(href, loc.href).origin === loc.origin;
      } catch (e) { return false; }
    }

    async function go(href) {
      if (!safeHref(href)) { await stop('navigation refusée (hôte non vérifié) : ' + href); return false; }
      deps.navigate(href);
      return true;
    }

    const set = (p) => store.set(p);
    const markTried = async (st, href) => set({ tried: [...(st.tried || []), href] });

    async function resolveBets(st) {
      const bets = Array.isArray(st.bets) ? st.bets : [];
      if (!bets.some((b) => b.status === 'pending')) return;
      const out = [];
      for (const b of bets) {
        if (b.status !== 'pending') { out.push(b); continue; }
        const r = await tracker.resolve(b.ref);
        if (r === 'won' || r === 'lost') {
          guard.recordResult(r);
          guard.release(b.stake);
          out.push({ ...b, status: r });
        } else out.push(b);
      }
      await set({ bets: out });
    }

    // Vérifie les règles de fin ; renvoie vrai si la session s'arrête.
    async function endRules() {
      const v = guard.check(null);
      if (v.verdict === 'ARRET') { await stop(v.reason); return true; }
      if (guard.state.placed >= Math.min(cfg.maxBets, 5)) { await stop('limite de session atteinte'); return true; }
      return false;
    }

    const quickCountFor = typeof deps.quickCountFor === 'function'
      ? deps.quickCountFor
      : (e) => (e && (e.sport === 'football' || e.sport === 'basketball') ? 1 : 0);

    function readMarkets() {
      const parsed = deps.parseMarkets(deps.doc);
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.markets) ? parsed.markets : [];
      const dedupe = typeof deps.dedupeMarkets === 'function' ? deps.dedupeMarkets : Parser.dedupeMarkets;
      return dedupe(list).filter((m) => m && m.suspended !== true);
    }

    const phases = {
      async IDLE() { return 'IDLE'; },
      async ARMED() { await set({ phase: 'SCAN' }); return 'SCAN'; },
      async SCAN(st) {
        await resolveBets(st);
        if (await endRules()) return 'STOPPED';
        const tried = new Set(st.tried || []);
        const events = (scanner.scanLive(deps.doc) || []).filter((e) => e && !tried.has(e.href));
        await set({ phase: 'CHOIX', events });
        return 'CHOIX';
      },
      async CHOIX(st) {
        const event = selector.pickEvent(st.events || [], new Set(st.tried || []), quickCountFor);
        if (!event) { await set({ phase: 'PAUSE', events: null }); return 'PAUSE'; }
        if (!safeHref(event.href)) { await stop('navigation refusée (hôte non vérifié) : ' + event.href); return 'STOPPED'; }
        await set({ phase: 'ANALYSE', event, events: null });
        deps.navigate(event.href);
        return 'ANALYSE';
      },
      async ANALYSE(st) {
        const event = st.event;
        const markets = selector.quickMarkets(readMarkets(), event.sport, cfg);
        const matches = markets.length ? await deps.analyze(markets, { event }) : [];
        const picks = selector.pickSelections(matches, markets, cfg, event.sport);
        if (!picks.length) {
          await markTried(st, event.href);
          await set({ phase: 'SCAN', event: null });
          if (!(await go(LIVE_HREF))) return 'STOPPED';
          return 'SCAN';
        }
        const p = picks[0];
        const m = markets.find((x) => x.id === p.marketId);
        await set({ phase: 'GARDE', pick: { ...p, marketTitle: m.title } });
        return 'GARDE';
      },
      async GARDE(st) {
        if (await endRules()) return 'STOPPED';
        const suggested = await deps.stakeFor({ event: st.event, pick: st.pick });
        const stake = guard.maxStake(suggested);
        if (!(stake > 0)) {
          await markTried(st, st.event.href);
          await set({ phase: 'SCAN', event: null, pick: null });
          return (await go(LIVE_HREF)) ? 'SCAN' : 'STOPPED';
        }
        await set({ phase: 'EXEC', stake });
        return 'EXEC';
      },
      async EXEC(st) {
        const pk = st.pick;
        const before = st.dryRun ? null : await tracker.snapshotOngoing();
        if (!st.dryRun && !Array.isArray(before)) { await stop('suivi des paris indisponible'); return 'STOPPED'; }
        const decision = { marketTitle: pk.marketTitle, window: pk.window, label: pk.label, event: st.event.name,
          analysedOdds: pk.odds, suggestedStake: st.stake, confidence: pk.confidence, dryRun: st.dryRun };
        const r = await executor.place(decision);
        const tried = [...(st.tried || []), st.event.href];
        if (r.status === 'placed') { await set({ phase: 'ATTENTE', before, tried, placedStake: r.stake }); return 'ATTENTE'; }
        if (r.status === 'halt') { await stop(r.reason || 'arrêt de l\'exécuteur'); return 'STOPPED'; }
        await set({ phase: 'PAUSE', tried, pick: null, event: null });
        log(r.status === 'dry' ? 'pari à blanc' : 'pari refusé', r.reason);
        return 'PAUSE';
      },
      async ATTENTE(st) {
        const id = await tracker.identify(st.before || []);
        if (!id || id.method === 'none') { await stop('pari placé non identifié : vérifier Mes paris + solde'); return 'STOPPED'; }
        const bet = { ref: id.reference || null, method: id.method, stake: st.placedStake, status: 'pending', event: st.event.name };
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
      let st;
      try {
        st = await store.get();
        if (st.stopped || st.phase === 'STOPPED') return 'STOPPED';
        if (st.ownerTabId != null && st.ownerTabId !== tabId) { foreign = true; return 'STOPPED'; }
        const fn = phases[st.phase] || phases.IDLE;
        return await fn(st);
      } catch (e) {
        await stop(`${st && st.phase || '?'} : ${String(e && e.message || e)}`);
        return 'STOPPED';
      }
    }

    return { init, arm, step, stop: (reason) => stop(reason), STATES };
  }

  const api = { createController, PHRASE };
  if (isNode) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Controller = api;
})(globalThis);

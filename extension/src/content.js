/**
 * Orchestrateur : parse -> fingerprint -> (cache | requête JEV) -> vérif fingerprint -> highlight.
 * N'effectue AUCUNE action de pari : lecture du DOM + ajout de styles/badges uniquement.
 */
(function (root) {
  const J = root.JEV;
  if (!J || J.__contentStarted) return;
  J.__contentStarted = true;
  const {
    CONFIG, log, warn, setDebug, debounce, normalizeText, parseMarkets, buildRequest, matchAnswers, toPlain,
    readWallet, readSlip, slipFingerprint, suggestStake, rankPicks, Highlighter, Picks, Reorder, StakeUI, UI, Storage, MatchContext
  } = J;

  const st = {
    settings: { ...Storage.DEFAULTS },
    cache: new Map(), // fingerprint global -> { answers, model, sentIds }
    seq: 0,
    inflight: null, // { requestId, fp }
    lastSentAt: 0,
    cooldownUntil: 0,
    status: 'idle', // idle | analyzing | done | stale | no-markets | error
    error: null,
    url: location.href,
    stats: { markets: 0, selections: 0, availableSelections: 0 },
    analysed: 0,
    recs: [],
    best: null,
    parsed: null
  };

  const send = (msg) => chrome.runtime.sendMessage(msg);

  /** Met à jour bloc de picks, dock et réordonnancement à partir de l'état courant. */
  function refreshUI(parsed) {
    if (parsed) st.parsed = parsed;
    const p = st.parsed;
    const ranked = rankPicks(st.recs);
    const first = p && p.list[0];
    Picks.render({
      ranked,
      best: st.best,
      analysed: st.analysed,
      anchor: first ? first.container : null,
      hasMarkets: !!(p && p.list.length),
      status: st.status,
      error: st.error,
      settings: st.settings
    });
    if (st.settings.reorderPicks && ranked.length) Reorder.applyOrder(ranked.map((r) => r.container));
    else Reorder.restoreOrder();
  }

  function setStatus(status, error = null) {
    st.status = status;
    st.error = error;
    Highlighter.setState(status === 'analyzing' ? 'loading' : status === 'stale' ? 'stale' : status === 'error' ? 'error' : '');
  }

  function cacheSet(fp, entry) {
    st.cache.set(fp, entry);
    while (st.cache.size > CONFIG.cacheMaxEntries) st.cache.delete(st.cache.keys().next().value);
  }

  function abortInflight() {
    if (!st.inflight) return;
    send({ type: 'JEV_ABORT', requestId: st.inflight.requestId }).catch(() => {});
    st.inflight = null;
  }

  function applyEntry(parsed, entry) {
    const m = matchAnswers(parsed.markets, entry.answers, { expectedIds: entry.sentIds });
    for (const r of m.recommendations)
      log(`${r.marketId} -> ${r.choice} (${typeof r.jevScore === 'number' ? r.jevScore.toFixed(2) : 'n/a'})`);
    if (!Highlighter.isUpToDate(m.recommendations, m.best)) Highlighter.apply(m.recommendations, m.best);
    else Highlighter.reposition();
    st.recs = m.recommendations;
    st.best = m.best;
    st.analysed = Object.keys(entry.answers).length;
    setStatus('done');
    refreshUI(parsed);
  }

  /** Mode debug : le corps exact envoyé à JEV (aucune clé : elle n'existe que dans le service worker). */
  function logPrompt(label, body) {
    log(`Prompt sent to JEV [${label}]:\n${JSON.stringify(body, null, 2)}`);
  }

  async function analyze({ force = false } = {}) {
    const parsed = parseMarkets(document);
    st.stats = parsed.stats;
    log(`${parsed.stats.markets} markets detected`);

    if (!parsed.list.length) {
      Highlighter.clear();
      st.recs = [];
      st.best = null;
      st.analysed = 0;
      setStatus('no-markets');
      refreshUI(parsed);
      return;
    }

    const fp = parsed.fingerprint;
    if (!force) {
      const cached = st.cache.get(fp);
      if (cached) {
        log('Fingerprint unchanged, using cached result');
        applyEntry(parsed, cached);
        return;
      }
      if (st.inflight && st.inflight.fp === fp) return;
    }

    // Contexte du match (forme, classement, face-à-face, live) : lu sur `<match>/match-center`, jamais bloquant.
    const matchKey = MatchContext.keyFromPath(location.pathname);
    let matchContext = null;
    if (matchKey && st.settings.matchContext) {
      setStatus('analyzing');
      matchContext = await MatchContext.get(matchKey); // rafraîchi seulement s'il dépasse CONFIG.context.ttlMs
      log(matchContext ? `Match context ready (${Object.keys(matchContext).join(', ')})` : 'No match context');
    }

    if (!force && st.settings.autoMode && auto.active) return; // contexte terminé après l'armement
    log('Building evaluation request');
    const built = buildRequest(parsed, { pageTitle: document.title, pagePath: location.pathname, matchContext });
    if (!built.questionCount) {
      setStatus('no-markets', 'Aucun marché évaluable (moins de 2 sélections disponibles)');
      refreshUI(parsed);
      return;
    }

    abortInflight();
    const requestId = ++st.seq;
    st.inflight = { requestId, fp };
    setStatus('analyzing');
    refreshUI(parsed);
    st.lastSentAt = Date.now();
    log(`Sending ${built.questionCount} questions`);
    logPrompt('analysis', built.body);

    let res;
    try {
      res = await send({ type: 'JEV_EVALUATE', requestId, body: built.body });
    } catch (e) {
      res = { ok: false, error: { code: 'extension', message: e.message } };
    }
    if (!st.inflight || st.inflight.requestId !== requestId) {
      log('Stale response ignored');
      return;
    }
    st.inflight = null;

    if (!res || !res.ok) {
      const err = (res && res.error) || { code: 'unknown', message: 'Réponse vide' };
      if (err.code === 'aborted') return;
      if (err.code === 'rate_limited') st.cooldownUntil = Date.now() + CONFIG.cooldownAfterRateLimitMs;
      setStatus('error', err.message);
      refreshUI();
      log(`Error: ${err.code} ${err.message}`);
      return;
    }
    log(`Response received in ${res.ms}ms`);

    // Le DOM a-t-il changé pendant la requête ? Si oui on ne applique pas un résultat périmé.
    const after = parseMarkets(document);
    if (after.fingerprint !== fp) {
      log('DOM changed during request, result discarded');
      setStatus('stale');
      refreshUI(after);
      if (st.settings.autoAnalyze) scheduleTick();
      return;
    }
    const entry = { answers: res.data.answers, model: res.data.model, sentIds: built.sentIds };
    cacheSet(fp, entry);
    applyEntry(after, entry);
  }

  // ------------------------------------------------------------------ auto-analyse (MutationObserver)

  const tick = async () => {
    if (st.settings.autoMode && auto.active) return; // un seul pilote automatique des requêtes
    if (/\/match-center\/?$/.test(location.pathname)) {
      // On est sur la page match-center : on mémorise ce qui s'affiche (source passive du contexte).
      if (st.settings.matchContext) MatchContext.ingestDocument(document, MatchContext.keyFromPath(location.pathname));
      return;
    }
    const parsed = parseMarkets(document);
    const cached = st.cache.get(parsed.fingerprint);
    if (!st.recs.length) refreshUI(parsed); // affiche le dock dès que des marchés sont présents
    if (cached && st.recs.length) {
      applyEntry(parsed, cached); // idempotent : ré-applique si la SPA a re-rendu les boutons
      return;
    }
    if (st.recs.length && st.status !== 'analyzing') {
      setStatus('stale'); // une cote a bougé : les marqueurs deviennent « périmés » (↻)
      refreshUI(parsed);
    }
    if (!st.settings.autoAnalyze) return;
    const now = Date.now();
    const wait = Math.max(st.lastSentAt + CONFIG.minIntervalMs - now, st.cooldownUntil - now, 0);
    if (wait > 0 && !cached) {
      setTimeout(scheduleTick, wait);
      return;
    }
    await analyze();
  };
  const scheduleTick = debounce(tick, CONFIG.debounceMs, CONFIG.debounceMaxWaitMs);

  // ------------------------------------------------------------------ suggestion de mise

  const stakeState = { fp: null, runId: 0, requestId: null };

  function abortStake() {
    stakeState.runId++;
    if (stakeState.requestId != null) send({ type: 'JEV_ABORT', requestId: stakeState.requestId }).catch(() => {});
    stakeState.requestId = null;
  }

  /** Préférence JEV connue pour une sélection du ticket (si elle a été analysée sur la page). */
  function jevPreferenceFor(sel) {
    const choice = normalizeText(sel.selection);
    const market = normalizeText(sel.market);
    const rec = st.recs.find((r) => {
      const title = normalizeText(r.marketTitle);
      return normalizeText(r.choice) === choice && (title === market || title.includes(market) || market.includes(title));
    });
    return rec ? { jev_preference: rec.jevScore, jev_confidence: rec.confidence } : { jev_preference: null, jev_confidence: null };
  }

  async function stakeTick() {
    if (st.settings.autoMode && auto.active) return;
    if (!st.settings.stakeAdvice) {
      log('Stake advice disabled');
      abortStake();
      stakeState.fp = null;
      StakeUI.hide();
      return;
    }
    const wallet = readWallet(document);
    const slip = readSlip(document);
    if (!wallet || !slip.selections.length || !slip.totalOdds || !slip.stakeInput) {
      log(
        `Stake skipped: wallet=${wallet} selections=${slip.selections.length} totalOdds=${slip.totalOdds} stakeInput=${!!slip.stakeInput}`
      );
      abortStake();
      stakeState.fp = null;
      StakeUI.hide();
      return;
    }
    const fp = slipFingerprint(wallet, slip);
    if (fp === stakeState.fp) {
      StakeUI.reposition();
      return;
    }
    if (Date.now() < st.cooldownUntil) {
      setTimeout(scheduleStake, st.cooldownUntil - Date.now());
      return;
    }

    abortStake();
    stakeState.fp = fp;
    const runId = stakeState.runId;
    const ctx = {
      wallet,
      totalOdds: slip.totalOdds,
      selections: slip.selections.map((s) => ({ ...s, ...jevPreferenceFor(s) })),
      matchContext: st.settings.matchContext ? MatchContext.peek(MatchContext.keyFromPath(location.pathname)) : null
    };
    log(`Stake sizing: wallet ${wallet}, ${ctx.selections.length} selection(s), odds ${ctx.totalOdds}`);
    StakeUI.showStatus('calcul de la mise…', slip.stakeInput);

    const ask = async (body) => {
      if (runId !== stakeState.runId) throw Object.assign(new Error('aborted'), { code: 'aborted' });
      const requestId = ++st.seq;
      stakeState.requestId = requestId;
      log(`Sending stake question (round ${body.state.round})`);
      logPrompt(`stake round ${body.state.round}`, body);
      const res = await send({ type: 'JEV_EVALUATE', requestId, body });
      if (runId !== stakeState.runId) throw Object.assign(new Error('aborted'), { code: 'aborted' });
      if (!res || !res.ok) {
        const e = (res && res.error) || { code: 'unknown', message: 'Réponse vide' };
        throw Object.assign(new Error(e.message), { code: e.code });
      }
      return res.data.answers;
    };

    try {
      const result = await suggestStake(ctx, ask);
      if (runId !== stakeState.runId) return;
      log(result.none ? `Stake: none (${result.reason})` : `Stake suggestion: ${result.amount} EUR`);
      StakeUI.show(result, ctx, slip.stakeInput);
    } catch (e) {
      if (e.code === 'aborted' || runId !== stakeState.runId) return;
      if (e.code === 'rate_limited') st.cooldownUntil = Date.now() + CONFIG.cooldownAfterRateLimitMs;
      log(`Stake error: ${e.code || ''} ${e.message}`);
      StakeUI.showStatus(`erreur : ${e.message}`, slip.stakeInput, true);
    }
  }
  const scheduleStake = debounce(stakeTick, CONFIG.stake.debounceMs, CONFIG.stake.debounceMaxWaitMs);

  const stripJev = (s) => (s || '').split(/\s+/).filter((c) => c && !c.startsWith('jev-')).sort().join(' ');
  function isOwnMutation(m) {
    const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    if (t && t.closest(`[${UI.HOST_ATTR}]`)) return true; // tout ce qui est dans nos hôtes
    if (m.type === 'attributes') return m.attributeName === 'class' && stripJev(m.oldValue) === stripJev(m.target.getAttribute('class'));
    if (m.type === 'childList') return [...m.addedNodes, ...m.removedNodes].every(UI.isHostNode);
    return false;
  }

  const observer = new MutationObserver((muts) => {
    const real = muts.filter((m) => !isOwnMutation(m));
    if (!real.length) return;
    scheduleTick();
    // la mise ne dépend que du ticket et du solde : on ignore le bruit du reste de la page (chrono, vidéo, scores…)
    const roots = CONFIG.selectors.slip.watchRoots;
    const touchesSlip = real.some((m) => {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      return !!el && !!el.closest && !!el.closest(roots);
    });
    if (touchesSlip) scheduleStake();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'disabled', 'aria-disabled'],
    attributeOldValue: true
  });

  // ------------------------------------------------------------------ navigation SPA

  function checkUrl() {
    if (location.href === st.url) return;
    st.url = location.href;
    log('SPA navigation detected');
    abortInflight();
    Highlighter.clear();
    st.recs = [];
    st.best = null;
    st.analysed = 0;
    setStatus('idle');
    refreshUI(parseMarkets(document));
    scheduleTick();
  }
  setInterval(checkUrl, CONFIG.urlPollMs);
  window.addEventListener('popstate', checkUrl);
  if (window.navigation) window.navigation.addEventListener('navigatesuccess', checkUrl);
  window.addEventListener('resize', debounce(() => Highlighter.reposition(), 200));

  // ------------------------------------------------------------------ popup <-> content

  function snapshot() {
    const parsed = parseMarkets(document);
    return {
      status: st.status,
      error: st.error,
      stats: parsed.stats,
      analysed: st.analysed,
      best: toPlain(st.best),
      recommendations: st.recs.length,
      context: MatchContext.status(MatchContext.keyFromPath(location.pathname))
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg.type === 'JEV_ANALYZE') await analyze({ force: true });
      else if (msg.type === 'JEV_CLEAR') {
        Highlighter.clear();
        st.recs = [];
        st.best = null;
        setStatus('idle');
        refreshUI();
      }
      sendResponse(snapshot());
    })();
    return true;
  });

  // ------------------------------------------------------------------ mode Auto (expert, désactivé par défaut)
  // autoMode faux => rien ici ne s'exécute. Jamais d'armement automatique : seul le bouton « Armer » du panneau arme.

  const auto = { started: false, active: false, rt: null, ui: null, timer: null, running: false, cancelled: false, stop: null };

  async function startAuto() {
    if (window !== window.top) return; // jamais de runtime Auto dans un sous-cadre
    const A = J.Auto;
    if (auto.started || !A || !A.Wiring || !A.UI) return;
    auto.started = true;
    const now = Date.now; // horloge UNIQUE
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const alog = (...a) => {
      console.log('[JEV][auto]', new Date(now()).toISOString(), location.pathname, ...a);
      if (auto.ui) auto.ui.addLog(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 1500));
    };
    let tabId = null;
    try { tabId = ((await send({ type: 'JEV_TAB_ID' })) || {}).tabId; } catch (e) { tabId = null; }
    if (tabId == null) { warn('Mode Auto : identifiant d\'onglet indisponible'); return; }

    const askJev = async (body) => {
      const requestId = ++st.seq, started = now();
      alog('JEV: request', { requestId, task: body.state && body.state.task, questions: Object.keys(body.questions || {}), state: body.state, criteria: Object.fromEntries(Object.entries(body.questions || {}).map(([id, q]) => [id, q.criteria])) });
      let res;
      try { res = await send({ type: 'JEV_EVALUATE', requestId, body: { model: CONFIG.JEV.model, ...body } }); }
      catch (e) { alog('JEV: transport error', { requestId, elapsedMs: now() - started, message: e.message }); throw e; }
      const answers = res && res.data && res.data.answers;
      alog('JEV: response', { requestId, elapsedMs: now() - started, ok: !!(res && res.ok), answers: Object.fromEntries(Object.entries(answers || {}).map(([id, a]) => [id, { choice: a && a.choice, confidence: a && a.confidence, probabilities: a && a.probabilities }])), error: res && res.error });
      if (!res || !res.ok) {
        const e = (res && res.error) || { code: 'unknown', message: 'Réponse vide' };
        throw Object.assign(new Error(e.message), { code: e.code });
      }
      return res.data.answers;
    };
    async function chooseEvent(events) {
      alog('JEV : choix du live', events.map(({ name, sport, clock, score }) => ({ name, sport, clock, score })));
      return A.Decisions.chooseEvent(events, askJev);
    }
    async function analyzeAuto(markets, ctx) {
      const matchKey = MatchContext.keyFromPath(location.pathname);
      const matchContext = matchKey && st.settings.matchContext ? MatchContext.peek(matchKey) : null;
      alog('JEV : choix du pari', markets.length);
      return A.Decisions.choosePick(markets, { event: ctx && ctx.event, match_context: matchContext }, askJev);
    }
    async function stakeFromTicket({ slip, wallet, decision }) {
      if (typeof wallet !== 'number' || !(slip.odds > 0)) return null;
      alog('JEV : choix de la mise', { wallet, odds: slip.odds });
      const ctx = {
        wallet,
        totalOdds: slip.odds,
        selections: [{ event: slip.event, market: slip.market, selection: slip.selection, odds: slip.odds, jev_preference: null, jev_confidence: decision.confidence }],
        matchContext: null
      };
      const r = await suggestStake(ctx, askJev);
      alog('JEV: stake result', r);
      return r.none ? null : r.amount;
    }

    const rt = A.Wiring.createRuntime({
      chromeApi: chrome, doc: document, tabId, settings: st.settings, cfg: CONFIG.auto, modules: A, now, sleep, log: alog,
      chooseEvent, analyze: analyzeAuto, stakeFromTicket, parseMarkets: (d) => parseMarkets(d).list, navigate: (url) => location.assign(url)
    });
    auto.rt = rt;
    const status = async () => ({ ...(await rt.store.get()), balance: A.Readers.readWallet(document) });
    const refresh = () => status().then((s) => auto.ui && auto.ui.refresh(s)).catch(() => {});

    // Planificateur séquentiel : un seul step() à la fois, le suivant n'est programmé qu'après la fin du précédent.
    const schedule = () => {
      if (auto.cancelled || auto.timer || auto.running) return;
      auto.timer = setTimeout(loop, CONFIG.auto.stepMs);
    };
    async function loop() {
      auto.timer = null;
      if (auto.cancelled) return;
      auto.running = true;
      let r = 'STOPPED';
      try { r = await rt.controller.step(); } catch (e) { await rt.stop('step : ' + (e && e.message)); }
      auto.running = false;
      auto.active = r !== 'STOPPED' && r !== 'IDLE';
      refresh();
      if (r !== 'STOPPED' && r !== 'IDLE') schedule();
    }

    auto.stop = async (reason) => {
      auto.cancelled = true;
      clearTimeout(auto.timer);
      auto.timer = null;
      await rt.stop(reason);
      auto.active = false;
      refresh();
    };
    auto.ui = A.UI.mount(
      {
        stop: auto.stop,
        arm: async (phrase, o) => {
          if (!st.settings.autoMode) return;
          auto.active = true;
          abortInflight(); abortStake();
          await rt.controller.arm(phrase, o);
          const s = await status();
          auto.active = !s.stopped && s.phase !== 'STOPPED' && s.phase !== 'IDLE';
          auto.ui.refresh(s);
          if (s.phase === 'ARMED' && !s.stopped) { auto.cancelled = false; schedule(); }
        }
      },
      { doc: document, getStatus: status }
    );
    auto.active = true;
    const r = await rt.controller.init();
    auto.active = r !== 'STOPPED' && r !== 'IDLE';
    if (auto.active) { abortInflight(); abortStake(); }
    refresh();
    if (r !== 'STOPPED' && r !== 'IDLE') schedule();
  }

  // ------------------------------------------------------------------ démarrage

  Storage.getSettings().then((s) => {
    st.settings = s;
    setDebug(s.debug);
    refreshUI(parseMarkets(document));
    scheduleTick();
    scheduleStake();
    if (s.autoMode === true) startAuto().catch((e) => warn('Mode Auto', e && e.message));
  });
  Storage.onSettingsChanged((patch) => {
    Object.assign(st.settings, patch);
    if ('debug' in patch) setDebug(patch.debug);
    if (patch.autoAnalyze) scheduleTick();
    if (['autoAnalyze', 'reorderPicks', 'dockOpen', 'dockCollapsed'].some((k) => k in patch)) refreshUI();
    if ('matchContext' in patch) st.cache.clear(); // le contexte change la requête : on ré-analysera
    if (patch.autoMode === true) startAuto().catch((e) => warn('Mode Auto', e && e.message));
    else if (patch.autoMode === false && auto.stop) auto.stop('Mode Auto désactivé').catch(() => {});
    if ('stakeAdvice' in patch) {
      stakeState.fp = null;
      scheduleStake();
    }
  });
})(globalThis);

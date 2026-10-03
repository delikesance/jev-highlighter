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

  // ------------------------------------------------------------------ démarrage

  Storage.getSettings().then((s) => {
    st.settings = s;
    setDebug(s.debug);
    refreshUI(parseMarkets(document));
    scheduleTick();
    scheduleStake();
  });
  Storage.onSettingsChanged((patch) => {
    Object.assign(st.settings, patch);
    if ('debug' in patch) setDebug(patch.debug);
    if (patch.autoAnalyze) scheduleTick();
    if (['autoAnalyze', 'reorderPicks', 'dockOpen', 'dockCollapsed'].some((k) => k in patch)) refreshUI();
    if ('matchContext' in patch) st.cache.clear(); // le contexte change la requête : on ré-analysera
    if ('stakeAdvice' in patch) {
      stakeState.fp = null;
      scheduleStake();
    }
  });
})(globalThis);

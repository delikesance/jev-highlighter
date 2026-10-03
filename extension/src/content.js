/**
 * Orchestrateur : parse -> fingerprint -> (cache | requête JEV) -> vérif fingerprint -> highlight.
 * N'effectue AUCUNE action de pari : lecture du DOM + ajout de styles/badges uniquement.
 */
(function (root) {
  const J = root.JEV;
  if (!J || J.__contentStarted) return;
  J.__contentStarted = true;
  const { CONFIG, log, warn, setDebug, debounce, parseMarkets, buildRequest, matchAnswers, toPlain, Highlighter, Storage } = J;

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
    best: null
  };

  const send = (msg) => chrome.runtime.sendMessage(msg);

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
    st.status = 'done';
    st.error = null;
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
      st.status = 'no-markets';
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

    log('Building evaluation request');
    const built = buildRequest(parsed, { pageTitle: document.title, pagePath: location.pathname });
    if (!built.questionCount) {
      st.status = 'no-markets';
      st.error = 'Aucun marché évaluable (moins de 2 sélections disponibles)';
      return;
    }

    abortInflight();
    const requestId = ++st.seq;
    st.inflight = { requestId, fp };
    st.status = 'analyzing';
    st.error = null;
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
      st.status = 'error';
      st.error = err.message;
      log(`Error: ${err.code} ${err.message}`);
      return;
    }
    log(`Response received in ${res.ms}ms`);

    // Le DOM a-t-il changé pendant la requête ? Si oui on ne applique pas un résultat périmé.
    const after = parseMarkets(document);
    if (after.fingerprint !== fp) {
      log('DOM changed during request, result discarded');
      st.status = 'stale';
      if (st.settings.autoAnalyze) scheduleTick();
      return;
    }
    const entry = { answers: res.data.answers, model: res.data.model, sentIds: built.sentIds };
    cacheSet(fp, entry);
    applyEntry(after, entry);
  }

  // ------------------------------------------------------------------ auto-analyse (MutationObserver)

  const tick = async () => {
    if (!st.settings.autoAnalyze) {
      // Pas d'auto-analyse : signaler seulement que l'affichage est périmé.
      const fp = parseMarkets(document).fingerprint;
      if (st.recs.length && !st.cache.has(fp)) st.status = 'stale';
      return;
    }
    const now = Date.now();
    const wait = Math.max(st.lastSentAt + CONFIG.minIntervalMs - now, st.cooldownUntil - now, 0);
    if (wait > 0 && !st.cache.has(parseMarkets(document).fingerprint)) {
      setTimeout(scheduleTick, wait);
      return;
    }
    await analyze();
  };
  const scheduleTick = debounce(tick, CONFIG.debounceMs);

  const stripJev = (s) => (s || '').split(/\s+/).filter((c) => c && !c.startsWith('jev-')).sort().join(' ');
  const isOwnNode = (n) => n.nodeType === 1 && (n.classList.contains(Highlighter.CLS.badge) || n.classList.contains(Highlighter.CLS.overlay));
  function isOwnMutation(m) {
    if (m.type === 'attributes') return m.attributeName === 'class' && stripJev(m.oldValue) === stripJev(m.target.getAttribute('class'));
    if (m.type === 'childList') return [...m.addedNodes, ...m.removedNodes].every(isOwnNode);
    return false;
  }

  const observer = new MutationObserver((muts) => {
    if (muts.every(isOwnMutation)) return;
    scheduleTick();
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
    st.status = 'idle';
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
      recommendations: st.recs.length
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg.type === 'JEV_ANALYZE') await analyze({ force: true });
      else if (msg.type === 'JEV_CLEAR') {
        Highlighter.clear();
        st.recs = [];
        st.best = null;
        st.status = 'idle';
      }
      sendResponse(snapshot());
    })();
    return true;
  });

  // ------------------------------------------------------------------ démarrage

  Storage.getSettings().then((s) => {
    st.settings = s;
    setDebug(s.debug);
    scheduleTick();
  });
  Storage.onSettingsChanged((patch) => {
    Object.assign(st.settings, patch);
    if ('debug' in patch) setDebug(patch.debug);
    if (patch.autoAnalyze) scheduleTick();
  });
})(globalThis);

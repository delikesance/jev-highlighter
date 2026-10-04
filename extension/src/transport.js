/**
 * Client HTTP JEV — service worker UNIQUEMENT (reçoit la clé via Secrets.getSecretSettings).
 */
(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const J = isNode ? Object.assign({}, require('./config'), require('./utils'), require('./jev')) : root.JEV;
  const { CONFIG, warn, JevError } = J;

  function isSafeUrl(u) {
    try {
      const url = new URL(u);
      if (url.protocol === 'https:') return true;
      return url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    } catch {
      return false;
    }
  }

  /** Détermine URL + headers selon le mode. Le mode backend n'envoie aucune clé. */
  function resolveTarget(settings) {
    const headers = { 'Content-Type': 'application/json' };
    let url;
    if (settings.mode === 'backend') {
      url = (settings.backendUrl || '').trim();
      if (!url) throw new JevError('not_configured', 'URL du backend non configurée');
    } else {
      url = (settings.endpoint || '').trim() || CONFIG.JEV.endpoint;
      const key = (settings.apiKey || '').trim();
      if (!key) throw new JevError('not_configured', 'Clé API JEV non configurée (mode dev)');
      const scheme = CONFIG.JEV.authScheme;
      headers[CONFIG.JEV.authHeaderName] = scheme ? `${scheme} ${key}` : key;
    }
    if (!isSafeUrl(url)) throw new JevError('not_configured', `URL refusée (https requis) : ${url}`);
    return { url, headers };
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new JevError('aborted', 'Analyse annulée'));
      const t = setTimeout(resolve, ms);
      if (signal)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new JevError('aborted', 'Analyse annulée'));
          },
          { once: true }
        );
    });
  }

  async function fetchOnce(target, body, outerSignal) {
    const ctrl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctrl.abort();
    if (outerSignal) {
      if (outerSignal.aborted) throw new JevError('aborted', 'Analyse annulée');
      outerSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, CONFIG.JEV.timeoutMs);
    let res;
    try {
      res = await fetch(target.url, {
        method: 'POST',
        headers: target.headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
        credentials: 'omit'
      });
    } catch (e) {
      if (timedOut) throw new JevError('timeout', 'Délai dépassé');
      if (outerSignal && outerSignal.aborted) throw new JevError('aborted', 'Analyse annulée');
      throw new JevError('network', `Erreur réseau : ${e.message}`);
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
    }

    if (res.ok) {
      let json;
      try {
        json = await res.json();
      } catch {
        throw new JevError('invalid_response', 'Réponse non JSON');
      }
      if (!json || typeof json !== 'object' || !json.answers || typeof json.answers !== 'object' || Array.isArray(json.answers))
        throw new JevError('invalid_response', 'Réponse JEV sans objet "answers"');
      return json;
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
    if (res.status === 401 || res.status === 403) throw new JevError('unauthorized', 'Clé API refusée', { status: res.status });
    if (res.status === 422) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new JevError('validation', `Requête invalide (422) ${detail}`.trim(), { status: 422 });
    }
    if (res.status === 429) throw new JevError('rate_limited', 'Limite de débit atteinte (429)', { status: 429, retryAfterMs });
    if (res.status === 529) throw new JevError('overloaded', 'Service surchargé (529)', { status: 529, retryAfterMs });
    throw new JevError('http', `Erreur HTTP ${res.status}`, { status: res.status });
  }

  async function requestWithRetry(target, body, signal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchOnce(target, body, signal);
      } catch (e) {
        const retryable = e.code === 'rate_limited' || e.code === 'overloaded';
        if (!retryable || attempt >= CONFIG.JEV.maxRetries) throw e;
        const wait = e.retryAfterMs ?? CONFIG.JEV.retryBaseMs * 2 ** attempt + Math.random() * 250;
        warn(`${e.code}, retry in ${Math.round(wait)}ms`);
        await sleep(wait, signal);
      }
    }
  }

  function chunkEntries(obj, size) {
    const entries = Object.entries(obj);
    const chunks = [];
    for (let i = 0; i < entries.length; i += size) chunks.push(Object.fromEntries(entries.slice(i, i + size)));
    return chunks;
  }

  /** Envoie la requête (découpée si besoin) et fusionne les réponses. */
  async function evaluate(body, settings, signal) {
    const target = resolveTarget(settings);
    const chunks = chunkEntries(body.questions, CONFIG.JEV.maxQuestionsPerRequest);
    const results = await Promise.all(chunks.map((q) => requestWithRetry(target, { ...body, questions: q }, signal)));
    const answers = Object.assign({}, ...results.map((r) => r.answers));
    return { model: results[0] && results[0].model, answers };
  }

  const api = { resolveTarget, evaluate, isSafeUrl, sleep };
  if (isNode) module.exports = api;
  else (root.JEV = root.JEV || {}).Transport = api;
})(globalThis);

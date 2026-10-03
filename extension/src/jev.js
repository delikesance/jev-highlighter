/**
 * Générateur de requête JEV (pur, utilisé côté content) + client HTTP (utilisé UNIQUEMENT dans le
 * service worker : c'est lui seul qui lit la clé API).
 */
(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const J = isNode ? Object.assign({}, require('./config'), require('./utils')) : root.JEV;
  const { CONFIG, normalizeText, log, warn } = J;

  // ---------------------------------------------------------------- construction de la requête

  /** Si le marché a exactement deux options disponibles Oui/Non, renvoie { yes, no }. */
  function findYesNo(market) {
    const avail = market.options.filter((o) => o.available);
    if (avail.length !== 2) return null;
    const yes = avail.find((o) => CONFIG.yesNames.includes(o.normalizedKey));
    const no = avail.find((o) => CONFIG.noNames.includes(o.normalizedKey));
    return yes && no ? { yes, no } : null;
  }

  /** Question JEV pour un marché, ou null si non évaluable (< 2 options disponibles). */
  function buildQuestion(market) {
    const avail = market.options.filter((o) => o.available);
    if (avail.length < 2) return null;
    const T = CONFIG.templates;

    const yn = CONFIG.useNoulForYesNo ? findYesNo(market) : null;
    if (yn) {
      return {
        type: 'noul',
        instructions: T.instructions(market.title),
        criteria: {
          true: T.criterion(market.title, yn.yes.name),
          false: T.criterion(market.title, yn.no.name)
        }
      };
    }
    const criteria = {};
    for (const o of avail) criteria[o.key] = T.criterion(market.title, o.name);
    return { type: 'choice', instructions: T.instructions(market.title), criteria };
  }

  /**
   * Construit le corps de requête. Aucune référence DOM n'y figure (strings/numbers uniquement).
   * @returns {{body: object, questionCount: number, sentIds: string[]}}
   */
  function buildRequest(parsed, ctx = {}) {
    const questions = {};
    for (const m of parsed.list) {
      const q = buildQuestion(m);
      if (q) questions[m.id] = q;
    }
    const body = {
      state: {
        source: 'bookmaker_page',
        page_title: ctx.pageTitle || '',
        page_path: ctx.pagePath || ''
      },
      questions
    };
    if (CONFIG.JEV.model) body.model = CONFIG.JEV.model;
    const sentIds = Object.keys(questions);
    return { body, questionCount: sentIds.length, sentIds };
  }

  // ---------------------------------------------------------------- client HTTP (service worker)

  class JevError extends Error {
    constructor(code, message, extra = {}) {
      super(message);
      this.name = 'JevError';
      this.code = code;
      Object.assign(this, extra);
    }
  }

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

  const api = { findYesNo, buildQuestion, buildRequest, JevError, resolveTarget, evaluate, isSafeUrl };
  if (isNode) module.exports = api;
  else Object.assign(root.JEV, api);
})(globalThis);

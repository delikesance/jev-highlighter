/**
 * Service worker. SEUL endroit qui lit la clé API et appelle JEV (ou votre backend).
 * Le content script n'a jamais accès à la clé.
 */
importScripts('config.js', 'utils.js', 'storage.js', 'jev.js', 'secrets.js', 'transport.js');

const { log, error, setDebug, Secrets, Transport } = globalThis.JEV;
const controllers = new Map(); // `${tabId}:${requestId}` -> AbortController

// Le contrôleur Auto (content script) persiste son état dans storage.session : il faut l'y autoriser.
try {
  const p = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  if (p && typeof p.catch === 'function') p.catch((e) => error('storage.session.setAccessLevel', e));
} catch (e) {
  error('storage.session.setAccessLevel', e);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (msg.type === 'JEV_TAB_ID') {
    sendResponse({ tabId: tabId == null ? null : tabId });
    return false;
  }
  if (msg.type === 'JEV_ABORT') {
    const c = controllers.get(`${tabId}:${msg.requestId}`);
    if (c) c.abort();
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type !== 'JEV_EVALUATE') return false;

  (async () => {
    const key = `${tabId}:${msg.requestId}`;
    const ctrl = new AbortController();
    controllers.set(key, ctrl);
    const t0 = Date.now();
    try {
      const settings = await Secrets.getSecretSettings();
      setDebug(settings.debug);
      const data = await Transport.evaluate(msg.body, settings, ctrl.signal);
      sendResponse({ ok: true, data, ms: Date.now() - t0 });
    } catch (e) {
      if (e.code !== 'aborted') error(e.code || 'error', e.message);
      sendResponse({ ok: false, error: { code: e.code || 'unknown', message: e.message } });
    } finally {
      controllers.delete(key);
    }
  })();
  return true; // réponse asynchrone
});

chrome.runtime.onInstalled.addListener(() => Secrets.syncHasKey().catch((e) => error('sync', e.message)));
Secrets.syncHasKey().catch((e) => error('sync', e.message));

log('service worker ready');

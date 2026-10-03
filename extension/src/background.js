/**
 * Service worker. SEUL endroit qui lit la clé API et appelle JEV (ou votre backend).
 * Le content script n'a jamais accès à la clé.
 */
importScripts('config.js', 'utils.js', 'storage.js', 'jev.js');

const { log, error, setDebug, Storage, evaluate } = globalThis.JEV;
const controllers = new Map(); // `${tabId}:${requestId}` -> AbortController

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
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
      const settings = await Storage.getSettings();
      setDebug(settings.debug);
      const data = await evaluate(msg.body, settings, ctrl.signal);
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

log('service worker ready');

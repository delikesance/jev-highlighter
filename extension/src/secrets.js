/**
 * Lecture de la clé API — service worker UNIQUEMENT (jamais listé dans content_scripts).
 */
(function (root) {
  async function getSecretSettings() {
    const base = await root.JEV.Storage.getSettings();
    const { apiKey } = await chrome.storage.local.get({ apiKey: '' });
    return { ...base, apiKey: typeof apiKey === 'string' ? apiKey : '' };
  }
  /** Recalcule le booléen hasKey à partir de la clé stockée. */
  async function syncHasKey() {
    const { apiKey, hasKey } = await chrome.storage.local.get({ apiKey: '', hasKey: false });
    const has = typeof apiKey === 'string' && !!apiKey.trim();
    if (has !== hasKey) await chrome.storage.local.set({ hasKey: has });
    return has;
  }
  const api = { getSecretSettings, syncHasKey };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.JEV = root.JEV || {}).Secrets = api;
})(globalThis);

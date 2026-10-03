/**
 * Réglages persistés dans chrome.storage.local.
 * ATTENTION : apiKey stockée ici = mode DÉVELOPPEMENT uniquement (la clé reste lisible par quiconque
 * possède l'extension). En production, utiliser mode "backend".
 */
(function (root) {
  const DEFAULTS = {
    mode: 'dev', // 'dev' (clé locale) | 'backend' (votre serveur, sans clé dans l'extension)
    apiKey: '',
    endpoint: '', // vide => CONFIG.JEV.endpoint
    backendUrl: '',
    autoAnalyze: false,
    debug: false
  };

  async function getSettings() {
    const stored = await chrome.storage.local.get(DEFAULTS);
    return { ...DEFAULTS, ...stored };
  }
  async function setSettings(patch) {
    await chrome.storage.local.set(patch);
  }
  function onSettingsChanged(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const patch = {};
      for (const [k, v] of Object.entries(changes)) patch[k] = v.newValue;
      cb(patch);
    });
  }
  function isConfigured(s) {
    return s.mode === 'backend' ? !!s.backendUrl.trim() : !!s.apiKey.trim();
  }

  const api = { DEFAULTS, getSettings, setSettings, onSettingsChanged, isConfigured };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.JEV = root.JEV || {}).Storage = api;
})(globalThis);

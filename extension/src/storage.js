/**
 * Réglages persistés dans chrome.storage.local.
 * La clé API n'est jamais lue ici (content script) : seul `hasKey` (booléen) est exposé.
 * Mode DÉVELOPPEMENT uniquement ; en production, utiliser le mode "backend".
 */
(function (root) {
  const DEFAULTS = {
    mode: 'dev', // 'dev' (clé locale) | 'backend' (votre serveur, sans clé dans l'extension)
    hasKey: false, // booléen écrit par le popup / le service worker
    endpoint: '', // vide => CONFIG.JEV.endpoint
    backendUrl: '',
    autoAnalyze: false,
    stakeAdvice: true,
    matchContext: true,
    reorderPicks: false,
    dockOpen: true,
    dockCollapsed: false,
    debug: false
  };

  async function getSettings() {
    const stored = await chrome.storage.local.get(DEFAULTS);
    const out = { ...DEFAULTS, ...stored };
    for (const k of Object.keys(out)) if (k.toLowerCase() === 'apikey') delete out[k];
    out.hasKey = !!out.hasKey;
    return out;
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
    return s.mode === 'backend' ? !!s.backendUrl.trim() : !!s.hasKey;
  }

  const api = { DEFAULTS, getSettings, setSettings, onSettingsChanged, isConfigured };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.JEV = root.JEV || {}).Storage = api;
})(globalThis);

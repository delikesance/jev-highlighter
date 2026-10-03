// Tout le contenu dynamique est écrit via textContent (jamais innerHTML).
const $ = (id) => document.getElementById(id);
const DEFAULTS = { mode: 'dev', apiKey: '', endpoint: '', backendUrl: '', autoAnalyze: false, debug: false };
const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : '—');

const STATUS_TEXT = {
  analyzing: 'Analyse en cours…',
  stale: 'La page a changé depuis la dernière analyse.',
  'no-markets': 'Aucun marché exploitable détecté.',
  done: 'Analyse terminée.'
};

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}

async function ask(type) {
  const id = await activeTabId();
  if (id == null) return null;
  try {
    return await chrome.tabs.sendMessage(id, { type });
  } catch {
    return null; // pas de content script (page non supportée ou onglet à recharger)
  }
}

function setMsg(text, isErr) {
  $('msg').hidden = !text;
  $('msg').textContent = text || '';
  $('msg').classList.toggle('err', !!isErr);
}

function render(s) {
  if (!s) {
    setMsg('Page non supportée, ou rechargez l’onglet après l’installation.', true);
    return;
  }
  $('markets').textContent = s.stats.markets;
  $('selections').textContent = `${s.stats.availableSelections}/${s.stats.selections}`;
  $('analysed').textContent = s.analysed;
  if (s.status === 'error') setMsg(s.error, true);
  else setMsg(s.error || STATUS_TEXT[s.status] || '', false);

  const best = s.best;
  $('best').hidden = !best;
  if (best) {
    $('bestChoice').textContent = best.choice;
    $('bestMarket').textContent = best.marketTitle;
    $('bestScore').textContent = pct(best.jevScore);
    $('bestConf').textContent = pct(best.confidence);
    $('bestOdds').textContent = best.oddsText || '—';
  }
}

async function loadSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $('mode').value = s.mode;
  $('apiKey').value = s.apiKey;
  $('endpoint').value = s.endpoint;
  $('backendUrl').value = s.backendUrl;
  $('auto').checked = s.autoAnalyze;
  $('debug').checked = s.debug;
  toggleMode();
  const configured = s.mode === 'backend' ? !!s.backendUrl.trim() : !!s.apiKey.trim();
  $('conn').textContent = configured ? 'configuré' : 'non configuré';
  $('conn').className = `pill ${configured ? 'ok' : 'ko'}`;
  $('analyze').disabled = !configured;
  if (!configured) setMsg('Renseignez la clé (dev) ou l’URL du backend dans « Configuration ».', true);
}

function toggleMode() {
  const backend = $('mode').value === 'backend';
  $('devFields').hidden = backend;
  $('keyBox').hidden = backend;
  $('backendFields').hidden = !backend;
}

$('mode').addEventListener('change', toggleMode);

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    mode: $('mode').value,
    apiKey: $('apiKey').value.trim(),
    endpoint: $('endpoint').value.trim(),
    backendUrl: $('backendUrl').value.trim()
  });
  setMsg('');
  await loadSettings();
});

$('saveKey').addEventListener('click', async () => {
  await chrome.storage.local.set({ apiKey: $('apiKey').value.trim() });
  await loadSettings();
  setMsg('Clef enregistrée.');
});

$('auto').addEventListener('change', (e) => chrome.storage.local.set({ autoAnalyze: e.target.checked }));
$('debug').addEventListener('change', (e) => chrome.storage.local.set({ debug: e.target.checked }));

$('analyze').addEventListener('click', async () => {
  $('analyze').disabled = true;
  setMsg('Analyse en cours…');
  render(await ask('JEV_ANALYZE'));
  $('analyze').disabled = false;
});

$('clear').addEventListener('click', async () => render(await ask('JEV_CLEAR')));

(async () => {
  await loadSettings();
  render(await ask('JEV_GET_STATE'));
})();

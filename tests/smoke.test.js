// Test de fumée : exécute TOUS les scripts de contenu (ordre du manifest) dans jsdom avec un faux chrome.* et un faux JEV.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ext = path.join(__dirname, '../extension');
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const open = [];
function boot(html, settings = {}) {
  const r = boot0(html, settings);
  open.push(r.close);
  return r;
}
function boot0(html, settings = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://bookmaker.test/match/1' });
  const w = dom.window;
  const listeners = [];
  const store = { autoAnalyze: false, stakeAdvice: false, reorderPicks: false, dockOpen: true, dockCollapsed: false, debug: false, ...settings };
  const sent = [];
  w.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg.type !== 'JEV_EVALUATE') return { ok: true };
        const answers = {};
        for (const [id, q] of Object.entries(msg.body.questions)) {
          const keys = Object.keys(q.criteria);
          if (id.startsWith('stake_round')) {
            answers[id] = { type: 'choice', choice: keys.find((k) => k !== 'Ne pas miser'), confidence: 0.6, probabilities: {} };
            continue;
          }
          const probs = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.7 : 0.3 / Math.max(1, keys.length - 1)]));
          answers[id] = { type: 'choice', choice: keys[0], confidence: 0.5, probabilities: probs };
        }
        return { ok: true, ms: 5, data: { model: 'mock', answers } };
      },
      onMessage: { addListener: (fn) => listeners.push(fn) }
    },
    storage: {
      local: {
        get: async (defaults) => ({ ...defaults, ...store }),
        set: async (patch) => Object.assign(store, patch)
      },
      onChanged: { addListener: () => {} }
    }
  };
  w.document.elementFromPoint = () => null;
  for (const f of manifest.content_scripts[0].js) w.eval(fs.readFileSync(path.join(ext, f), 'utf8'));
  const call = (msg) => new Promise((resolve) => listeners[0](msg, {}, resolve));
  return { w, doc: w.document, call, sent, close: () => w.close() };
}

const fixture = () => fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');

test('smoke : analyse -> anneaux, bloc « Sélection du moment », dock ; effacement complet', async () => {
  const { doc, call, sent } = boot(fixture());
  const res = await call({ type: 'JEV_ANALYZE' });
  assert.equal(res.status, 'done');
  assert.ok(res.analysed >= 5);
  assert.equal(sent.filter((m) => m.type === 'JEV_EVALUATE').length, 1);

  assert.ok(doc.querySelectorAll('.jev-recommended-bet').length >= 5);
  assert.equal(doc.querySelectorAll('.jev-best-bet').length, 1);

  const hosts = [...doc.querySelectorAll('[data-jev-host]')].map((h) => h.tagName.toLowerCase());
  assert.ok(hosts.includes('jev-lens'), 'calque (marqueurs + dock)');
  assert.ok(hosts.includes('jev-picks'), 'bloc de picks');

  const picks = doc.querySelector('jev-picks').shadowRoot;
  assert.equal(picks.querySelectorAll('.pick').length, 3);
  assert.ok(picks.querySelector('.pick--top'));
  const layer = doc.querySelector('jev-lens').shadowRoot.querySelector('.layer');
  assert.ok(layer.querySelectorAll('.chip').length >= 5);
  assert.ok(layer.querySelector('.chip--top').textContent.includes('TOP PICK'));
  assert.ok(layer.querySelector('.dock'));
  // le bloc est inséré AVANT le premier marché
  assert.equal(doc.querySelector('jev-picks').nextElementSibling, doc.querySelector('sports-markets-single-market'));

  // le texte du site n'est jamais touché
  assert.equal(doc.querySelector('.btn_label').textContent.trim(), '1,20');

  const cleared = await call({ type: 'JEV_CLEAR' });
  assert.equal(cleared.status, 'idle');
  assert.equal(doc.querySelectorAll('.jev-recommended-bet').length, 0);
  assert.equal(layer.querySelectorAll('.chip').length, 0);
  assert.equal(doc.querySelector('jev-picks'), null);
});

test('smoke : « Remonter les picks en tête » active -> CSS order sur les marchés, DOM inchangé', async () => {
  const { doc, call } = boot(fixture(), { reorderPicks: true });
  // la fixture place les marchés dans <body> (bloc) avec d'autres éléments : on les enveloppe dans un parent flex
  const wrap = doc.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  const markets = [...doc.querySelectorAll('sports-markets-single-market')];
  markets[0].before(wrap);
  markets.forEach((m) => wrap.appendChild(m));
  const before = [...wrap.children].map((c) => c.tagName);
  await call({ type: 'JEV_ANALYZE' });
  assert.ok(markets.some((m) => m.style.order !== ''));
  assert.deepEqual([...wrap.children].filter((c) => !c.hasAttribute('data-jev-host')).map((c) => c.tagName), before);
  await call({ type: 'JEV_CLEAR' });
  assert.ok(markets.every((m) => m.style.order === ''));
});

test('smoke : dock réduit -> pastille ; dock fermé -> absent', async () => {
  const a = boot(fixture(), { dockCollapsed: true });
  await a.call({ type: 'JEV_ANALYZE' });
  const la = a.doc.querySelector('jev-lens').shadowRoot.querySelector('.layer');
  assert.ok(la.querySelector('.dock-pill'));
  assert.ok(!la.querySelector('.dock'));

  const b = boot(fixture(), { dockOpen: false });
  await b.call({ type: 'JEV_ANALYZE' });
  const lb = b.doc.querySelector('jev-lens').shadowRoot.querySelector('.layer');
  assert.ok(!lb.querySelector('.dock') && !lb.querySelector('.dock-pill'));
});

test('smoke : assistant de mise inséré dans le ticket (avant le champ), détail en 3 étapes, champ intact', async () => {
  const slip = fs.readFileSync(path.join(__dirname, 'fixture-slip.html'), 'utf8');
  const { doc } = boot(slip, { stakeAdvice: true });
  await wait(2400); // debounce 1,5 s + 3 tours de faux JEV
  const host = doc.querySelector('jev-stake');
  assert.ok(host, 'module de mise présent');
  assert.equal(host.nextElementSibling, doc.querySelector('betting-slip-footer-stake-input'));
  const sr = host.shadowRoot;
  assert.match(sr.querySelector('.stake__amount').textContent, /\d,\d\d/);
  assert.match(sr.querySelector('.jbtn--primary').textContent, /Copier \d,\d\d/);
  sr.querySelectorAll('.jbtn')[1].click(); // « Détail »
  assert.equal(host.shadowRoot.querySelectorAll('.step__head').length, 3);
  // le champ de mise du site n'est jamais rempli ni modifié
  assert.equal(doc.querySelector('input[name="stakeField"]').value, '');
});

// fermeture des fenêtres jsdom (timers/observers) pour que le process puisse se terminer
test('cleanup', () => open.forEach((c) => c()));

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
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: settings.__url || 'https://bookmaker.test/match/1' });
  const w = dom.window;
  const listeners = [];
  const store = { autoAnalyze: false, stakeAdvice: false, matchContext: true, reorderPicks: false, dockOpen: true, dockCollapsed: false, debug: false, ...settings };
  delete store.__url;
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
  assert.equal(host.shadowRoot.querySelectorAll('.step__head').length >= 2, true); // plafond 10 % du solde : fourchette plus étroite
  // le champ de mise du site n'est jamais rempli ni modifié
  assert.equal(doc.querySelector('input[name="stakeField"]').value, '');
});

const MATCH = '/basketball-sbasketball/betclic-elite-c15/nancy-cholet-m1233460038488064';
const matchUrl = `https://bookmaker.test${MATCH}`;
const C = require('../extension/src/context');
const cdoc = (f) => new JSDOM(fs.readFileSync(path.join(__dirname, f), 'utf8')).window.document;

test('smoke : contexte du match mémorisé -> transmis à JEV dans l\'état de la requête', async () => {
  const parts = {
    live: C.parseLive(cdoc('fixture-matchcenter-live.html')),
    h2h: C.parseHeadToHead(cdoc('fixture-matchcenter-perf.html')),
    standings: C.parseStandings(cdoc('fixture-matchcenter-standing.html'))
  };
  const { call, sent } = boot(fixture(), { __url: matchUrl, jevCtx: { [MATCH]: { at: Date.now(), parts } } });
  await wait(30); // laisse les réglages se charger
  const res = await call({ type: 'JEV_ANALYZE' });
  assert.equal(res.status, 'done');
  assert.deepEqual([...res.context.parts].sort(), ['h2h', 'live', 'standings']);
  const body = JSON.parse(JSON.stringify(sent.find((m) => m.type === 'JEV_EVALUATE').body));
  assert.deepEqual(body.state.match_context.teams, ['Nancy', 'Cholet']);
  assert.ok(body.state.match_context.standings.match_teams.length === 2);
});

test('smoke : contexte désactivé ou indisponible -> l\'analyse fonctionne quand même, sans contexte', async () => {
  const off = boot(fixture(), { __url: matchUrl, matchContext: false });
  await wait(30);
  await off.call({ type: 'JEV_ANALYZE' });
  assert.ok(!('match_context' in off.sent.find((m) => m.type === 'JEV_EVALUATE').body.state));

  const none = boot(fixture(), { __url: matchUrl });
  none.w.JEV.CONFIG.context.iframeLoadMs = 150; // iframe jamais chargé dans jsdom : on vérifie le repli
  none.w.JEV.CONFIG.context.waitMs = 400;
  await wait(30);
  const res = await none.call({ type: 'JEV_ANALYZE' });
  assert.equal(res.status, 'done');
  assert.ok(!('match_context' in none.sent.find((m) => m.type === 'JEV_EVALUATE').body.state));
  assert.equal(none.doc.querySelector('iframe'), null, 'iframe caché toujours retiré');
});

test('smoke : page live bruyante + ticket qui apparaît plus tard -> l\'assistant de mise s\'affiche quand même', async () => {
  const slip = fs.readFileSync(path.join(__dirname, 'fixture-slip.html'), 'utf8').replace('</body>', '<div id="noise">0</div></body>');
  const { w, doc } = boot(slip, { stakeAdvice: true });
  const card = doc.querySelector('betting-slip-selection-card');
  const parent = card.parentNode;
  card.remove(); // pas encore de sélection dans le ticket
  await wait(50);
  // bruit continu hors ticket (chrono vidéo, scores…) : toutes les 80 ms
  let n = 0;
  const noise = w.setInterval(() => { doc.getElementById('noise').textContent = String(++n); }, 80);
  await wait(300);
  parent.prepend(card); // l'utilisateur ajoute une sélection
  await wait(2600); // anti-rebond 1,5 s + 3 tours
  w.clearInterval(noise);
  assert.ok(doc.querySelector('jev-stake'), 'module de mise présent malgré le bruit');
  assert.match(doc.querySelector('jev-stake').shadowRoot.querySelector('.stake__amount').textContent, /\d,\d\d/);
});

// fermeture des fenêtres jsdom (timers/observers) pour que le process puisse se terminer
test('cleanup', () => open.forEach((c) => c()));

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
  const frame = !!settings.__frame;
  const before = settings.__before;
  const session = { ...(settings.__session || {}) };
  const url = settings.__url || 'https://bookmaker.test/match/1';
  const dom = frame
    ? new JSDOM('<!doctype html><body><iframe></iframe></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url })
    : new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url });
  const w = frame ? dom.window.document.querySelector('iframe').contentWindow : dom.window;
  if (frame) { w.document.open(); w.document.write(html); w.document.close(); }
  const sessionCalls = [];
  const listeners = [];
  const store = { autoAnalyze: false, stakeAdvice: false, matchContext: true, reorderPicks: false, dockOpen: true, dockCollapsed: false, debug: false, ...settings };
  for (const k of ['__url', '__frame', '__before', '__session']) delete store[k];
  const sent = [];
  w.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg.type === 'JEV_TAB_ID') return { tabId: 7 };
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
      session: {
        get: async (keys) => {
          sessionCalls.push(['get', keys]);
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.filter((k) => k in session).map((k) => [k, JSON.parse(JSON.stringify(session[k]))]));
        },
        set: async (o) => { sessionCalls.push(['set', o]); Object.assign(session, JSON.parse(JSON.stringify(o))); },
        remove: async (k) => { sessionCalls.push(['remove', k]); delete session[k]; }
      },
      onChanged: { addListener: () => {} }
    }
  };
  w.document.elementFromPoint = () => null;
  for (const f of manifest.content_scripts[0].js) w.eval(fs.readFileSync(path.join(ext, f), 'utf8'));
  if (before) before(w);
  const call = (msg) => new Promise((resolve) => listeners[0](msg, {}, resolve));
  return { w, doc: w.document, call, sent, session, sessionCalls, close: () => dom.window.close() };
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


// ------------------------------------------------------------------ mode Auto

const AUTO_FILES = ['clock', 'guard', 'scanner', 'selector', 'readers', 'executor', 'tracker', 'controller', 'wiring', 'auto-ui'].map((f) => `src/auto/${f}.js`);

test('manifest : fichiers Auto avant content.js, dans l\'ordre de dépendance, sans all_frames', () => {
  const cs = manifest.content_scripts[0];
  const js = cs.js;
  const idx = AUTO_FILES.map((f) => js.indexOf(f));
  assert.ok(idx.every((i) => i >= 0), 'tous présents');
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, 'ordre');
  assert.ok(idx[idx.length - 1] < js.indexOf('src/content.js'));
  assert.ok(js.indexOf('src/parser.js') < idx[0] && js.indexOf('src/ui-root.js') < idx[0]);
  assert.ok(!('all_frames' in cs));
  assert.doesNotMatch(manifest.description, /Ne place jamais/);
  assert.match(manifest.description, /mode Auto/);
});

// Espionne createRuntime (appelé par content.js) ; `patch(opts)` peut remplacer des dépendances.
function spyRuntime(w, patch) {
  const calls = [];
  const real = w.JEV.Auto.Wiring.createRuntime;
  w.JEV.Auto.Wiring.createRuntime = (opts) => {
    calls.push(opts);
    if (patch) patch(opts);
    return real(opts);
  };
  return calls;
}

test('smoke Auto : autoMode faux -> aucun hôte, aucun storage.session, aucun message, aucun écouteur clavier', async () => {
  let rt;
  const keys = [];
  const { doc, sent, sessionCalls } = boot(fixture(), {
    __before: (w) => {
      rt = spyRuntime(w);
      const add = w.document.addEventListener.bind(w.document);
      w.document.addEventListener = (t, ...a) => { keys.push(t); return add(t, ...a); };
    }
  });
  await wait(60);
  assert.equal(doc.querySelector('jev-auto'), null);
  assert.equal(rt.length, 0);
  assert.deepEqual(sessionCalls, []);
  assert.deepEqual(sent.map((m) => m.type), []);
  assert.ok(!keys.includes('keydown'));
});

test('smoke Auto : autoMode vrai -> panneau monté, runtime unique, aucun pari tant que non armé', async () => {
  let rt;
  const { doc, sent, session } = boot(fixture(), { autoMode: true, __before: (w) => { rt = spyRuntime(w, (o) => {
    o.analyze = async () => { throw new Error('analyze appelé'); };
    o.navigate = () => { throw new Error('navigate appelé'); };
  }); } });
  await wait(80);
  assert.ok(doc.querySelector('jev-auto'), 'hôte jev-auto');
  assert.equal(rt.length, 1);
  assert.equal(rt[0].tabId, 7);
  assert.ok(!Object.keys(rt[0].settings).some((k) => /api.?key/i.test(k)));
  assert.ok(sent.some((m) => m.type === 'JEV_TAB_ID'));
  assert.ok(!sent.some((m) => m.type === 'JEV_EVALUATE'));
  assert.ok(!session.jevAuto || !['ARMED', 'SCAN', 'EXEC'].includes(session.jevAuto.phase));
  const sr = doc.querySelector('jev-auto').shadowRoot;
  assert.equal(sr.querySelector('[data-k="dry"]').checked, true);
});

test('smoke Auto : jamais de runtime dans un sous-cadre', async () => {
  let rt = [];
  const { doc, sessionCalls, sent } = boot(fixture(), { autoMode: true, __frame: true, __before: (w) => { rt = spyRuntime(w); } });
  await wait(60);
  assert.equal(doc.querySelector('jev-auto'), null);
  assert.equal(rt.length, 0);
  assert.deepEqual(sessionCalls, []);
  assert.ok(!sent.some((m) => m.type === 'JEV_TAB_ID'));
});

test('smoke Auto : step() appelé séquentiellement (jamais de chevauchement), arrêt sur STOPPED', async () => {
  let active = 0;
  let maxActive = 0;
  let steps = 0;
  const { w } = boot(fixture(), { autoMode: true, __before: (w) => {
    w.JEV.CONFIG.auto.stepMs = 5;
    w.JEV.Auto.Wiring.createRuntime = () => ({
      store: { get: async () => ({ phase: 'SCAN' }) },
      stop: async () => {},
      controller: {
        init: async () => 'SCAN',
        arm: async () => {},
        stop: async () => {},
        step: async () => {
          active++; maxActive = Math.max(maxActive, active); steps++;
          await new Promise((r) => setTimeout(r, 40)); // step lent
          active--;
          return steps >= 4 ? 'STOPPED' : 'SCAN';
        }
      }
    });
  } });
  await wait(400);
  assert.equal(maxActive, 1);
  assert.equal(steps, 4, 'arrêt dès STOPPED');
  assert.ok(w);
});

test('smoke Auto : marchés rapides dupliqués entre sections -> un seul envoyé à analyze', async () => {
  const seen = [];
  const fast = fs.readFileSync(path.join(__dirname, 'fixture-fast.html'), 'utf8');
  const st = { phase: 'ANALYSE', event: { href: '/match/1', sport: 'football' }, session: { startBalance: 100 },
    guardSnap: { placed: 0, inFlight: 0, consecutiveLosses: 0, reserved: 0 }, ownerTabId: 7, tried: [], bets: [] };
  boot(fast, { autoMode: true, __session: { jevAuto: st }, __before: (w) => {
    w.JEV.CONFIG.auto.stepMs = 500; // minimum validé par le guard
    spyRuntime(w, (o) => {
      const real = o.analyze;
      assert.equal(typeof real, 'function');
      o.analyze = async (markets) => { seen.push(markets.map((m) => m.title)); return []; };
      o.navigate = () => {};
    });
  } });
  await wait(700);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].filter((t) => t.startsWith('Nombre total')).length, 1);
});

test('smoke Auto : décisions live, pari et mise du ticket via JEV ; analyse manuelle intacte', async () => {
  let opts;
  const { sent, doc } = boot(fixture(), { autoMode: true, __before: (w) => { spyRuntime(w, (o) => { opts = o; }); } });
  await wait(60);
  const list = opts.parseMarkets(doc);
  assert.ok(Array.isArray(list) && list.length >= 5);
  const events = [{ href: '/match/1', name: 'A - B', sport: 'football', clock: { running: true } }];
  const live = await opts.chooseEvent(events);
  assert.equal(live.href, events[0].href);
  const matches = await opts.analyze(list.slice(0, 2), { event: { href: '/match/1' } });
  assert.equal(sent.filter((m) => m.type === 'JEV_EVALUATE').length, 2);
  assert.equal(matches.length, 1);
  assert.equal(sent.find((m) => m.type === 'JEV_EVALUATE').body.model, 'jev-latest');
  assert.ok(matches.every((m) => typeof m.marketId === 'string' && typeof m.choice === 'string'));
  const amount = await opts.stakeFromTicket({ slip: { event: 'A - B', market: 'Vainqueur', selection: 'A', odds: 2.35 }, wallet: 14.47, decision: { confidence: 0.8 } });
  assert.ok(amount > 0 && amount < 14.47);
  const requests = sent.filter((m) => m.type === 'JEV_EVALUATE').map((m) => m.body);
  assert.equal(requests[0].state.task, 'auto_choose_live');
  assert.equal(requests[1].state.task, 'auto_choose_bet');
  assert.ok(requests.slice(2).every((b) => b.state.task === 'stake_sizing' && b.state.wallet_eur === 14.47 && b.state.total_odds === 2.35));
  // l'analyse manuelle n'est pas touchée : aucun surlignage
  assert.equal(doc.querySelectorAll('.jev-recommended-bet').length, 0);
});

test('smoke Auto : STOP annule un step programmé', async () => {
  let steps = 0;
  let stopped = false;
  const { doc } = boot(fixture(), { autoMode: true, __before: (w) => {
    w.JEV.CONFIG.auto.stepMs = 100;
    w.JEV.Auto.Wiring.createRuntime = () => ({
      store: { get: async () => ({ phase: stopped ? 'STOPPED' : 'SCAN' }) },
      stop: async () => { stopped = true; },
      controller: { init: async () => 'SCAN', arm: async () => {}, step: async () => { steps++; return 'SCAN'; } }
    });
  } });
  await wait(30);
  doc.querySelector('jev-auto').shadowRoot.querySelector('[data-k="stop"]').click();
  await wait(170);
  assert.equal(steps, 0);
});

// fermeture des fenêtres jsdom (timers/observers) pour que le process puisse se terminer
test('cleanup', () => open.forEach((c) => c()));

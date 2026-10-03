const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { CONFIG } = require('../extension/src/config');
const Wiring = require('../extension/src/auto/wiring');
const Executor = require('../extension/src/auto/executor');

const ORIGIN = 'https://www.betclic.fr';
const fx = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

function fakeChrome(o = {}) {
  const data = {};
  const area = {
    writes: 0,
    async get(k) {
      if (o.failGet) throw new Error('storage down');
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      const keys = Array.isArray(k) ? k : [k];
      const out = {};
      for (const x of keys) if (x in data) out[x] = structuredClone(data[x]);
      return out;
    },
    async set(obj) {
      await new Promise((r) => setTimeout(r, Math.random() * 3));
      area.writes++;
      Object.assign(data, structuredClone(obj));
    },
    async remove(k) { for (const x of [].concat(k)) delete data[x]; }
  };
  return { storage: { session: area }, data };
}

test('store : 10 set concurrents appliqués dans l\'ordre, sans perte', async () => {
  const ch = fakeChrome();
  const s = Wiring.makeSessionStore(ch, 7, () => 0);
  const ps = [];
  for (let i = 0; i < 10; i++) ps.push(s.set({ ['k' + i]: i, last: i }));
  await Promise.all(ps);
  const st = await s.get();
  for (let i = 0; i < 10; i++) assert.equal(st['k' + i], i);
  assert.equal(st.last, 9);
  assert.equal(ch.storage.session.writes, 10);
});

test('store : await set() résout après l\'écriture durable', async () => {
  const ch = fakeChrome();
  const s = Wiring.makeSessionStore(ch, 7, () => 0);
  await s.set({ a: 1 });
  assert.equal(ch.data.jevAuto.a, 1);
});

test('store : stopFlag (stopped, jevAutoStop, storage en erreur)', async () => {
  const ch = fakeChrome();
  let clock = 0;
  const s = Wiring.makeSessionStore(ch, 7, () => clock++);
  assert.equal(await s.stopFlag(), false);
  await s.set({ stopped: true });
  assert.equal(await s.stopFlag(), true);
  await s.set({ stopped: false });
  assert.equal(await s.stopFlag(), false);
  await s.requestStop('Échap');
  assert.ok(ch.data.jevAutoStop);
  assert.equal(await s.stopFlag(), true);
  // Réarmement (stopped:false) efface la demande d'arrêt.
  await s.set({ stopped: false });
  assert.equal(await s.stopFlag(), false);
  const bad = Wiring.makeSessionStore(fakeChrome({ failGet: true }), 7, () => 0);
  assert.equal(await bad.stopFlag(), true);
});

// ---- getMyBetsDoc ----
function hostDoc() { return new JSDOM('<!doctype html><body></body>', { url: ORIGIN + '/live' }).window.document; }

function factory(o = {}) {
  const made = [];
  const fn = (doc, url) => {
    const el = doc.createElement('iframe');
    const inner = o.never ? null : new JSDOM(fx(o.file || 'fixture-mybets-ongoing.html'), { url: ORIGIN + '/mes-paris' }).window.document;
    Object.defineProperty(el, 'contentDocument', { get: () => (el.isConnected ? inner : null) });
    made.push({ el, url, inner });
    return el;
  };
  fn.made = made;
  return fn;
}

function activate(d, flt) {
  for (const b of d.querySelectorAll('[data-qa^="my-bets-filter-"]')) b.className = b.getAttribute('data-qa') === 'my-bets-filter-' + flt ? 'is-active' : '';
}
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = (o = {}) => ({ ...structuredClone(CONFIG.auto), myBetsWaitMs: 200, pollMs: 50, ...o });

test('getMyBetsDoc : doc frais, bon filtre, ancien iframe retiré, un seul vivant', async () => {
  const doc = hostDoc();
  const f = factory();
  const filters = [];
  const orig = Executor.selectMyBetsFilter;
  // Simule le site : le clic rend le filtre actif.
  const sel = (d, flt) => { filters.push(flt); const ok = orig(d, flt); if (ok) activate(d, flt); return ok; };
  const get = Wiring.makeMyBetsDoc({ doc, cfg: cfg(), iframeFactory: f, selectFilter: sel, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now });
  const d1 = await get.getMyBetsDoc('ongoing');
  assert.equal(doc.querySelectorAll('iframe').length, 1);
  const d2 = await get.getMyBetsDoc('ended');
  assert.notEqual(d1, d2);
  assert.equal(f.made[0].el.isConnected, false);
  assert.equal(doc.querySelectorAll('iframe').length, 1);
  assert.deepEqual(filters, ['ended']); // « en cours » déjà actif : pas de clic
  assert.equal(f.made[1].url, ORIGIN + '/mes-paris');
  const el = f.made[1].el;
  assert.equal(el.getAttribute('aria-hidden'), 'true');
  assert.equal(el.style.position, 'fixed');
  assert.equal(el.style.left, '-10000px');
  assert.equal(el.style.opacity, '0');
  assert.equal(el.style.pointerEvents, 'none');
  get.dispose();
  assert.equal(doc.querySelectorAll('iframe').length, 0);
});

test('getMyBetsDoc : timeout => rejette et retire l\'iframe', async () => {
  const doc = hostDoc();
  const logs = [];
  const get = Wiring.makeMyBetsDoc({ doc, cfg: cfg(), log: (...a) => logs.push(a), iframeFactory: factory({ never: true }), selectFilter: () => true, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now });
  await assert.rejects(get.getMyBetsDoc('ongoing'));
  assert.equal(doc.querySelectorAll('iframe').length, 0);
  const timeout = logs.find(([label]) => label === 'mybets: timeout/error');
  assert.ok(timeout, 'état iframe indispensable au diagnostic');
  assert.equal(timeout[1].filter, 'ongoing');
  assert.equal(timeout[1].pageFound, false);
  assert.ok(timeout[1].elapsedMs >= 200);
  assert.ok(Array.isArray(timeout[1].componentTags));
  assert.doesNotMatch(JSON.stringify(timeout), /outerHTML|cookie|Authorization/);
});

test('getMyBetsDoc : filtre non cliquable => rejette', async () => {
  const doc = hostDoc();
  const get = Wiring.makeMyBetsDoc({ doc, cfg: cfg(), iframeFactory: factory({ file: 'fixture-mybets-ended.html' }), selectFilter: () => false, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now });
  await assert.rejects(get.getMyBetsDoc('ongoing'));
});

const mk = (f, sel, c = cfg()) => Wiring.makeMyBetsDoc({ doc: hostDoc(), cfg: c, iframeFactory: f, selectFilter: sel, sleep: realSleep, now: Date.now });

test('getMyBetsDoc : filtre actif + 0 carte stable => doc vide accepté', async () => {
  const f = factory();
  const get = mk(f, () => true);
  const p = get.getMyBetsDoc('ongoing');
  for (const c of f.made[0].inner.querySelectorAll('bet-card')) c.remove();
  const d = await p;
  assert.equal(d.querySelectorAll('bet-card').length, 0);
});

test('getMyBetsDoc : 0 carte + loader présent => rejet', async () => {
  const f = factory();
  const get = mk(f, () => true);
  const p = get.getMyBetsDoc('ongoing');
  const inner = f.made[0].inner;
  for (const c of inner.querySelectorAll('bet-card')) c.remove();
  inner.querySelector('my-bets-page').insertAdjacentHTML('beforeend', '<div class="bcdk-skeleton-row"></div>');
  await assert.rejects(p, /instable|non confirmé/);
});

test('getMyBetsDoc : filtre jamais actif => rejet', async () => {
  const get = mk(factory(), () => true); // clic sans effet : « Terminés » jamais actif
  await assert.rejects(get.getMyBetsDoc('ended'), /non confirmé|instable/);
});

test('getMyBetsDoc : ancien filtre affiché puis re-rendu asynchrone => lit seulement le bon filtre', async () => {
  const f = factory();
  const ended = new JSDOM(fx('fixture-mybets-ended.html')).window.document;
  const sel = (d) => { setTimeout(() => { d.body.innerHTML = ended.body.innerHTML; }, 120); return true; };
  const get = mk(f, sel, cfg({ myBetsWaitMs: 1000 }));
  const d = await get.getMyBetsDoc('ended');
  const want = Array.from(ended.querySelectorAll('bet-card')).map((c) => c.getAttribute('data-qa'));
  assert.deepEqual(Array.from(d.querySelectorAll('bet-card')).map((c) => c.getAttribute('data-qa')), want);
  assert.ok(d.querySelector('[data-qa="my-bets-filter-ended"]').classList.contains('is-active'));
});

test('getMyBetsDoc : cartes qui changent sans cesse => rejet', async () => {
  const f = factory();
  const get = mk(f, () => true, cfg({ myBetsWaitMs: 400 }));
  const p = get.getMyBetsDoc('ongoing');
  let n = 0;
  const iv = setInterval(() => { const pg = f.made[0].inner.querySelector('my-bets-page'); pg.insertAdjacentHTML('beforeend', `<bet-card data-qa="x${n++}"></bet-card>`); }, 20);
  try { await assert.rejects(p, /instable/); } finally { clearInterval(iv); }
});

test('getMyBetsDoc : myBetsWaitMs / pollMs invalides => rejet immédiat sans iframe', async () => {
  for (const c of [cfg({ myBetsWaitMs: 0 }), cfg({ myBetsWaitMs: 'x' }), cfg({ pollMs: 0 }), cfg({ pollMs: NaN })]) {
    const f = factory();
    await assert.rejects(mk(f, () => true, c).getMyBetsDoc('ongoing'));
    assert.equal(f.made.length, 0);
  }
});

test('store : STOP posé pendant un réarmement en file => stopFlag reste vrai', async () => {
  const ch = fakeChrome();
  let t = 10;
  const s = Wiring.makeSessionStore(ch, 7, () => t);
  await s.requestStop('ancien'); // at 10
  t = 20;
  const rearm = s.set({ stopped: false }); // réarmement à 20, en file
  t = 25;
  await ch.storage.session.set({ jevAutoStop: { reason: 'Échap', at: 25 } }); // STOP concurrent
  await rearm;
  assert.equal(await s.stopFlag(), true);
  assert.ok(ch.data.jevAutoStop);
  // STOP antérieur au réarmement : effacé.
  t = 30;
  await s.set({ stopped: false });
  assert.equal(await s.stopFlag(), false);
});

// ---- selectMyBetsFilter ----
function betsDoc() {
  const d = new JSDOM(fx('fixture-mybets-ongoing.html') + '<button id="betBtn">Parier</button>').window.document;
  const clicks = [];
  for (const b of d.querySelectorAll('button')) b.addEventListener('click', () => clicks.push(b.getAttribute('data-qa') || b.id));
  return { d, clicks };
}

test('selectMyBetsFilter : clique seulement le filtre voulu', () => {
  const { d, clicks } = betsDoc();
  assert.equal(Executor.selectMyBetsFilter(d, 'ended'), true);
  assert.deepEqual(clicks, ['my-bets-filter-ended']);
  assert.equal(Executor.selectMyBetsFilter(d, 'ongoing'), true);
  assert.deepEqual(clicks, ['my-bets-filter-ended', 'my-bets-filter-ongoing']);
});

test('selectMyBetsFilter : refuse un filtre invalide, ne touche jamais #betBtn', () => {
  const { d, clicks } = betsDoc();
  for (const f of ['won', '<script>', '', null, 'ongoing"]', 'betBtn']) assert.equal(Executor.selectMyBetsFilter(d, f), false);
  assert.deepEqual(clicks, []);
  assert.equal(Executor.selectMyBetsFilter(new JSDOM('<p></p>').window.document, 'ongoing'), false);
});

// ---- createRuntime (smoke) ----
test('createRuntime : init/arm/step SCAN avec modules réels, une seule now', async () => {
  const dom = new JSDOM(fx('fixture-live-list.html'), { url: ORIGIN + '/live' });
  const doc = dom.window.document;
  doc.body.insertAdjacentHTML('afterbegin', '<div class="header_walletBalance"><bc-header-animated-balance><span>100,00 €</span></bc-header-animated-balance></div>');
  const now = () => 1000;
  const modules = {
    Clock: require('../extension/src/auto/clock'), Guard: require('../extension/src/auto/guard'),
    Scanner: require('../extension/src/auto/scanner'), Selector: require('../extension/src/auto/selector'),
    Readers: require('../extension/src/auto/readers'), Executor, Controller: require('../extension/src/auto/controller'),
    Tracker: require('../extension/src/auto/tracker')
  };
  const seen = [];
  const spy = (name, mod, fn) => ({ ...mod, [fn]: (deps) => { seen.push([name, deps.now]); return mod[fn](deps); } });
  modules.Controller = spy('controller', modules.Controller, 'createController');
  modules.Executor = spy('executor', Executor, 'createExecutor');
  const ch = fakeChrome();
  const rt = Wiring.createRuntime({
    chromeApi: ch, doc, win: dom.window, tabId: 3, settings: { debug: false }, cfg: CONFIG.auto, modules,
    parseMarkets: () => [], analyze: async () => [], stakeFor: async () => 1, navigate: () => {}, now,
    sleep: async () => {}, log: () => {}, iframeFactory: factory()
  });
  assert.equal(rt.store.now, now);
  assert.equal(await rt.controller.init(), 'IDLE');
  await rt.controller.arm('PARIER AUTO', { noManualBets: true, dryRun: true });
  assert.equal((await rt.store.get()).phase, 'ARMED');
  assert.equal(await rt.controller.step(), 'SCAN');
  assert.equal(await rt.controller.step(), 'CHOIX');
  const st = await rt.store.get();
  assert.ok(Array.isArray(st.events) && st.events.length > 0);
  assert.equal(st.stopped, false);
  assert.equal(st.ownerTabId, 3);
  // makeExecutor via makeGuard (arm) : l'exécuteur reçoit la même now.
  assert.ok(seen.some(([n, f]) => n === 'controller' && f === now));
  assert.ok(seen.some(([n, f]) => n === 'executor' && f === now));
  // M5 : iframe « Mes paris » retirée dès que step() renvoie STOPPED.
  await rt.myBets.getMyBetsDoc('ongoing');
  assert.equal(doc.querySelectorAll('iframe').length, 1);
  await rt.store.set({ stopped: true });
  assert.equal(await rt.controller.step(), 'STOPPED');
  assert.equal(doc.querySelectorAll('iframe').length, 0);
  await rt.stop('test');
  assert.equal(await rt.store.stopFlag(), true);
  assert.equal((await rt.store.get()).phase, 'STOPPED');
});

test('config : myBetsPath / myBetsWaitMs validés', () => {
  const Guard = require('../extension/src/auto/guard');
  assert.equal(CONFIG.auto.myBetsPath, '/mes-paris');
  assert.equal(CONFIG.auto.myBetsWaitMs, 10000);
  for (const p of ['mes-paris', '//evil.com', '/a\\b', 'javascript:x', '/a:b', 3]) {
    assert.equal(Guard.validateConfig({ ...CONFIG.auto, myBetsPath: p }).ok, false, String(p));
  }
  assert.equal(Guard.validateConfig({ ...CONFIG.auto, myBetsWaitMs: 20001 }).ok, false);
});

test('wiring.js / executor.js : pas de clé API littérale', () => {
  for (const f of ['wiring.js', 'executor.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../extension/src/auto', f), 'utf8'), /api[_-]?key/i);
  }
});

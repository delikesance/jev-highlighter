const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CONFIG } = require('../extension/src/config');
const Guard = require('../extension/src/auto/guard');
const Controller = require('../extension/src/auto/controller');

const ORIGIN = 'https://www.betclic.fr';
const EVENT = { href: '/football/match-1', name: 'A - B', sport: 'football', clock: { running: true, elapsedSec: 600 }, index: 0 };
const MARKETS = [
  { id: 'm1', title: 'Prochain but', window: null, suspended: false, options: [{ name: 'A', odds: 2, available: true, normalizedKey: 'a' }] },
  { id: 'm2', title: 'Vainqueur', window: null, suspended: false, options: [{ name: 'A', odds: 2, available: true, normalizedKey: 'a' }] }
];

function fakeStore(init = {}) {
  let s = { ...init };
  return {
    sets: [],
    async get() { return { ...s }; },
    async set(p) { this.sets.push(p); s = { ...s, ...p }; },
    async stopFlag() { return !!s.stopped; },
    raw: () => s
  };
}

function setup(o = {}) {
  const calls = [];
  const rec = (name, fn) => (...a) => { calls.push(name); return fn(...a); };
  const cfg = { ...structuredClone(CONFIG.auto), pauseMs: 1000, ...(o.cfg || {}) };
  const guard = o.guard || Guard.create(cfg, 100);
  const store = o.store || fakeStore();
  const placeResults = o.placeResults || [];
  const tracker = {
    snapshotOngoing: rec('snapshot', async () => []),
    identify: rec('identify', async () => o.identify || { method: 'reference', reference: 'R' + calls.length }),
    resolve: rec('resolve', async (ref) => (o.resolve ? o.resolve(ref) : 'pending')),
    resolveByBalance: () => 'unknown'
  };
  const navs = [];
  const deps = {
    store, guard, tracker, cfg, tabId: o.tabId ?? 7,
    settings: o.settings || { debug: false },
    doc: { location: { origin: ORIGIN, href: ORIGIN + '/live' } },
    scanner: { scanLive: rec('scan', () => o.events || [EVENT]) },
    selector: require('../extension/src/auto/selector'),
    readers: {},
    parseMarkets: rec('parse', () => ({ markets: MARKETS })),
    analyze: rec('analyze', async () => (o.answers || [{ marketId: 'm1', choice: 'A', confidence: 0.8 }])),
    stakeFor: rec('stakeFor', async () => 5),
    executor: {
      place: rec('place', async (d) => {
        deps.lastDecision = d;
        const r = placeResults.length ? placeResults.shift() : { status: d.dryRun ? 'dry' : 'placed', stake: 5, odds: 2 };
        if (r.status === 'placed') { guard.reserve(5); guard.recordPlaced(); }
        return r;
      })
    },
    navigate: (h) => navs.push(h),
    sleep: async () => {}, now: () => 0, log: () => {}
  };
  Object.assign(deps, o.deps || {});
  return { deps, calls, navs, store, guard, ctl: Controller.createController(deps) };
}

test('arm refuse mauvaise phrase et noManualBets absent', async () => {
  const { ctl, store } = setup();
  await ctl.init();
  await ctl.arm('parier auto', { dryRun: false, noManualBets: true });
  assert.notEqual(store.raw().phase, 'ARMED');
  await ctl.arm('PARIER AUTO', { dryRun: false });
  assert.notEqual(store.raw().phase, 'ARMED');
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  assert.equal(store.raw().phase, 'ARMED');
  assert.equal(store.raw().ownerTabId, 7);
});

test('cycle normal ARMED→SCAN→CHOIX→ANALYSE→GARDE→EXEC→ATTENTE→PAUSE→SCAN', async () => {
  const { ctl, store, navs, deps } = setup();
  await ctl.init();
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  const seq = [];
  for (let i = 0; i < 8; i++) seq.push(await ctl.step());
  assert.deepEqual(seq, ['SCAN', 'CHOIX', 'ANALYSE', 'GARDE', 'EXEC', 'ATTENTE', 'PAUSE', 'SCAN']);
  assert.deepEqual(navs, ['/football/match-1']);
  assert.equal(deps.lastDecision.confidence, 0.8);
  assert.equal(deps.lastDecision.analysedOdds, 2);
  assert.equal(deps.lastDecision.marketTitle, 'Prochain but');
  assert.equal(store.raw().bets.length, 1);
  assert.equal(store.raw().bets[0].status, 'pending');
});

async function runUntilStop(ctl, n = 60) {
  let s;
  for (let i = 0; i < n; i++) { s = await ctl.step(); if (s === 'STOPPED') break; }
  return s;
}

test('STOPPED collant : step ne bouge plus et n\'appelle rien', async () => {
  const { ctl, calls, store } = setup();
  await ctl.init();
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  await ctl.stop('test');
  const n = calls.length;
  assert.equal(await ctl.step(), 'STOPPED');
  assert.equal(await ctl.step(), 'STOPPED');
  assert.equal(calls.length, n);
  assert.equal(store.raw().stopped, true);
});

test('reprise avec pending → STOPPED, place jamais appelé, réserve +1', async () => {
  const store = fakeStore({ phase: 'EXEC', ownerTabId: 7, pending: { stake: 5, marketTitle: 'x' } });
  const { ctl, calls, guard } = setup({ store });
  assert.equal(await ctl.init(), 'STOPPED');
  assert.equal(guard.state.placed, 1);
  assert.equal(guard.state.reserved, 5);
  assert.match(store.raw().message, /Mes paris/);
  await ctl.step();
  assert.ok(!calls.includes('place'));
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  assert.equal(store.raw().phase, 'STOPPED');
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true, manualCheckDone: true });
  assert.equal(store.raw().phase, 'ARMED');
  assert.equal(store.raw().pending, null);
  assert.equal(guard.state.placed, 1);
});

test('clé détectée → STOPPED et refus d\'armer', async () => {
  const k = 'api' + 'Key';
  const { ctl, store } = setup({ settings: { [k]: 'x' } });
  assert.equal(await ctl.init(), 'STOPPED');
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  assert.equal(store.raw().phase, 'STOPPED');
});

test('second onglet → STOPPED sans toucher l\'état de l\'autre', async () => {
  const store = fakeStore({ phase: 'SCAN', ownerTabId: 3 });
  const { ctl, calls } = setup({ store });
  assert.equal(await ctl.init(), 'STOPPED');
  assert.equal(await ctl.step(), 'STOPPED');
  assert.deepEqual(store.sets, []);
  assert.equal(store.raw().phase, 'SCAN');
  assert.deepEqual(calls, []);
});

test('stopped persisté → reste STOPPED', async () => {
  const store = fakeStore({ phase: 'STOPPED', stopped: true, ownerTabId: 7 });
  const { ctl } = setup({ store });
  assert.equal(await ctl.init(), 'STOPPED');
});

test('5e pari → STOPPED limite de session', async () => {
  const { ctl, store, guard } = setup();
  await ctl.init();
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  // tried empêcherait de rejouer le même événement : on le retire à chaque tour
  let s;
  for (let i = 0; i < 80; i++) { s = await ctl.step(); if (s === 'STOPPED') break; if (s === 'SCAN') await store.set({ tried: [] }); }
  assert.equal(s, 'STOPPED');
  assert.equal(guard.state.placed, 5);
  assert.match(store.raw().reason, /limite de session/);
});

test('exception d\'une dépendance → STOPPED sans propagation', async () => {
  const { ctl, store } = setup({ deps: { scanner: { scanLive: () => { throw new Error('boom'); } } } });
  await ctl.init();
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  await ctl.step();
  assert.equal(await ctl.step(), 'STOPPED');
  assert.match(store.raw().reason, /boom/);
});

test('executor halt → STOPPED', async () => {
  const { ctl, store } = setup({ placeResults: [{ status: 'halt', reason: 'dérive' }] });
  await ctl.init();
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  assert.equal(await runUntilStop(ctl), 'STOPPED');
  assert.match(store.raw().reason, /dérive/);
});

test('href externe → STOPPED sans navigate', async () => {
  const { ctl, navs } = setup({ events: [{ ...EVENT, href: 'https://evil.example/x' }] });
  await ctl.init();
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  assert.equal(await runUntilStop(ctl, 5), 'STOPPED');
  assert.deepEqual(navs, []);
  const s2 = setup({ events: [{ ...EVENT, href: '//evil.example/x' }] });
  await s2.ctl.init();
  await s2.ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  assert.equal(await runUntilStop(s2.ctl, 5), 'STOPPED');
  assert.deepEqual(s2.navs, []);
});

test('aucun pick → événement tried et retour SCAN', async () => {
  const { ctl, store } = setup({ answers: [] });
  await ctl.init();
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(await ctl.step());
  assert.deepEqual(seq, ['SCAN', 'CHOIX', 'ANALYSE', 'SCAN']);
  assert.deepEqual(store.raw().tried, ['/football/match-1']);
});

test('identify none → STOPPED', async () => {
  const { ctl } = setup({ identify: { method: 'none' } });
  await ctl.init();
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  assert.equal(await runUntilStop(ctl), 'STOPPED');
});

test('3 défaites résolues → STOPPED', async () => {
  const { ctl, store, guard } = setup({ resolve: () => 'lost' });
  await ctl.init();
  await ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true });
  let s;
  for (let i = 0; i < 80; i++) { s = await ctl.step(); if (s === 'STOPPED') break; if (s === 'SCAN') await store.set({ tried: [] }); }
  assert.equal(s, 'STOPPED');
  assert.equal(guard.state.consecutiveLosses, 3);
  assert.equal(guard.state.reserved, 0);
  assert.match(store.raw().reason, /défaites/);
});

test('dryRun n\'incrémente pas placed', async () => {
  const { ctl, guard, store } = setup();
  await ctl.init();
  await ctl.arm('PARIER AUTO', { dryRun: true, noManualBets: true });
  for (let i = 0; i < 8; i++) await ctl.step();
  assert.equal(guard.state.placed, 0);
  assert.equal((store.raw().bets || []).length, 0);
});

test('controller.js : ni clic, ni mot de la clé', () => {
  const src = fs.readFileSync(path.join(__dirname, '../extension/src/auto/controller.js'), 'utf8');
  assert.doesNotMatch(src, /apiKey|\.click\(|dispatchEvent|eval\(|setInterval/);
});

test('validateConfig : pauseMs borné', () => {
  assert.equal(CONFIG.auto.pauseMs, 5000);
  assert.equal(Guard.validateConfig({ ...CONFIG.auto, pauseMs: 500 }).ok, false);
  assert.equal(Guard.validateConfig({ ...CONFIG.auto, pauseMs: 70000 }).ok, false);
});

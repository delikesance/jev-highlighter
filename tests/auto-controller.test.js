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
  const store = o.store || fakeStore();
  const placeResults = o.placeResults || [];
  const world = o.world || { wallet: 100, walletReads: 0, path: '/live' };
  const doc = {
    location: {
      get href() { return ORIGIN + world.path; }, origin: ORIGIN, protocol: 'https:',
      get pathname() { return new URL(world.path, ORIGIN).pathname; }
    }
  };
  const tracker = {
    snapshotOngoing: rec('snapshot', async () => []),
    identify: rec('identify', async () => o.identify || { method: 'reference', reference: 'R' + calls.length }),
    resolve: rec('resolve', async (ref) => (o.resolve ? o.resolve(ref) : 'pending')),
    resolveByBalance: rec('resolveByBalance', (prev, stakes) => (o.byBalance ? o.byBalance(prev, stakes) : 'unknown'))
  };
  const navs = [];
  const deps = {
    store, tracker, cfg, doc, tabId: o.tabId ?? 7,
    settings: o.settings || { debug: false },
    makeGuard: (sb, snap) => { calls.push('makeGuard'); deps.guard = Guard.create(cfg, sb, snap); return deps.guard; },
    readers: { readWalletStable: rec('wallet', async () => { world.walletReads++; return world.wallet; }) },
    scanner: { scanLive: rec('scan', () => o.events || [EVENT]) },
    selector: require('../extension/src/auto/selector'),
    parseMarkets: rec('parse', () => ({ markets: o.markets || MARKETS })),
    analyze: rec('analyze', async () => (o.answers || [{ marketId: 'm1', choice: 'A', confidence: 0.8 }])),
    stakeFor: rec('stakeFor', async () => o.stake || 5),
    makeExecutor: (guard) => ({
      place: rec('place', async (d) => {
        deps.lastDecision = d;
        if (placeResults.length) return placeResults.shift();
        const st = await store.get();
        if (st.pending) return { status: 'halt', reason: 'pending' };
        const stake = guard.maxStake(d.suggestedStake);
        const v = guard.check({ balance: world.wallet, stake, odds: d.analysedOdds, analysedOdds: d.analysedOdds, suspended: false, leadSec: 200, confidence: d.confidence });
        if (v.verdict === 'ARRET') return { status: 'halt', reason: v.reason };
        if (v.verdict !== 'OUI') return { status: 'refused', reason: v.reason };
        if (d.dryRun) return { status: 'dry', stake, odds: d.analysedOdds };
        await store.set({ pending: { stake } });
        guard.reserve(stake);
        if (o.crashInPlace) throw new Error('rechargement pendant place');
        guard.recordPlaced();
        await store.set({ pending: null });
        return { status: 'placed', stake, odds: d.analysedOdds };
      })
    }),
    navigate: (h) => { navs.push(h); world.path = new URL(h).pathname; },
    sleep: async () => {}, now: () => 0, log: () => {}
  };
  Object.assign(deps, o.deps || {});
  const ctl = Controller.createController(deps);
  return { deps, calls, navs, store, world, ctl, get guard() { return deps.guard; } };
}

const ARM = ['PARIER AUTO', { dryRun: false, noManualBets: true }];

async function armed(o) {
  const t = setup(o);
  await t.ctl.init();
  await t.ctl.arm(...(o && o.arm || ARM));
  return t;
}
async function runUntil(ctl, n = 60, stopAt = 'STOPPED') {
  let s;
  for (let i = 0; i < n; i++) { s = await ctl.step(); if (s === stopAt) break; }
  return s;
}
// Rechargement simulé : nouveau contrôleur ET nouveau guard à chaque step, même store et même « page ».
async function reloadingRun(o, n = 150, onScan) {
  const store = fakeStore();
  const world = { wallet: 100, walletReads: 0, path: '/live' };
  let t = setup({ ...o, store, world });
  await t.ctl.init();
  await t.ctl.arm(...ARM);
  let s; const all = { place: 0 };
  for (let i = 0; i < n; i++) {
    t = setup({ ...o, store, world });
    await t.ctl.init();
    s = await t.ctl.step();
    all.place += t.calls.filter((c) => c === 'place').length;
    if (s === 'STOPPED') break;
    if (s === 'SCAN' && onScan) await onScan(store, world, t);
  }
  return { s, store, world, t, all };
}

test('arm refuse mauvaise phrase et noManualBets absent', async () => {
  const { ctl, store } = setup();
  await ctl.init();
  await ctl.arm('parier auto', { dryRun: false, noManualBets: true });
  assert.notEqual(store.raw().phase, 'ARMED');
  await ctl.arm('PARIER AUTO', { dryRun: false });
  assert.notEqual(store.raw().phase, 'ARMED');
  await ctl.arm(...ARM);
  assert.equal(store.raw().phase, 'ARMED');
  assert.equal(store.raw().ownerTabId, 7);
  assert.equal(store.raw().session.startBalance, 100);
});

test('arm refusé si solde illisible', async () => {
  const t = setup();
  t.world.wallet = null;
  await t.ctl.init();
  await t.ctl.arm(...ARM);
  assert.notEqual(t.store.raw().phase, 'ARMED');
});

test('cycle normal ARMED→SCAN→CHOIX→ANALYSE→GARDE→EXEC→ATTENTE→PAUSE→SCAN, retour /live', async () => {
  const t = await armed();
  const seq = [];
  for (let i = 0; i < 9; i++) seq.push(await t.ctl.step());
  assert.deepEqual(seq, ['SCAN', 'CHOIX', 'ANALYSE', 'GARDE', 'EXEC', 'ATTENTE', 'PAUSE', 'SCAN', 'SCAN']);
  assert.deepEqual(t.navs, [ORIGIN + '/football/match-1', ORIGIN + '/live']);
  assert.equal(t.deps.lastDecision.confidence, 0.8);
  assert.equal(t.deps.lastDecision.analysedOdds, 2);
  assert.equal(t.deps.lastDecision.marketTitle, 'Prochain but');
  assert.equal(t.store.raw().bets.length, 1);
  assert.equal(t.store.raw().bets[0].status, 'pending');
  assert.deepEqual({ ...t.store.raw().guardSnap }, { placed: 1, reserved: 5, inFlight: 0, consecutiveLosses: 0 });
});

test('STOPPED collant : step ne bouge plus et n\'appelle rien', async () => {
  const t = await armed();
  await t.ctl.stop('test');
  const n = t.calls.length;
  assert.equal(await t.ctl.step(), 'STOPPED');
  assert.equal(await t.ctl.step(), 'STOPPED');
  assert.equal(t.calls.length, n);
  assert.equal(t.store.raw().stopped, true);
});

test('reprise avec pending → STOPPED, place jamais appelé, réserve +1, pas de double compte', async () => {
  const store = fakeStore({ phase: 'EXEC', ownerTabId: 7, session: { startBalance: 100 }, pending: { stake: 5, marketTitle: 'x' } });
  let t = setup({ store });
  assert.equal(await t.ctl.init(), 'STOPPED');
  assert.equal(t.guard.state.placed, 1);
  assert.equal(t.guard.state.reserved, 5);
  assert.match(store.raw().message, /Mes paris/);
  await t.ctl.step();
  assert.ok(!t.calls.includes('place'));
  // rechargement : le pending déjà compté dans l'instantané n'est pas recompté
  t = setup({ store });
  await t.ctl.init();
  assert.equal(t.guard.state.placed, 1);
  assert.equal(t.guard.state.reserved, 5);
  await t.ctl.arm(...ARM);
  assert.equal(store.raw().phase, 'STOPPED');
  await t.ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true, manualCheckDone: true });
  assert.equal(store.raw().phase, 'ARMED');
  assert.equal(store.raw().pending, null);
  assert.equal(t.guard.state.placed, 1);
  assert.equal(store.raw().session.startBalance, 100);
});

test('crash pendant place → rechargement compte le pending une seule fois', async () => {
  const store = fakeStore();
  const world = { wallet: 100, walletReads: 0, path: '/live' };
  let t = setup({ store, world, crashInPlace: true });
  await t.ctl.init(); await t.ctl.arm(...ARM);
  await runUntil(t.ctl, 10, 'STOPPED');
  // simule le rechargement survenu au milieu de place() : état d'avant l'exception
  await store.set({ stopped: false, phase: 'EXEC' });
  t = setup({ store, world });
  assert.equal(await t.ctl.init(), 'STOPPED');
  assert.equal(t.guard.state.placed, 1);
  assert.equal(t.guard.state.reserved, 5);
});

test('clé détectée → STOPPED et refus d\'armer', async () => {
  const k = 'api' + 'Key';
  const { ctl, store } = setup({ settings: { [k]: 'x' } });
  assert.equal(await ctl.init(), 'STOPPED');
  await ctl.arm(...ARM);
  assert.equal(store.raw().phase, 'STOPPED');
});

test('second onglet → STOPPED sans toucher l\'état de l\'autre (même avec la clé)', async () => {
  const k = 'api' + 'Key';
  const store = fakeStore({ phase: 'SCAN', ownerTabId: 3 });
  const { ctl, calls } = setup({ store, settings: { [k]: 'x' } });
  assert.equal(await ctl.init(), 'STOPPED');
  assert.equal(await ctl.step(), 'STOPPED');
  await ctl.stop('x');
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
  const t = await armed();
  let s;
  for (let i = 0; i < 80; i++) { s = await t.ctl.step(); if (s === 'STOPPED') break; if (s === 'SCAN') await t.store.set({ tried: [] }); }
  assert.equal(s, 'STOPPED');
  assert.equal(t.guard.state.placed, 5);
  assert.match(t.store.raw().reason, /limite de session/);
});

test('rechargement à chaque step : le 6e pari n\'est jamais tenté', async () => {
  const r = await reloadingRun({}, 200, (store) => store.set({ tried: [] }));
  assert.equal(r.s, 'STOPPED');
  assert.equal(r.all.place, 5);
  assert.equal(r.store.raw().bets.length, 5);
  assert.match(r.store.raw().reason, /limite de session/);
  assert.equal(r.world.walletReads, 1);
  assert.equal(r.store.raw().session.startBalance, 100);
});

test('rechargements : 3 défaites → STOPPED', async () => {
  const r = await reloadingRun({ resolve: () => 'lost' }, 200, (store) => store.set({ tried: [] }));
  assert.equal(r.s, 'STOPPED');
  assert.match(r.store.raw().reason, /défaites/);
  assert.equal(r.t.guard.state.consecutiveLosses, 3);
});

test('rechargements : perte > 50 % du solde de départ → refus, solde de départ non relu', async () => {
  let n = 0;
  const r = await reloadingRun({ stake: 10, resolve: () => 'won' }, 200, (store, world) => { n++; world.wallet = 55; return store.set({ tried: [] }); });
  assert.equal(r.world.walletReads, 1);
  assert.equal(r.store.raw().session.startBalance, 100);
  assert.equal(r.all.place >= 1, true);
  assert.equal(r.store.raw().bets.length, 0);
  assert.ok(n > 0);
});

test('exception d\'une dépendance → STOPPED sans propagation', async () => {
  const t = await armed({ deps: { scanner: { scanLive: () => { throw new Error('boom'); } } } });
  await t.ctl.step();
  assert.equal(await t.ctl.step(), 'STOPPED');
  assert.match(t.store.raw().reason, /boom/);
});

test('exception dans place → instantané persisté', async () => {
  const t = await armed({ crashInPlace: true });
  assert.equal(await runUntil(t.ctl, 10), 'STOPPED');
  assert.equal(t.store.raw().guardSnap.reserved, 5);
});

test('executor halt → STOPPED', async () => {
  const t = await armed({ placeResults: [{ status: 'halt', reason: 'dérive' }] });
  assert.equal(await runUntil(t.ctl), 'STOPPED');
  assert.match(t.store.raw().reason, /dérive/);
});

for (const bad of ['/\t/evil.com/x', '//evil.com', '/\\evil.com', 'javascript:alert(1)', 'https://evil.com/', 'https://evilbetclic.fr', 'http://www.betclic.fr/x']) {
  test('href refusé : ' + JSON.stringify(bad), async () => {
    const t = await armed({ events: [{ ...EVENT, href: bad }] });
    assert.equal(await runUntil(t.ctl, 5), 'STOPPED');
    assert.deepEqual(t.navs, []);
  });
}

test('href relatif accepté, URL résolue transmise', async () => {
  const t = await armed({ events: [{ ...EVENT, href: '/football-sfootball/x-m1' }] });
  await runUntil(t.ctl, 3, 'ANALYSE');
  assert.deepEqual(t.navs, [ORIGIN + '/football-sfootball/x-m1']);
});

test('aucun pick → événement tried et retour SCAN puis /live', async () => {
  const t = await armed({ answers: [] });
  const seq = [];
  for (let i = 0; i < 5; i++) seq.push(await t.ctl.step());
  assert.deepEqual(seq, ['SCAN', 'CHOIX', 'ANALYSE', 'SCAN', 'SCAN']);
  assert.deepEqual(t.store.raw().tried, ['/football/match-1']);
  assert.equal(t.navs.at(-1), ORIGIN + '/live');
});

test('marché du pick introuvable → tried, SCAN', async () => {
  const sel = require('../extension/src/auto/selector');
  const t = await armed({ deps: { selector: { ...sel, pickSelections: () => [{ marketId: 'zz', label: 'A', odds: 2, confidence: 0.8, window: null }] } } });
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(await t.ctl.step());
  assert.deepEqual(seq, ['SCAN', 'CHOIX', 'ANALYSE', 'SCAN']);
  assert.deepEqual(t.store.raw().tried, ['/football/match-1']);
});

test('identify none → STOPPED', async () => {
  const t = await armed({ identify: { method: 'none' } });
  assert.equal(await runUntil(t.ctl), 'STOPPED');
});

test('pari sans référence : resolveByBalance, jamais resolve(null), réserve libérée une fois', async () => {
  const t = await armed({ identify: { method: 'balance' }, byBalance: () => 'lost' });
  for (let i = 0; i < 12; i++) await t.ctl.step();
  assert.ok(t.calls.includes('resolveByBalance'));
  assert.ok(!t.calls.includes('resolve'));
  const b = t.store.raw().bets[0];
  assert.equal(b.prevBalance, 100);
  assert.equal(b.status, 'lost');
  assert.equal(b.released, true);
});

test('3 défaites résolues → STOPPED, réserve libérée', async () => {
  const t = await armed({ resolve: () => 'lost' });
  let s;
  for (let i = 0; i < 80; i++) { s = await t.ctl.step(); if (s === 'STOPPED') break; if (s === 'SCAN') await t.store.set({ tried: [] }); }
  assert.equal(s, 'STOPPED');
  assert.equal(t.guard.state.consecutiveLosses, 3);
  assert.equal(t.guard.state.reserved, 0);
  assert.match(t.store.raw().reason, /défaites/);
});

test('dryRun n\'incrémente pas placed', async () => {
  const t = await armed({ arm: ['PARIER AUTO', { dryRun: true, noManualBets: true }] });
  for (let i = 0; i < 8; i++) await t.ctl.step();
  assert.equal(t.guard.state.placed, 0);
  assert.equal((t.store.raw().bets || []).length, 0);
});

test('ré-entrance : deux step() concurrents → un seul place()', async () => {
  const t = await armed();
  for (let i = 0; i < 5; i++) await t.ctl.step();
  assert.equal(t.store.raw().phase, 'EXEC');
  const n = t.store.sets.length;
  const [a, b] = await Promise.all([t.ctl.step(), t.ctl.step()]);
  assert.equal(t.calls.filter((c) => c === 'place').length, 1);
  assert.deepEqual([a, b].sort(), ['ATTENTE', 'EXEC']);
  assert.ok(t.store.sets.length > n);
});

test('limite de cycles → STOPPED', async () => {
  const t = await armed({ cfg: { maxCycles: 2 }, answers: [] });
  let s;
  for (let i = 0; i < 40; i++) { s = await t.ctl.step(); if (s === 'STOPPED') break; if (s === 'SCAN') await t.store.set({ tried: [] }); }
  assert.equal(s, 'STOPPED');
  assert.match(t.store.raw().reason, /limite de cycles/);
});

test('controller.js : ni clic, ni mot de la clé', () => {
  const src = fs.readFileSync(path.join(__dirname, '../extension/src/auto/controller.js'), 'utf8');
  assert.doesNotMatch(src, /apiKey|\.click\(|dispatchEvent|eval\(|setInterval/);
});

test('validateConfig : pauseMs borné', () => {
  assert.equal(CONFIG.auto.pauseMs, 5000);
  assert.equal(CONFIG.auto.maxCycles, 60);
  assert.equal(Guard.validateConfig({ ...CONFIG.auto, pauseMs: 500 }).ok, false);
  assert.equal(Guard.validateConfig({ ...CONFIG.auto, pauseMs: 70000 }).ok, false);
});

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
    sets: [], crashWhen: null, dead: false,
    async get() { return { ...s }; },
    // crashWhen(patch) vrai : le patch est appliqué puis la page « meurt » (écritures suivantes perdues).
    async set(p) {
      if (this.dead) throw new Error('page morte');
      this.sets.push(p); s = { ...s, ...p };
      if (this.crashWhen && this.crashWhen(p)) { this.dead = true; this.crashWhen = null; throw new Error('crash'); }
    },
    revive() { this.dead = false; },
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
    snapshotOngoing: rec('snapshot', async () => (o.snapshot === null ? null : [])),
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
        guard.reserve(stake);
        await store.set({ pending: { stake, reservedInSnap: true, execId: d.execId }, guardSnap: guard.snapshot() });
        if (o.crashInPlace) throw new Error('rechargement pendant place');
        guard.recordPlaced();
        await store.set({ pending: null, lastPlaced: { marketTitle: d.marketTitle, window: d.window, label: d.label, event: d.event, stake, at: deps.now(), execId: d.execId }, guardSnap: guard.snapshot() });
        return { status: 'placed', stake, odds: d.analysedOdds };
      })
    }),
    navigate: (h) => { navs.push(h); world.path = new URL(h).pathname; },
    sleep: async () => {}, now: o.now || (() => (world.clock = (world.clock || 0) + 1)), log: () => {}
  };
  Object.assign(deps, o.deps || {});
  const ctl = Controller.createController(deps);
  return { deps, calls, navs, store, world, ctl, get guard() { return deps.guard; } };
}

const ARM = ['PARIER AUTO', { dryRun: false, noManualBets: true }];

test('flow JEV : live choisi par JEV, marché hors Fast accepté, mise différée au ticket', async () => {
  const second = { ...EVENT, href: '/football/second', name: 'C - D' };
  const calls = [];
  const t = await armed({ events: [EVENT, second], markets: [MARKETS[1]], answers: [{ marketId: 'm2', choice: 'A', confidence: 0.8 }], deps: {
    chooseEvent: async (events) => { calls.push('live'); return events[1]; },
    ticketSizing: true,
    stakeFor: async () => { throw new Error('mise demandée avant ticket'); }
  } });
  await t.ctl.step(); await t.ctl.step();
  assert.equal(await t.ctl.step(), 'ANALYSE');
  assert.equal(t.store.raw().event.href, second.href);
  assert.equal(await t.ctl.step(), 'GARDE');
  assert.equal(t.store.raw().pick.marketId, 'm2');
  assert.equal(await t.ctl.step(), 'EXEC');
  assert.deepEqual(calls, ['live']);
});

test('match sans pick : réanalyse après 30 secondes, pas exclusion permanente', async () => {
  let time = 0;
  const t = await armed({ answers: [], now: () => time });
  await t.ctl.step(); await t.ctl.step(); await t.ctl.step(); await t.ctl.step();
  assert.equal(t.store.raw().retryAfter[EVENT.href], 30000);
  await t.ctl.step(); await t.ctl.step(); await t.ctl.step();
  assert.equal(t.store.raw().events.length, 0);
  time = 30001;
  await t.store.set({ phase: 'SCAN' });
  await t.ctl.step();
  assert.equal(t.store.raw().events.length, 1);
});

test('JEV : meilleur score choisi parmi les marchés éligibles non joués', async () => {
  const second = { ...MARKETS[0], id: 'm3', title: 'Prochain buteur' };
  const t = await armed({ markets: [MARKETS[0], second], answers: [
    { marketId: 'm1', choice: 'A', confidence: 0.8, jevScore: 0.65 },
    { marketId: 'm3', choice: 'A', confidence: 0.7, jevScore: 0.9 }
  ] });
  await t.ctl.step(); await t.ctl.step(); await t.ctl.step(); await t.ctl.step();
  assert.equal(t.store.raw().pick.marketId, 'm3');
  await t.store.set({ phase: 'ANALYSE', playedKeys: [`${EVENT.href}|Prochain buteur||A`] });
  assert.equal(await t.ctl.step(), 'GARDE');
  assert.equal(t.store.raw().pick.marketId, 'm1');
});

test('SCAN explique les matchs déjà tentés au lieu de prétendre qu’aucun match n’est en cours', async () => {
  const t = await armed();
  await t.store.set({ phase: 'SCAN', tried: [EVENT.href] });
  assert.equal(await t.ctl.step(), 'CHOIX');
  assert.equal(await t.ctl.step(), 'PAUSE');
  assert.match(t.store.raw().message, /1 déjà tenté/);
  assert.equal(t.store.raw().scanSummary.total, 1);
});

test('ANALYSE attend les marchés après un rendu Angular tardif', async () => {
  let reads = 0;
  let clock = 0;
  const t = await armed({ deps: {
    parseMarkets: () => ++reads < 3 ? [] : MARKETS,
    now: () => clock,
    sleep: async (ms) => { clock += ms; }
  } });
  await t.ctl.step(); await t.ctl.step(); await t.ctl.step();
  assert.equal(await t.ctl.step(), 'GARDE');
  assert.equal(reads, 3);
});

test('STOP pendant PAUSE reste STOPPED sans être remplacé par SCAN', async () => {
  const t = await armed({ events: [] });
  await t.ctl.step(); await t.ctl.step(); await t.ctl.step();
  t.deps.sleep = async () => { await t.ctl.stop('STOP pendant pause'); };
  // sleep est capturé à la construction : crée une nouvelle instance avec la même session.
  const resumed = setup({ store: t.store, deps: { sleep: t.deps.sleep } });
  await resumed.ctl.init();
  assert.equal(await resumed.ctl.step(), 'STOPPED');
  assert.equal(t.store.raw().phase, 'STOPPED');
});

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

test('(b) crash juste après l\'écriture de pending → init compte le pari une seule fois', async () => {
  const store = fakeStore();
  const world = { wallet: 100, walletReads: 0, path: '/live' };
  let t = setup({ store, world });
  await t.ctl.init(); await t.ctl.arm(...ARM);
  store.crashWhen = (p) => p.pending && p.pending.stake;
  await runUntil(t.ctl, 10, 'STOPPED');
  store.revive();
  assert.equal(store.raw().phase, 'EXEC');
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
  for (let i = 0; i < 80; i++) { s = await t.ctl.step(); if (s === 'STOPPED') break; if (s === 'SCAN') await t.store.set({ tried: [], playedKeys: [] }); }
  assert.equal(s, 'STOPPED');
  assert.equal(t.guard.state.placed, 5);
  assert.match(t.store.raw().reason, /limite de session/);
});

test('rechargement à chaque step : le 6e pari n\'est jamais tenté', async () => {
  const r = await reloadingRun({}, 200, (store) => store.set({ tried: [], playedKeys: [] }));
  assert.equal(r.s, 'STOPPED');
  assert.equal(r.all.place, 5);
  assert.equal(r.store.raw().bets.length, 5);
  assert.match(r.store.raw().reason, /limite de session/);
  assert.equal(r.world.walletReads, 1);
  assert.equal(r.store.raw().session.startBalance, 100);
});

test('rechargements : 3 défaites → STOPPED', async () => {
  const r = await reloadingRun({ resolve: () => 'lost' }, 200, (store) => store.set({ tried: [], playedKeys: [] }));
  assert.equal(r.s, 'STOPPED');
  assert.match(r.store.raw().reason, /défaites/);
  assert.equal(r.t.guard.state.consecutiveLosses, 3);
});

test('rechargements : perte > 50 % du solde de départ → refus, solde de départ non relu', async () => {
  let n = 0;
  const r = await reloadingRun({ stake: 10, resolve: () => 'won' }, 200, (store, world) => { n++; world.wallet = 55; return store.set({ tried: [], playedKeys: [] }); });
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

test('aucun pick → pause obligatoire avant retour /live, pas de flood', async () => {
  const t = await armed({ answers: [] });
  const seq = [];
  for (let i = 0; i < 6; i++) seq.push(await t.ctl.step());
  assert.deepEqual(seq, ['SCAN', 'CHOIX', 'ANALYSE', 'PAUSE', 'SCAN', 'SCAN']);
  assert.deepEqual(t.store.raw().tried, ['/football/match-1']);
  assert.equal(t.navs.at(-1), ORIGIN + '/live');
});

test('marché du pick introuvable → tried, PAUSE', async () => {
  const sel = require('../extension/src/auto/selector');
  const t = await armed({ deps: { selector: { ...sel, pickSelections: () => [{ marketId: 'zz', label: 'A', odds: 2, confidence: 0.8, window: null }] } } });
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(await t.ctl.step());
  assert.deepEqual(seq, ['SCAN', 'CHOIX', 'ANALYSE', 'PAUSE']);
  assert.deepEqual(t.store.raw().tried, ['/football/match-1']);
});

test('refus : motif conservé dans le panneau, pause avant toute nouvelle analyse', async () => {
  const t = await armed({ placeResults: [{ status: 'refused', reason: 'confiance JEV insuffisante' }] });
  for (let i = 0; i < 6; i++) await t.ctl.step();
  assert.equal(t.store.raw().phase, 'PAUSE');
  assert.match(t.store.raw().message, /Pari non placé : confiance JEV insuffisante/);
  const analyzed = t.calls.filter((c) => c === 'analyze').length;
  assert.equal(await t.ctl.step(), 'SCAN');
  assert.equal(t.calls.filter((c) => c === 'analyze').length, analyzed);
});

test('identify none → STOPPED', async () => {
  const t = await armed({ identify: { method: 'none' } });
  assert.equal(await runUntil(t.ctl), 'STOPPED');
});

test('identify balance → STOPPED, pari « unverified » compté, réserve conservée, aucune relance', async () => {
  const t = await armed({ identify: { method: 'balance' } });
  assert.equal(await runUntil(t.ctl), 'STOPPED');
  const st = t.store.raw();
  assert.equal(st.bets.length, 1);
  assert.equal(st.bets[0].status, 'unverified');
  assert.equal(st.bets[0].prevBalance, 100);
  assert.ok(t.guard.state.reserved > 0);
  assert.match(st.reason, /suivi impossible/);
  assert.ok(!t.calls.includes('resolveByBalance'));
  const n = t.calls.length;
  await t.ctl.step();
  assert.equal(t.calls.length, n);
});

test('snapshot null → STOPPED sans place()', async () => {
  const t = await armed({ snapshot: null });
  assert.equal(await runUntil(t.ctl), 'STOPPED');
  assert.match(t.store.raw().message, /Aucun pari validé/);
  assert.ok(!t.calls.includes('place'));
});

test('3 défaites résolues → STOPPED, réserve libérée', async () => {
  const t = await armed({ resolve: () => 'lost' });
  let s;
  for (let i = 0; i < 80; i++) { s = await t.ctl.step(); if (s === 'STOPPED') break; if (s === 'SCAN') await t.store.set({ tried: [], playedKeys: [] }); }
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

test('dryRun : une seule simulation puis STOPPED, aucune boucle de requêtes', async () => {
  let time = 0;
  const t = await armed({ now: () => time, arm: ['PARIER AUTO', { dryRun: true, noManualBets: true }] });
  for (let i = 0; i < 8; i++) await t.ctl.step();
  assert.equal(t.calls.filter((c) => c === 'place').length, 1);
  assert.deepEqual(t.store.raw().playedKeys, []);
  time = 30001;
  for (let i = 0; i < 8; i++) await t.ctl.step();
  assert.equal(t.calls.filter((c) => c === 'place').length, 1);
  assert.equal(t.store.raw().phase, 'STOPPED');
  assert.match(t.store.raw().message, /Simulation terminée/);
  assert.equal(t.guard.state.placed, 0);
  assert.equal(t.guard.state.reserved, 0);
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
  for (let i = 0; i < 40; i++) { s = await t.ctl.step(); if (s === 'STOPPED') break; if (s === 'SCAN') await t.store.set({ tried: [], playedKeys: [] }); }
  assert.equal(s, 'STOPPED');
  assert.match(t.store.raw().reason, /limite de cycles/);
});

test('controller.js : ni clic, ni mot de la clé', () => {
  const src = fs.readFileSync(path.join(__dirname, '../extension/src/auto/controller.js'), 'utf8');
  assert.doesNotMatch(src, /apiKey|\.click\(|dispatchEvent|eval\(|setInterval/);
});

test('validateConfig : pauseMs borné', () => {
  assert.equal(CONFIG.auto.pauseMs, 30000);
  assert.equal(CONFIG.auto.maxCycles, 60);
  assert.equal(Guard.validateConfig({ ...CONFIG.auto, pauseMs: 500 }).ok, false);
  assert.equal(Guard.validateConfig({ ...CONFIG.auto, pauseMs: 70000 }).ok, false);
});

async function toCrash(pred, o = {}) {
  const store = fakeStore();
  const world = { wallet: 100, walletReads: 0, path: '/live' };
  let t = setup({ store, world, ...o });
  await t.ctl.init(); await t.ctl.arm(...ARM);
  store.crashWhen = pred;
  const s = await runUntil(t.ctl, 10, 'STOPPED');
  store.revive();
  return { store, world, s, first: t };
}

test('(a) crash juste après {pending:null, lastPlaced, guardSnap} → compté une fois, EXEC non rejoué', async () => {
  const { store, world } = await toCrash((p) => p.pending === null && p.lastPlaced);
  assert.equal(store.raw().phase, 'EXEC');
  const t = setup({ store, world });
  assert.equal(await t.ctl.init(), 'EXEC');
  assert.equal(t.guard.state.placed, 1);
  assert.equal(t.guard.state.reserved, 5);
  assert.equal(await t.ctl.step(), 'ATTENTE');
  assert.ok(!t.calls.includes('place'));
  assert.equal(await t.ctl.step(), 'PAUSE');
  assert.equal(store.raw().bets.length, 1);
  assert.equal(store.raw().bets[0].stake, 5);
  assert.equal(t.guard.state.placed, 1);
});

test('(a bis) lastPlaced adopté sans snapshot « before » → pari sans référence, prevBalance connu', async () => {
  const { store, world } = await toCrash((p) => p.pending === null && p.lastPlaced);
  await store.set({ before: null });
  const t = setup({ store, world });
  await t.ctl.init();
  assert.equal(await t.ctl.step(), 'STOPPED');
  assert.ok(!t.calls.includes('place'));
  const b = store.raw().bets[0];
  assert.equal(b.ref, null); assert.equal(b.status, 'unverified');
  assert.equal(b.prevBalance, 100);
});

test('(c) crash avant tout (entrée en EXEC) → rien compté, rejeu autorisé', async () => {
  const { store, world } = await toCrash((p) => p.phase === 'EXEC');
  const t = setup({ store, world });
  assert.equal(await t.ctl.init(), 'EXEC');
  assert.equal(t.guard.state.placed, 0);
  assert.equal(t.guard.state.reserved, 0);
  assert.equal(await t.ctl.step(), 'ATTENTE');
  assert.equal(t.calls.filter((c) => c === 'place').length, 1);
  assert.equal(t.guard.state.placed, 1);
});

test('(c bis) pending présent en EXEC → STOPPED, pas de place', async () => {
  const store = fakeStore({ phase: 'EXEC', ownerTabId: 7, session: { startBalance: 100 }, pending: { stake: 5, reservedInSnap: true }, guardSnap: { placed: 0, reserved: 5, inFlight: 1, consecutiveLosses: 0 } });
  const t = setup({ store });
  assert.equal(await t.ctl.init(), 'STOPPED');
  assert.equal(t.guard.state.placed, 1);
  assert.equal(t.guard.state.reserved, 5);
  await t.ctl.step();
  assert.ok(!t.calls.includes('place'));
});

test('(d) même pari réel filtré dès ANALYSE, aucun second place()', async () => {
  const t = await armed();
  for (let i = 0; i < 5; i++) await t.ctl.step();
  assert.equal(t.store.raw().phase, 'EXEC');
  assert.deepEqual(t.store.raw().tried, ['/football/match-1']);
  for (let i = 0; i < 3; i++) await t.ctl.step();
  await t.store.set({ tried: [] });
  let s;
  for (let i = 0; i < 6; i++) {
    s = await t.ctl.step();
    if (t.calls.filter((c) => c === 'analyze').length === 2) break;
  }
  assert.equal(s, 'PAUSE');
  assert.equal(t.calls.filter((c) => c === 'place').length, 1);
  assert.equal(t.store.raw().playedKeys.length, 1);
});

test('horloge qui recule + crash après {pending:null,lastPlaced,guardSnap} → place() une seule fois', async () => {
  let c = 1000;
  const now = () => (c -= 7); // chaque lecture renvoie une valeur plus petite (NTP en arrière)
  const { store, world } = await toCrash((p) => p.pending === null && p.lastPlaced, { now });
  const lp = store.raw().lastPlaced;
  assert.equal(lp.execId, store.raw().execId);
  let total = 1;
  const t = setup({ store, world, now });
  await t.ctl.init();
  for (let i = 0; i < 3; i++) await t.ctl.step();
  total += t.calls.filter((x) => x === 'place').length;
  assert.equal(total, 1);
  assert.equal(store.raw().bets.length, 1);
  assert.equal(t.guard.state.placed, 1);
});

test('execId transmis à l\'exécuteur et incrémenté', async () => {
  const t = await armed();
  for (let i = 0; i < 6; i++) await t.ctl.step();
  assert.equal(t.deps.lastDecision.execId, 'exec-1');
  assert.equal(t.store.raw().execSeq, 1);
});

test('arm(manualCheckDone) : le pari incertain passe dans bets (unverified), compté par endRules', async () => {
  const store = fakeStore({ phase: 'EXEC', ownerTabId: 7, session: { startBalance: 100 }, bets: [{ ref: 'a', status: 'won', stake: 5, released: true }, { ref: 'b', status: 'won', stake: 5, released: true }, { ref: 'c', status: 'won', stake: 5, released: true }, { ref: 'd', status: 'won', stake: 5, released: true }],
    guardSnap: { placed: 0, reserved: 0, inFlight: 0, consecutiveLosses: 0 }, pending: { stake: 5, marketTitle: 'x' } });
  const t = setup({ store });
  await t.ctl.init();
  await t.ctl.arm('PARIER AUTO', { dryRun: false, noManualBets: true, manualCheckDone: true });
  assert.equal(store.raw().pending, null);
  assert.equal(store.raw().bets.length, 5);
  assert.equal(store.raw().bets[4].status, 'unverified');
  await t.ctl.step();
  assert.equal(await t.ctl.step(), 'STOPPED');
  assert.match(store.raw().reason, /limite de session/);
  assert.ok(!t.calls.includes('place'));
});

test('journal : décision enregistrée puis issue (placé) ; execId copié sur le pari suivi', async () => {
  const log = [];
  const journal = { record: async (e) => { log.push(['record', e]); }, update: async (id, p) => { log.push(['update', id, p]); } };
  const t = await armed({ deps: { journal } });
  for (let i = 0; i < 7; i++) await t.ctl.step();
  const rec = log.find((l) => l[0] === 'record')[1];
  assert.equal(rec.execId, 'exec-1');
  assert.equal(rec.pick.label, 'A');
  assert.equal(rec.pick.odds, 2);
  assert.equal(rec.stake, 5);
  assert.deepEqual(log.find((l) => l[0] === 'update').slice(1, 2), ['exec-1']);
  assert.equal(log.find((l) => l[0] === 'update')[2].outcome, 'placed');
  assert.equal(t.store.raw().bets[0].execId, 'exec-1');
});

test('journal : résultat gagné/perdu reporté par execId au règlement', async () => {
  const log = [];
  const journal = { record: async () => {}, update: async (id, p) => { log.push([id, p.outcome]); } };
  const t = await armed({ deps: { journal }, resolve: () => 'won' });
  for (let i = 0; i < 12; i++) await t.ctl.step();
  assert.deepEqual(log.at(-1), ['exec-1', 'won']);
});

test('journal défaillant : le pari et la session continuent', async () => {
  const journal = { record: async () => { throw new Error('quota'); }, update: async () => { throw new Error('quota'); } };
  const t = await armed({ deps: { journal } });
  const seq = [];
  for (let i = 0; i < 7; i++) seq.push(await t.ctl.step());
  assert.ok(!seq.includes('STOPPED'));
  assert.equal(t.store.raw().bets.length, 1);
});

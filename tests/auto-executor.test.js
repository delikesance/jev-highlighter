const test = require('node:test');
const assert = require('node:assert');
const { makeFakeSite } = require('./helpers-fakesite');
const Readers = require('../extension/src/auto/readers');
const Guard = require('../extension/src/auto/guard');
const { createExecutor } = require('../extension/src/auto/executor');

const CFG = {
  minOdds: 1.3, maxOdds: 4, maxDriftPct: 3, minLeadSec: 90, minConfidence: 0.6, confirmTimeoutMs: 8000, hiddenTabMs: 5000,
  maxBets: 5, maxLosses: 3, maxLossFraction: 0.5, maxStakeFraction: 0.1, quickMarkets: { football: [/sur la période/] },
};
const DEC = {
  marketTitle: 'Résultat sur la période (seule)', window: '30:00 - 34:59', label: 'Canada', event: 'Canada - Pérou',
  analysedOdds: 2.1, suggestedStake: 0.5, confidence: 0.7, dryRun: false,
};

function setup(siteOpts = {}, { stopWhen } = {}) {
  const site = makeFakeSite(siteOpts);
  const guard = Guard.create(CFG, 6.53);
  let t = 0;
  const writes = [];
  const state = {};
  const store = {
    async get() { return { ...state }; },
    async set(p) { writes.push(p); Object.assign(state, p); },
    async stopFlag() { return !!(stopWhen && stopWhen(site)); },
  };
  const logs = [];
  const ex = createExecutor({
    doc: site.doc, readers: Readers, guard, store, cfg: CFG,
    sleep: async (ms) => { t += ms; }, now: () => t, log: (...a) => logs.push(a),
  });
  return { site, guard, store, state, writes, ex, logs };
}

test('succès : #betBtn cliqué une fois, fermeture par close-selections', async () => {
  const s = setup();
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'placed', r.reason);
  assert.strictEqual(r.stake, 0.5);
  assert.strictEqual(r.odds, 2.1);
  assert.strictEqual(s.site.spy.betBtn, 1);
  assert.strictEqual(s.site.spy.close, 1);
  assert.strictEqual(s.site.spy.keep, 0);
  assert.strictEqual(s.guard.state.placed, 1);
  assert.strictEqual(s.state.pending, null);
  assert.ok(s.state.lastPlaced);
  assert.ok(s.writes.findIndex((w) => w.pending) < s.writes.findIndex((w) => w.pending === null));
  assert.strictEqual(s.site.slipCount(), 0);
});

test('setter natif utilisé (assignation directe ignorée par le site)', async () => {
  const s = setup();
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'placed', r.reason);
  assert.strictEqual(s.site.spy.directAssign, 0);
});

test('dry-run : #betBtn jamais cliqué, ticket revenu vide', async () => {
  const s = setup();
  const r = await s.ex.place({ ...DEC, dryRun: true });
  assert.strictEqual(r.status, 'dry', r.reason);
  assert.strictEqual(s.site.spy.betBtn, 0);
  assert.strictEqual(s.site.slipCount(), 0);
  assert.strictEqual(s.guard.state.reserved, 0);
});

test('cote qui bouge après la mise > maxDriftPct → halt + retrait', async () => {
  const s = setup({ driftAfterStake: 2.3 });
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'halt');
  assert.strictEqual(s.site.spy.betBtn, 0);
  assert.strictEqual(s.site.spy.iconClose, 1);
  assert.strictEqual(s.site.slipCount(), 0);
  assert.strictEqual(s.state.stopped, true);
});

test('marché suspendu → halt sans clic', async () => {
  const s = setup({ suspended: true });
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'halt');
  assert.strictEqual(s.site.spy.oddsClicks, 0);
  assert.strictEqual(s.site.spy.betBtn, 0);
});

test('noModal → halt, pending conservé, un seul clic #betBtn', async () => {
  const s = setup({ noModal: true });
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'halt');
  assert.strictEqual(s.site.spy.betBtn, 1);
  assert.ok(s.state.pending && s.state.pending.stake === 0.5);
  assert.strictEqual(s.state.stopped, true);
  assert.strictEqual(s.guard.state.reserved, 0.5);
  assert.strictEqual(s.site.spy.iconClose, 0);
});

test('modale avec mise différente → halt', async () => {
  const s = setup({ modalStake: 0.4 });
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'halt');
  assert.strictEqual(s.site.spy.betBtn, 1);
  assert.strictEqual(s.site.spy.close + s.site.spy.keep, 0);
  assert.ok(s.state.pending);
});

test('modale avec cote différente → halt', async () => {
  const s = setup({ modalOdds: 2.5 });
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'halt');
  assert.strictEqual(s.site.spy.betBtn, 1);
  assert.strictEqual(s.guard.state.placed, 0);
});

test('bouton « Accepter les cotes » jamais cliqué', async () => {
  const s = setup({ betLabel: 'Accepter les cotes' });
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'halt');
  assert.strictEqual(s.site.spy.betBtn, 0);
  assert.strictEqual(s.site.slipCount(), 0);
});

test('bannière inconnue → halt + retrait', async () => {
  const s = setup({ extraBanner: 'Les cotes ont changé' });
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'halt');
  assert.strictEqual(s.site.spy.betBtn, 0);
  assert.strictEqual(s.site.spy.iconClose, 1);
});

test('preselected → halt sans retrait ni clic', async () => {
  const s = setup({ preselected: true });
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'halt');
  assert.strictEqual(s.site.slipCount(), 1);
  assert.deepStrictEqual(s.site.spy.clicks, []);
});

test('STOP levé avant la saisie → arrêt + retrait', async () => {
  const s = setup({}, { stopWhen: (site) => site.slipCount() === 1 });
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'halt');
  assert.strictEqual(s.site.spy.oddsClicks, 1);
  assert.strictEqual(s.site.spy.iconClose, 1);
  assert.strictEqual(s.site.slipCount(), 0);
  assert.strictEqual(s.site.doc.querySelector('input[name=stakeField]'), null);
  assert.strictEqual(s.site.spy.betBtn, 0);
});

test('onglet masqué > hiddenTabMs → halt sans aucun clic', async () => {
  const s = setup({ hidden: true });
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'halt');
  assert.deepStrictEqual(s.site.spy.clicks, []);
});

test('marché introuvable → halt sans clic', async () => {
  const s = setup();
  const r = await s.ex.place({ ...DEC, label: 'Brésil' });
  assert.strictEqual(r.status, 'halt');
  assert.deepStrictEqual(s.site.spy.clicks, []);
});

test('marché ambigu (deux marchés identiques) → halt sans clic', async () => {
  const s = setup();
  const r = await s.ex.place({ ...DEC, marketTitle: 'Nombre total de buts sur la période (seule)', label: 'Plus de 0,5', analysedOdds: 2.4 });
  assert.strictEqual(r.status, 'halt');
  assert.match(r.reason, /ambig/i);
  assert.deepStrictEqual(s.site.spy.clicks, []);
});

test('fenêtre différente → introuvable, halt sans clic', async () => {
  const s = setup();
  const r = await s.ex.place({ ...DEC, window: '40:00 - 44:59' });
  assert.strictEqual(r.status, 'halt');
  assert.deepStrictEqual(s.site.spy.clicks, []);
});

test('guard NON (mise > plafond) → refused sans clic', async () => {
  const s = setup({}, {});
  s.guard.maxStake = () => 5; // mise forcée au-delà du plafond de 10 %
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'refused');
  assert.deepStrictEqual(s.site.spy.clicks, []);
  assert.notStrictEqual(s.state.stopped, true);
});

test('confidence absente → halt sans clic', async () => {
  const s = setup();
  const { confidence, ...d } = DEC;
  const r = await s.ex.place(d);
  assert.strictEqual(r.status, 'halt');
  assert.deepStrictEqual(s.site.spy.clicks, []);
});

test('exception interne → halt, jamais de relance', async () => {
  const s = setup();
  s.store.stopFlag = async () => { throw new Error('boom'); };
  const r = await s.ex.place(DEC);
  assert.strictEqual(r.status, 'halt');
  assert.deepStrictEqual(s.site.spy.clicks, []);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeFakeSite } = require('./helpers-fakesite');
const { CONFIG } = require('../extension/src/config');
const Parser = require('../extension/src/parser');
const Readers = require('../extension/src/auto/readers');
const Guard = require('../extension/src/auto/guard');
const Decisions = require('../extension/src/auto/decisions');
const { createController } = require('../extension/src/auto/controller');
const { createExecutor } = require('../extension/src/auto/executor');

test('cycle complet : live JEV → pari JEV → ticket → mise JEV → simulation → retour live', async () => {
  const site = makeFakeSite();
  site.dom.reconfigure({ url: 'https://www.betclic.fr/live' });
  let time = 0;
  const state = {};
  const store = { get: async () => ({ ...state }), set: async (p) => Object.assign(state, p), stopFlag: async () => !!state.stopped };
  const cfg = { ...CONFIG.auto, pauseMs: 1000 };
  const sleep = async (ms) => { time += ms; site.advance(ms); };
  const now = () => time;
  const trace = [];
  const event = { href: '/football/canada-perou-m1', name: 'Canada - Pérou', sport: 'football', clock: { running: true, elapsedSec: 1620 }, score: [0, 0] };
  const ask = async (body) => {
    trace.push(body.state.task);
    if (body.state.task === 'auto_choose_live') return { auto_live: { choice: 'live_0' } };
    const selection = body.state.selections.find((s) => s.choice === 'Canada' && s.window === '30:00 - 34:59');
    assert.ok(selection);
    return { auto_pick: { choice: selection.id, confidence: 0.8 } };
  };
  const ctl = createController({
    doc: site.doc, store, cfg, tabId: 1, settings: {}, readers: Readers, sleep, now,
    scanner: { scanLive: () => [event] }, selector: require('../extension/src/auto/selector'),
    tracker: { resolve: async () => 'pending' },
    navigate: (url) => site.dom.reconfigure({ url }),
    parseMarkets: (doc) => Parser.parseMarkets(doc).list,
    chooseEvent: (events) => Decisions.chooseEvent(events, ask),
    analyze: (markets, context) => Decisions.choosePick(markets, context, ask),
    ticketSizing: true,
    makeGuard: (balance, snap) => Guard.create(cfg, balance, snap),
    makeExecutor: (guard) => createExecutor({ doc: site.doc, store, cfg, readers: Readers, sleep, now, guard,
      stakeFromTicket: async ({ slip, wallet }) => {
        trace.push('auto_stake');
        assert.equal(site.slipCount(), 1);
        assert.equal(slip.odds, 2.1);
        assert.equal(wallet, 6.53);
        assert.equal(slip.stake, null);
        return 0.4;
      } })
  });
  assert.equal(await ctl.init(), 'IDLE');
  await ctl.arm('PARIER AUTO', { dryRun: true, noManualBets: true });
  for (const phase of ['SCAN', 'CHOIX', 'ANALYSE', 'GARDE', 'EXEC', 'PAUSE']) assert.equal(await ctl.step(), phase, state.reason);
  assert.deepEqual(trace, ['auto_choose_live', 'auto_choose_bet', 'auto_stake']);
  assert.equal(site.spy.oddsClicks, 1);
  assert.equal(site.spy.betBtn, 0);
  assert.equal(site.slipCount(), 0);
  assert.equal(await ctl.step(), 'SCAN');
  assert.equal(await ctl.step(), 'SCAN');
  assert.equal(site.doc.location.pathname, '/live');
  site.dom.window.close();
});

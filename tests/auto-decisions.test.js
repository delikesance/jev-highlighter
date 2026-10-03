const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../extension/src/auto/decisions');

test('JEV choisit un live parmi les identifiants transmis', async () => {
  const events = [{ href: '/a', name: 'A - B', sport: 'football', clock: { running: true }, score: [0, 1] },
    { href: '/b', name: 'C - D', sport: 'basketball', clock: { running: true }, score: [20, 21] }];
  let body;
  const e = await D.chooseEvent(events, async (b) => { body = b; return { auto_live: { choice: 'live_1' } }; });
  assert.equal(e, events[1]);
  assert.equal(body.state.task, 'auto_choose_live');
  assert.deepEqual(body.state.events[0].score, [0, 1]);
  await assert.rejects(D.chooseEvent(events, async () => ({ auto_live: { choice: 'https://evil.test' } })), /inconnu/);
});

test('JEV choisit une sélection globale sans filtre Fast et reçoit les cotes', async () => {
  const markets = [{ id: 'm', title: 'Vainqueur du match', window: null, options: [
    { name: 'A', odds: 2, available: true }, { name: 'B', odds: 3, available: true }
  ] }];
  let body;
  const picks = await D.choosePick(markets, {}, async (b) => { body = b; return { auto_pick: { choice: 'pick_1', confidence: 0.8 } }; });
  assert.equal(body.state.task, 'auto_choose_bet');
  assert.equal(body.state.selections[1].odds, 3);
  assert.equal(picks[0].choice, 'B');
  assert.equal(picks[0].marketId, 'm');
  assert.deepEqual(await D.choosePick(markets, {}, async () => ({ auto_pick: { choice: 'none' } })), []);
});

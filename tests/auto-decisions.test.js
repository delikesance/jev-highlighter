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
  assert.ok(!('none' in body.questions.auto_pick.criteria), 'aucune option none');
  await assert.rejects(D.choosePick(markets, {}, async () => ({ auto_pick: { choice: 'none' } })), /inconnu/);
});

test('choosePick : objectif profit, probabilité implicite, marge et session transmis à JEV', async () => {
  const markets = [{ id: 'm', title: 'Prochain but', window: null, options: [
    { name: 'A', odds: 1.5, available: true }, { name: 'B', odds: 3, available: true }, { name: 'C', odds: 9, available: false }
  ] }];
  let body;
  await D.choosePick(markets, { session: { wallet_eur: 50 } }, async (b) => { body = b; return { auto_pick: { choice: 'pick_0' } }; });
  const q = body.questions.auto_pick;
  assert.match(q.instructions, /faire croître/);
  assert.match(q.instructions, /cote basse n’est pas un avantage/);
  assert.match(q.instructions, /obligatoirement/);
  assert.ok(!('none' in q.criteria));
  assert.equal(body.state.selections.length, 2, 'option indisponible exclue');
  assert.equal(body.state.selections[0].implied_probability_pct, 66.7);
  assert.equal(body.state.selections[1].implied_probability_pct, 33.3);
  assert.equal(body.state.selections[0].market_margin_pct, 0);
  assert.deepEqual(body.state.session, { wallet_eur: 50 });
});

test('choosePick : jevScore tiré des probabilités, confidence conservée', async () => {
  const markets = [{ id: 'm', title: 'T', options: [{ name: 'A', odds: 2, available: true }, { name: 'B', odds: 4, available: true }] }];
  const [p] = await D.choosePick(markets, {}, async () => ({ auto_pick: { choice: 'pick_1', confidence: 0.7, probabilities: { pick_0: 0.2, pick_1: 0.7, none: 0.1 } } }));
  assert.equal(p.jevScore, 0.7);
  assert.equal(p.confidence, 0.7);
});

test('choosePick : au plus 250 options envoyées (limite choice)', async () => {
  const options = Array.from({ length: 300 }, (_, i) => ({ name: 'o' + i, odds: 2 + i / 100, available: true }));
  let body;
  await D.choosePick([{ id: 'm', title: 'T', options }], {}, async (b) => { body = b; return { auto_pick: { choice: 'pick_0' } }; });
  assert.equal(Object.keys(body.questions.auto_pick.criteria).length, 250);
  assert.equal(body.state.selections.length, 250);
});

test('chooseEvent : objectif profit, cotes principales et session, jamais de none', async () => {
  const events = [{ name: 'A - B', sport: 'football', clock: { running: true }, score: [1, 0], mainOdds: [1.4, 4.2, 7] }];
  let body;
  const e = await D.chooseEvent(events, async (b) => { body = b; return { auto_live: { choice: 'live_0' } }; }, { session: { wallet_eur: 20 } });
  assert.equal(e, events[0]);
  assert.ok(!('none' in body.questions.auto_live.criteria));
  assert.deepEqual(body.state.events[0].main_odds, [1.4, 4.2, 7]);
  assert.deepEqual(body.state.session, { wallet_eur: 20 });
  assert.match(body.questions.auto_live.instructions, /faire croître/);
});

test('marketMargin : somme des probabilités implicites − 100, null si < 2 cotes', () => {
  assert.equal(D.marketMargin({ options: [{ available: true, odds: 2 }, { available: true, odds: 2 }] }), 0);
  assert.equal(D.marketMargin({ options: [{ available: true, odds: 1.9 }, { available: true, odds: 1.9 }] }), 5.3);
  assert.equal(D.marketMargin({ options: [{ available: true, odds: 2 }] }), null);
});

test('choosePick : seules les cotes acceptables par le guard sont proposées', async () => {
  const markets = [{ id: 'm', title: 'T', options: [
    { name: 'bas', odds: 1.1, available: true }, { name: 'ok', odds: 2, available: true }, { name: 'haut', odds: 9, available: true }
  ] }];
  let body;
  const [p] = await D.choosePick(markets, {}, async (b) => { body = b; return { auto_pick: { choice: 'pick_0' } }; }, { minOdds: 1.3, maxOdds: 4 });
  assert.deepEqual(body.state.selections.map((s) => s.choice), ['ok']);
  assert.equal(p.choice, 'ok');
});

test('choosePick : aucune cote jouable => aucun pari, JEV non interrogé', async () => {
  const markets = [{ id: 'm', title: 'T', options: [{ name: 'haut', odds: 9, available: true }] }];
  let asked = false;
  assert.deepEqual(await D.choosePick(markets, {}, async () => { asked = true; }, { minOdds: 1.3, maxOdds: 4 }), []);
  assert.equal(asked, false);
});

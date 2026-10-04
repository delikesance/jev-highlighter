const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { readWallet, readSlip, buildLadder, suggestStake, slipFingerprint } = require('../extension/src/stake');

const slipDoc = () => new JSDOM(fs.readFileSync(path.join(__dirname, 'fixture-slip.html'), 'utf8')).window.document;

test('lecture du solde et du ticket (HTML réel du bookmaker)', () => {
  const doc = slipDoc();
  assert.equal(readWallet(doc), 5.9);
  const slip = readSlip(doc);
  assert.equal(slip.selections.length, 1);
  assert.deepEqual(slip.selections[0], { event: 'Almeria - Real Burgos CF', selection: 'Nul', market: 'Résultat du match (t. rég)', odds: 2.75 });
  assert.equal(slip.totalOdds, 2.75);
  assert.ok(slip.stakeInput);
  assert.equal(slipFingerprint(5.9, slip), slipFingerprint(5.9, readSlip(slipDoc())));
  assert.notEqual(slipFingerprint(5.9, slip), slipFingerprint(4.9, slip));
});

test('tranches : 5,90 € -> paliers de 1 €, puis 0,10 €, puis 0,01 €', () => {
  const r1 = buildLadder(0, 5.9, 10);
  assert.equal(r1.length, 6);
  assert.deepEqual([r1[0].lo, r1[0].hi, r1[5].lo, r1[5].hi], [0, 1, 5, 5.9]);
  assert.equal(r1[0].key, '0,00 à 1,00 €');
  const r2 = buildLadder(2, 3, 10);
  assert.equal(r2.length, 10);
  assert.equal(r2[3].key, '2,30 à 2,40 €');
  const r3 = buildLadder(2.3, 2.4, 10);
  assert.equal(r3.length, 10);
  assert.equal(r3[0].key, '2,30 à 2,31 €');
});

// Faux JEV : choisit la tranche qui contient la cible.
function fakeAsk(target, log) {
  return async (body) => {
    const [id, q] = Object.entries(body.questions)[0];
    log.push(body);
    const hit = Object.keys(q.criteria).find((k) => {
      const m = k.match(/^(\d+),(\d+) à (\d+),(\d+) €$/);
      if (!m) return false;
      const lo = Number(`${m[1]}.${m[2]}`), hi = Number(`${m[3]}.${m[4]}`);
      return target >= lo - 1e-9 && target <= hi + 1e-9;
    });
    return { [id]: { type: 'choice', choice: hit, confidence: 0.7, probabilities: {} } };
  };
}

test('suggestStake : affinage jusqu\'au centime, sans dépasser le solde', async () => {
  const log = [];
  const ctx = { wallet: 59, totalOdds: 2.75, selections: [{ selection: 'Nul' }] };
  const r = await suggestStake(ctx, fakeAsk(2.34, log));
  assert.equal(log.length, 3);
  assert.ok(Math.abs(r.amount - 2.34) <= 0.011, `montant ${r.amount}`);
  assert.ok(r.amount <= 5.9); // plafond = 10 % de 59 €
  assert.equal(r.potentialWinnings, Math.round(r.amount * 2.75 * 100) / 100);
  assert.equal(log[0].state.wallet_eur, 59);
  assert.ok('Ne pas miser' in log[0].questions.stake_round_1.criteria);
  assert.ok(!('Ne pas miser' in log[1].questions.stake_round_2.criteria));
  assert.ok(!JSON.stringify(log).includes('element'));
});

test('suggestStake : « ne pas miser », solde trop bas, réponse invalide', async () => {
  const ctx = { wallet: 5.9, totalOdds: 2, selections: [] };
  const none = await suggestStake(ctx, async (b) => ({ stake_round_1: { choice: 'ne pas miser' } }));
  assert.equal(none.none, true);
  assert.equal((await suggestStake({ ...ctx, wallet: 0.05 }, async () => ({}))).reason, 'wallet-too-low');
  await assert.rejects(suggestStake(ctx, async () => ({ stake_round_1: { choice: '9,00 à 9,99 €' } })), /invalide/);
});

test('suggestStake : jamais all-in (plafond dur 10 % du solde, JEV arbitre le risque)', async () => {
  const seen = [];
  const ask = async (body) => {
    const [id, q] = Object.entries(body.questions)[0];
    const keys = Object.keys(q.criteria).filter((k) => k !== 'Ne pas miser');
    seen.push(body.state);
    return { [id]: { type: 'choice', choice: keys[keys.length - 1], confidence: 0.9, probabilities: {} } }; // JEV vise la tranche la plus haute
  };
  const r = await suggestStake({ wallet: 100, totalOdds: 2, selections: [] }, ask);
  assert.ok(r.amount <= 10, `montant ${r.amount}`);
  const risky = await suggestStake({ wallet: 100, totalOdds: 12, selections: [] }, ask);
  assert.ok(risky.amount <= 10, `cote haute ${risky.amount}`); // JEV décide du risque, plafond dur inchangé
});

test('suggestStake : allowNone false (mode Auto) => pas d\'option « Ne pas miser », mise obligatoire', async () => {
  const log = [];
  const ctx = { wallet: 59, totalOdds: 2.75, selections: [], allowNone: false };
  const r = await suggestStake(ctx, fakeAsk(2.34, log));
  assert.ok(!('Ne pas miser' in log[0].questions.stake_round_1.criteria));
  assert.match(log[0].questions.stake_round_1.instructions, /mise est obligatoire/);
  assert.ok(r.amount > 0 && !r.none);
});

test('suggestStake : allowNone par défaut conserve « Ne pas miser » (popup)', async () => {
  const log = [];
  await suggestStake({ wallet: 59, totalOdds: 2, selections: [] }, fakeAsk(2, log));
  assert.ok('Ne pas miser' in log[0].questions.stake_round_1.criteria);
});

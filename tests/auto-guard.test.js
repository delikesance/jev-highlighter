const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { CONFIG } = require('../extension/src/config');
const Guard = require('../extension/src/auto/guard');

const base = () => JSON.parse(JSON.stringify(CONFIG.auto));
const good = (o = {}) => ({ balance: 100, stake: 5, odds: 2, analysedOdds: 2, suspended: false, leadSec: 200, confidence: 0.8, ...o });

test('defauts CONFIG.auto', () => {
  const a = CONFIG.auto;
  assert.deepStrictEqual(
    [a.minOdds, a.maxOdds, a.maxDriftPct, a.minLeadSec, a.minConfidence, a.confirmTimeoutMs, a.hiddenTabMs, a.maxBets, a.maxLosses, a.maxLossFraction, a.maxStakeFraction],
    [1.3, 4, 3, 90, 0.6, 8000, 5000, 5, 3, 0.5, 0.1]);
  assert.ok(a.quickMarkets.football.length >= 5 && a.quickMarkets.basketball.length >= 2);
  assert.deepStrictEqual(Guard.validateConfig(a), { ok: true, errors: [] });
});

const over = [
  ['maxStakeFraction', 0.11], ['maxLossFraction', 0.51], ['maxBets', 6], ['maxLosses', 4],
  ['minOdds', 1.19], ['maxOdds', 6.01], ['maxDriftPct', 5.1], ['minLeadSec', 59],
  ['minConfidence', 0.49], ['confirmTimeoutMs', 15001], ['hiddenTabMs', 10001]
];
for (const [k, v] of over) {
  test(`refuse ${k}=${v}`, () => {
    const c = base(); c[k] = v;
    const r = Guard.validateConfig(c);
    assert.equal(r.ok, false); assert.ok(r.errors.length >= 1);
  });
}
test('accepte durcissement et valeurs limites', () => {
  const c = base(); Object.assign(c, { maxStakeFraction: 0.05, minOdds: 1.2, maxOdds: 6, maxDriftPct: 5, minLeadSec: 60, minConfidence: 0.5, confirmTimeoutMs: 15000, hiddenTabMs: 10000 });
  assert.equal(Guard.validateConfig(c).ok, true);
});
test('refuse non numerique / NaN / negatif / absent', () => {
  for (const k of Object.keys(base()).filter((k) => k !== 'quickMarkets')) {
    for (const v of ['1', NaN, -1, null, undefined, Infinity, {}]) {
      const c = base(); c[k] = v;
      assert.equal(Guard.validateConfig(c).ok, false, `${k}=${String(v)}`);
    }
  }
  assert.equal(Guard.validateConfig(null).ok, false);
  assert.equal(Guard.validateConfig({}).ok, false);
});
test('create refuse config invalide et solde invalide', () => {
  const c = base(); c.maxBets = 9;
  assert.throws(() => Guard.create(c, 100));
  for (const s of [0, -5, NaN, '100', null]) assert.throws(() => Guard.create(base(), s));
});

test('maxStake', () => {
  const g = Guard.create(base(), 100);
  assert.equal(g.maxStake(0.019), 0.01);
  assert.equal(g.maxStake(50), 10);
  assert.equal(g.maxStake(3.456), 3.45);
  assert.equal(g.maxStake(0.29), 0.29);
  assert.equal(g.maxStake(NaN), 0);
  assert.equal(g.maxStake(-1), 0);
  assert.equal(g.maxStake(undefined), 0);
  const h = Guard.create(base(), 5.9);
  assert.equal(h.maxStake(100), 0.59);
  // base sur le solde de depart, pas courant
  assert.equal(g.check(good({ balance: 20, stake: 10 })).verdict, 'NON'); // perte 80+10 > 50
});

test('check OUI nominal et refus un par un', () => {
  const g = Guard.create(base(), 100);
  assert.equal(g.check(good()).verdict, 'OUI');
  const no = (o) => { const r = g.check(good(o)); assert.equal(r.verdict, 'NON', JSON.stringify(o)); assert.ok(r.reason); };
  no({ stake: 10.01 }); no({ stake: 0 }); no({ stake: NaN }); no({ stake: -1 });
  no({ odds: 1.29 }); no({ odds: 4.01 }); no({ odds: NaN }); no({ odds: null });
  no({ analysedOdds: 0 }); no({ analysedOdds: NaN }); no({ analysedOdds: undefined });
  no({ odds: 2.07 }); no({ odds: 1.93 });
  no({ suspended: true }); no({ suspended: undefined });
  no({ leadSec: null }); no({ leadSec: NaN }); no({ leadSec: 89 });
  no({ confidence: null }); no({ confidence: 0.59 }); no({ confidence: '0.9' }); no({ confidence: NaN });
  no({ balance: NaN }); no({ balance: undefined });
  assert.equal(g.check(good({ odds: 2.05 })).verdict, 'OUI');
  assert.equal(g.check(good({ leadSec: 90, confidence: 0.6, odds: 1.3, analysedOdds: 1.3 })).verdict, 'OUI');
  assert.equal(g.check().verdict, 'NON');
  assert.equal(g.check(null).verdict, 'NON');
});

test('perte et reserve', () => {
  const g = Guard.create(base(), 100);
  // perte 40 + mise 10 = 50 -> ok ; 40.01 -> non
  assert.equal(g.check(good({ balance: 60, stake: 10 })).verdict, 'OUI');
  assert.equal(g.check(good({ balance: 59.99, stake: 10 })).verdict, 'NON');
  g.reserve(10);
  assert.equal(g.state.reserved, 10);
  assert.equal(g.check(good({ balance: 90, stake: 10 })).verdict, 'OUI'); // 10+10+10
  g.reserve(30);
  assert.equal(g.check(good({ balance: 90, stake: 10 })).verdict, 'NON'); // 10+40+10=60
  g.release(30);
  assert.equal(g.state.reserved, 10);
  g.release(1000);
  assert.equal(g.state.reserved, 0);
});

test('compteurs: 5 paris, 3 defaites', () => {
  const g = Guard.create(base(), 100);
  for (let i = 0; i < 4; i++) g.recordPlaced();
  assert.equal(g.check(good()).verdict, 'OUI');
  g.recordPlaced();
  assert.equal(g.state.placed, 5);
  assert.equal(g.check(good()).verdict, 'NON');
  const h = Guard.create(base(), 100);
  h.recordResult('lost'); h.recordResult('lost');
  assert.equal(h.check(good()).verdict, 'OUI');
  h.recordResult('won');
  assert.equal(h.state.consecutiveLosses, 0);
  h.recordResult('lost'); h.recordResult('lost'); h.recordResult('lost');
  assert.equal(h.check(good()).verdict, 'ARRET');
  assert.throws(() => h.recordResult('draw'));
});

test('ARRET est collant et prioritaire', () => {
  const g = Guard.create(base(), 100);
  for (let i = 0; i < 3; i++) g.recordResult('lost');
  assert.equal(g.check(good({ suspended: true })).verdict, 'ARRET');
});

test('config durcie respectee', () => {
  const c = base(); c.maxStakeFraction = 0.05; c.maxBets = 2;
  const g = Guard.create(c, 100);
  assert.equal(g.maxStake(50), 5);
  assert.equal(g.check(good({ stake: 5.01 })).verdict, 'NON');
  g.recordPlaced(); g.recordPlaced();
  assert.equal(g.check(good({ stake: 1 })).verdict, 'NON');
});

test('fuzz: 2000 propositions, plafonds jamais depasses', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const weird = [NaN, null, undefined, '5', -1, Infinity, 0];
  let oui = 0;
  for (let i = 0; i < 2000; i++) {
    const start = rnd() < 0.2 ? 5.9 : 1 + rnd() * 500;
    const g = Guard.create(base(), start);
    g.state.placed = Math.floor(rnd() * 6);
    if (rnd() < 0.25) g.reserve(rnd() * start * 0.3);
    const pick = (v) => (rnd() < 0.08 ? weird[Math.floor(rnd() * weird.length)] : v);
    const o = 1.1 + rnd() * 5;
    const p = {
      balance: pick(start * (0.4 + rnd() * 0.9)), stake: pick(rnd() * start * 0.14),
      odds: pick(o), analysedOdds: pick(rnd() < 0.7 ? o * (1 + (rnd() - 0.5) * 0.12) : 1 + rnd() * 6),
      suspended: rnd() < 0.1, leadSec: pick(rnd() * 300), confidence: pick(0.4 + rnd() * 0.6)
    };
    const r = g.check(p);
    if (r.verdict !== 'OUI') continue;
    oui++;
    assert.ok(p.stake <= start * 0.1 + 1e-9, 'mise > 10 %');
    assert.ok(start - p.balance + g.state.reserved + p.stake <= start * 0.5 + 1e-9, 'perte > 50 %');
    assert.ok(g.state.placed < 5);
    assert.ok(p.odds >= 1.2 && p.odds <= 6 && p.leadSec >= 60 && p.confidence >= 0.5 && !p.suspended);
    assert.ok(Math.abs(p.odds - p.analysedOdds) / p.analysedOdds * 100 <= 5);
  }
  assert.ok(oui > 20, 'le fuzz doit produire quelques OUI : ' + oui);
});

test('guard.js et config.js sans mot cle API', () => {
  for (const f of ['../extension/src/auto/guard.js', '../extension/src/config.js']) {
    assert.doesNotMatch(fs.readFileSync(require('node:path').join(__dirname, f), 'utf8'), /apiKey|eval\(/);
  }
});

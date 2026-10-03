const test = require('node:test');
const assert = require('node:assert');
const { parseClock, parseWindow, leadSeconds, parseMoney } = require('../extension/src/auto/clock');

test('parseClock foot', () => {
  assert.deepStrictEqual(parseClock("27' • MT 1"), { elapsedSec: 1620, remainingSec: null, period: 'MT 1', running: true });
  assert.strictEqual(parseClock("45+2' • MT 1").elapsedSec, 2820);
  assert.strictEqual(parseClock("85' • MT 2").elapsedSec, 5100);
});
test('parseClock basket', () => {
  const c = parseClock('7:41 • Q1');
  assert.strictEqual(c.remainingSec, 461);
  assert.strictEqual(c.elapsedSec, null);
  assert.strictEqual(c.period, 'Q1');
  assert.strictEqual(c.running, true);
});
test('parseClock non-running', () => {
  for (const t of ['Débute', 'MT', 'Fin Q1', '5ème manche', '']) assert.strictEqual(parseClock(t).running, false, t);
  assert.strictEqual(parseClock('Débute').elapsedSec, null);
});
test('parseWindow', () => {
  assert.deepStrictEqual(parseWindow('30:00 - 34:59'), { startSec: 1800, endSec: 2099 });
  assert.strictEqual(parseWindow('rien'), null);
});
test('leadSeconds', () => {
  const c = parseClock("27' • MT 1");
  assert.strictEqual(leadSeconds(c, { startSec: 1800, endSec: 2099 }), 180);
  assert.strictEqual(leadSeconds(c, null), 2700 - 1620);
  assert.strictEqual(leadSeconds(parseClock("50' • MT 2"), null), 5400 - 3000);
  assert.strictEqual(leadSeconds(parseClock('7:41 • Q1'), null), 461);
  assert.strictEqual(leadSeconds(parseClock('Débute'), { startSec: 1, endSec: 2 }), null);
  assert.strictEqual(leadSeconds(parseClock("12' • Q9"), null), null);
});
test('parseMoney', () => {
  assert.strictEqual(parseMoney('6,53 €'), 6.53);
  assert.strictEqual(parseMoney('6,53 €'), 6.53);
  assert.strictEqual(parseMoney('1 234,50 €'), 1234.5);
  assert.strictEqual(parseMoney(''), null);
  assert.strictEqual(parseMoney('abc'), null);
});

test('fix round 1', () => {
  const w = { startSec: 1800, endSec: 2099 };
  assert.strictEqual(leadSeconds(parseClock("45+2' • MT 1"), null), -120);
  assert.strictEqual(leadSeconds(parseClock("45+2' • MT 1"), w), 1800 - 2820);
  assert.strictEqual(leadSeconds(parseClock("40' • MT 1"), w), -600);
  assert.strictEqual(leadSeconds(parseClock('7:41 • Q1'), w), null);
  assert.strictEqual(parseMoney('1.234,50 \u20ac'), null);
  assert.strictEqual(parseMoney('1,234.50'), null);
  assert.strictEqual(parseMoney('1\u00a0234,50\u00a0\u20ac'), 1234.5);
  assert.strictEqual(parseMoney('1\u202f234,50\u202f\u20ac'), 1234.5);
  assert.strictEqual(parseClock('27\u2019 • MT 1').elapsedSec, 1620);
  assert.strictEqual(parseClock('27\u2032 • MT 1').elapsedSec, 1620);
  assert.strictEqual(parseWindow('35:00 - 30:00'), null);
});

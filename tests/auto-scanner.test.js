const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { scanLive } = require('../extension/src/auto/scanner');

const load = () => new JSDOM(fs.readFileSync(path.join(__dirname, 'fixture-live-list.html'), 'utf8')).window.document;

test('scanLive: nombre, ordre, index, href exact', () => {
  const ev = scanLive(load());
  assert.strictEqual(ev.length, 6);
  assert.deepStrictEqual(ev.map((e) => e.index), [0, 1, 2, 3, 4, 5]);
  assert.strictEqual(ev[0].href, '/football-sfootball/matchs-amicaux-c79/canada-perou-m1240024819470433');
  assert.strictEqual(ev[0].name, 'Canada - Pérou');
});
test('scanLive: temps et score foot', () => {
  const e = scanLive(load())[0];
  assert.strictEqual(e.clock.elapsedSec, 1620);
  assert.strictEqual(e.clock.period, 'MT 1');
  assert.deepStrictEqual(e.score, [1, 0]);
  assert.strictEqual(e.sport, 'football');
  assert.strictEqual(e.mainSuspended, false);
});
test('scanLive: cote suspendue', () => {
  const ev = scanLive(load());
  assert.strictEqual(ev[1].mainSuspended, true);
  assert.strictEqual(ev[2].mainSuspended, false);
});
test('scanLive: mi-temps, débute, basket, other', () => {
  const ev = scanLive(load());
  assert.strictEqual(ev[2].clock.running, false);
  assert.strictEqual(ev[3].clock.running, false);
  assert.strictEqual(ev[3].score, null);
  assert.strictEqual(ev[4].sport, 'basketball');
  assert.strictEqual(ev[4].clock.remainingSec, 461);
  assert.deepStrictEqual(ev[4].score, [24, 19]);
  assert.strictEqual(ev[5].sport, 'other');
});
test('scanLive: lecture seule', () => {
  const doc = load();
  const before = doc.documentElement.outerHTML;
  scanLive(doc);
  assert.strictEqual(doc.documentElement.outerHTML, before);
});

const test = require('node:test');
const assert = require('node:assert');
const { pickEvent, quickMarkets, pickSelections } = require('../extension/src/auto/selector');
const { CONFIG } = require('../extension/src/config');
const cfg = CONFIG.auto;

const ev = (href, o = {}) => ({
  href, name: href, sport: 'football', clock: { running: true, elapsedSec: 600 },
  score: [0, 0], mainSuspended: false, index: 0, ...o
});
const opt = (name, odds, available = true) => ({ name, key: name, odds, available });
const mk = (id, title, options, window = null) => ({ id, title, window, options });
const markets = [
  mk('prochain_but', 'Prochain but', [opt('Canada', 2.1), opt('Pérou', 3.2), opt('Aucun', 4.5)], '0-10 min'),
  mk('resultat', 'Résultat du match', [opt('Canada', 1.5)]),
  mk('corners', 'Corners', [opt('Plus', 1.8), opt('Moins', 1.1)])
];
// format réel de matchAnswers
const rec = (marketId, choice, confidence, extra = {}) => ({
  marketId, marketTitle: 't', choice, jevScore: 0.7, confidence, odds: 99, probabilities: {}, ...extra
});

test('pickEvent: tri quickCount desc, elapsed asc (null dernier), index asc', () => {
  const counts = { a: 2, b: 3, c: 3, d: 3, e: 3 };
  const events = [
    ev('a', { index: 0 }),
    ev('b', { index: 1, clock: { running: true, elapsedSec: 900 } }),
    ev('c', { index: 2, clock: { running: true, elapsedSec: 300 } }),
    ev('d', { index: 3, clock: { running: true, elapsedSec: null } }),
    ev('e', { index: 4, clock: { running: true, elapsedSec: 300 } })
  ];
  const copy = events.slice();
  assert.strictEqual(pickEvent(events, new Set(), (e) => counts[e.href]).href, 'c');
  assert.deepStrictEqual(events, copy);
  assert.strictEqual(pickEvent(events, new Set(['c', 'e']), (e) => counts[e.href]).href, 'b');
  assert.strictEqual(pickEvent(events, new Set(['b', 'c', 'e']), (e) => counts[e.href]).href, 'd');
});
test('pickEvent: écarte Débute, déjà tenté, quickCount 0, autre sport', () => {
  const q = () => 1;
  assert.strictEqual(pickEvent([ev('x', { clock: { running: false, elapsedSec: 0 } })], new Set(), q), null);
  assert.strictEqual(pickEvent([ev('x', { clock: null })], new Set(), q), null);
  assert.strictEqual(pickEvent([ev('x')], new Set(['x']), q), null);
  assert.strictEqual(pickEvent([ev('x')], new Set(), () => 0), null);
  assert.strictEqual(pickEvent([ev('x')], new Set(), () => NaN), null);
  assert.strictEqual(pickEvent([ev('x', { sport: 'other' })], new Set(), q), null);
  assert.strictEqual(pickEvent([ev('x', { sport: 'tennis' })], new Set(), q), null);
  assert.strictEqual(pickEvent([], new Set(), q), null);
  assert.strictEqual(pickEvent(undefined, new Set(), q), null);
});
test('pickEvent: un match en cours reste candidat si son marché principal est suspendu', () => {
  const event = ev('basket-q4', { sport: 'basketball', mainSuspended: true, clock: { running: true, remainingSec: 225, elapsedSec: null } });
  assert.strictEqual(pickEvent([event], new Set(), () => 1), event);
});
test('quickMarkets: liste blanche par titre, sport inconnu => []', () => {
  assert.deepStrictEqual(quickMarkets(markets, 'football', cfg).map((m) => m.id), ['prochain_but', 'corners']);
  assert.deepStrictEqual(quickMarkets(markets, 'tennis', cfg), []);
  assert.deepStrictEqual(quickMarkets(undefined, 'football', cfg), []);
  const c2 = { quickMarkets: { football: ['Résultat'] } };
  assert.deepStrictEqual(quickMarkets(markets, 'football', c2).map((m) => m.id), ['resultat']);
});
test('pickSelections: retenue valide, label/odds/window depuis le Market', () => {
  const r = pickSelections([rec('prochain_but', 'Canada', 0.8)], markets, cfg, 'football');
  assert.deepStrictEqual(r, [{ marketId: 'prochain_but', label: 'Canada', odds: 2.1, confidence: 0.8, window: '0-10 min' }]);
});
test('pickSelections: choice normalisé (accents/casse)', () => {
  const r = pickSelections([rec('prochain_but', 'perou', 0.7)], markets, cfg, 'football');
  assert.strictEqual(r[0].label, 'Pérou');
});
test('pickSelections: confidence null/NaN/chaîne/basse refusée', () => {
  const strictCfg = { ...cfg, minConfidence: 0.6 };
  for (const c of [null, NaN, '0.9', undefined, 0.59]) {
    assert.deepStrictEqual(pickSelections([rec('prochain_but', 'Canada', c)], markets, strictCfg, 'football'), []);
  }
});
test('pickSelections: libellé inconnu ou marché inconnu ignoré', () => {
  assert.deepStrictEqual(pickSelections([rec('prochain_but', 'Brésil', 0.9)], markets, cfg, 'football'), []);
  assert.deepStrictEqual(pickSelections([rec('inconnu', 'Canada', 0.9)], markets, cfg, 'football'), []);
});
test('pickSelections: cote hors bornes refusée (la cote du Market, pas celle du matcher)', () => {
  assert.deepStrictEqual(pickSelections([rec('prochain_but', 'Aucun', 0.9)], markets, cfg, 'football'), []);
  assert.deepStrictEqual(pickSelections([rec('corners', 'Moins', 0.9)], markets, cfg, 'football'), []);
});
test('pickSelections: marché hors liste blanche refusé, option indisponible refusée', () => {
  assert.deepStrictEqual(pickSelections([rec('resultat', 'Canada', 0.9)], markets, cfg, 'football'), []);
  const m = [mk('corners', 'Corners', [opt('Plus', 1.8, false)])];
  assert.deepStrictEqual(pickSelections([rec('corners', 'Plus', 0.9)], m, cfg, 'football'), []);
});
test('pickSelections: entrées invalides sans exception', () => {
  assert.deepStrictEqual(pickSelections(undefined, markets, cfg, 'football'), []);
  assert.deepStrictEqual(pickSelections([], markets, cfg, 'football'), []);
  assert.deepStrictEqual(pickSelections([{}, null, { choice: 'x' }, 5], markets, cfg, 'football'), []);
  assert.deepStrictEqual(pickSelections([rec('corners', 'Plus', 0.9)], undefined, cfg), []);
});

test('pickSelections: sport obligatoire (fail-closed)', () => {
  const a = [rec('prochain_but', 'Canada', 0.8)];
  for (const sp of [undefined, '', null, 5, 'tennis', 'other']) assert.deepStrictEqual(pickSelections(a, markets, cfg, sp), []);
});
test('pickSelections: bornes exactes (cfg personnalisé)', () => {
  const c = { minOdds: 1.5, maxOdds: 3, minConfidence: 0.7, quickMarkets: { football: [/corner/] } };
  const one = (odds, conf) => pickSelections([rec('c', 'Plus', conf)], [mk('c', 'Corners', [opt('Plus', odds)])], c, 'football').length;
  assert.strictEqual(one(2, 0.7), 1);
  assert.strictEqual(one(2, 0.6999), 0);
  assert.strictEqual(one(1.5, 0.9), 1);
  assert.strictEqual(one(1.4999, 0.9), 0);
  assert.strictEqual(one(3, 0.9), 1);
  assert.strictEqual(one(3.0001, 0.9), 0);
});
const bk = [
  mk('pp', 'Prochain panier', [opt('Lakers', 1.9), opt('Celtics', 2.0)]),
  mk('qt', 'Total du quart-temps', [opt('Plus', 1.8), opt('Moins', 1.9)]),
  mk('res', 'Vainqueur du match', [opt('Lakers', 1.5)])
];
test('basket: quickMarkets et pickSelections', () => {
  assert.deepStrictEqual(quickMarkets(bk, 'basketball', cfg).map((m) => m.id), ['pp', 'qt']);
  const r = pickSelections([rec('pp', 'Lakers', 0.8), rec('qt', 'Plus', 0.8), rec('res', 'Lakers', 0.9)], bk, cfg, 'basketball');
  assert.deepStrictEqual(r.map((p) => p.marketId), ['pp', 'qt']);
  assert.deepStrictEqual(pickSelections([rec('pp', 'Lakers', 0.8)], bk, cfg, 'football'), []);
});
test('pickSelections: doublons par marketId, le premier gagne', () => {
  const r = pickSelections([rec('prochain_but', 'Canada', 0.8), rec('prochain_but', 'Pérou', 0.9)], markets, cfg, 'football');
  assert.deepStrictEqual(r.map((p) => p.label), ['Canada']);
});
test('pickEvent: égalité quickCount et elapsed départagée par index', () => {
  const evs = [ev('z', { index: 5 }), ev('y', { index: 2 }), ev('w', { index: 9 })];
  assert.strictEqual(pickEvent(evs, new Set(), () => 2).href, 'y');
});

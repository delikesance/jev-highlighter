const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { parseMarkets, dedupeMarkets } = require('../extension/src/parser');
const { buildQuestion } = require('../extension/src/jev');

const html = fs.readFileSync(path.join(__dirname, 'fixture-fast.html'), 'utf8');
const doc = () => new JSDOM(html).window.document;
const R = 'Résultat sur la période (seule)';

test('window extraite sans le texte du bouton Modifier', () => {
  const { list } = parseMarkets(doc());
  const m = list.find((x) => x.title === R);
  assert.equal(m.window, '30:00 - 34:59');
  assert.ok(!list.some((x) => /modifier/i.test(x.window || '')));
  assert.equal(list.find((x) => x.title.startsWith('Quand')).window, null);
});

test('ids distincts et stables selon la fenêtre, indépendants de l ordre', () => {
  const d1 = doc();
  const r1 = parseMarkets(d1).list.filter((x) => x.title === R);
  assert.deepEqual(r1.map((x) => x.id), ['resultat_sur_la_periode_seule_30_00_34_59', 'resultat_sur_la_periode_seule_35_00_39_59']);
  const d2 = doc();
  const sec = d2.querySelector('[data-section="a"]');
  const boxes = [...sec.querySelectorAll('sports-markets-single-market')];
  sec.prepend(boxes[1]);
  const r2 = parseMarkets(d2).list.filter((x) => x.title === R);
  assert.deepEqual(r2.map((x) => x.id).sort(), r1.map((x) => x.id).sort());
});

test('dedupeMarkets: même marché dans 2 sections -> un seul', () => {
  const { list } = parseMarkets(doc());
  const n = (l) => l.filter((x) => x.title.startsWith('Nombre total')).length;
  assert.equal(n(list), 2);
  const d = dedupeMarkets(list);
  assert.equal(n(d), 1);
  assert.equal(d.length, list.length - 1);
});

test('la question JEV inclut la fenêtre', () => {
  const m = parseMarkets(doc()).list.find((x) => x.title === R);
  const q = buildQuestion(m);
  assert.match(JSON.stringify(q), /fenêtre : 30:00 - 34:59/);
});

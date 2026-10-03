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
  const map = (l) => Object.fromEntries(l.map((x) => [x.window, x.id]));
  assert.deepEqual(map(r2), map(r1));
  assert.equal(map(r2)['30:00 - 34:59'], 'resultat_sur_la_periode_seule_30_00_34_59');
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

test('titre long (>80 car.) avec deux fenêtres : ids distincts et stables', () => {
  const long = 'Un titre de marché vraiment très long ' + 'x'.repeat(60) + ' sur la période (seule)';
  const build = (order) => {
    const d = new JSDOM(html).window.document;
    const boxes = [...d.querySelectorAll('[data-section="a"] sports-markets-single-market')].slice(0, 2);
    boxes.forEach((b) => (b.querySelector('.marketBox_headTitleWrapper').textContent = long));
    if (order) boxes[1].parentNode.prepend(boxes[1]);
    return Object.fromEntries(parseMarkets(d).list.filter((m) => m.title === long).map((m) => [m.window, m.id]));
  };
  const a = build(false), b = build(true);
  assert.notEqual(a['30:00 - 34:59'], a['35:00 - 39:59']);
  assert.deepEqual(a, b);
});

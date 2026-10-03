const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { loadFixture } = require('./helpers');
const { parseMarkets } = require('../extension/src/parser');
const { matchAnswers, toPlain } = require('../extension/src/matcher');
const { rankPicks } = require('../extension/src/picks');
const { suggestStake } = require('../extension/src/stake');

const src = (f) => fs.readFileSync(path.join(__dirname, '../extension/src', f), 'utf8');

test('rankPicks : score décroissant, égalité départagée par la confidence, scores inconnus exclus', () => {
  const r = rankPicks([
    { id: 'a', jevScore: 0.5, confidence: 0.1 },
    { id: 'b', jevScore: 0.75 },
    { id: 'c', jevScore: null },
    { id: 'd', jevScore: 0.5, confidence: 0.9 }
  ]);
  assert.deepEqual(r.map((x) => x.id), ['b', 'd', 'a']);
});

test('matcher : distribution des options (carte de survol) + container, sans DOM dans toPlain', () => {
  const p = parseMarkets(loadFixture());
  const id = 'premier_a_atteindre_2_points_dans_le_jeu_10_2eme_set';
  const m = matchAnswers(p.markets, {
    [id]: { type: 'choice', choice: 'Elena Rybakina', confidence: 0.6, probabilities: { 'Elena Rybakina': 0.81, 'Alina Charaeva': 0.19 } }
  });
  const rec = m.recommendations[0];
  assert.deepEqual(rec.distribution, [
    { name: 'Elena Rybakina', score: 0.81 },
    { name: 'Alina Charaeva', score: 0.19 }
  ]);
  assert.equal(rec.container, p.markets.get(id).container);
  const plain = toPlain(rec);
  assert.ok(!('element' in plain) && !('container' in plain));
  assert.ok(!JSON.stringify(plain).includes('element'));
});

test('suggestStake : renvoie les étapes (cellules + index) pour le zoom', async () => {
  const ask = async (body) => {
    const [id, q] = Object.entries(body.questions)[0];
    const keys = Object.keys(q.criteria).filter((k) => k !== 'Ne pas miser');
    return { [id]: { type: 'choice', choice: keys[Math.min(3, keys.length - 1)], confidence: 0.5, probabilities: {} } };
  };
  const r = await suggestStake({ wallet: 5.9, totalOdds: 2, selections: [] }, ask);
  assert.equal(r.rounds.length, 3);
  for (const round of r.rounds) {
    assert.ok(Array.isArray(round.cells) && round.cells.length >= 2);
    assert.ok(round.index >= 0 && round.index < round.cells.length);
    assert.equal(round.cells[round.index].lo, round.lo);
  }
});

// ---- reorder.js exécuté dans un vrai DOM jsdom (CSS order, réversible)
function loadReorder(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(src('config.js'));
  w.eval(src('utils.js'));
  w.JEV.UI = { isHostNode: (n) => !!n && n.nodeType === 1 && n.hasAttribute('data-jev-host') };
  w.eval(src('reorder.js'));
  return { w, doc: w.document, R: w.JEV.Reorder };
}
const mk = (n) => `<sports-markets-single-market id="m${n}"></sports-markets-single-market>`;

test('reorder : parent flex -> CSS order posé puis restauré, DOM jamais déplacé', () => {
  const { doc, R } = loadReorder(`<div id="p" style="display:flex;flex-direction:column">${mk(1)}${mk(2)}${mk(3)}</div>`);
  const [m1, m2, m3] = ['m1', 'm2', 'm3'].map((i) => doc.getElementById(i));
  assert.equal(R.applyOrder([m3, m1]), true);
  assert.equal(m3.style.order, '-500');
  assert.equal(m1.style.order, '-499');
  assert.equal(m2.style.order, '');
  assert.deepEqual([...doc.getElementById('p').children].map((c) => c.id), ['m1', 'm2', 'm3']); // ordre DOM intact
  R.restoreOrder();
  assert.equal(m3.style.order, '');
});

test('reorder : parent en bloc ne contenant que des marchés -> passe en flex puis restaure ; sinon no-op', () => {
  const a = loadReorder(`<div id="p">${mk(1)}${mk(2)}</div>`);
  const p = a.doc.getElementById('p');
  assert.equal(a.R.applyOrder([a.doc.getElementById('m2')]), true);
  assert.equal(p.style.display, 'flex');
  a.R.restoreOrder();
  assert.equal(p.style.display, '');

  const b = loadReorder(`<div id="p"><h2>Titre</h2>${mk(1)}${mk(2)}</div>`);
  assert.equal(b.R.applyOrder([b.doc.getElementById('m2')]), false);
});

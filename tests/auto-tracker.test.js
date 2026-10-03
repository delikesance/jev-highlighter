const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Tracker = require('../extension/src/auto/tracker');
const readers = require('../extension/src/auto/readers');

const load = (f) => new JSDOM(fs.readFileSync(path.join(__dirname, f), 'utf8')).window.document;
const ongoing = () => load('fixture-mybets-ongoing.html');
const ended = () => load('fixture-mybets-ended.html');
const empty = () => new JSDOM('<html><body></body></html>').window.document;
const refsOf = (d) => readers.readMyBets(d).map((b) => b.reference);
const mk = (o = {}) => Tracker.createTracker({
  readers, readBalance: () => 100, sleep: async () => {}, cfg: { identifyRetries: 3, pollMs: 50 }, log: () => {},
  getMyBetsDoc: async (f) => (f === 'ended' ? ended() : ongoing()), ...o
});

test('snapshotOngoing: références en cours', async () => {
  const s = await mk().snapshotOngoing();
  assert.deepStrictEqual(s, refsOf(ongoing()));
  assert.ok(s.length >= 2);
});
test('identify: une nouvelle carte -> référence', async () => {
  const all = refsOf(ongoing());
  const r = await mk().identify(all.slice(1));
  assert.deepStrictEqual(r, { method: 'reference', reference: all[0] });
});
test('identify: deux nouvelles -> solde', async () => {
  const all = refsOf(ongoing());
  assert.deepStrictEqual(await mk().identify(all.slice(2)), { method: 'balance' });
});
test('identify: zéro nouvelle après réessais -> solde, avec réessais', async () => {
  let n = 0, sl = 0;
  const t = mk({ getMyBetsDoc: async () => { n++; return ongoing(); }, sleep: async () => { sl++; } });
  assert.deepStrictEqual(await t.identify(refsOf(ongoing())), { method: 'balance' });
  assert.strictEqual(n, 3); assert.strictEqual(sl, 2);
});
test('identify: solde illisible -> none', async () => {
  const t = mk({ readBalance: () => null });
  assert.deepStrictEqual(await t.identify(refsOf(ongoing())), { method: 'none' });
  assert.deepStrictEqual(await mk({ readBalance: () => NaN }).identify(refsOf(ongoing())), { method: 'none' });
});
test('identify: la carte apparaît au 2e réessai', async () => {
  const all = refsOf(ongoing()); let n = 0;
  const t = mk({ getMyBetsDoc: async () => (++n < 3 ? empty() : ongoing()) });
  const r = await t.identify(all.slice(1));
  assert.deepStrictEqual(r, { method: 'reference', reference: all[0] });
});
test('resolve: lost / won depuis ended', async () => {
  const t = mk();
  assert.strictEqual(await t.resolve('9876543200002'), 'lost');
  assert.strictEqual(await t.resolve('9876543200001'), 'won');
});
test('resolve: en cours / introuvable -> pending', async () => {
  const t = mk(); const r = refsOf(ongoing())[0];
  assert.strictEqual(await t.resolve(r), 'pending');
  assert.strictEqual(await t.resolve('0000'), 'pending');
});
test('resolve: statut unknown -> pending', async () => {
  const fake = { ...readers, readMyBets: () => [{ id: 'x', reference: '42', status: 'unknown' }] };
  assert.strictEqual(await mk({ readers: fake }).resolve('42'), 'pending');
});
test('resolveByBalance ne conclut jamais', () => {
  for (const [bal, prev, st] of [[95, 100, 5], [94, 100, 5], [100, 100, 5], [120, 100, 5], [null, 100, 5], [95, 'x', 5], [95, 100, [5]], [95, 100, 0]]) {
    assert.strictEqual(mk({ readBalance: () => bal }).resolveByBalance(prev, st), 'unknown');
  }
});
const cardNoRef = (qa) => '<bet-card data-qa="' + qa + '"><div data-qa="bet-card-stake">1 €</div></bet-card>';
const docOf = (html) => new JSDOM('<html><body>' + html + '</body></html>').window.document;
test('snapshot qui échoue -> null', async () => {
  assert.strictEqual(await mk({ getMyBetsDoc: async () => { throw new Error('x'); } }).snapshotOngoing(), null);
});
test('carte sans référence nouvelle seule -> balance', async () => {
  const t = mk({ getMyBetsDoc: async () => docOf(cardNoRef('c1')) });
  assert.deepStrictEqual(await t.identify([]), { method: 'balance' });
});
test('carte sans référence + carte avec référence nouvelles -> balance', async () => {
  const withRef = '<bet-card data-qa="c2"><span data-qa="bet-card-reference">777</span></bet-card>';
  const t = mk({ getMyBetsDoc: async () => docOf(cardNoRef('c1') + withRef) });
  assert.deepStrictEqual(await t.identify([]), { method: 'balance' });
});
test('snapshot représente une carte sans référence par id:<data-qa>', async () => {
  const t = mk({ getMyBetsDoc: async () => docOf(cardNoRef('c1')) });
  assert.deepStrictEqual(await t.snapshotOngoing(), ['id:c1']);
  assert.deepStrictEqual(await t.identify(['id:c1']), { method: 'balance' });
});
test('getMyBetsDoc qui lève -> valeurs sûres', async () => {
  const t = mk({ getMyBetsDoc: async () => { throw new Error('x'); } });
  assert.deepStrictEqual(await t.snapshotOngoing(), null);
  assert.deepStrictEqual(await t.identify(['a']), { method: 'balance' });
  assert.strictEqual(await t.resolve('1'), 'pending');
  const t2 = mk({ getMyBetsDoc: async () => { throw new Error('x'); }, readBalance: () => { throw new Error('y'); } });
  assert.deepStrictEqual(await t2.identify([]), { method: 'none' });
  assert.strictEqual(t2.resolveByBalance(100, 5), 'unknown');
});

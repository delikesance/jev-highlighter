const test = require('node:test');
const assert = require('node:assert/strict');
const { createJournal, KEY } = require('../extension/src/auto/journal');

const memArea = () => {
  const data = {};
  return { data, get: async (k) => ({ [k]: data[k] }), set: async (o) => { Object.assign(data, JSON.parse(JSON.stringify(o))); } };
};
const entry = (id, extra) => ({ execId: id, stake: 2, pick: { label: 'A', odds: 3 }, ...extra });

test('record + update : outcome mis à jour par execId', async () => {
  const area = memArea();
  const j = createJournal({ area, now: () => 100 });
  await j.record(entry('exec-1'));
  await j.record(entry('exec-2'));
  await j.update('exec-1', { outcome: 'won' });
  const l = await j.list();
  assert.equal(l[0].outcome, 'won');
  assert.equal(l[1].outcome, 'decided');
  assert.equal(l[0].at, 100);
});

test('update : sans effet si execId absent ou nul', async () => {
  const j = createJournal({ area: memArea() });
  await j.record(entry('exec-1'));
  await j.update('exec-9', { outcome: 'won' });
  await j.update(null, { outcome: 'won' });
  assert.equal((await j.list())[0].outcome, 'decided');
});

test('borné aux max dernières entrées', async () => {
  const area = memArea();
  const j = createJournal({ area, max: 3 });
  for (let i = 1; i <= 5; i++) await j.record(entry('exec-' + i));
  assert.deepEqual((await j.list()).map((e) => e.execId), ['exec-3', 'exec-4', 'exec-5']);
  assert.equal(area.data[KEY].length, 3);
});

test('écritures concurrentes sérialisées : aucune perte', async () => {
  const j = createJournal({ area: memArea() });
  await Promise.all([1, 2, 3, 4].map((i) => j.record(entry('exec-' + i))));
  assert.equal((await j.list()).length, 4);
});

test('summary : gain net = mise×(cote−1) si gagné, −mise si perdu ; non réglés ignorés', async () => {
  const j = createJournal({ area: memArea() });
  await j.record(entry('a', { outcome: 'won', stake: 2, pick: { odds: 3 } }));
  await j.record(entry('b', { outcome: 'lost', stake: 1, pick: { odds: 2 } }));
  await j.record(entry('c', { outcome: 'placed', stake: 5, pick: { odds: 2 } }));
  assert.deepEqual(await j.summary(), { decided: 3, won: 1, lost: 1, staked: 3, net: 3 });
});

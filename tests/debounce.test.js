const test = require('node:test');
const assert = require('node:assert/strict');
const { debounce } = require('../extension/src/utils');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('debounce : un anti-rebond pur est affamé par un flux continu, maxWait force l\'exécution', async () => {
  let pure = 0;
  let guarded = 0;
  const a = debounce(() => pure++, 60);
  const b = debounce(() => guarded++, 60, 150);
  for (let i = 0; i < 20; i++) { // 20 appels toutes les 20 ms = 400 ms de « bruit »
    a();
    b();
    await wait(20);
  }
  assert.equal(pure, 0, 'sans garde-fou : jamais exécuté pendant le flux');
  assert.ok(guarded >= 2, `avec maxWait : exécuté pendant le flux (${guarded})`);
  await wait(100);
  assert.equal(pure, 1, 'exécuté une fois le calme revenu');
});

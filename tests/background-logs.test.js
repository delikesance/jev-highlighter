const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('background : requête/résultat corrélés sans journaliser les réglages secrets', async () => {
  const logs = [];
  let listener;
  const context = {
    importScripts: () => {}, AbortController, Date,
    console: { log: (...args) => logs.push(args) },
    JEV: { log: () => {}, error: () => {}, setDebug: () => {},
      Secrets: { getSecretSettings: async () => ({ mode: 'dev', credential: 'SECRET_NEVER_PRINT' }), syncHasKey: async () => {} },
      Transport: { evaluate: async () => ({ answers: { q: { choice: 'a' } } }) } },
    chrome: { storage: { session: { setAccessLevel: async () => {} } }, runtime: {
      onMessage: { addListener: (fn) => { listener = fn; } }, onInstalled: { addListener: () => {} }
    } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/src/background.js'), 'utf8'), context);
  const response = await new Promise((resolve) => {
    assert.equal(listener({ type: 'JEV_EVALUATE', requestId: 12, body: { state: { task: 'auto_choose_live' }, questions: { q: {} } } }, { tab: { id: 7 } }, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.ok(logs.some((l) => l[1] === 'request' && l[2].requestId === 12 && l[2].tabId === 7));
  assert.ok(logs.some((l) => l[1] === 'result' && l[2].answers === 1));
  assert.doesNotMatch(JSON.stringify(logs), /SECRET_NEVER_PRINT|credential/);
});

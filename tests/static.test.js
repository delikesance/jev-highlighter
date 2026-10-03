const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ext = path.join(__dirname, '..', 'extension');

test('aucun fichier content_scripts ne contient apiKey', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  for (const cs of manifest.content_scripts) {
    for (const f of cs.js) {
      const src = fs.readFileSync(path.join(ext, f), 'utf8');
      assert.doesNotMatch(src, /apiKey/, `${f} contient apiKey`);
    }
  }
});

test('getSettings sans apiKey', async () => {
  const real = global.chrome;
  global.chrome = { storage: { local: { get: async (defaults) => ({ ...defaults, apiKey: 'k', mode: 'dev', hasKey: true }) } } };
  try {
    const Storage = require('../extension/src/storage');
    const s = await Storage.getSettings();
    assert.equal('apiKey' in s, false);
    assert.equal(s.hasKey, true);
    assert.equal(Storage.isConfigured(s), true);
    assert.equal(Storage.isConfigured({ ...s, hasKey: false }), false);
  } finally {
    global.chrome = real;
  }
});

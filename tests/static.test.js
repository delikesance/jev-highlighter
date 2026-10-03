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

test('un seul module clique : auto/executor.js (exemption fermée : context.js)', () => {
  const RE = /\.click\(|dispatchEvent|new (Mouse|Input|Keyboard)?Event|\.submit\(|\.value\s*=/;
  const EXEMPT = new Set(['auto/executor.js', 'context.js']);
  const src = path.join(ext, 'src');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const offenders = walk(src)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.relative(src, f).split(path.sep).join('/'))
    .filter((rel) => !EXEMPT.has(rel) && RE.test(fs.readFileSync(path.join(src, rel), 'utf8')));
  assert.deepStrictEqual(offenders, []);
  assert.ok(fs.existsSync(path.join(src, 'auto/executor.js')), 'executor.js doit exister');
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

test('onSettingsChanged ne transmet jamais la clé', () => {
  const real = global.chrome;
  let handler;
  global.chrome = { storage: { onChanged: { addListener: (fn) => (handler = fn) } } };
  try {
    const Storage = require('../extension/src/storage');
    const patches = [];
    Storage.onSettingsChanged((p) => patches.push(p));
    handler({ apiKey: { newValue: 'k' }, debug: { newValue: true } }, 'local');
    assert.deepEqual(patches, [{ debug: true }]);
  } finally {
    global.chrome = real;
  }
});

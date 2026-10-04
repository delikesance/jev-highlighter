// Panneau du mode Auto (Shadow DOM `jev-auto`) : armement, STOP, Échap, journal en textContent uniquement.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const AutoUI = require('../extension/src/auto/auto-ui');

function setup() {
  const dom = new JSDOM('<!doctype html><body><p>site</p></body>', { url: 'https://bookmaker.test/live' });
  const doc = dom.window.document;
  const calls = { stop: [], arm: [] };
  const controller = {
    stop: async (r) => { calls.stop.push(r); },
    arm: async (p, o) => { calls.arm.push([p, o]); }
  };
  const ui = AutoUI.mount(controller, { doc });
  const host = doc.querySelector('jev-auto');
  const sr = host && host.shadowRoot;
  const $ = (s) => sr.querySelector(s);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { dom, doc, ui, host, sr, $, calls, flush };
}

test('monte un hôte jev-auto (Shadow DOM, marqué data-jev-host)', () => {
  const { host, sr, dom } = setup();
  assert.ok(host);
  assert.ok(host.hasAttribute('data-jev-host'));
  assert.ok(sr);
  dom.window.close();
});

test('« à blanc » cochée par défaut, « aucun pari manuel » décochée', () => {
  const { $, dom } = setup();
  assert.equal($('[data-k="dry"]').checked, true);
  assert.equal($('[data-k="nomanual"]').checked, false);
  dom.window.close();
});

test('STOP appelle controller.stop("STOP bouton")', async () => {
  const { $, calls, flush, dom } = setup();
  $('[data-k="stop"]').click();
  await flush();
  assert.deepEqual(calls.stop, ['STOP bouton']);
  dom.window.close();
});

test('mauvaise phrase : arm non appelé, message d\'erreur', async () => {
  const { $, calls, flush, dom } = setup();
  $('[data-k="phrase"]').value = 'parier auto';
  $('[data-k="nomanual"]').checked = true;
  $('[data-k="arm"]').click();
  await flush();
  assert.equal(calls.arm.length, 0);
  assert.match($('[data-k="err"]').textContent, /phrase/i);
  dom.window.close();
});

test('« aucun pari manuel » obligatoire', async () => {
  const { $, calls, flush, dom } = setup();
  $('[data-k="phrase"]').value = 'PARIER AUTO';
  $('[data-k="arm"]').click();
  await flush();
  assert.equal(calls.arm.length, 0);
  assert.match($('[data-k="err"]').textContent, /manuel/i);
  dom.window.close();
});

test('armement valide : arm(phrase, { dryRun, noManualBets })', async () => {
  const { $, calls, flush, dom } = setup();
  $('[data-k="phrase"]').value = 'PARIER AUTO';
  $('[data-k="nomanual"]').checked = true;
  $('[data-k="arm"]').click();
  await flush();
  assert.deepEqual(calls.arm, [['PARIER AUTO', { dryRun: true, noManualBets: true }]]);
  $('[data-k="dry"]').checked = false;
  $('[data-k="arm"]').click();
  await flush();
  assert.deepEqual(calls.arm[1], ['PARIER AUTO', { dryRun: false, noManualBets: true }]);
  dom.window.close();
});

test('Échap (document, capture) -> stop("Échap") ; plus rien après unmount', async () => {
  const { doc, dom, calls, ui, flush } = setup();
  doc.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  assert.deepEqual(calls.stop, ['Échap']);
  ui.unmount();
  assert.equal(doc.querySelector('jev-auto'), null);
  doc.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  assert.equal(calls.stop.length, 1);
  dom.window.close();
});

test('journal : textContent seulement (aucun <img> injecté), 50 dernières lignes', () => {
  const { ui, sr, doc, dom } = setup();
  ui.addLog('<img src=x onerror="alert(1)">');
  assert.equal(sr.querySelectorAll('img').length, 0);
  assert.equal(doc.querySelectorAll('img').length, 0);
  assert.ok(sr.querySelector('[data-k="log"]').textContent.includes('<img'));
  for (let i = 0; i < 80; i++) ui.addLog(`ligne ${i}`);
  const lines = sr.querySelectorAll('[data-k="log"] > *');
  assert.equal(lines.length, 50);
  assert.ok(lines[lines.length - 1].textContent.includes('ligne 79'));
  dom.window.close();
});

test('refresh : phase, message, solde, bilan (paris, défaites, perte) sans HTML', () => {
  const { ui, sr, $, dom } = setup();
  ui.refresh({
    phase: 'PAUSE', reason: '<img src=x onerror=1>', dryRun: true, balance: 92.5,
    session: { startBalance: 100 }, guardSnap: { placed: 2, consecutiveLosses: 1, reserved: 0, inFlight: 0 }, bets: [{}, {}]
  });
  assert.match($('[data-k="phase"]').textContent, /PAUSE/);
  assert.match($('[data-k="phase"]').textContent, /blanc/);
  assert.match($('[data-k="msg"]').textContent, /<img/);
  assert.match($('[data-k="balance"]').textContent, /92,50/);
  const s = $('[data-k="summary"]').textContent;
  assert.match(s, /2/);
  assert.match(s, /1/);
  assert.match(s, /7,50/);
  assert.equal(sr.querySelectorAll('img').length, 0);
  dom.window.close();
});

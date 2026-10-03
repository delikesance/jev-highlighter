const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const R = require('../extension/src/auto/readers');

const load = (f) => new JSDOM(fs.readFileSync(path.join(__dirname, f), 'utf8')).window.document;

test('readSlip: ticket vide', () => {
  const s = R.readSlip(load('fixture-slip-empty.html'));
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.betButton.present, true);
  assert.strictEqual(s.betButton.enabled, false);
  assert.deepStrictEqual(s.unknown, []);
  assert.strictEqual(s.odds, null);
  assert.strictEqual(s.stake, null);
});
test('readSlip: une sélection', () => {
  const s = R.readSlip(load('fixture-slip-one.html'));
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.selection, 'Canada');
  assert.strictEqual(s.market, 'Résultat sur la période');
  assert.deepStrictEqual(s.window, { startSec: 1800, endSec: 2099 });
  assert.strictEqual(s.event, 'Canada - Pérou');
  assert.strictEqual(s.odds, 6.5);
  assert.strictEqual(s.stake, 0.65);
  assert.strictEqual(s.winnings, 4.23);
  assert.deepStrictEqual(s.betButton, { present: true, enabled: true, label: 'Parier' });
  assert.deepStrictEqual(s.unknown, []);
});
test('readSlip: mise virgule, vide, compte illisible', () => {
  const d = load('fixture-slip-one.html');
  const inp = d.querySelector('input[name=stakeField]');
  inp.value = '0,65';
  assert.strictEqual(R.readSlip(d).stake, 0.65);
  inp.value = '';
  assert.strictEqual(R.readSlip(d).stake, null);
  d.querySelector('.progressiveBettingSlip_headerTitle').textContent = 'bizarre';
  assert.strictEqual(R.readSlip(d).count, null);
  d.querySelector('.progressiveBettingSlip_headerTitle').remove();
  assert.strictEqual(R.readSlip(d).count, null);
});
test('readSlip: élément inconnu dans unknown', () => {
  const d = load('fixture-slip-one.html');
  const c = d.querySelector('.progressiveBettingSlip_content');
  const x = d.createElement('div');
  x.textContent = '  Les cotes ont changé  ';
  c.appendChild(x);
  const a = d.createElement('betting-slip-alert');
  a.innerHTML = '<div class="alert is-error">Sélection indisponible</div>';
  d.querySelector('sports-betting-slip').appendChild(a);
  assert.deepStrictEqual(R.readSlip(d).unknown, ['Les cotes ont changé', 'Sélection indisponible']);
});
test('readSlip: bandeau multiboost ignoré', () => {
  const d = load('fixture-slip-one.html');
  const a = d.createElement('betting-slip-alert');
  a.innerHTML = '<div class="alert is-multiboost">Booste ton pari ! Ajoute une sélection</div>';
  d.querySelector('sports-betting-slip').appendChild(a);
  assert.deepStrictEqual(R.readSlip(d).unknown, []);
});
test('readWallet', () => {
  assert.strictEqual(R.readWallet(load('fixture-slip-one.html')), 6.53);
  assert.strictEqual(R.readWallet(new JSDOM('<p></p>').window.document), null);
});
test('readWalletStable: stable puis changeant', async () => {
  const d = load('fixture-slip-one.html');
  assert.strictEqual(await R.readWalletStable(d, async () => {}), 6.53);
  const span = d.querySelector('.header_walletBalance span:last-child');
  assert.strictEqual(await R.readWalletStable(d, async () => { span.textContent = '7,00 €'; }), null);
});
test('readConfirmation', () => {
  const c = R.readConfirmation(load('fixture-confirm-modal.html'));
  assert.deepStrictEqual(c, { open: true, validated: true, stake: 0.65, odds: 6.5, winnings: 4.23 });
  const n = R.readConfirmation(load('fixture-slip-one.html'));
  assert.strictEqual(n.open, false);
  assert.strictEqual(n.validated, false);
});
test('readMyBets en cours', () => {
  const b = R.readMyBets(load('fixture-mybets-ongoing.html'));
  assert.strictEqual(b.length, 2);
  assert.deepStrictEqual(b[0], { id: '9876543210001', reference: '9876543210001', stake: 0.65, winnings: 4.23, status: 'ongoing', date: '03/10/2026 20:11' });
  assert.ok(b.every((x) => x.status === 'ongoing'));
});
test('readMyBets terminés', () => {
  const b = R.readMyBets(load('fixture-mybets-ended.html'));
  assert.deepStrictEqual(b.map((x) => x.status), ['lost', 'won']);
  assert.strictEqual(b[1].stake, 3.5);
});
test('readTimer', () => {
  const t = R.readTimer(load('fixture-slip-one.html'));
  assert.strictEqual(t.elapsedSec, 1620);
  assert.strictEqual(t.running, true);
  assert.strictEqual(R.readTimer(new JSDOM('<p></p>').window.document).running, false);
});
test('readTimer: préfère l\'en-tête de match', () => {
  const d = new JSDOM(`<scoreboards-timer>10'</scoreboards-timer><sports-match-page-desktop><div class="event_infoTime"><scoreboards-timer>44'</scoreboards-timer></div></sports-match-page-desktop>`).window.document;
  assert.strictEqual(R.readTimer(d).elapsedSec, 2640);
});
test('lecture seule: DOM inchangé', () => {
  for (const f of ['fixture-slip-one.html', 'fixture-confirm-modal.html', 'fixture-mybets-ended.html']) {
    const d = load(f);
    const before = d.documentElement.outerHTML;
    R.readSlip(d); R.readWallet(d); R.readConfirmation(d); R.readMyBets(d); R.readTimer(d);
    assert.strictEqual(d.documentElement.outerHTML, before);
  }
});

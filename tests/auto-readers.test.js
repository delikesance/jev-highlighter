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
test('readSlip: ticket vide — textes informatifs réels ne sont pas des alertes', () => {
  const d = load('fixture-slip-empty.html');
  d.querySelector('.progressiveBettingSlip_headerTitle').textContent = '0 selection';
  d.querySelector('bcdk-empty-view').innerHTML = '<p>Place un nouveau pari</p><p>On croise les doigts pour toi !</p>';
  d.querySelector('betting-slip-footer').insertAdjacentHTML('afterbegin', '<p>Gains possibles</p>');
  assert.strictEqual(R.readSlip(d).count, 0);
  assert.deepStrictEqual(R.readSlip(d).unknown, []);
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
test('readSlip: promotion Boost connue et suffixe EUR de cote ignorés', () => {
  const d = load('fixture-slip-one.html');
  d.querySelector('sports-betting-slip').insertAdjacentHTML(
    'afterbegin',
    '<betting-slip-alert><div>Booste ton pari !Ajoute 1 sélection supérieure à 1,20</div></betting-slip-alert>'
  );
  d.querySelector('betting-slip-odds-field').insertAdjacentHTML('beforeend', '<span>EUR</span>');
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
const page = (inner) => new JSDOM(`<sports-match-page-desktop><div class="event_infoTime">${inner}</div></sports-match-page-desktop>`).window.document;
test('readTimer: en-tête de match', () => {
  const t = R.readTimer(page("<scoreboards-timer> 27' • 1ère mi-temps </scoreboards-timer>"));
  assert.strictEqual(t.elapsedSec, 1620);
  assert.strictEqual(t.period, 'MT 1');
  assert.strictEqual(t.running, true);
});
test('readTimer: pas de repli sur un timer de liste', () => {
  assert.strictEqual(R.readTimer(load('fixture-slip-one.html')).running, false);
  const d = new JSDOM(`<scoreboards-timer>10'</scoreboards-timer><sports-match-page-desktop><div class="event_infoTime"><scoreboards-timer>44'</scoreboards-timer></div></sports-match-page-desktop>`).window.document;
  assert.strictEqual(R.readTimer(d).elapsedSec, 2640);
});
const slipWith = (fn) => { const d = load('fixture-slip-one.html'); fn(d); return R.readSlip(d).unknown; };
test('unknown: Suspendu dans la carte', () => {
  assert.deepStrictEqual(slipWith((d) => { const e = d.createElement('span'); e.textContent = 'Suspendu'; d.querySelector('.progressiveBettingSlip_cardContent').appendChild(e); }), ['Suspendu']);
});
test('unknown: Cotes modifiées à côté de #betBtn', () => {
  assert.deepStrictEqual(slipWith((d) => { const e = d.createElement('div'); e.textContent = 'Cotes modifiées'; d.querySelector('#betBtn').parentNode.appendChild(e); }), ['Cotes modifiées']);
});
test('unknown: div.alert et bcdk-alert', () => {
  assert.deepStrictEqual(slipWith((d) => { const e = d.createElement('div'); e.className = 'alert'; e.textContent = 'Erreur X'; d.querySelector('betting-slip-footer').appendChild(e); }), ['Erreur X']);
  assert.deepStrictEqual(slipWith((d) => { const e = d.createElement('bcdk-alert'); e.innerHTML = '<p>Alerte Y</p>'; d.querySelector('sports-betting-slip').appendChild(e); }), ['Alerte Y']);
});
test('multiboost: conteneur mixte ne masque pas l\'erreur', () => {
  assert.deepStrictEqual(slipWith((d) => { const e = d.createElement('betting-slip-alert'); e.innerHTML = '<div class="alert is-multiboost">Booste ton pari !</div><div class="alert is-error">Mise trop haute</div>'; d.querySelector('sports-betting-slip').appendChild(e); }), ['Mise trop haute']);
});
test('confirmation: non validé / invalidé refusés', () => {
  for (const [t, ok] of [['Pari non validé', false], ['Pari invalidé', false], ['Ton pari n\'est pas validé', false], ['Super ! Ton pari est validé', true]]) {
    const d = load('fixture-confirm-modal.html');
    d.querySelector('[data-qa="bet-confirmation-title"]').textContent = t;
    assert.strictEqual(R.readConfirmation(d).validated, ok, t);
  }
});
test('mes paris: is-ended sans preuve -> unknown', () => {
  const d = load('fixture-mybets-ended.html');
  const c = d.querySelector('bet-card');
  c.className = 'betCard is-ended';
  c.querySelector('[data-qa="bet-card-status-tag"]').remove();
  assert.strictEqual(R.readMyBets(d)[0].status, 'unknown');
  assert.strictEqual(R.readMyBets(d)[1].status, 'won');
});
test('solde: deux portefeuilles -> null', () => {
  const d = load('fixture-slip-one.html');
  d.body.insertAdjacentHTML('beforeend', '<a class="header_walletBalance"><bc-header-animated-balance><span>9,00 €</span></bc-header-animated-balance></a>');
  assert.strictEqual(R.readWallet(d), null);
});
test('cote: « x2 6,50 » jamais 2', () => {
  const d = load('fixture-slip-one.html');
  d.querySelector('betting-slip-footer-odds .btn_label').textContent = 'x2 6,50';
  assert.strictEqual(R.readSlip(d).odds, null);
});
test('lecture seule: DOM inchangé', () => {
  for (const f of ['fixture-slip-one.html', 'fixture-confirm-modal.html', 'fixture-mybets-ended.html']) {
    const d = load(f);
    const before = d.documentElement.outerHTML;
    R.readSlip(d); R.readWallet(d); R.readConfirmation(d); R.readMyBets(d); R.readTimer(d);
    assert.strictEqual(d.documentElement.outerHTML, before);
  }
});

test('unknown: textes cachés dans un nœud connu (sous-arbre non sauté)', () => {
  assert.deepStrictEqual(slipWith((d) => { d.querySelector('.progressiveBettingSlip_cardMarketValue').insertAdjacentHTML('beforeend', '<span>Suspendu</span>'); }), ['Suspendu']);
  assert.deepStrictEqual(slipWith((d) => { d.querySelector('#betBtn').insertAdjacentHTML('beforeend', '<div class="alert">Err bouton</div>'); }), ['Err bouton']);
  assert.deepStrictEqual(slipWith((d) => { d.querySelector('betting-slip-footer-odds').insertAdjacentHTML('beforeend', '<i>Modifiée</i>'); }), ['Modifiée']);
  const e = new JSDOM(fs.readFileSync(path.join(__dirname, 'fixture-slip-empty.html'), 'utf8')).window.document;
  e.querySelector('bcdk-empty-view').innerHTML = '<p>Erreur vide</p>';
  assert.deepStrictEqual(R.readSlip(e).unknown, ['Erreur vide']);
});
test('multiboost contenant une alerte: erreur signalée', () => {
  assert.deepStrictEqual(slipWith((d) => { d.querySelector('sports-betting-slip').insertAdjacentHTML('beforeend', '<betting-slip-alert><div class="is-multiboost wrap">Booste<div class="alert">Err</div></div></betting-slip-alert>'); }), ['Err']);
});
test('fixtures réelles du ticket: unknown vide', () => {
  for (const f of ['fixture-slip-one.html', 'fixture-slip-empty.html', 'fixture-slip.html']) {
    assert.deepStrictEqual(R.readSlip(load(f)).unknown, [], f);
  }
});

test('unknown: allowlist ancrée au contexte et à la forme', () => {
  const U = slipWith;
  assert.deepStrictEqual(U((d) => d.querySelector('.progressiveBettingSlip_cardEventName').insertAdjacentHTML('beforeend', '<span class="ellipsis">Suspendu</span>')), ['Suspendu']);
  assert.deepStrictEqual(U((d) => d.querySelector('#betBtn').insertAdjacentHTML('beforeend', '<span class="ellipsis">Suspendu</span>')), ['Suspendu']);
  assert.deepStrictEqual(U((d) => d.querySelector('betting-slip-footer-odds').insertAdjacentHTML('beforeend', '<span class="btn_label">Cotes modifiées</span>')), ['Cotes modifiées']);
  assert.deepStrictEqual(U((d) => d.querySelector('#betBtn').insertAdjacentHTML('beforeend', '<span class="btn_label">Cotes modifiées</span>')), ['Cotes modifiées']);
  assert.deepStrictEqual(U((d) => { d.querySelector('#betBtn .btn_label').textContent = 'Accepter les cotes'; }), ['Accepter les cotes']);
  assert.deepStrictEqual(U((d) => { d.querySelector('betting-slip-footer-odds .btn_label').textContent = 'Indisponible'; }), ['Indisponible']);
  assert.deepStrictEqual(U((d) => { d.querySelector('.progressiveBettingSlip_headerTitle span').textContent = 'Erreur'; }), ['Erreur']);
  assert.deepStrictEqual(U((d) => d.querySelector('sports-betting-slip').insertAdjacentHTML('beforeend', '<span class="is-multiboost">Booste ton pari</span>')), ['Booste ton pari']);
});

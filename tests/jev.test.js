const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFixture } = require('./helpers');
const { normalizeText, slugify, parseOdds } = require('../extension/src/utils');
const { parseMarkets } = require('../extension/src/parser');
const { buildRequest, resolveTarget, evaluate, JevError } = require('../extension/src/jev');
const { matchAnswers } = require('../extension/src/matcher');
const { CONFIG } = require('../extension/src/config');

test('normalizeText: accents, apostrophes, espaces, casse', () => {
  assert.equal(normalizeText('  Zoé   O’Brien '), "zoe o'brien");
  assert.equal(normalizeText("ZOE O'BRIEN"), "zoe o'brien");
  assert.equal(normalizeText('2ème set'), '2eme set');
});

test('parseOdds / slugify', () => {
  assert.equal(parseOdds('1,20'), 1.2);
  assert.equal(parseOdds(' 1 200,50 '), 1200.5);
  assert.equal(parseOdds('—'), null);
  assert.equal(slugify('Premier à atteindre 2 points - 2ème set'), 'premier_a_atteindre_2_points_2eme_set');
});

test('parser: marchés, doublons, indisponibles, sans titre', () => {
  const p = parseMarkets(loadFixture());
  assert.equal(p.stats.markets, 6); // le marché sans titre est ignoré
  assert.equal(p.stats.skipped, 1);
  const ids = [...p.markets.keys()];
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('premier_a_atteindre_2_points_dans_le_jeu_10_2eme_set'));

  const m = p.markets.get('vainqueur_du_jeu_11');
  const charaeva = m.options.find((o) => o.name === 'Alina Charaeva');
  assert.equal(charaeva.available, false);
  assert.equal(m.options.find((o) => o.name === 'Égalité').available, true);

  const noOdds = p.markets.get('marche_sans_cote');
  assert.equal(noOdds.options[0].available, false);
  assert.equal(noOdds.options[0].odds, null);

  const rybakina = p.markets.get('premier_a_atteindre_2_points_dans_le_jeu_10_2eme_set').options[0];
  assert.equal(rybakina.odds, 1.2);
  assert.ok(rybakina.element); // référence DOM conservée côté extension
});

test('buildRequest: pas de DOM sérialisé, options indisponibles exclues', () => {
  const p = parseMarkets(loadFixture());
  const { body, questionCount } = buildRequest(p, { pageTitle: 'T', pagePath: '/x' });
  const json = JSON.stringify(body);
  assert.ok(!json.includes('element'));
  assert.equal(questionCount, 5); // "sans cote" : 1 seule option disponible, non évaluable
  const q = body.questions['vainqueur_du_jeu_11'];
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria), ['Elena Rybakina', 'Égalité']); // barré exclu
});

test('buildRequest: noul pour Oui/Non seulement si activé', () => {
  const p = parseMarkets(loadFixture());
  assert.equal(buildRequest(p).body.questions['le_jeu_atteint_il_40_40'].type, 'choice');
  CONFIG.useNoulForYesNo = true;
  try {
    const q = buildRequest(p).body.questions['le_jeu_atteint_il_40_40'];
    assert.equal(q.type, 'noul');
    const m = matchAnswers(p.markets, { le_jeu_atteint_il_40_40: { type: 'noul', noul: 0.2 } });
    assert.equal(m.recommendations[0].choice, 'Non');
    assert.ok(Math.abs(m.recommendations[0].jevScore - 0.8) < 1e-9);
  } finally {
    CONFIG.useNoulForYesNo = false;
  }
});

test('matcher: matching normalisé, meilleur pari, cas dégradés', () => {
  const p = parseMarkets(loadFixture());
  const answers = {
    premier_a_atteindre_2_points_dans_le_jeu_10_2eme_set: {
      type: 'choice', choice: 'Elena Rybakina', confidence: 0.62,
      probabilities: { 'Elena Rybakina': 0.81, 'Alina Charaeva': 0.19 }
    },
    qui_remporte_l_echange: {
      type: 'choice', choice: 'ZOE o\'brien', confidence: 0.4,
      probabilities: { "Zoe O'Brien": 0.55, 'Chloe Muller': 0.45 }
    },
    vainqueur_du_jeu_11: { type: 'choice', choice: 'Alina Charaeva', probabilities: { 'Alina Charaeva': 0.9 } }, // barré
    marche_disparu: { type: 'choice', choice: 'A', probabilities: {} },
    marche_sans_cote: { type: 'choice', choice: 'Inconnu', probabilities: {} }
  };
  const m = matchAnswers(p.markets, answers, { expectedIds: ['le_jeu_atteint_il_40_40'] });
  assert.equal(m.recommendations.length, 2);
  assert.equal(m.best.choice, 'Elena Rybakina');
  assert.equal(m.best.jevScore, 0.81);
  const reasons = Object.fromEntries(m.unmatched.map((u) => [u.marketId, u.reason]));
  assert.equal(reasons.vainqueur_du_jeu_11, 'option-unavailable');
  assert.equal(reasons.marche_disparu, 'market-gone');
  assert.equal(reasons.marche_sans_cote, 'choice-not-in-dom');
  assert.equal(reasons.le_jeu_atteint_il_40_40, 'missing-answer');
});

test('fingerprint: stable puis modifié si cote change', () => {
  const a = parseMarkets(loadFixture()).fingerprint;
  assert.equal(parseMarkets(loadFixture()).fingerprint, a);
  const b = parseMarkets(loadFixture((d) => { d.querySelector('.btn_label').textContent = '1,25'; })).fingerprint;
  assert.notEqual(a, b);
});

test('client: configuration, URL non sûre, réponses d\'erreur', async () => {
  assert.throws(() => resolveTarget({ mode: 'dev', apiKey: '' }), (e) => e.code === 'not_configured');
  assert.throws(() => resolveTarget({ mode: 'backend', backendUrl: 'http://evil.example/x' }), (e) => e.code === 'not_configured');
  const t = resolveTarget({ mode: 'dev', apiKey: 'k' });
  assert.equal(t.headers.Authorization, 'Bearer k');
  assert.equal(resolveTarget({ mode: 'backend', backendUrl: 'http://localhost:8787/jev' }).headers.Authorization, undefined);

  const realFetch = global.fetch;
  try {
    const mk = (status, body, headers = {}) => async () => new Response(JSON.stringify(body), { status, headers });
    global.fetch = mk(200, { nope: 1 });
    await assert.rejects(evaluate({ questions: { a: {} } }, { mode: 'dev', apiKey: 'k' }), (e) => e.code === 'invalid_response');
    global.fetch = mk(401, {});
    await assert.rejects(evaluate({ questions: { a: {} } }, { mode: 'dev', apiKey: 'k' }), (e) => e.code === 'unauthorized');
    let calls = 0;
    global.fetch = async () => (++calls < 2 ? new Response('{}', { status: 429, headers: { 'retry-after': '0.01' } }) : new Response(JSON.stringify({ model: 'm', answers: { a: {} } }), { status: 200 }));
    const r = await evaluate({ questions: { a: {} } }, { mode: 'dev', apiKey: 'k' });
    assert.equal(calls, 2);
    assert.deepEqual(Object.keys(r.answers), ['a']);
  } finally {
    global.fetch = realFetch;
  }
});

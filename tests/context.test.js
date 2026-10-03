const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const C = require('../extension/src/context');
const { buildRequest } = require('../extension/src/jev');
const { parseMarkets } = require('../extension/src/parser');
const { loadFixture } = require('./helpers');

const doc = (f) => new JSDOM(fs.readFileSync(path.join(__dirname, f), 'utf8')).window.document;

test('keyFromPath : page de match et match-center, sinon null', () => {
  const p = '/basketball-sbasketball/betclic-elite-c15/nancy-cholet-m1233460038488064';
  assert.equal(C.keyFromPath(p), p);
  assert.equal(C.keyFromPath(`${p}/match-center`), p);
  assert.equal(C.keyFromPath(`${p}/match-center/`), p);
  assert.equal(C.keyFromPath('/basketball-sbasketball/betclic-elite-c15'), null);
  assert.equal(C.keyFromPath('/'), null);
});

test('parseLive : équipes, période, statistiques', () => {
  const l = C.parseLive(doc('fixture-matchcenter-live.html'));
  assert.equal(l.home, 'Nancy');
  assert.equal(l.away, 'Cholet');
  assert.equal(l.period, 'Tous');
  assert.deepEqual(l.stats[0], { name: 'Lancers-francs réussis', home: '100%', away: '0%' });
  assert.deepEqual(l.stats.find((s) => s.name === 'Possession de balle'), { name: 'Possession de balle', home: '73 %', away: '27 %' });
  assert.equal(C.parseLive(doc('fixture-matchcenter-standing.html')), null); // mauvais onglet
});

test('parseHeadToHead : probabilité, face-à-face, forme par quart-temps, derniers matchs', () => {
  const h = C.parseHeadToHead(doc('fixture-matchcenter-perf.html'));
  assert.deepEqual(h.win_probability, { home: 50, away: 50 });
  assert.deepEqual(h.previous_meetings, { home_wins: 17, since: 2005, away_wins: 18 });
  assert.equal(h.head_to_head_averages[0].name, 'Total de pts');
  assert.equal(h.head_to_head_averages[0].value, 158);
  assert.equal(h.head_to_head_averages[0].league_average, 164.4);
  const [nancy, cholet] = h.team_form;
  assert.equal(nancy.team, 'Nancy');
  assert.equal(nancy.position, 11);
  assert.deepEqual(nancy.per_quarter.points_for, { QT1: 15, QT2: 17, QT3: 24, QT4: 17 });
  assert.deepEqual(cholet.per_quarter.diff, { QT1: -3, QT2: -10, QT3: 2, QT4: -1 });
  assert.equal(h.last_matches[0].team, 'Nancy');
  assert.deepEqual(h.last_matches[0].matches[0], { date: '27 Sept, 2026', competition: 'LNB Elite', result: 'D', home: 'Nancy', away: 'Paris Basketball', score: '73-78' });
  assert.equal(h.last_matches[1].matches.length, 2);
});

test('parseStandings : seules les équipes du match sont isolées', () => {
  const s = C.parseStandings(doc('fixture-matchcenter-standing.html'));
  assert.equal(s.competition, 'LNB Elite');
  assert.equal(s.teams_count, 3);
  assert.deepEqual(s.match_teams.map((r) => [r.position, r.team, r.points, r.diff, r.form]), [
    [11, 'Nancy', '73:78', -5, 'D'],
    [15, 'Cholet', '85:97', -12, 'D']
  ]);
  assert.equal(s.leader.team, 'Roanne');
});

function fullEntry() {
  return { at: 1, parts: C.parseAll(doc('fixture-matchcenter-live.html')) && {
    live: C.parseLive(doc('fixture-matchcenter-live.html')),
    h2h: C.parseHeadToHead(doc('fixture-matchcenter-perf.html')),
    standings: C.parseStandings(doc('fixture-matchcenter-standing.html'))
  } };
}

test('compactContext : structure utile, taille bornée, sans DOM', () => {
  const ctx = C.compactContext(fullEntry());
  assert.deepEqual(ctx.teams, ['Nancy', 'Cholet']);
  assert.equal(ctx.competition, 'LNB Elite');
  assert.equal(ctx.sportradar_win_probability_pct.home, 50);
  assert.ok(ctx.last_matches[0].matches[0].startsWith('D Nancy 73-78 Paris Basketball'));
  assert.ok(JSON.stringify(ctx).length <= 3500);
  // budget très serré : les blocs peu utiles (live, moyennes…) sautent d'abord, le classement reste
  const tiny = C.compactContext(fullEntry(), 1500);
  assert.ok(JSON.stringify(tiny).length <= 1500 || !tiny.live);
  assert.ok(!('live' in tiny));
  assert.ok(tiny.standings);
  assert.equal(C.compactContext(null), null);
  assert.equal(C.compactContext({ parts: {} }), null);
});

test('buildRequest : le contexte est transmis dans l\'état (et seulement s\'il existe)', () => {
  const p = parseMarkets(loadFixture());
  const ctx = C.compactContext(fullEntry());
  const withCtx = buildRequest(p, { pageTitle: 'T', pagePath: '/x', matchContext: ctx }).body;
  assert.deepEqual(withCtx.state.match_context.teams, ['Nancy', 'Cholet']);
  assert.ok(!JSON.stringify(withCtx).includes('element'));
  const without = buildRequest(p, { pageTitle: 'T', pagePath: '/x' }).body;
  assert.ok(!('match_context' in without.state));
  const q = Object.values(withCtx.questions)[0];
  assert.match(q.instructions, /contexte du match/i);
});

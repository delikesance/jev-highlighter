const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { scanLive } = require('../extension/src/auto/scanner');

const load = () => new JSDOM(fs.readFileSync(path.join(__dirname, 'fixture-live-list.html'), 'utf8')).window.document;

test('scanLive: nombre, ordre, index, href exact', () => {
  const ev = scanLive(load());
  assert.strictEqual(ev.length, 6);
  assert.deepStrictEqual(ev.map((e) => e.index), [0, 1, 2, 3, 4, 5]);
  assert.strictEqual(ev[0].href, '/football-sfootball/matchs-amicaux-c79/canada-perou-m1240024819470433');
  assert.strictEqual(ev[0].name, 'Canada - Pérou');
});
test('scanLive: temps et score foot', () => {
  const e = scanLive(load())[0];
  assert.strictEqual(e.clock.elapsedSec, 1620);
  assert.strictEqual(e.clock.period, 'MT 1');
  assert.deepStrictEqual(e.score, [1, 0]);
  assert.strictEqual(e.sport, 'football');
  assert.strictEqual(e.mainSuspended, false);
});
test('scanLive: cote suspendue', () => {
  const ev = scanLive(load());
  assert.strictEqual(ev[1].mainSuspended, true);
  assert.strictEqual(ev[2].mainSuspended, false);
});
test('scanLive: mi-temps, débute, basket, other', () => {
  const ev = scanLive(load());
  assert.strictEqual(ev[2].clock.running, false);
  assert.strictEqual(ev[3].clock.running, false);
  assert.strictEqual(ev[3].score, null);
  assert.strictEqual(ev[4].sport, 'basketball');
  assert.strictEqual(ev[4].clock.remainingSec, 461);
  assert.deepStrictEqual(ev[4].score, [24, 19]);
  assert.strictEqual(ev[5].sport, 'other');
});
test('scanLive: lecture seule', () => {
  const doc = load();
  const before = doc.documentElement.outerHTML;
  scanLive(doc);
  assert.strictEqual(doc.documentElement.outerHTML, before);
});

const docOf = (body) => new JSDOM('<body>' + body + '</body>').window.document;
const btn = (o, cls = '', attr = '', inner = '') =>
  `<button bcdkbetbutton class="btn is-odd ${cls}" ${attr}><bcdk-bet-button-odds-animated>${o}${inner}</bcdk-bet-button-odds-animated></button>`;
const cardHtml = ({ icon = '', btns = [btn('1,50'), btn('2,00'), btn('3,00')], score = '', name = 'A - B' } = {}) =>
  `<a sports-events-event-card aria-label="${name}" href="/x"><span class="breadcrumb_itemIcon ${icon}"></span>
   <div class="event_infoTime">27' • MT 1</div><scoreboards-scoreboard><div data-qa="scoreboard-score">${score}</div></scoreboards-scoreboard>
   <sports-default-markets>${btns.join('')}</sports-default-markets></a>`;
const bucketHtml = (head, cards) =>
  `<sports-live-event-bucket>${head ? `<span class="list_itemImg ${head}"></span>` : ''}${cards}</sports-live-event-bucket>`;
const sportOfDoc = (b) => scanLive(docOf(b))[0].sport;

test('sport: handball dans bucket foot => other', () => {
  assert.strictEqual(sportOfDoc(bucketHtml('icon_sport_football', cardHtml({ icon: 'icon_sport_handball' }))), 'other');
});
test('sport: carte sans icône dans bucket foot => football', () => {
  assert.strictEqual(sportOfDoc(bucketHtml('icon_sport_football', cardHtml())), 'football');
});
test('sport: carte sans icône, bucket sans en-tête => other', () => {
  assert.strictEqual(sportOfDoc(bucketHtml('', cardHtml())), 'other');
  assert.strictEqual(sportOfDoc(cardHtml()), 'other');
});
test('sport: conflit carte basket / bucket foot => other', () => {
  assert.strictEqual(sportOfDoc(bucketHtml('icon_sport_football', cardHtml({ icon: 'icon_sport_basketball' }))), 'other');
});
test('sport: icône .list_itemImg dans une carte ignorée comme en-tête', () => {
  const c = cardHtml().replace('</a>', '<i class="list_itemImg icon_sport_football"></i></a>');
  assert.strictEqual(sportOfDoc(bucketHtml('', c)), 'other');
});

const susp = (btns) => scanLive(docOf(cardHtml({ btns })))[0].mainSuspended;
test('mainSuspended: conditions isolées', () => {
  assert.strictEqual(susp([btn('1,5'), btn('2'), btn('3', 'is-strikethrough')]), true);
  assert.strictEqual(susp([btn('1,5'), btn('2'), btn('3', '', '', '<i class="is-strikethrough"></i>')]), true);
  assert.strictEqual(susp([btn('1,5'), btn('2'), btn('-')]), true);
  assert.strictEqual(susp([btn('1,5'), btn('2'), btn('3', '', 'disabled')]), true);
  assert.strictEqual(susp([]), true);
  assert.strictEqual(susp([btn('1,5'), btn('2'), btn('8,25\n  ')]), false);
});

test('score illisible => null', () => {
  const sc = (h) => scanLive(docOf(cardHtml({ score: h })))[0].score;
  assert.strictEqual(sc('<span class="scoreboard_score-1">x</span><span class="scoreboard_score-2">0</span>'), null);
  assert.strictEqual(sc('<span class="scoreboard_score-1">1</span>'), null);
  assert.deepStrictEqual(sc('<span class="scoreboard_score-1">1</span><span class="scoreboard_score-2">0</span>'), [1, 0]);
});

test('mainOdds : cotes lues dans l\'ordre, null si une cote est illisible', () => {
  assert.deepStrictEqual(scanLive(docOf(cardHtml()))[0].mainOdds, [1.5, 2, 3]);
  assert.strictEqual(scanLive(docOf(cardHtml({ btns: [btn('1,50'), btn('-')] })))[0].mainOdds, null);
  assert.strictEqual(scanLive(docOf(cardHtml({ btns: [] })))[0].mainOdds, null);
});

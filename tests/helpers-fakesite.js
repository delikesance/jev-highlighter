/**
 * Faux site Betclic (jsdom) pour l'exécuteur. Markup repris des fixtures réelles (fixture-fast, fixture-slip-*, fixture-confirm-modal),
 * comportement « Angular » simulé : seul un évènement `input` met à jour la mise (une assignation `.value =` directe ne fait rien).
 */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const body = (html) => html.replace(/^[\s\S]*?<body>/, '').replace(/<\/body>[\s\S]*$/, '');
const fr = (n) => n.toFixed(2).replace('.', ',');

const HEADER = body(read('fixture-slip-empty.html')).split('<scoreboards-timer>')[0];
const MARKETS = body(read('fixture-fast.html'));
const MODAL_TPL = body(read('fixture-confirm-modal.html')).replace(/^[\s\S]*?(<div class="cdk-overlay-container">)/, '$1');
const SLIP_EMPTY = body(read('fixture-slip-empty.html')).replace(/^[\s\S]*?(<sports-betting-slip>)/, '$1');

function makeFakeSite(opts = {}) {
  const o = { event: 'Canada - Pérou', balance: 6.53, timer: "27' • 1ère mi-temps", betLabel: 'Parier', ...opts };
  const html = `<!doctype html><html><body>${HEADER.replace('6,53', fr(o.balance))}
<sports-match-page-desktop><div class="event_infoTime"><scoreboards-timer> ${o.timer} </scoreboards-timer></div>${MARKETS}</sports-match-page-desktop>
${SLIP_EMPTY}</body></html>`;
  const dom = new JSDOM(html);
  const win = dom.window;
  const doc = win.document;
  const spy = { clicks: [], betBtn: 0, keep: 0, close: 0, iconClose: 0, oddsClicks: 0, directAssign: 0 };
  let sel = null; // { label, market, window, odds }
  let stake = null;
  let hidden = !!o.hidden;
  let clock = 0;
  let timers = [];
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });

  if (o.odds !== undefined) {
    const b = doc.querySelector('sports-tabs-markets[data-section=a] .marketBox_lineSelection button[data-qa=market-selection] .btn_label');
    b.textContent = fr(o.odds);
  }
  if (o.suspended) {
    const b = doc.querySelector('sports-tabs-markets[data-section=a] .marketBox_lineSelection button[data-qa=market-selection]');
    b.setAttribute('disabled', '');
    b.classList.add('is-strikethrough');
  }

  const slipRoot = () => doc.querySelector('sports-betting-slip');
  const oddsNum = (s) => parseFloat(String(s).trim().replace(',', '.'));

  function renderEmpty() {
    slipRoot().outerHTML = SLIP_EMPTY;
    sel = null; stake = null;
  }

  function renderSel() {
    const one = body(read('fixture-slip-one.html')).replace(/^[\s\S]*?(<sports-betting-slip>)/, '$1')
      .replace(' Canada - Pérou ', ` ${o.event} `)
      .replace('>Canada<', `>${sel.label}<`)
      .replace('Résultat sur la période 30:00 - 34:59', `${sel.market}${sel.window ? ' ' + sel.window : ''}`)
      .replace(/6,50/g, fr(sel.odds))
      .replace('value="0.65"', 'value=""')
      .replace('4,23&nbsp;€', '0,00&nbsp;€')
      .replace(' Parier ', ` ${o.betLabel} `)
      .replace('id="betBtn"', o.betLabelEnabled ? 'id="betBtn"' : 'id="betBtn" disabled');
    slipRoot().outerHTML = one;
    if (o.extraBanner) {
      const a = doc.createElement('betting-slip-alert');
      a.innerHTML = `<div class="alert is-error">${o.extraBanner}</div>`;
      slipRoot().appendChild(a);
    }
    const input = doc.querySelector('input[name=stakeField]');
    // Comme un framework : la propriété d'instance masque le setter natif ; seule la voie native + `input` fonctionne.
    const desc = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value');
    Object.defineProperty(input, 'value', { configurable: true, get() { return desc.get.call(this); }, set() { spy.directAssign += 1; } });
  }

  function update() {
    for (const l of doc.querySelectorAll('betting-slip-footer-odds .btn_label, betting-slip-odds-field .btn_label')) l.textContent = fr(sel.odds);
    const w = stake ? Math.round(stake * sel.odds * 100) / 100 : 0;
    doc.querySelector('.progressiveBettingSlip_footerValue').innerHTML = `${fr(w)}&nbsp;€`;
    const btn = doc.querySelector('#betBtn');
    if ((stake && stake > 0) || o.betLabelEnabled) btn.removeAttribute('disabled'); else btn.setAttribute('disabled', '');
  }

  function addSelection(button) {
    const box = button.closest('.marketBox');
    const line = button.closest('.marketBox_lineSelection');
    const title = box.querySelector('.marketBox_headTitleWrapper').textContent.replace(/\s*\(seule\)\s*$/, '').trim();
    const h = box.querySelector('.marketBox_marketHandler');
    const wm = h && h.textContent.match(/\d+:\d{2} - \d+:\d{2}/);
    sel = { label: line.querySelector('.marketBox_label').textContent.trim(), market: title, window: wm ? wm[0] : null, odds: oddsNum(button.querySelector('.btn_label').textContent) };
    button.classList.add('is-active');
    renderSel();
    update();
  }

  function openModal() {
    const st = o.modalStake !== undefined ? o.modalStake : stake;
    const od = o.modalOdds !== undefined ? o.modalOdds : sel.odds;
    const m = MODAL_TPL.replace(' 0,65&nbsp;€ ', ` ${fr(st)}&nbsp;€ `).replace(' 6,50 ', ` ${fr(od)} `).replace(' 4,23&nbsp;€', ` ${fr(Math.round(st * od * 100) / 100)}&nbsp;€`);
    doc.body.insertAdjacentHTML('beforeend', m);
  }

  if (o.preselected) {
    addSelection(doc.querySelectorAll('sports-tabs-markets[data-section=a] button[data-qa=market-selection]')[1]);
  }

  doc.addEventListener('click', (e) => {
    const t = e.target;
    spy.clicks.push(t.id || t.getAttribute('data-qa') || t.className);
    const odd = t.closest('button[data-qa=market-selection]');
    if (odd) { spy.oddsClicks += 1; if (!odd.disabled && !sel) addSelection(odd); return; }
    if (t.closest('#betBtn')) {
      spy.betBtn += 1;
      if (!t.closest('#betBtn').disabled && !o.noModal) openModal();
      return;
    }
    if (t.closest('.icon_close') || t.querySelector('.icon_close')) { spy.iconClose += 1; renderEmpty(); return; }
    if (t.closest('[data-qa=bet-confirmation-close-selections]')) {
      spy.close += 1; doc.querySelector('.cdk-overlay-container').remove(); renderEmpty(); return;
    }
    if (t.closest('[data-qa=bet-confirmation-keep-selections]')) { spy.keep += 1; doc.querySelector('.cdk-overlay-container').remove(); }
  });

  doc.addEventListener('input', (e) => {
    if (!sel || e.target.name !== 'stakeField') return;
    const v = oddsNum(e.target.value);
    stake = Number.isFinite(v) ? v : null;
    if (o.driftAfterStake !== undefined) sel.odds = o.driftAfterStake;
    if (o.asyncStakeDelayMs !== undefined) {
      // Angular asynchrone : les gains ne suivent qu'après un délai (temps simulé, avancé par advance()).
      const keep = stake; stake = null; update(); stake = keep;
      timers.push({ due: clock + o.asyncStakeDelayMs, fn: update });
    } else update();
  });

  return {
    dom, win, doc, spy,
    setHidden(v) { hidden = v; },
    advance(ms) {
      clock += ms;
      const due = timers.filter((t) => t.due <= clock);
      timers = timers.filter((t) => t.due > clock);
      for (const t of due) if (sel) t.fn();
    },
    setOdds(x) { sel.odds = x; update(); },
    setBetLabel(l) { doc.querySelector('#betBtn .btn_label').textContent = ` ${l} `; },
    addUserSelection() {
      doc.querySelector('.progressiveBettingSlip_headerTitle span').textContent = ' 2 sélections ';
      const card = doc.querySelector('.progressiveBettingSlip_card');
      card.parentNode.appendChild(card.cloneNode(true));
    },
    slipCount: () => parseInt(doc.querySelector('.progressiveBettingSlip_headerTitle').textContent, 10),
  };
}

module.exports = { makeFakeSite };

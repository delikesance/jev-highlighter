/** Scanner de la liste live (spec §2/§3). LECTURE SEULE : aucun clic, aucun événement, aucune écriture. */
(function (root) {
  const Clock = typeof module === 'object' && module.exports
    ? require('./clock')
    : root.JEV && root.JEV.Auto && root.JEV.Auto.Clock;

  const txt = (el) => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();

  function sportOf(el) {
    const icon = el && el.querySelector('[class*="icon_sport_"]');
    const m = icon && icon.className.match(/icon_sport_([a-z0-9_-]+)/i);
    const s = m ? m[1].toLowerCase() : '';
    return s === 'football' || s === 'basketball' ? s : 'other';
  }

  function parseScore(card) {
    const box = card.querySelector('[data-qa="scoreboard-score"]');
    if (!box) return null;
    const a = box.querySelector('.scoreboard_score-1');
    const b = box.querySelector('.scoreboard_score-2');
    if (!a || !b) return null;
    const x = txt(a), y = txt(b);
    if (!/^\d+$/.test(x) || !/^\d+$/.test(y)) return null;
    return [parseInt(x, 10), parseInt(y, 10)];
  }

  function mainSuspended(card) {
    const btns = card.querySelectorAll('sports-default-markets button[bcdkbetbutton]');
    if (!btns.length) return true; // fail-closed : pas de cotes lisibles
    return Array.from(btns).some((b) => {
      if (b.hasAttribute('disabled') || b.classList.contains('is-disabled') || b.classList.contains('is-strikethrough')) return true;
      if (b.querySelector('.is-strikethrough')) return true;
      const odds = txt(b.querySelector('bcdk-bet-button-odds-animated'));
      return odds === '-' || odds === '' || !/\d/.test(odds);
    });
  }

  function scanLive(doc) {
    const out = [];
    doc.querySelectorAll('a[sports-events-event-card]').forEach((card) => {
      const href = card.getAttribute('href');
      if (!href) return;
      const bucket = card.closest('sports-live-event-bucket');
      let sport = sportOf(card.querySelector('.breadcrumb_itemIcon') ? card : null);
      if (sport === 'other' && bucket) sport = sportOf(bucket);
      out.push({
        href,
        name: card.getAttribute('aria-label') || '',
        sport,
        clock: Clock.parseClock(txt(card.querySelector('.event_infoTime'))),
        score: parseScore(card),
        mainSuspended: mainSuspended(card),
        index: out.length
      });
    });
    return out;
  }

  const api = { scanLive };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Scanner = api;
})(globalThis);

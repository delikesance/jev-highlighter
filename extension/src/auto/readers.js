/** Lecteurs DOM (spec §2 bis, §5, §7). LECTURE SEULE : aucun clic, aucun événement, aucune écriture. */
(function (root) {
  const Clock = typeof module === 'object' && module.exports
    ? require('./clock')
    : root.JEV && root.JEV.Auto && root.JEV.Auto.Clock;

  const txt = (el) => (el ? el.textContent : '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = (doc, sel) => doc.querySelector(sel);
  const num = (s) => {
    const m = String(s == null ? '' : s).replace(/[  \s]/g, '').match(/^(\d+(?:[.,]\d+)?)$/);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  };
  const oddsOf = (el) => {
    const m = txt(el).match(/(\d+(?:[.,]\d+)?)/);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  };

  const WINDOW_RE = /\d+:\d{2}\s*[-–—]\s*\d+:\d{2}/;
  const KNOWN_TAGS = new Set(['BCDK-EMPTY-VIEW']);
  const isCard = (el) => /progressiveBettingSlip_card/.test(el.className || '') || el.tagName === 'BETTING-SLIP-SELECTION-CARD';

  function collectUnknown(doc) {
    const out = [];
    const push = (el) => { const t = txt(el); if (t) out.push(t); };
    const content = q(doc, '.progressiveBettingSlip_content');
    if (content) {
      for (const el of content.children) {
        if (KNOWN_TAGS.has(el.tagName) || isCard(el)) continue;
        if (el.tagName === 'BETTING-SLIP-CONTENT') {
          for (const c of el.children) if (!KNOWN_TAGS.has(c.tagName) && !isCard(c)) push(c);
        } else push(el);
      }
    }
    for (const el of doc.querySelectorAll('betting-slip-alert, betting-slip-info-banner, betting-slip-footer-info-banner')) {
      if (el.classList.contains('is-multiboost') || el.querySelector('.is-multiboost')) continue;
      push(el);
    }
    return out;
  }

  function readSlip(doc) {
    const title = txt(q(doc, '.progressiveBettingSlip_headerTitle'));
    const cm = title.match(/^(\d+)\s*s[eé]lection/i);
    const count = cm ? parseInt(cm[1], 10) : null;
    const selEl = q(doc, '.progressiveBettingSlip_cardMarketLabel');
    const mvEl = q(doc, '.progressiveBettingSlip_cardMarketValue');
    const mv = txt(mvEl);
    const wm = mv.match(WINDOW_RE);
    const input = q(doc, 'input[name=stakeField]');
    const sv = input ? String(input.value).trim() : '';
    const btn = q(doc, '[data-qa="betting-slip-bet-button"]') || q(doc, '#betBtn');
    const evEl = q(doc, '.progressiveBettingSlip_cardEventName');
    return {
      count,
      selection: selEl ? txt(selEl) : null,
      market: mvEl ? ((wm ? mv.replace(wm[0], '') : mv).trim() || null) : null,
      window: wm ? Clock.parseWindow(wm[0]) : null,
      event: evEl ? txt(evEl) : null,
      odds: oddsOf(q(doc, 'betting-slip-footer-odds')),
      stake: sv ? num(sv) : null,
      winnings: (() => { const e = q(doc, '.progressiveBettingSlip_footerValue'); return e ? Clock.parseMoney(txt(e)) : null; })(),
      betButton: { present: !!btn, enabled: !!btn && !btn.disabled && !btn.hasAttribute('disabled'), label: btn ? txt(btn) : '' },
      unknown: collectUnknown(doc),
    };
  }

  function readWallet(doc) {
    const spans = doc.querySelectorAll('.header_walletBalance span');
    for (let i = spans.length - 1; i >= 0; i--) {
      const t = txt(spans[i]);
      if (t) return Clock.parseMoney(t);
    }
    return null;
  }

  async function readWalletStable(doc, sleep) {
    const a = readWallet(doc);
    await sleep(300);
    const b = readWallet(doc);
    return a !== null && a === b ? a : null;
  }

  function readConfirmation(doc) {
    const modal = q(doc, 'sports-bet-confirmation-modal');
    const money = (sel) => { const e = q(doc, sel); return e ? Clock.parseMoney(txt(e)) : null; };
    if (!modal) return { open: false, validated: false, stake: null, odds: null, winnings: null };
    return {
      open: true,
      validated: /valid[eé]/i.test(txt(q(doc, '[data-qa="bet-confirmation-title"]'))),
      stake: money('[data-qa="bet-confirmation-stake-amount"] .potentialWinnings_value'),
      odds: oddsOf(q(doc, '[data-qa="bet-confirmation-odds"] .potentialWinnings_value')),
      winnings: money('[data-qa="bet-confirmation-winnings-amount"]'),
    };
  }

  function readMyBets(doc) {
    const m = (card, qa) => { const e = card.querySelector(`[data-qa="${qa}"]`); return e ? Clock.parseMoney(txt(e)) : null; };
    return Array.from(doc.querySelectorAll('bet-card')).map((c) => {
      const cls = c.className || '';
      const tag = txt(c.querySelector('[data-qa="bet-card-status-tag"]'));
      let status = 'ongoing';
      if (/\bis-lost\b/.test(cls) || /perdu/i.test(tag)) status = 'lost';
      else if (/\bis-won\b/.test(cls) || /gagn[eé]/i.test(tag)) status = 'won';
      const ref = c.querySelector('[data-qa="bet-card-reference"]');
      const date = c.querySelector('.betCard_date');
      return {
        id: c.getAttribute('data-qa') || '',
        reference: ref ? txt(ref) || null : null,
        stake: m(c, 'bet-card-stake'),
        winnings: m(c, 'bet-card-winnings'),
        status,
        date: date ? txt(date) || null : null,
      };
    });
  }

  function readTimer(doc) {
    const el = q(doc, 'sports-match-page-desktop .event_infoTime scoreboards-timer') || q(doc, 'scoreboards-timer');
    return Clock.parseClock(el ? txt(el) : '');
  }

  const api = { readSlip, readWallet, readWalletStable, readConfirmation, readMyBets, readTimer };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Readers = api;
})(globalThis);

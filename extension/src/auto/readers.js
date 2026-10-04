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
    const l = el && el.querySelector('.btn_label');
    return l ? num(txt(l)) : null;
  };

  const WINDOW_RE = /\d+:\d{2}\s*[-–—]\s*\d+:\d{2}/;
  // Textes structurels connus, ancrés à leur contexte ET à la forme attendue du texte.
  const ODDS_RE = /^\d+(?:[.,]\d+)?$/;
  const EMPTY_SLIP_COPY = new Set(['Place un nouveau pari', 'On croise les doigts pour toi !']);
  const BOOST_COPY = /^Booste ton pari\s*!?\s*Ajoute (?:une|1) sélection supérieure à 1[,.]20$/i;
  const selectionCount = (t) => /^\d+\s+s[eé]lections?$/i.test(t);
  const fold = (t) => String(t).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const DANGER_COPY = /\b(?:suspendu|indisponible|erreur|refus|impossible|echoue|invalide)\b|\bmodifi|\bcotes?\s+(?:ont\s+)?change|\baccepter les cotes\b/;
  const first = (el, ctx, sel) => { const c = el.closest(ctx); return !!c && c.querySelector(sel) === el; };
  const KNOWN = [
    ['.progressiveBettingSlip_cardEventName .ellipsis', (el) => first(el, '.progressiveBettingSlip_cardEventName', '.ellipsis'), () => true],
    ['.progressiveBettingSlip_headerTitle > span', () => true, selectionCount],
    // Le site rend parfois le compteur sans le <span> habituel (locale anglaise / rendu Angular transitoire).
    ['.progressiveBettingSlip_headerTitle', () => true, selectionCount],
    // Copie informative du ticket VIDE, reconnue textuellement et seulement dans bcdk-empty-view.
    ['bcdk-empty-view *', (el) => !!el.closest('bcdk-empty-view'), (t) => EMPTY_SLIP_COPY.has(t)],
    ['betting-slip-footer *', (el) => !!el.closest('betting-slip-footer'), (t) => t === 'Gains possibles'],
    // Promotion non décisionnelle, admise seulement avec sa formulation exacte dans le bandeau du ticket.
    ['betting-slip-alert, betting-slip-alert *', (el) => !!el.closest('betting-slip-alert'), (t) => BOOST_COPY.test(t)],
    // Angular peut fragmenter ou déplacer ce jeton de devise ; seul le texte EXACT « EUR » est structurel.
    ['sports-betting-slip *', (el) => !!el.closest('sports-betting-slip'), (t) => t === 'EUR'],
    ['.progressiveBettingSlip_cardMarketLabel', () => true, () => true],
    ['.progressiveBettingSlip_cardMarketValue', () => true, () => true],
    ['.progressiveBettingSlip_footerLabel', () => true, () => true],
    ['.progressiveBettingSlip_footerValue', () => true, () => true],
    ['betting-slip-footer-odds .btn_label, betting-slip-odds-field .btn_label', (el) => first(el, 'betting-slip-footer-odds, betting-slip-odds-field', '.btn_label'), (t) => ODDS_RE.test(t)],
    ['betting-slip-footer-odds bcdk-bet-button-odds-animated, betting-slip-odds-field bcdk-bet-button-odds-animated', (el) => first(el, 'betting-slip-footer-odds, betting-slip-odds-field', 'bcdk-bet-button-odds-animated'), (t) => ODDS_RE.test(t)],
    ['#betBtn .btn_label, [data-qa="betting-slip-bet-button"] .btn_label', (el) => first(el, '#betBtn, [data-qa="betting-slip-bet-button"]', '.btn_label'), (t) => t === 'Parier'],
    ['betting-slip-alert .is-multiboost, .alert.is-multiboost', () => true, () => true],
  ];
  const isKnownText = (el, own) => KNOWN.some(([sel, ctx, form]) => el.matches(sel) && ctx(el) && form(own));
  const isActionAlert = (el) => {
    const alert = el.closest('bcdk-alert, .alert');
    if (alert && !alert.classList.contains('is-multiboost')) return true;
    return !!el.closest('betting-slip-alert') && !el.closest('.is-multiboost');
  };

  function collectUnknown(doc) {
    const out = [];
    const slip = q(doc, 'sports-betting-slip');
    if (!slip) return out;
    const walk = (el) => {
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
      own = own.replace(/[\u00a0\u202f\s]+/g, ' ').trim();
      // Les textes décoratifs/promotionnels évoluent souvent. On ne remonte que les alertes explicites
      // ou les formulations dangereuses ; les invariants du ticket restent vérifiés par l'exécuteur.
      if (own && !isKnownText(el, own) && (isActionAlert(el) || DANGER_COPY.test(fold(own)))) out.push(own);
      for (const c of el.children) walk(c);
    };
    for (const c of slip.children) walk(c);
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
    if (doc.querySelectorAll('.header_walletBalance').length > 1) return null;
    for (const sp of doc.querySelectorAll('.header_walletBalance bc-header-animated-balance span')) {
      const t = txt(sp);
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
    const money = (sel) => { const e = q(modal, sel); return e ? Clock.parseMoney(txt(e)) : null; };
    if (!modal) return { open: false, validated: false, stake: null, odds: null, winnings: null };
    return {
      open: true,
      validated: (() => {
        const t = txt(q(modal, '[data-qa="bet-confirmation-title"]'));
        return /\bpari\s+(?:est\s+)?valid[eé](?![a-zà-ÿ])/i.test(t) && !/\b(?:non|in|pas|refus[eé]?|échou[eé]?)\s*-?\s*valid|\binvalid|\brefus|\bpas\s+(?:été\s+)?valid/i.test(t);
      })(),
      stake: money('[data-qa="bet-confirmation-stake-amount"] .potentialWinnings_value'),
      odds: oddsOf(q(modal, '[data-qa="bet-confirmation-odds"] .potentialWinnings_value')),
      winnings: money('[data-qa="bet-confirmation-winnings-amount"]'),
    };
  }

  // status: 'ongoing' (carte non terminée), 'won', 'lost', ou 'unknown' (carte is-ended sans preuve de résultat).
  function readMyBets(doc) {
    const m = (card, qa) => { const e = card.querySelector(`[data-qa="${qa}"]`); return e ? Clock.parseMoney(txt(e)) : null; };
    return Array.from(doc.querySelectorAll('bet-card')).map((c) => {
      const cls = c.className || '';
      const tag = txt(c.querySelector('[data-qa="bet-card-status-tag"]'));
      let status = /\bis-ended\b/.test(cls) ? 'unknown' : 'ongoing';
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
    const el = q(doc, 'sports-match-page-desktop .event_infoTime scoreboards-timer');
    return Clock.parseClock(el ? txt(el) : '');
  }

  const api = { readSlip, readWallet, readWalletStable, readConfirmation, readMyBets, readTimer };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Readers = api;
})(globalThis);

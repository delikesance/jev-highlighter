/**
 * Highlight non destructif : classes CSS sur le bouton + badge adjacent (textContent uniquement).
 * Le contenu d'origine du bouton n'est jamais modifié. Aucun clic, aucune saisie.
 */
(function (root) {
  const J = root.JEV;
  const { log, formatPct } = J;

  const CLS = { rec: 'jev-recommended-bet', best: 'jev-best-bet', anchor: 'jev-anchor', badge: 'jev-badge' };
  /** bouton -> { badge, anchor, anchorAdded, isBest } */
  const active = new Map();

  function makeBadge(rec, isBest) {
    const badge = document.createElement('span');
    badge.className = CLS.badge + (isBest ? ' jev-badge--top' : '');
    badge.setAttribute('role', 'note');
    badge.title = 'Score de préférence JEV — ce n’est pas une probabilité réelle de gain.';

    const star = document.createElement('span');
    star.textContent = isBest ? '★ JEV TOP PICK' : '★ JEV';
    badge.appendChild(star);

    const score = document.createElement('span');
    score.className = 'jev-badge__score';
    score.textContent = formatPct(rec.jevScore);
    badge.appendChild(score);

    if (typeof rec.confidence === 'number') {
      const conf = document.createElement('span');
      conf.className = 'jev-badge__conf';
      conf.textContent = `conf. ${formatPct(rec.confidence)}`;
      badge.appendChild(conf);
    }
    return badge;
  }

  function position(button, badge) {
    // offsets relatifs à l'ancre positionnée (parent du bouton)
    badge.style.top = `${button.offsetTop - 9}px`;
    badge.style.left = `${button.offsetLeft + 6}px`;
  }

  function decorate(rec, isBest) {
    const button = rec.element;
    const anchor = button.parentElement;
    if (!anchor) return;
    let anchorAdded = false;
    if (getComputedStyle(anchor).position === 'static') {
      anchor.classList.add(CLS.anchor);
      anchorAdded = true;
    }
    button.classList.add(CLS.rec);
    if (isBest) button.classList.add(CLS.best);
    const badge = makeBadge(rec, isBest);
    button.insertAdjacentElement('afterend', badge);
    position(button, badge);
    active.set(button, { badge, anchor, anchorAdded, isBest });
    log('Highlighting DOM element');
  }

  function clear() {
    for (const [button, s] of active) {
      button.classList.remove(CLS.rec, CLS.best);
      s.badge.remove();
      if (s.anchorAdded) s.anchor.classList.remove(CLS.anchor);
    }
    active.clear();
    document.querySelectorAll(`.${CLS.badge}`).forEach((n) => n.remove());
  }

  /** Vrai si le DOM affiche déjà exactement ces recommandations (évite re-render + mutations inutiles). */
  function isUpToDate(recs, best) {
    if (active.size !== recs.length) return false;
    return recs.every((r) => {
      const s = active.get(r.element);
      return s && s.badge.isConnected && r.element.isConnected && s.isBest === (r === best);
    });
  }

  function apply(recs, best) {
    clear();
    for (const rec of recs) decorate(rec, rec === best);
  }

  function reposition() {
    for (const [button, s] of active) if (button.isConnected) position(button, s.badge);
  }

  const api = { Highlighter: { apply, clear, isUpToDate, reposition, CLS } };
  Object.assign(root.JEV, api);
})(globalThis);

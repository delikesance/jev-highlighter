/**
 * Highlight non destructif : classes CSS sur le bouton + badge dans un calque fixe (textContent uniquement).
 * Le contenu d'origine du bouton n'est jamais modifié. Aucun clic, aucune saisie.
 */
(function (root) {
  const J = root.JEV;
  const { log, formatPct } = J;

  const CLS = { rec: 'jev-recommended-bet', best: 'jev-best-bet', badge: 'jev-badge', overlay: 'jev-overlay' };
  /** bouton -> { badge, isBest } */
  const active = new Map();
  let overlay = null;

  // Les badges vivent dans un calque global en position:fixed, hors du flux du site :
  // aucun overflow:hidden, grille ou z-index du bookmaker ne peut les masquer ou décaler la mise en page.
  function getOverlay() {
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement('div');
      overlay.className = CLS.overlay;
      document.documentElement.appendChild(overlay);
    }
    return overlay;
  }

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

  /** Place le badge sur le coin haut-gauche du bouton ; le masque si le bouton n'est pas réellement visible. */
  function position(button, badge) {
    const r = button.getBoundingClientRect();
    const inView = r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    let visible = inView;
    if (inView) {
      // masqué si recouvert (header collant) ou rogné par un conteneur scrollable
      const el = document.elementFromPoint(
        Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1),
        Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1)
      );
      visible = !!el && (el === button || button.contains(el) || el.contains(button));
    }
    badge.style.visibility = visible ? 'visible' : 'hidden';
    badge.style.top = `${Math.round(r.top - 9)}px`;
    badge.style.left = `${Math.round(r.left + 6)}px`;
  }

  function decorate(rec, isBest) {
    const button = rec.element;
    button.classList.add(CLS.rec);
    if (isBest) button.classList.add(CLS.best);
    const badge = makeBadge(rec, isBest);
    getOverlay().appendChild(badge);
    position(button, badge);
    active.set(button, { badge, isBest });
    log('Highlighting DOM element');
  }

  function clear() {
    for (const [button, s] of active) {
      button.classList.remove(CLS.rec, CLS.best);
      s.badge.remove();
    }
    active.clear();
    if (overlay) overlay.replaceChildren();
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
    for (const [button, s] of active) {
      if (button.isConnected) position(button, s.badge);
      else s.badge.style.visibility = 'hidden';
    }
  }

  // suivi du scroll (y compris conteneurs internes, en capture) et du redimensionnement
  let raf = 0;
  const schedule = () => {
    if (raf || !active.size) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      reposition();
    });
  };
  addEventListener('scroll', schedule, true);
  addEventListener('resize', schedule);

  const api = { Highlighter: { apply, clear, isUpToDate, reposition, CLS } };
  Object.assign(root.JEV, api);
})(globalThis);

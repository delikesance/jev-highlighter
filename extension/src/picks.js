/**
 * « Sélection du moment » (bloc ajouté au-dessus des marchés) et dock flottant (classement + réglages).
 * Les cartes et lignes font défiler jusqu'à la cote : elles ne cliquent jamais sur le site.
 */
(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const J = isNode ? Object.assign({}, require('./utils')) : root.JEV;
  const { hash } = J;
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const pct = (x) => (isNum(x) ? Math.round(x * 100) : '—');

  /** Classement : score JEV décroissant, à égalité la confidence la plus haute. Exclut les scores inconnus. */
  function rankPicks(recs) {
    return recs
      .filter((r) => isNum(r.jevScore))
      .sort((a, b) => b.jevScore - a.jevScore || (b.confidence ?? 0) - (a.confidence ?? 0));
  }

  if (isNode) {
    module.exports = { rankPicks };
    return;
  }

  const { UI, Highlighter, Storage, formatPct } = J;
  let latest = new Map(); // marketId -> rec (éléments DOM à jour pour les clics)

  // ------------------------------------------------------------------ bloc « Sélection du moment »

  const strip = { host: null, shadow: null, key: '' };

  function removeStrip() {
    if (strip.host) strip.host.remove();
    strip.host = strip.shadow = null;
    strip.key = '';
  }

  function renderStrip({ ranked, best, analysed, anchor }) {
    if (!anchor || !anchor.parentElement || !ranked.length) return removeStrip();
    if (!strip.host || !strip.host.isConnected || strip.host.nextElementSibling !== anchor) {
      if (!strip.host) {
        const { host, shadow } = UI.makeHost('jev-picks');
        host.style.display = 'block';
        host.style.order = '-1000';
        strip.host = host;
        strip.shadow = shadow;
        strip.key = '';
      }
      anchor.parentElement.insertBefore(strip.host, anchor);
    }
    const top = ranked.slice(0, 3);
    const key = hash(JSON.stringify([top.map((r) => [r.marketId, r.choice, r.jevScore, r.oddsText]), analysed, best && best.marketId]));
    if (key === strip.key) return;
    strip.key = key;

    for (const n of [...strip.shadow.children]) if (n.tagName !== 'LINK') n.remove();
    const sec = UI.el('section', 'picks');
    sec.setAttribute('aria-label', 'Sélection JEV');

    const head = UI.el('div', 'picks__head');
    const title = UI.el('div', 'picks__title');
    title.append(UI.el('span', 'pill pill--amber', '★ JEV'), UI.el('span', null, 'Sélection du moment'));
    const meta = UI.el('div', 'picks__meta');
    meta.append(UI.el('span', 'dot'), UI.el('span', null, `${analysed} marchés analysés`));
    head.append(title, meta);
    sec.appendChild(head);

    const grid = UI.el('div', 'picks__grid');
    top.forEach((rec, i) => {
      const isTop = rec === best || (i === 0 && !best);
      const card = UI.el('button', `pick${isTop ? ' pick--top' : ''}`);
      card.type = 'button';
      card.title = 'Aller à ce marché';
      const row = UI.el('div', 'pick__top');
      row.append(UI.el('span', 'pick__tag', isTop ? 'TOP PICK' : `#${i + 1}`), UI.el('b', 'pick__score', pct(rec.jevScore)));
      card.append(
        row,
        UI.el('div', 'pick__choice', rec.choice),
        UI.el('div', 'pick__market', rec.marketTitle),
        UI.el('div', 'pick__odds', rec.oddsText || '—')
      );
      card.addEventListener('click', () => Highlighter.scrollTo(latest.get(rec.marketId)));
      grid.appendChild(card);
    });
    sec.appendChild(grid);
    strip.shadow.appendChild(sec);
  }

  // ------------------------------------------------------------------ dock

  const dock = { node: null, key: '' };

  function removeDock() {
    if (dock.node) dock.node.remove();
    dock.node = null;
    dock.key = '';
  }

  function toggle(label, on, onChange) {
    const row = UI.el('div', 'row');
    const sw = UI.el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!on));
    sw.setAttribute('aria-label', label);
    sw.addEventListener('click', () => onChange(!on));
    row.append(UI.el('span', null, label), sw);
    return row;
  }

  const STATUS = {
    analyzing: 'Analyse en cours…',
    stale: 'La page a changé : relance l’analyse.',
    error: 'Erreur d’analyse.',
    'no-markets': 'Aucun marché détecté.',
    idle: 'Lance « Analyser la page » depuis l’icône de l’extension.',
    done: 'Aucune sélection recommandée.'
  };

  function renderDock({ ranked, best, status, error, settings, hasMarkets }) {
    if (!settings.dockOpen || !hasMarkets) return removeDock();
    const key = hash(JSON.stringify([ranked.slice(0, 4).map((r) => [r.marketId, r.jevScore, r.oddsText]), best && best.marketId, status, error, settings.autoAnalyze, settings.reorderPicks, settings.dockCollapsed]));
    if (key === dock.key && dock.node && dock.node.isConnected) return;
    dock.key = key;
    removeDockNode();

    let node;
    if (settings.dockCollapsed) {
      node = UI.el('button', 'dock-pill');
      node.type = 'button';
      node.setAttribute('aria-label', 'Ouvrir JEV Lens');
      node.append(UI.el('span', null, '★'), UI.el('span', null, `JEV · ${ranked.length}`));
      if (best) node.append(UI.el('span', null, pct(best.jevScore)));
      node.addEventListener('click', () => Storage.setSettings({ dockCollapsed: false }));
    } else {
      node = UI.el('div', 'dock');
      const head = UI.el('div', 'dock__head');
      const title = UI.el('div', 'dock__title');
      title.append(UI.el('span', null, '★ '), document.createTextNode('JEV Lens'));
      const ctl = UI.el('div');
      const min = UI.el('button', 'icon-btn', '–');
      min.type = 'button';
      min.setAttribute('aria-label', 'Réduire');
      min.addEventListener('click', () => Storage.setSettings({ dockCollapsed: true }));
      const close = UI.el('button', 'icon-btn', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Fermer');
      close.addEventListener('click', () => Storage.setSettings({ dockOpen: false }));
      ctl.append(min, close);
      head.append(title, ctl);
      node.appendChild(head);

      const list = UI.el('div', 'dock__list');
      list.appendChild(UI.el('div', 'lab', 'Classement JEV'));
      if (ranked.length) {
        ranked.slice(0, 4).forEach((rec) => {
          const row = UI.el('button', `rank${rec === best ? ' rank--top' : ''}`);
          row.type = 'button';
          row.append(
            UI.el('b', 'mono score', pct(rec.jevScore)),
            UI.el('span', null, rec.choice),
            UI.el('b', 'mono', rec.oddsText || '—')
          );
          row.title = rec.marketTitle;
          row.addEventListener('click', () => Highlighter.scrollTo(latest.get(rec.marketId)));
          list.appendChild(row);
        });
      } else {
        list.appendChild(UI.el('div', 'dock__empty', error || STATUS[status] || STATUS.idle));
      }
      node.appendChild(list);

      const foot = UI.el('div', 'dock__foot');
      foot.append(
        toggle('Analyse automatique', settings.autoAnalyze, (v) => Storage.setSettings({ autoAnalyze: v })),
        toggle('Remonter les picks en tête', settings.reorderPicks, (v) => Storage.setSettings({ reorderPicks: v }))
      );
      node.appendChild(foot);
    }
    UI.getLayer().appendChild(node);
    dock.node = node;
  }
  function removeDockNode() {
    if (dock.node) dock.node.remove();
    dock.node = null;
  }

  /** Point d'entrée unique : met à jour bloc de picks + dock. */
  function render(data) {
    latest = new Map(data.ranked.map((r) => [r.marketId, r]));
    renderStrip(data);
    renderDock(data);
  }

  Object.assign(J, { rankPicks, Picks: { render, removeStrip, removeDock } });
})(globalThis);

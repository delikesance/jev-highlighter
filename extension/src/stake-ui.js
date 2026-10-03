/**
 * Panneau de suggestion de mise, affiché au-dessus du champ de mise dans le calque fixe.
 * Affichage seul : le champ de mise du site n'est jamais modifié. Le bouton « Copier » ne touche
 * que le presse-papiers, sur clic de l'utilisateur.
 */
(function (root) {
  const J = root.JEV;
  const { Highlighter, fmtMoney, formatPct } = J;

  let panel = null;
  let anchor = null;

  function el(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function ensure() {
    if (!panel || !panel.isConnected) {
      panel = el('div', 'jev-stake');
      Highlighter.getOverlay().appendChild(panel);
    }
    return panel;
  }

  function reposition() {
    if (!panel || !panel.isConnected || !anchor || !anchor.isConnected) return hide();
    const r = anchor.getBoundingClientRect();
    const visible = r.width > 0 && r.bottom > 0 && r.top < innerHeight;
    panel.style.visibility = visible ? 'visible' : 'hidden';
    panel.style.left = `${Math.round(r.left)}px`;
    panel.style.bottom = `${Math.round(innerHeight - r.top + 6)}px`;
    panel.style.minWidth = `${Math.round(r.width)}px`;
  }

  function showStatus(message, input, isError) {
    anchor = input;
    const p = ensure();
    p.replaceChildren(el('div', `jev-stake__title${isError ? ' jev-stake__title--err' : ''}`, `★ JEV · ${message}`));
    reposition();
  }

  function show(result, ctx, input) {
    anchor = input;
    const p = ensure();
    p.replaceChildren();
    p.appendChild(el('div', 'jev-stake__title', '★ JEV · mise suggérée'));

    if (result.none) {
      p.appendChild(
        el(
          'div',
          'jev-stake__sub',
          result.reason === 'wallet-too-low' ? 'Solde insuffisant pour une mise.' : 'JEV préfère ne pas miser sur ce pari.'
        )
      );
    } else {
      const row = el('div', 'jev-stake__row');
      row.appendChild(el('span', 'jev-stake__amount', `${fmtMoney(result.amount)} €`));
      const copy = el('button', 'jev-stake__copy', 'Copier');
      copy.type = 'button';
      copy.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(fmtMoney(result.amount));
          copy.textContent = 'Copié';
        } catch {
          copy.textContent = 'Échec';
        }
        setTimeout(() => (copy.textContent = 'Copier'), 1500);
      });
      row.appendChild(copy);
      p.appendChild(row);

      const conf = result.rounds.map((r) => r.confidence).filter((c) => typeof c === 'number');
      const avg = conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null;
      p.appendChild(
        el(
          'div',
          'jev-stake__sub',
          `Gains possibles ${fmtMoney(result.potentialWinnings)} € · cote ${ctx.totalOdds}` +
            ` · affiné en ${result.rounds.length} étape${result.rounds.length > 1 ? 's' : ''}` +
            (avg != null ? ` · conf. ${formatPct(avg)}` : '')
        )
      );
    }
    p.appendChild(el('div', 'jev-stake__note', 'Suggestion du modèle, pas une garantie. Jouez avec modération.'));
    reposition();
  }

  function hide() {
    anchor = null;
    if (panel) panel.remove();
    panel = null;
  }

  let raf = 0;
  const schedule = () => {
    if (raf || !panel) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      reposition();
    });
  };
  addEventListener('scroll', schedule, true);
  addEventListener('resize', schedule);

  Object.assign(J, { StakeUI: { show, showStatus, hide, reposition } });
})(globalThis);

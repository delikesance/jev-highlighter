/**
 * Assistant de mise : module inséré dans le ticket, juste avant le champ de mise.
 * Affichage seul : le champ de mise du site n'est jamais modifié. « Copier » ne touche que le presse-papiers,
 * sur clic de l'utilisateur.
 */
(function (root) {
  const J = root.JEV;
  const { UI, fmtMoney, formatPct } = J;

  let host = null;
  let shadow = null;
  let anchorInput = null;
  let detailOpen = false;
  let lastRender = null;

  function ensureHost(input) {
    anchorInput = input;
    const target = input.closest('betting-slip-footer-stake-input') || input.parentElement;
    if (!target || !target.parentElement) return false;
    if (!host) {
      const made = UI.makeHost('jev-stake');
      host = made.host;
      shadow = made.shadow;
      host.style.display = 'block';
    }
    if (host.nextElementSibling !== target) target.parentElement.insertBefore(host, target);
    return true;
  }

  function reset() {
    for (const n of [...shadow.children]) if (n.tagName !== 'LINK') n.remove();
    const sec = UI.el('section', 'stake');
    shadow.appendChild(sec);
    return sec;
  }

  function showStatus(message, input, isError) {
    if (!ensureHost(input)) return;
    lastRender = null;
    const sec = reset();
    const head = UI.el('div', 'stake__head');
    head.append(UI.el('span', 'pill pill--amber', '★ JEV'), UI.el('span', 'stake__sub', 'Mise suggérée'));
    sec.appendChild(head);
    sec.appendChild(UI.el('div', isError ? 'stake__err' : 'stake__line', message));
  }

  function step(label, round, cols) {
    const wrap = UI.el('div');
    const head = UI.el('div', 'step__head');
    const range = `${fmtMoney(round.lo)} – ${fmtMoney(round.hi)} €`;
    head.append(UI.el('span', null, label), UI.el('span', 'mono', range));
    const grid = UI.el('div', 'cells');
    grid.style.gridTemplateColumns = `repeat(${Math.max(1, round.cells.length)}, 1fr)`;
    round.cells.forEach((_, i) => grid.appendChild(UI.el('div', `cell${i === round.index ? ' cell--on' : ''}`)));
    wrap.append(head, grid);
    return wrap;
  }

  function show(result, ctx, input) {
    lastRender = { result, ctx };
    if (!ensureHost(input)) return;
    const sec = reset();

    const head = UI.el('div', 'stake__head');
    head.append(UI.el('span', 'pill pill--amber', '★ JEV'), UI.el('span', 'stake__sub', 'Mise suggérée'));
    sec.appendChild(head);

    if (result.none) {
      sec.appendChild(
        UI.el('div', 'stake__line', result.reason === 'wallet-too-low' ? 'Solde insuffisant pour une mise.' : 'JEV préfère ne pas miser sur ce pari.')
      );
    } else {
      const amount = UI.el('div', 'stake__amount mono');
      amount.append(document.createTextNode(fmtMoney(result.amount).replace(' ', '')), UI.el('small', null, ' €'));
      sec.appendChild(amount);

      const line = UI.el('div', 'stake__line');
      line.append(document.createTextNode('Gains possibles '), UI.el('b', null, `${fmtMoney(result.potentialWinnings)} €`));
      sec.appendChild(line);

      const actions = UI.el('div', 'stake__actions');
      const copy = UI.el('button', 'jbtn jbtn--primary', `Copier ${fmtMoney(result.amount)}`);
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        const label = copy.textContent;
        try {
          await navigator.clipboard.writeText(fmtMoney(result.amount));
          copy.textContent = 'Copié';
        } catch {
          copy.textContent = 'Échec';
        }
        setTimeout(() => (copy.textContent = label), 1500);
      });
      const more = UI.el('button', 'jbtn jbtn--ghost', detailOpen ? 'Masquer' : 'Détail');
      more.type = 'button';
      more.setAttribute('aria-expanded', String(detailOpen));
      more.addEventListener('click', () => {
        detailOpen = !detailOpen;
        if (lastRender) show(lastRender.result, lastRender.ctx, anchorInput);
      });
      actions.append(copy, more);
      sec.appendChild(actions);

      if (detailOpen) {
        const detail = UI.el('div', 'stake__detail');
        const labels = ['1 · Tranche', '2 · Affinage', '3 · Précision'];
        result.rounds.forEach((r, i) => detail.appendChild(step(labels[i] || `${i + 1}`, r)));
        const conf = result.rounds.map((r) => r.confidence).filter((c) => typeof c === 'number');
        if (conf.length) detail.appendChild(UI.el('div', 'stake__sub', `Confidence moyenne ${formatPct(conf.reduce((a, b) => a + b, 0) / conf.length)}`));
        sec.appendChild(detail);
      }
    }
    sec.appendChild(
      UI.el('div', 'stake__note', 'Tu saisis le montant toi-même : l’extension ne remplit jamais la mise et ne lance aucun pari. Suggestion du modèle, pas une garantie. Joue avec modération.')
    );
  }

  function hide() {
    if (host) host.remove();
    host = shadow = anchorInput = lastRender = null;
  }

  /** Ré-insère le module si la SPA l'a retiré. */
  function reposition() {
    if (host && anchorInput && anchorInput.isConnected) ensureHost(anchorInput);
  }

  Object.assign(J, { StakeUI: { show, showStatus, hide, reposition } });
})(globalThis);

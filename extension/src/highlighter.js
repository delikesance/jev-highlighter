/**
 * Highlight non destructif : anneau (classe CSS) sur le bouton du site + pastille/barre/tooltip dans le calque
 * fixe de l'extension. Le contenu du bouton n'est jamais modifié. Aucun clic, aucune saisie.
 */
(function (root) {
  const J = root.JEV;
  const { log, formatPct, UI } = J;

  const CLS = { rec: 'jev-recommended-bet', best: 'jev-best-bet', pulse: 'jev-pulse' };
  /** bouton -> { chip, bar, rec, isBest } */
  const active = new Map();
  let tip = null;

  const pctNum = (x) => (typeof x === 'number' ? Math.round(x * 100) : '—');

  function buildParts(rec, isBest) {
    const chip = UI.el('div', `chip${isBest ? ' chip--top' : ''}`, isBest ? '★ TOP PICK' : `★ ${pctNum(rec.jevScore)}`);
    chip.setAttribute('role', 'note');
    const bar = UI.el('div', `bar${isBest ? ' bar--top' : ''}`);
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(0, Math.min(100, pctNum(rec.jevScore) || 0))}%`;
    bar.appendChild(fill);
    return { chip, bar };
  }

  /** Visible = dans la fenêtre ET pas recouvert (header collant) ni rogné par un conteneur scrollable. */
  function isReallyVisible(button, r) {
    if (!(r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) return false;
    const el = document.elementFromPoint(
      Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1),
      Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1)
    );
    return !!el && (el === button || button.contains(el) || el.contains(button));
  }

  function position(button, s) {
    const r = button.getBoundingClientRect();
    const vis = isReallyVisible(button, r) ? 'visible' : 'hidden';
    s.chip.style.visibility = s.bar.style.visibility = vis;
    s.chip.style.left = `${Math.round(r.left + 8)}px`;
    s.chip.style.top = `${Math.round(r.top - 12)}px`;
    s.bar.style.left = `${Math.round(r.left + 6)}px`;
    s.bar.style.top = `${Math.round(r.bottom + 8)}px`;
    s.bar.style.width = `${Math.max(0, Math.round(r.width - 12))}px`;
  }

  function decorate(rec, isBest) {
    const button = rec.element;
    button.classList.add(CLS.rec);
    if (isBest) button.classList.add(CLS.best);
    const parts = buildParts(rec, isBest);
    const layer = UI.getLayer();
    layer.append(parts.chip, parts.bar);
    const s = { ...parts, rec, isBest };
    active.set(button, s);
    position(button, s);
    log('Highlighting DOM element');
  }

  function clear() {
    hideTip();
    for (const [button, s] of active) {
      button.classList.remove(CLS.rec, CLS.best, CLS.pulse);
      s.chip.remove();
      s.bar.remove();
    }
    active.clear();
  }

  /** Vrai si le DOM affiche déjà exactement ces recommandations (évite re-render + mutations inutiles). */
  function isUpToDate(recs, best) {
    if (active.size !== recs.length) return false;
    return recs.every((r) => {
      const s = active.get(r.element);
      return s && s.chip.isConnected && r.element.isConnected && s.isBest === (r === best) && s.rec.jevScore === r.jevScore;
    });
  }

  function apply(recs, best) {
    clear();
    for (const rec of recs) decorate(rec, rec === best);
  }

  function reposition() {
    for (const [button, s] of active) {
      if (button.isConnected) position(button, s);
      else s.chip.style.visibility = s.bar.style.visibility = 'hidden';
    }
    hideTip();
  }

  /** '' | 'loading' | 'stale' | 'error' : piloté par CSS sur le calque. */
  function setState(state) {
    UI.getLayer().dataset.state = state || '';
  }

  // ---------------------------------------------------------------- carte de survol

  function hideTip() {
    if (tip) tip.remove();
    tip = null;
  }

  function showTip(button, s) {
    hideTip();
    const rec = s.rec;
    const t = UI.el('div', 'tip');
    const h = UI.el('div', 'tip__h');
    h.append(UI.el('span', null, 'Préférence JEV'));
    if (typeof rec.confidence === 'number') h.append(UI.el('span', 'mono', `conf. ${formatPct(rec.confidence)}`));
    t.appendChild(h);
    const dist = (rec.distribution || []).slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    for (const d of dist) {
      const row = UI.el('div', `tip__row${d.name === rec.choice ? ' tip__row--top' : ' tip__row--lo'}`);
      const b = document.createElement('b');
      b.append(UI.el('span', null, d.name), UI.el('span', 'mono', pctNum(d.score)));
      const track = UI.el('div', 'tip__track');
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(0, Math.min(100, pctNum(d.score) || 0))}%`;
      track.appendChild(fill);
      row.append(b, track);
      t.appendChild(row);
    }
    t.appendChild(UI.el('div', 'tip__f', 'Poids donné par le modèle, pas une probabilité réelle de gain.'));
    UI.getLayer().appendChild(t);

    const r = button.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left + r.width / 2 - 122), innerWidth - 252);
    let top = r.top - t.offsetHeight - 14;
    if (top < 8) top = r.bottom + 22;
    t.style.left = `${Math.round(left)}px`;
    t.style.top = `${Math.round(top)}px`;
    tip = t;
  }

  function findActive(node) {
    if (!(node instanceof Element)) return null;
    for (const [button, s] of active) if (button === node || button.contains(node)) return { button, s };
    return null;
  }
  document.addEventListener('mouseover', (e) => {
    const hit = findActive(e.target);
    if (hit) showTip(hit.button, hit.s);
  }, true);
  document.addEventListener('mouseout', (e) => {
    if (!findActive(e.relatedTarget)) hideTip();
  }, true);
  addEventListener('scroll', hideTip, true);

  // ---------------------------------------------------------------- suivi scroll/resize + navigation vers un pick

  let raf = 0;
  const schedule = () => {
    if (raf || !active.size) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      for (const [button, s] of active) if (button.isConnected) position(button, s);
    });
  };
  addEventListener('scroll', schedule, true);
  addEventListener('resize', schedule);

  /** Fait défiler jusqu'à la cote recommandée et la fait pulser. Ne clique JAMAIS dessus. */
  function scrollTo(rec) {
    const button = rec && rec.element;
    if (!button || !button.isConnected) return;
    button.scrollIntoView({ block: 'center', behavior: 'smooth' });
    button.classList.add(CLS.pulse);
    setTimeout(() => button.classList.remove(CLS.pulse), 1600);
  }

  Object.assign(J, { Highlighter: { apply, clear, isUpToDate, reposition, setState, scrollTo, CLS } });
})(globalThis);

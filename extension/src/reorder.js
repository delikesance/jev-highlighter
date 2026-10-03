/**
 * « Remonter les picks en tête » : réordonnancement VISUEL des marchés via CSS `order`.
 * Les nœuds ne sont jamais déplacés dans le DOM (la SPA du site reste intacte) ; tout est réversible.
 */
(function (root) {
  const J = root.JEV;
  const { CONFIG, log, UI } = J;
  const saved = new Map(); // élément -> ancien style.order
  let parentSaved = null;

  function restoreOrder() {
    for (const [el, v] of saved) el.style.order = v;
    saved.clear();
    if (parentSaved) {
      parentSaved.parent.style.display = parentSaved.display;
      parentSaved.parent.style.flexDirection = parentSaved.dir;
      parentSaved = null;
    }
  }

  /**
   * @param {HTMLElement[]} containers conteneurs de marchés, meilleurs en premier
   * @returns {boolean} true si appliqué
   */
  function applyOrder(containers) {
    restoreOrder();
    if (!containers.length) return false;
    const parent = containers[0].parentElement;
    if (!parent || containers.some((c) => c.parentElement !== parent)) {
      log('Reorder skipped: markets do not share a parent');
      return false;
    }
    if (!/flex|grid/.test(getComputedStyle(parent).display)) {
      // Parent en bloc : on ne le passe en flex colonne que s'il ne contient QUE des marchés (et nos hôtes).
      const onlyMarkets = [...parent.children].every((ch) => UI.isHostNode(ch) || ch.matches(CONFIG.selectors.market));
      if (!onlyMarkets) {
        log('Reorder skipped: parent is not flex/grid and holds other elements');
        return false;
      }
      parentSaved = { parent, display: parent.style.display, dir: parent.style.flexDirection };
      parent.style.display = 'flex';
      parent.style.flexDirection = 'column';
    }
    containers.forEach((c, i) => {
      saved.set(c, c.style.order);
      c.style.order = String(-500 + i);
    });
    return true;
  }

  Object.assign(J, { Reorder: { applyOrder, restoreOrder } });
})(globalThis);

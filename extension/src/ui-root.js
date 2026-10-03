/**
 * Hôtes Shadow DOM : toute l'UI de l'extension y vit, isolée du CSS du site (et inversement).
 * Seuls textContent / createElement sont utilisés : jamais de HTML construit à partir de chaînes.
 */
(function (root) {
  const J = root.JEV;
  const CSS_URL = chrome.runtime.getURL('styles/lens.css');
  const HOST_ATTR = 'data-jev-host';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** @returns {{host: HTMLElement, shadow: ShadowRoot}} hôte non inséré, feuille lens.css chargée. */
  function makeHost(tagName) {
    const host = document.createElement(tagName);
    host.setAttribute(HOST_ATTR, '');
    const shadow = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_URL;
    shadow.appendChild(link);
    return { host, shadow };
  }

  let overlay = null;
  /** Calque fixe plein écran (marqueurs, tooltip, dock). */
  function getLayer() {
    if (!overlay || !overlay.host.isConnected) {
      const { host, shadow } = makeHost('jev-lens');
      const layer = el('div', 'layer');
      shadow.appendChild(layer);
      document.documentElement.appendChild(host);
      overlay = { host, layer };
    }
    return overlay.layer;
  }

  const isHostNode = (n) => !!n && n.nodeType === 1 && n.hasAttribute(HOST_ATTR);

  Object.assign(J, { UI: { el, makeHost, getLayer, isHostNode, HOST_ATTR } });
})(globalThis);

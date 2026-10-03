(function (root) {
  const PREFIX = '[JEV]';
  const flags = { debug: false };

  function setDebug(v) {
    flags.debug = !!v;
  }
  function log(...args) {
    if (flags.debug) console.log(PREFIX, ...args);
  }
  function warn(...args) {
    if (flags.debug) console.warn(PREFIX, ...args);
  }
  function error(...args) {
    console.error(PREFIX, ...args);
  }

  /** Texte pour l'affichage : espaces normalisés, valeur originale conservée ailleurs. */
  function cleanText(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  /** Texte pour la comparaison : trim, minuscules, espaces, apostrophes, tirets, accents, Unicode. */
  function normalizeText(text) {
    return String(text == null ? '' : text)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[‘’‛ʼ`´]/g, "'")
      .replace(/[‐-―−]/g, '-')
      .replace(/[​-‍﻿]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function slugify(text) {
    const s = normalizeText(text)
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80)
      .replace(/_+$/g, '');
    return s || 'market';
  }

  /** FNV-1a 32 bits -> hex. Suffisant pour une empreinte de changement (non cryptographique). */
  function hash(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /** "1,20" -> 1.2 ; "1 200,50" -> 1200.5 ; sinon null. */
  function parseOdds(text) {
    const t = cleanText(text).replace(/(\d)\s+(?=\d)/g, '$1');
    const m = t.match(/\d+(?:[.,]\d+)?/);
    if (!m) return null;
    const n = Number(m[0].replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function debounce(fn, ms) {
    let t = null;
    const d = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
    d.cancel = () => clearTimeout(t);
    return d;
  }

  function formatPct(x) {
    return typeof x === 'number' && Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—';
  }

  const api = { setDebug, log, warn, error, cleanText, normalizeText, slugify, hash, parseOdds, debounce, formatPct };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign((root.JEV = root.JEV || {}), api);
})(globalThis);

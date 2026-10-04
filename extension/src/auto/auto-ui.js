/**
 * Panneau du mode Auto (spec §6) : état, journal, solde, bilan, STOP, armement.
 * Hôte Shadow DOM `jev-auto` (même technique que ui-root.js). Tout texte via textContent : jamais de HTML construit.
 * Ce module ne clique jamais et ne déclenche aucun évènement : il n'écoute que l'utilisateur.
 */
(function (root) {
  const HOST_ATTR = 'data-jev-host';
  const PHRASE = 'PARIER AUTO';
  const MAX_LOG = 50;
  const CSS = [
    ':host{all:initial}',
    '.p{position:fixed;left:12px;bottom:12px;z-index:2147483646;width:300px;max-height:70vh;overflow:auto;',
    'background:#111;color:#eee;font:12px/1.4 system-ui,sans-serif;border:2px solid #d33;border-radius:8px;padding:8px}',
    '.h{font-weight:700;color:#f66;margin-bottom:4px}',
    '.stop{width:100%;padding:8px;font-weight:700;background:#d33;color:#fff;border:0;border-radius:6px;cursor:pointer;margin:4px 0}',
    '.row{display:block;margin:3px 0}',
    '.err{color:#f88}',
    '.log{font:11px/1.3 ui-monospace,monospace;background:#000;padding:4px;max-height:160px;overflow:auto;white-space:pre-wrap}',
    'input[type=text]{width:100%;box-sizing:border-box}'
  ].join('');

  const money = (x) => (typeof x === 'number' && Number.isFinite(x) ? `${x.toFixed(2).replace('.', ',')} €` : '—');

  function mount(controller, opts) {
    const o = opts || {};
    const doc = o.doc || root.document;
    const mk = (tag, attrs, text) => {
      const n = doc.createElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
      if (text != null) n.textContent = text;
      return n;
    };

    const host = doc.createElement('jev-auto');
    host.setAttribute(HOST_ATTR, '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(mk('style', null, CSS));
    const panel = mk('div', { class: 'p' });
    shadow.appendChild(panel);

    panel.appendChild(mk('div', { class: 'h' }, 'JEV — mode Auto'));
    const phase = mk('div', { 'data-k': 'phase' }, 'Phase : —');
    const msg = mk('div', { 'data-k': 'msg' });
    const balance = mk('div', { 'data-k': 'balance' }, 'Solde : —');
    const summary = mk('div', { 'data-k': 'summary' }, 'Bilan : —');
    const stopBtn = mk('button', { class: 'stop', 'data-k': 'stop', type: 'button' }, 'STOP');
    panel.append(phase, msg, balance, summary, stopBtn);

    const phraseIn = mk('input', { type: 'text', 'data-k': 'phrase', placeholder: `Phrase d'armement : ${PHRASE}`, autocomplete: 'off' });
    const dry = mk('input', { type: 'checkbox', 'data-k': 'dry' });
    dry.checked = true; // première session à blanc par défaut
    const noManual = mk('input', { type: 'checkbox', 'data-k': 'nomanual' });
    noManual.checked = false;
    const dryRow = mk('label', { class: 'row' });
    dryRow.append(dry, doc.createTextNode(' À blanc (aucun pari réel)'));
    const nmRow = mk('label', { class: 'row' });
    nmRow.append(noManual, doc.createTextNode(' Je confirme : aucun pari manuel pendant la session'));
    const armBtn = mk('button', { type: 'button', 'data-k': 'arm' }, 'Armer');
    const err = mk('div', { class: 'err', 'data-k': 'err' });
    const logBox = mk('div', { class: 'log', 'data-k': 'log' });
    panel.append(phraseIn, dryRow, nmRow, armBtn, err, logBox);

    const safe = (fn) => Promise.resolve().then(fn).catch((e) => addLog(`erreur : ${(e && e.message) || e}`));

    function addLog(line) {
      const t = new Date();
      const hh = [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
      logBox.appendChild(mk('div', null, `${hh} ${String(line)}`));
      while (logBox.childNodes.length > MAX_LOG) logBox.removeChild(logBox.firstChild);
      logBox.scrollTop = logBox.scrollHeight;
    }

    function refresh(state) {
      const s = state || {};
      phase.textContent = `Phase : ${s.phase || 'IDLE'}${s.dryRun ? ' (à blanc)' : s.phase && s.phase !== 'IDLE' && s.phase !== 'STOPPED' ? ' (RÉEL)' : ''}`;
      msg.textContent = s.message || s.reason || '';
      balance.textContent = `Solde : ${money(s.balance)}`;
      const g = s.guardSnap || {};
      const start = s.session && s.session.startBalance;
      const loss = typeof start === 'number' && typeof s.balance === 'number' ? Math.max(0, start - s.balance) : null;
      const placed = Number.isInteger(g.placed) ? g.placed : Array.isArray(s.bets) ? s.bets.length : 0;
      summary.textContent = `Bilan : ${placed} pari(s) placé(s) · ${g.consecutiveLosses || 0} défaite(s) d'affilée · perte ${money(loss)}`;
    }

    stopBtn.addEventListener('click', () => safe(() => controller.stop('STOP bouton')));
    armBtn.addEventListener('click', () => safe(async () => {
      err.textContent = '';
      if (phraseIn.value !== PHRASE) { err.textContent = `Phrase incorrecte : tapez exactement « ${PHRASE} ».`; return; }
      if (!noManual.checked) { err.textContent = 'Cochez « aucun pari manuel pendant la session ».'; return; }
      await controller.arm(phraseIn.value, { dryRun: !!dry.checked, noManualBets: true });
    }));
    const onKey = (e) => { if (e.key === 'Escape') safe(() => controller.stop('Échap')); };
    doc.addEventListener('keydown', onKey, true);

    doc.documentElement.appendChild(host);
    if (typeof o.getStatus === 'function') safe(async () => refresh(await o.getStatus()));

    function unmount() {
      doc.removeEventListener('keydown', onKey, true);
      host.remove();
    }
    return { unmount, addLog, refresh };
  }

  const api = { mount, PHRASE };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).UI = api;
})(globalThis);

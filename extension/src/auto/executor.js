/**
 * Exécuteur de pari (spec §3 ter, §5, §5 bis). SEUL module autorisé à cliquer / saisir / valider.
 * Fail-closed : toute vérification en échec, toute exception, tout doute => ARRÊT (halt), jamais de relance.
 */
(function (root) {
  const Clock = typeof module === 'object' && module.exports
    ? require('./clock')
    : root.JEV && root.JEV.Auto && root.JEV.Auto.Clock;

  const norm = (s) => String(s == null ? '' : s).replace(/[  \s]+/g, ' ').trim().toLowerCase();
  // Le ticket affiche le titre du marché sans son suffixe entre parenthèses (« (seule) ») : comparaison sans ce suffixe.
  const baseTitle = (s) => norm(s).replace(/\s*\([^()]*\)\s*$/, '');
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const sameWin = (a, b) => (a === null && b === null) || (!!a && !!b && a.startSec === b.startSec && a.endSec === b.endSec);
  const driftPct = (odds, ref) => (Math.abs(odds - ref) / ref) * 100;
  const MAX_LOG = 500;

  class Halt extends Error {}

  /**
   * Contrat SessionStore : get() → état ({ stopped, reason, pending, lastPlaced, … }) ; set(patch) fusionne ;
   * stopFlag() → vrai si STOP/Échap a été demandé OU si state.stopped est vrai (ARRÊT collant).
   */
  function createExecutor(deps) {
    const { doc, readers, guard, store, sleep, now, cfg } = deps;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const view = doc.defaultView;
    const slipWaitMs = num(cfg.slipWaitMs) ? cfg.slipWaitMs : 3000;
    const pollMs = num(cfg.pollMs) ? cfg.pollMs : 250;
    let inProgress = false;

    const visible = () => doc.visibilityState === 'visible';
    const fail = (reason) => { throw new Halt(reason); };

    async function waitVisible() {
      const t0 = now();
      while (!visible()) {
        if (now() - t0 > cfg.hiddenTabMs) return false;
        await sleep(pollMs);
      }
      return true;
    }

    // Le seul point de clic. Jamais en onglet masqué.
    function click(el) {
      if (!visible()) fail('onglet masqué au moment du clic');
      el.click();
    }

    async function stopCheck(step) {
      if (await store.stopFlag()) fail(`STOP levé avant l'étape ${step}`);
    }

    function findOddsButton(d) {
      const wantWin = d.window === null ? null : Clock.parseWindow(d.window);
      if (d.window !== null && !wantWin) fail('fenêtre de la décision illisible');
      const found = [];
      for (const box of doc.querySelectorAll('.marketBox')) {
        const t = box.querySelector('h2[data-qa=market-title] .marketBox_headTitleWrapper');
        if (!t || norm(t.textContent) !== norm(d.marketTitle)) continue;
        const h = box.querySelector('.marketBox_marketHandler');
        const hText = h ? h.textContent : '';
        if ((hText.match(/\d+:\d{2}\s*[-–—]\s*\d+:\d{2}/g) || []).length > 1) continue;
        const win = h ? Clock.parseWindow(hText) : null;
        if (!sameWin(win, wantWin)) continue;
        for (const line of box.querySelectorAll('.marketBox_lineSelection')) {
          const lab = line.querySelector('p.marketBox_label');
          const btns = line.querySelectorAll('button[data-qa=market-selection]');
          if (lab && btns.length === 1 && norm(lab.textContent) === norm(d.label)) found.push(btns[0]);
        }
      }
      if (found.length === 0) fail('marché/sélection introuvable sur la page');
      if (found.length > 1) fail(`marché ambigu (${found.length} correspondances)`);
      return found[0];
    }

    const btnOdds = (b) => {
      const l = b.querySelector('.btn_label');
      const m = l && l.textContent.replace(/[  \s]/g, '').match(/^(\d+(?:[.,]\d+)?)$/);
      return m ? parseFloat(m[1].replace(',', '.')) : null;
    };
    const isSuspended = (b) => !b || !b.isConnected || b.disabled || b.hasAttribute('disabled') ||
      b.classList.contains('is-strikethrough') || !!b.querySelector('.is-strikethrough') || btnOdds(b) === null;

    // Le bouton de validation : UN seul nœud dans tout le document, situé dans le ticket. On lit et on clique CE nœud.
    function betButtonNode() {
      const all = new Set(doc.querySelectorAll('#betBtn, [data-qa="betting-slip-bet-button"]'));
      if (all.size !== 1) fail(`bouton de validation : ${all.size} candidats au lieu d'un`);
      const b = all.values().next().value;
      if (!b.closest('sports-betting-slip')) fail('bouton de validation hors du ticket');
      return b;
    }
    const labelOf = (b) => b.textContent.replace(/[  \s]+/g, ' ').trim();
    const enabled = (b) => !b.disabled && !b.hasAttribute('disabled');

    function lead(d) {
      const win = d.window === null ? null : Clock.parseWindow(d.window);
      return Clock.leadSeconds(readers.readTimer(doc), win);
    }

    // Ticket : libellé du bouton, éléments inconnus, carte identique à la décision, dérive ; avec `stake` : mise et gains.
    function checkSlip(d, s, stake) {
      if (s.count !== 1) fail(`ticket : ${s.count} sélection(s) au lieu d'une`);
      const b = betButtonNode();
      if (labelOf(b) !== 'Parier') fail(`libellé de #betBtn inattendu : « ${labelOf(b)} »`);
      if (s.unknown.length) fail('élément inconnu dans le ticket : ' + s.unknown.join(' | '));
      if (norm(s.selection) !== norm(d.label)) fail('sélection du ticket différente');
      if (norm(s.market) !== baseTitle(d.marketTitle)) fail('marché du ticket différent');
      const want = d.window === null ? null : Clock.parseWindow(d.window);
      if (!sameWin(s.window, want)) fail('fenêtre du ticket différente');
      if (norm(s.event) !== norm(d.event)) fail('événement du ticket différent');
      if (!num(s.odds)) fail('cote du ticket illisible (suspendu ?)');
      if (driftPct(s.odds, d.analysedOdds) > cfg.maxDriftPct) fail(`dérive de cote ${s.odds} vs ${d.analysedOdds}`);
      if (stake !== undefined) {
        if (!stakeShown(s, stake)) fail('mise ou gains du ticket ≠ mise × cote');
      }
      return b;
    }
    const stakeShown = (s, stake) => num(s.stake) && Math.abs(s.stake - stake) <= 0.001 &&
      num(s.odds) && num(s.winnings) && Math.abs(s.winnings - stake * s.odds) <= 0.01;

    function setStake(value) {
      const input = doc.querySelector('sports-betting-slip input[name=stakeField]');
      if (!input) fail('champ de mise absent');
      const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value').set;
      if (!visible()) fail('onglet masqué au moment de la saisie');
      setter.call(input, value.toFixed(2));
      input.dispatchEvent(new view.Event('input', { bubbles: true }));
    }

    // Ne retire que NOTRE sélection : une seule carte, identique à la décision. Sinon rien (journalisé).
    function removeOurSelection(d) {
      const s = readers.readSlip(doc);
      if (s.count === 0) return true;
      const want = d.window === null ? null : Clock.parseWindow(d.window);
      if (s.count !== 1 || norm(s.selection) !== norm(d.label) || norm(s.market) !== baseTitle(d.marketTitle) || !sameWin(s.window, want)) {
        log('retrait refusé : la carte du ticket n\'est pas (seulement) la nôtre', { count: s.count, selection: s.selection });
        return false;
      }
      const icon = doc.querySelector('sports-betting-slip .progressiveBettingSlip_card .icon_close');
      if (!icon || !visible()) return false;
      (icon.closest('button') || icon).click();
      return readers.readSlip(doc).count === 0;
    }

    async function place(d) {
      if (inProgress) return { status: 'refused', reason: 'busy' };
      inProgress = true;
      try { return await run(d); } finally { inProgress = false; }
    }

    async function run(d) {
      const ctx = { ours: false, betClicked: false, reserved: null, pending: false };
      const halt = async (reason) => {
        let removed = null;
        if (ctx.ours && !ctx.betClicked) {
          try { removed = removeOurSelection(d); } catch (e) { removed = false; }
        }
        if (!ctx.betClicked) {
          // Aucun clic de validation : rien n'est engagé, on annule réserve et « validation en cours ».
          if (ctx.reserved !== null) guard.release(ctx.reserved, true);
          if (ctx.pending) { try { await store.set({ pending: null }); } catch (e) { log('halt: effacement de pending impossible', String(e)); } }
        }
        const slipEl = doc.querySelector('sports-betting-slip');
        let unknown = null;
        try { unknown = readers.readSlip(doc).unknown; } catch (e) { /* journal seulement */ }
        const slip = slipEl ? slipEl.textContent.replace(/\s+/g, ' ').trim().slice(0, MAX_LOG) : null;
        log('halt', { reason, removed, betClicked: ctx.betClicked, slip, unknown });
        try { await store.set({ stopped: true, reason }); } catch (e) { log('halt: écriture du STOP impossible', String(e)); }
        return { status: 'halt', reason };
      };

      try {
        if (!d || typeof d !== 'object') fail('décision absente');
        if (typeof d.marketTitle !== 'string' || typeof d.label !== 'string' || typeof d.event !== 'string') fail('décision incomplète');
        if (!(d.window === null || typeof d.window === 'string')) fail('fenêtre de la décision invalide');
        if (!num(d.analysedOdds) || d.analysedOdds <= 0 || !num(d.suggestedStake) || !num(d.confidence)) fail('décision : nombres invalides');
        if (typeof d.dryRun !== 'boolean') fail('décision : dryRun requis');

        // 1. Préconditions
        await stopCheck(1);
        const st = (await store.get()) || {};
        if (st.stopped) fail('session arrêtée (ARRÊT collant)');
        if (st.pending) fail('pari incertain non résolu (« validation en cours ») : vérification manuelle requise');
        if (!(await waitVisible())) fail('onglet masqué trop longtemps');
        const s0 = readers.readSlip(doc);
        if (s0.count !== 0) fail('ticket non vide au départ : vide-le toi-même');
        if (s0.unknown.length) fail('élément inconnu dans le ticket : ' + s0.unknown.join(' | '));
        const balance = await readers.readWalletStable(doc, sleep);
        if (!num(balance)) fail('solde illisible');
        const btn = findOddsButton(d);
        if (isSuspended(btn)) fail('marché suspendu');
        const stake = guard.maxStake(d.suggestedStake);
        const proposal = (odds, bal) => ({ balance: bal, stake, odds, analysedOdds: d.analysedOdds, suspended: false, leadSec: lead(d), confidence: d.confidence });
        const pre = guard.check(proposal(btnOdds(btn), balance));
        if (!pre || pre.verdict !== 'OUI') {
          if (!pre || pre.verdict === 'ARRET') fail(pre ? pre.reason : 'guard muet');
          log('refused', pre.reason);
          return { status: 'refused', reason: pre.reason };
        }

        // 2. Clic sur la cote, carte du ticket
        await stopCheck(2);
        if (!(await waitVisible())) fail('onglet masqué trop longtemps');
        if (isSuspended(btn) || readers.readSlip(doc).count !== 0) fail('état changé avant le clic sur la cote');
        click(btn);
        ctx.ours = true;
        let s = readers.readSlip(doc);
        for (const t0 = now(); s.count !== 1 && now() - t0 < slipWaitMs; s = readers.readSlip(doc)) await sleep(pollMs);
        checkSlip(d, s);

        // 3. Mise (Angular asynchrone : on attend que mise et gains reflètent la saisie)
        await stopCheck(3);
        setStake(stake);
        s = readers.readSlip(doc);
        for (const t0 = now(); !stakeShown(s, stake); s = readers.readSlip(doc)) {
          if (now() - t0 >= slipWaitMs) fail('ticket non mis à jour après la saisie de la mise');
          await sleep(pollMs);
        }
        checkSlip(d, s, stake); // cote relue après la saisie (dérive)

        // 4. Mode à blanc
        if (d.dryRun) {
          if (!removeOurSelection(d)) fail('mode à blanc : retrait de la sélection impossible');
          log('dry', { marketTitle: d.marketTitle, window: d.window, label: d.label, stake, odds: s.odds });
          return { status: 'dry', reason: 'mode à blanc', stake, odds: s.odds };
        }

        // 5–6. « Validation en cours » + réserve D'ABORD, puis STOP, solde frais, puis relecture finale SYNCHRONE et clic sans await.
        await stopCheck(5);
        if (!(await waitVisible())) fail('onglet masqué trop longtemps');
        checkSlip(d, readers.readSlip(doc), stake);
        await store.set({ pending: { marketTitle: d.marketTitle, window: d.window, stake, odds: s.odds, at: now() } });
        ctx.pending = true;
        guard.reserve(stake);
        ctx.reserved = stake;
        await stopCheck(6);
        const freshBalance = await readers.readWalletStable(doc, sleep);
        // ---- aucun await à partir d'ici jusqu'au clic ----
        if (!num(freshBalance)) fail('solde illisible (relecture finale)');
        if (!visible()) fail('onglet masqué avant le clic');
        s = readers.readSlip(doc);
        const betBtn = checkSlip(d, s, stake);
        if (!enabled(betBtn)) fail('#betBtn désactivé');
        if (isSuspended(btn)) fail('marché suspendu');
        const odds = s.odds;
        // la réserve de CE pari est retirée le temps du contrôle (synchrone) pour ne pas compter sa mise deux fois
        guard.release(stake, true);
        const fin = guard.check(proposal(odds, freshBalance));
        guard.reserve(stake);
        if (!fin || fin.verdict !== 'OUI') fail('guard (relecture finale) : ' + (fin ? fin.reason : 'muet'));
        ctx.betClicked = true;
        click(betBtn);
        // ---- fin de la section synchrone ----

        let conf = readers.readConfirmation(doc);
        for (const t0 = now(); !conf.validated && now() - t0 < cfg.confirmTimeoutMs; conf = readers.readConfirmation(doc)) await sleep(pollMs);
        if (!conf.validated) fail('pas de confirmation « validé » dans le délai');
        if (!num(conf.stake) || Math.abs(conf.stake - stake) > 0.001) fail(`mise de la confirmation ${conf.stake} ≠ ${stake}`);
        if (!num(conf.odds) || Math.abs(conf.odds - odds) > 0.001) fail(`cote de la confirmation ${conf.odds} ≠ ${odds}`);

        guard.recordPlaced();
        const close = doc.querySelector('sports-bet-confirmation-modal [data-qa="bet-confirmation-close-selections"]');
        if (close && visible()) click(close);
        else log('fermeture de la modale non faite', { present: !!close });
        const lastPlaced = { marketTitle: d.marketTitle, window: d.window, label: d.label, event: d.event, stake, odds, at: now() };
        await store.set({ pending: null, lastPlaced });
        log('placed', lastPlaced);
        return { status: 'placed', reason: 'ok', stake, odds };
      } catch (e) {
        return halt(e instanceof Halt ? e.message : 'exception : ' + (e && e.message ? e.message : String(e)));
      }
    }

    return { place };
  }
  const api = { createExecutor };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else ((root.JEV = root.JEV || {}).Auto = root.JEV.Auto || {}).Executor = api;
})(globalThis);

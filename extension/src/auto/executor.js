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
  const POLL_MS = 200;
  const SLIP_WAIT_MS = 3000;

  class Halt extends Error {}

  function createExecutor(deps) {
    const { doc, readers, guard, store, sleep, now, cfg } = deps;
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const view = doc.defaultView;

    const visible = () => doc.visibilityState === 'visible';
    const fail = (reason) => { throw new Halt(reason); };

    async function waitVisible() {
      const t0 = now();
      while (!visible()) {
        if (now() - t0 > cfg.hiddenTabMs) return false;
        await sleep(250);
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

    function lead(d) {
      const win = d.window === null ? null : Clock.parseWindow(d.window);
      return Clock.leadSeconds(readers.readTimer(doc), win);
    }

    // Carte du ticket : sélection, marché, fenêtre, événement identiques à la décision ; aucun élément inconnu.
    function verifyCard(d, s) {
      if (s.count !== 1) fail(`ticket : ${s.count} sélection(s) au lieu d'une`);
      if (s.unknown.length) fail('élément inconnu dans le ticket : ' + s.unknown.join(' | '));
      if (norm(s.selection) !== norm(d.label)) fail('sélection du ticket différente');
      if (baseTitle(s.market) !== baseTitle(d.marketTitle)) fail('marché du ticket différent');
      const want = d.window === null ? null : Clock.parseWindow(d.window);
      if (!sameWin(s.window, want)) fail('fenêtre du ticket différente');
      if (norm(s.event) !== norm(d.event)) fail('événement du ticket différent');
      if (!num(s.odds)) fail('cote du ticket illisible (suspendu ?)');
      if (driftPct(s.odds, d.analysedOdds) > cfg.maxDriftPct) fail(`dérive de cote ${s.odds} vs ${d.analysedOdds}`);
    }

    function checkGuard(p) {
      const v = guard.check(p);
      return v && v.verdict === 'OUI' ? null : v;
    }

    function setStake(value) {
      const input = doc.querySelector('sports-betting-slip input[name=stakeField]');
      if (!input) fail('champ de mise absent');
      const setter = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value').set;
      if (!visible()) fail('onglet masqué au moment de la saisie');
      setter.call(input, value.toFixed(2));
      input.dispatchEvent(new view.Event('input', { bubbles: true }));
    }

    function removeOurSelection() {
      const s = readers.readSlip(doc);
      if (s.count === 0) return true;
      const icon = doc.querySelector('sports-betting-slip .progressiveBettingSlip_card .icon_close');
      if (!icon || !visible()) return false;
      (icon.closest('button') || icon).click();
      return readers.readSlip(doc).count === 0;
    }

    async function place(d) {
      const ctx = { ours: false, betClicked: false, reserved: null };
      const halt = async (reason) => {
        let removed = null;
        if (ctx.ours && !ctx.betClicked) {
          try { removed = removeOurSelection(); } catch (e) { removed = false; }
        }
        if (ctx.reserved !== null && !ctx.betClicked) guard.release(ctx.reserved, true);
        const slipEl = doc.querySelector('sports-betting-slip');
        let unknown = null;
        try { unknown = readers.readSlip(doc).unknown; } catch (e) { /* journal seulement */ }
        log('halt', { reason, removed, betClicked: ctx.betClicked, slip: slipEl ? slipEl.textContent.replace(/\s+/g, ' ').trim() : null, unknown });
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
        if (!(await waitVisible())) fail('onglet masqué trop longtemps');
        const s0 = readers.readSlip(doc);
        if (s0.count !== 0) fail('ticket non vide au départ : vide-le toi-même');
        if (s0.unknown.length) fail('élément inconnu dans le ticket : ' + s0.unknown.join(' | '));
        const balance = await readers.readWalletStable(doc, sleep);
        if (!num(balance)) fail('solde illisible');
        const btn = findOddsButton(d);
        if (isSuspended(btn)) fail('marché suspendu');
        const pageOdds = btnOdds(btn);
        const stake = guard.maxStake(d.suggestedStake);
        const proposal = (odds) => ({ balance, stake, odds, analysedOdds: d.analysedOdds, suspended: false, leadSec: lead(d), confidence: d.confidence });
        const pre = checkGuard(proposal(pageOdds));
        if (pre) {
          if (pre.verdict === 'ARRET') fail(pre.reason);
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
        for (const t0 = now(); s.count !== 1 && now() - t0 < SLIP_WAIT_MS; s = readers.readSlip(doc)) await sleep(POLL_MS);
        verifyCard(d, s);
        const g2 = checkGuard(proposal(s.odds));
        if (g2) fail('guard : ' + g2.reason);

        // 3. Mise
        await stopCheck(3);
        setStake(stake);
        s = readers.readSlip(doc);
        if (!num(s.stake) || Math.abs(s.stake - stake) > 0.001) fail('mise non prise en compte par le ticket');
        verifyCard(d, s); // relit la cote après la saisie (dérive)
        if (!num(s.winnings) || Math.abs(s.winnings - stake * s.odds) > 0.01) fail('gains affichés ≠ mise × cote');

        // 4. Mode à blanc
        if (d.dryRun) {
          if (!removeOurSelection()) fail('mode à blanc : retrait de la sélection impossible');
          log('dry', { marketTitle: d.marketTitle, window: d.window, label: d.label, stake, odds: s.odds });
          return { status: 'dry', reason: 'mode à blanc', stake, odds: s.odds };
        }

        // 5. Relecture finale juste avant #betBtn
        await stopCheck(5);
        if (!(await waitVisible())) fail('onglet masqué trop longtemps');
        s = readers.readSlip(doc);
        verifyCard(d, s);
        const odds = s.odds;
        if (!num(s.stake) || Math.abs(s.stake - stake) > 0.001) fail('mise changée');
        if (!num(s.winnings) || Math.abs(s.winnings - stake * odds) > 0.01) fail('gains affichés ≠ mise × cote');
        if (!s.betButton.present || !s.betButton.enabled) fail('#betBtn absent ou désactivé');
        if (s.betButton.label !== 'Parier') fail(`libellé de #betBtn inattendu : « ${s.betButton.label} »`);
        if (isSuspended(btn)) fail('marché suspendu');
        const g5 = checkGuard(proposal(odds));
        if (g5) fail('guard : ' + g5.reason);
        const betBtn = doc.querySelector('sports-betting-slip #betBtn');
        if (!betBtn) fail('#betBtn absent');

        // 6. « Validation en cours » puis clic unique
        await store.set({ pending: { marketTitle: d.marketTitle, window: d.window, stake, odds, at: now() } });
        await stopCheck(6);
        guard.reserve(stake);
        ctx.reserved = stake;
        if (!visible()) fail('onglet masqué au moment du clic');
        ctx.betClicked = true;
        click(betBtn);

        let conf = readers.readConfirmation(doc);
        for (const t0 = now(); !conf.validated && now() - t0 < cfg.confirmTimeoutMs; conf = readers.readConfirmation(doc)) await sleep(POLL_MS);
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

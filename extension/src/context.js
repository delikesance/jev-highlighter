/**
 * Contexte du match : forme, classement, face-à-face et stats live, lus sur la page « match-center » du bookmaker
 * (widgets Sportradar) puis envoyés à JEV pour que ses choix ne reposent pas que sur les cotes.
 *
 * Deux sources :
 *  - active  : un iframe invisible same-origin charge `<url du match>/match-center` ; on lit ses 3 onglets
 *              (Live, Performances, Classement). Le clic sur un onglet ne concerne que cet iframe caché.
 *  - passive : quand tu es toi-même sur une page match-center, on lit ce qui s'affiche et on le mémorise.
 * Lecture seule : rien n'est cliqué sur la page visible, aucun pari.
 */
(function (root) {
  const isNode = typeof module === 'object' && module.exports;
  const J = isNode ? Object.assign({}, require('./config'), require('./utils')) : root.JEV;
  const { CONFIG, cleanText, log, warn } = J;

  const t = (el) => (el ? cleanText(el.textContent) : '');
  const num = (s) => {
    const m = String(s).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const q = (el, sel) => (el ? el.querySelector(sel) : null);
  const qa = (el, sel) => (el ? [...el.querySelectorAll(sel)] : []);

  // ------------------------------------------------------------------ parsers (purs : prennent un Document)

  /** Onglet « Live » : statistiques du match en cours. */
  function parseLive(doc) {
    if (!doc.querySelector('.sr-general-statistics')) return null;
    const stats = [];
    for (const w of qa(doc, '.sr-general-statistics__statstypes-wrapper')) {
      const labels = q(w, '.sr-general-statistics__labels');
      const name = t(q(labels, '.sr-general-statistics__title'));
      const home = t(q(labels, '.sr-general-statistics__label-left .sr-general-statistics__label-val'));
      const away = t(q(labels, '.sr-general-statistics__label-right .sr-general-statistics__label-val'));
      if (name && (home || away)) stats.push({ name, home, away });
    }
    if (!stats.length) return null;
    return {
      home: t(q(doc, '.sr-matchteamheader__left .sr-matchteamheader__team')),
      away: t(q(doc, '.sr-matchteamheader__right .sr-matchteamheader__team')),
      period: t(q(doc, '.sr-general-statistics-periods__period.srm-is-active .sr-general-statistics-periods__period-name-long')),
      stats
    };
  }

  const FORM_ROWS = ['points_for', 'points_against', 'diff'];

  function parseTeamForm(node) {
    const meta = {};
    for (const it of qa(node, '.sr-hth-team-info__tournament-meta-item'))
      meta[t(q(it, '.sr-hth-team-info__meta-label'))] = t(q(it, '.sr-hth-team-info__meta-value'));
    const cols = qa(node, '.sr-hth-team-form-table__column-header-cell.srm-show-on-large').map(t);
    const perQuarter = {};
    qa(node, '.sr-hth-team-form-table__section-row').forEach((row, i) => {
      const cells = qa(row, '.sr-hth-team-form-table__cell').map((c) => num(t(c)));
      const key = FORM_ROWS[i] || `row_${i}`;
      perQuarter[key] = Object.fromEntries(cols.map((c, j) => [c, cells[j] ?? null]));
    });
    return {
      team: t(q(node, '.sr-hth-team-info__team-name')),
      competition: t(q(node, '.sr-hth-team-info__tournament-name')),
      position: num(meta.Pos),
      played: num(meta.MJ),
      win_pct: num(meta['%']),
      per_quarter: perQuarter
    };
  }

  function parseMatchRow(w) {
    const pick = (cls) => t(q(w, `.${cls}.srm-hide-on-small`)) || t(q(w, `.${cls}`));
    return {
      date: t(q(w, '.sr-hth-match__date')),
      competition: t(q(w, '.sr-hth-match__tournament')),
      result: t(q(w, '.sr-bs-wdlbox__wrapper span')), // V / D / N
      home: pick('sr-hth-match__home'),
      away: pick('sr-hth-match__away'),
      score: `${t(q(w, '.sr-hth-match__score-home'))}-${t(q(w, '.sr-hth-match__score-away'))}`
    };
  }

  /** Onglet « Performances » : probabilité Sportradar, face-à-face, forme, derniers matchs. */
  function parseHeadToHead(doc) {
    if (!doc.querySelector('.sr-hth')) return null;
    const holders = qa(doc, '.sr-hth-0-previous-meetings__pm-count-holder').map((h) => t(q(h, '.sr-hth-0-previous-meetings__pm-count')));
    const wp = (side) => num(t(q(doc, `.sr-win-probability__odds-labels-number-${side} .sr-win-probability__odds-labels-number-value`)));
    const averages = qa(doc, '.sr-hth-0-teamsaverages__item')
      .map((it) => ({
        name: t(q(it, '.sr-hth-0-teamsaverages__item-title')),
        value: num(t(q(it, '.sr-hth-0-teamsaverages__item-value'))),
        league_average: num(t(q(it, '.sr-hth-0-teamsaverages__averages-value')))
      }))
      .filter((a) => a.name && a.value != null);
    return {
      win_probability: { home: wp('home'), away: wp('away') }, // probabilité Sportradar (source tierce)
      previous_meetings: holders.length >= 3 ? { home_wins: num(holders[0]), since: num(holders[1]), away_wins: num(holders[2]) } : null,
      head_to_head_averages: averages,
      team_form: qa(doc, '.sr-hth-team-form').map(parseTeamForm),
      last_matches: qa(doc, '.sr-hth-last-next-matches__team-column').map((col) => ({
        team: t(q(col, '.sr-hth-last-matches__title-team')),
        matches: qa(col, '.sr-hth-match__wrapper').slice(0, 5).map(parseMatchRow)
      }))
    };
  }

  /** Onglet « Classement ». Les équipes du match portent la classe `srt-base-1-is-active`. */
  function parseStandings(doc) {
    if (!doc.querySelector('.sr-livetable')) return null;
    const rows = qa(doc, '.sr-livetable__tableRow.srm-dataRow').map((tr) => {
      const td = qa(tr, 'td');
      return {
        position: num(t(q(tr, '.sr-livetable__tablePosNum')) || t(td[1])),
        team: t(q(tr, '.sr-livetable__tableTeamName')),
        played: num(t(td[3])),
        wins: num(t(td[4])),
        losses: num(t(td[5])),
        points: t(td[6]), // « pour:contre »
        diff: num(t(td[7])),
        win_pct: num(t(td[9])),
        form: qa(tr, '.sr-livetable__tableCellForm span').map(t).join(''),
        is_match_team: !!tr.querySelector('.srt-base-1-is-active')
      };
    });
    if (!rows.length) return null;
    return {
      competition: t(q(doc, '.sr-livetable__tableName')),
      teams_count: rows.length,
      match_teams: rows.filter((r) => r.is_match_team).map(({ is_match_team, ...r }) => r),
      leader: rows[0] ? { team: rows[0].team, wins: rows[0].wins, played: rows[0].played } : null
    };
  }

  function parseAll(doc) {
    const parts = { live: parseLive(doc), h2h: parseHeadToHead(doc), standings: parseStandings(doc) };
    return Object.values(parts).some(Boolean) ? parts : null;
  }

  // ------------------------------------------------------------------ mise en forme pour JEV

  /** Contexte compact (≤ maxChars) : les blocs les moins utiles sautent d'abord (live, puis moyennes). */
  function compactContext(entry, maxChars = CONFIG.context.maxChars) {
    if (!entry || !entry.parts) return null;
    const { live, h2h, standings } = entry.parts;
    const names = (live && [live.home, live.away]) || (h2h && h2h.last_matches.map((l) => l.team)) || null;
    const out = {
      teams: names && names.filter(Boolean).length === 2 ? names : null,
      competition: (standings && standings.competition) || (h2h && h2h.team_form[0] && h2h.team_form[0].competition) || null,
      sportradar_win_probability_pct: h2h ? h2h.win_probability : null,
      previous_meetings: h2h ? h2h.previous_meetings : null,
      standings: standings ? { teams_count: standings.teams_count, match_teams: standings.match_teams, leader: standings.leader } : null,
      form: h2h
        ? h2h.team_form.map((f) => ({ team: f.team, position: f.position, played: f.played, win_pct: f.win_pct, per_quarter: f.per_quarter }))
        : null,
      last_matches: h2h
        ? h2h.last_matches.map((l) => ({ team: l.team, matches: l.matches.map((m) => `${m.result} ${m.home} ${m.score} ${m.away} (${m.competition})`) }))
        : null,
      head_to_head_averages: h2h ? h2h.head_to_head_averages : null,
      live: live ? { period: live.period, stats: live.stats.slice(0, 14) } : null
    };
    for (const drop of [null, 'live', 'head_to_head_averages', 'form', 'last_matches']) {
      if (drop) out[drop] = null;
      if (JSON.stringify(out).length <= maxChars) break;
    }
    for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
    return Object.keys(out).length ? out : null;
  }

  /** `/sport/ligue/equipe-a-equipe-b-m123` ou `.../match-center` -> clé du match, sinon null. */
  function keyFromPath(pathname) {
    const p = String(pathname).replace(/\/+$/, '').replace(/\/match-center$/, '');
    return /-m\d+$/.test(p) ? p : null;
  }

  if (isNode) {
    module.exports = { parseLive, parseHeadToHead, parseStandings, parseAll, compactContext, keyFromPath };
    return;
  }

  // ------------------------------------------------------------------ collecte (navigateur)

  const TABS = [
    { qa: 'match-center-tab-live', ready: parseLive, part: 'live' },
    { qa: 'match-center-tab-performance', ready: parseHeadToHead, part: 'h2h' },
    { qa: 'match-center-tab-team-standing', ready: parseStandings, part: 'standings' }
  ];
  const mem = new Map(); // clé -> { parts, at }
  const loading = new Map(); // clé -> Promise
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, ms, step = 250) {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = fn(); } catch { /* document pas encore prêt */ }
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(step);
    }
  }

  async function readStored(key) {
    try {
      const o = await chrome.storage.local.get('jevCtx');
      return (o.jevCtx && o.jevCtx[key]) || null;
    } catch { return null; }
  }
  async function writeStored(key, entry) {
    try {
      const o = await chrome.storage.local.get('jevCtx');
      const all = o.jevCtx || {};
      all[key] = entry;
      const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
      for (const k of keys.slice(CONFIG.context.maxStored)) delete all[k];
      await chrome.storage.local.set({ jevCtx: all });
    } catch { /* quota / indisponible : le cache mémoire suffit */ }
  }

  async function remember(key, parts) {
    const prev = mem.get(key) || (await readStored(key)) || { parts: {} };
    const entry = { parts: { ...prev.parts }, at: Date.now() };
    for (const [k, v] of Object.entries(parts)) if (v) entry.parts[k] = v;
    mem.set(key, entry);
    await writeStored(key, entry);
    return entry;
  }

  /** Source passive : on est sur la page match-center, on mémorise ce qui est affiché. */
  async function ingestDocument(doc, key) {
    const parts = parseAll(doc);
    if (!parts || !key) return false;
    await remember(key, parts);
    log(`Match context ingested (${Object.keys(parts).filter((k) => parts[k]).join(', ')})`);
    return true;
  }

  /** Source active : iframe invisible same-origin sur `<match>/match-center`. */
  async function collectViaIframe(key) {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('data-jev-host', ''); // ignoré par notre MutationObserver
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0;opacity:0;pointer-events:none;';
    iframe.src = `${location.origin}${key}/match-center`;
    const parts = {};
    try {
      document.documentElement.appendChild(iframe);
      await new Promise((resolve, reject) => {
        iframe.addEventListener('load', resolve, { once: true });
        iframe.addEventListener('error', reject, { once: true });
        setTimeout(reject, CONFIG.context.iframeLoadMs);
      });
      const doc = iframe.contentDocument; // same-origin : accès direct
      if (!doc) throw new Error('iframe inaccessible');
      log(`Match context iframe loaded: ${doc.location && doc.location.href} (title: ${doc.title})`);
      for (const tab of TABS) {
        const el = await waitFor(() => doc.querySelector(`[data-qa="${tab.qa}"]`), 4000);
        if (!el) {
          // onglet absent (ex. pas de Live avant le match) : on liste ce qui existe pour adapter les sélecteurs
          const found = [...doc.querySelectorAll('[data-qa^="match-center"]')].map((n) => n.getAttribute('data-qa'));
          log(`Match context: tab "${tab.qa}" not found. data-qa present: ${found.join(', ') || 'none'}`);
          continue;
        }
        if (!el.classList.contains('isActive')) el.click(); // onglet de l'iframe CACHÉ uniquement
        parts[tab.part] = await waitFor(() => tab.ready(doc), CONFIG.context.tabMs);
        if (parts[tab.part]) log(`Match context: tab ${tab.part} parsed`);
        else {
          // aide au diagnostic : classes Sportradar présentes + début du texte affiché (autre sport = autre balisage)
          const sr = [...new Set([...doc.querySelectorAll('[class*="sr-"]')].map((n) => String(n.className).split(/\s+/).find((c) => c.startsWith('sr-'))))].filter(Boolean);
          const text = ((doc.body && doc.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 600);
          log(`Match context: tab ${tab.part} found but nothing parsed. sr-* classes (${sr.length}): ${sr.slice(0, 60).join(' ')} | text: ${text}`);
        }
      }
    } catch (e) {
      warn(`Match context iframe failed: ${e && e.message ? e.message : 'timeout/blocked'}`);
    } finally {
      iframe.remove();
    }
    return parts;
  }

  /**
   * Contexte compact pour la page de match courante, ou null. Ne lève jamais.
   * @param {string} key clé du match (keyFromPath)
   */
  async function get(key, { force = false } = {}) {
    if (!key) return null;
    try {
      let entry = mem.get(key) || (await readStored(key));
      const fresh = entry && Date.now() - entry.at < CONFIG.context.ttlMs;
      if (!force && fresh) {
        mem.set(key, entry);
        return compactContext(entry);
      }
      if (location.pathname.replace(/\/+$/, '').endsWith('/match-center')) return compactContext(entry); // passif seulement
      if (!loading.has(key)) {
        log('Loading match context from match-center');
        loading.set(
          key,
          collectViaIframe(key)
            .then((parts) => {
              if (!Object.values(parts).some(Boolean)) {
                // rien de lisible : on ne mémorise PAS un résultat vide (il bloquerait les essais suivants pendant le TTL)
                warn('Match context: nothing collected, not cached');
                return null;
              }
              return remember(key, parts);
            })
            .finally(() => loading.delete(key))
        );
      }
      const done = await Promise.race([loading.get(key), sleep(CONFIG.context.waitMs).then(() => null)]);
      entry = done || mem.get(key) || entry;
      return compactContext(entry);
    } catch (e) {
      warn(`Match context unavailable: ${e && e.message}`);
      return null;
    }
  }

  /** Lecture mémoire seule (pas de chargement) : utilisée par la suggestion de mise. */
  function peek(key) {
    return key && mem.has(key) ? compactContext(mem.get(key)) : null;
  }

  function status(key) {
    const e = key && mem.get(key);
    if (!e) return { state: loading.has(key) ? 'loading' : 'none', parts: [], ageSec: null };
    return { state: 'ready', parts: Object.keys(e.parts).filter((k) => e.parts[k]), ageSec: Math.round((Date.now() - e.at) / 1000) };
  }

  Object.assign(J, { MatchContext: { keyFromPath, get, peek, status, ingestDocument, compactContext } });
})(globalThis);

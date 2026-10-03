/**
 * Configuration centrale. TOUT ce qui dépend de l'API JEV ou du site du bookmaker est ici.
 * Les valeurs marquées "À CONFIRMER" ne sont pas garanties par la doc : vérifiez-les.
 */
(function (root) {
  const CONFIG = {
    JEV: {
      // Doc : https://docs.typesafe.ai/api.md  (POST /v1/systemone, Bearer auth)
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      authHeaderName: 'Authorization',
      authScheme: 'Bearer', // header = `${authScheme} <clé>` ; mettre '' pour envoyer la clé seule
      // `model` est OBLIGATOIRE (sinon 422). "jev-latest" = alias documenté ; voir https://docs.typesafe.ai/models.md
      model: 'jev-latest',
      maxQuestionsPerRequest: 100, // À CONFIRMER : la doc ne fixe pas de limite ; on découpe au-delà.
      timeoutMs: 20000,
      maxRetries: 2, // retries sur 429 / 529 uniquement
      retryBaseMs: 600
    },

    // Sélecteurs DOM du bookmaker.
    selectors: {
      market: 'sports-markets-single-market',
      marketBox: '[data-qa="market-box"]',
      title: '[data-qa="market-title"]',
      titleText: '.marketBox_headTitleWrapper',
      marketHandler: '.marketBox_marketHandler',
      line: '.marketBox_lineSelection',
      label: '.marketBox_label',
      button: '[data-qa="market-selection"]',
      odds: '.btn_label',
      strikethrough: '.is-strikethrough',
      // À CONFIRMER : sélecteur d'un marché suspendu (valeur supposée).
      suspended: '[data-qa="market-suspended"], .is-suspended',
      // Solde du portefeuille (en-tête du site)
      wallet: '.header_walletBalance bc-header-animated-balance, [data-qa="commonDeposit"] bc-header-animated-balance, .header_wallet bc-header-animated-balance, bc-header-animated-balance',
      // Ticket de pari
      slip: {
        card: 'betting-slip-selection-card',
        event: '.progressiveBettingSlip_cardEventName',
        label: '.progressiveBettingSlip_cardMarketLabel', // la sélection (ex. "Nul")
        market: '.progressiveBettingSlip_cardMarketValue', // le marché (ex. "Résultat du match")
        odds: 'betting-slip-odds-field .btn_label',
        footerOdds: 'betting-slip-footer-odds .btn_label',
        stakeInput: 'input[name="stakeField"], betting-slip-stake-field input, input[placeholder="Mise"]',
        // zones dont les changements doivent relancer la suggestion de mise (ticket + solde)
        watchRoots: 'sports-betting-slip, bc-header-wallets'
      }
    },

    // Contexte du match lu sur la page `<url du match>/match-center` (widgets Sportradar).
    context: {
      ttlMs: 3 * 60 * 1000, // fraîcheur (les stats live bougent) ; au-delà on recharge
      waitMs: 15000, // attente max du contexte avant d'analyser sans lui
      iframeLoadMs: 10000,
      tabMs: 6000, // attente max du rendu de chaque onglet
      maxChars: 3500, // taille max du contexte envoyé à JEV
      maxStored: 20 // matchs mémorisés dans chrome.storage
    },

    // Suggestion de mise : JEV choisit une tranche de mise parmi plusieurs, puis on affine tranche par tranche.
    // Suggestion uniquement : l'extension ne remplit JAMAIS le champ de mise.
    stake: {
      cells: 10, // tranches proposées à chaque tour
      maxRounds: 3, // ex. solde 5,90 € : tranches de 1 € -> 0,10 € -> 0,01 €
      maxFractionOfWallet: 0.1, // plafond dur = 10 % du solde : jamais all-in
      oddsRiskRef: 0, // 0 = JEV décide du risque ; sinon, au-delà de cette cote totale le plafond est réduit (cap × ref / cote)
      minStake: 0.1,
      debounceMs: 1500,
      debounceMaxWaitMs: 3000
    },

    // Mode Auto : valeurs réglables, bornées par les plafonds durs de auto/guard.js (on peut durcir, pas relâcher).
    auto: {
      minOdds: 1.3,
      maxOdds: 4,
      maxDriftPct: 3,
      minLeadSec: 90,
      minConfidence: 0.6,
      confirmTimeoutMs: 8000,
      hiddenTabMs: 5000,
      slipWaitMs: 3000, // attente des mises à jour du ticket (Angular asynchrone), ≤ 10000
      pollMs: 250, // pas d'interrogation du DOM, ≥ 50
      pauseMs: 5000, // pause entre deux cycles du contrôleur, 1000..60000
      maxBets: 5,
      maxLosses: 3,
      maxLossFraction: 0.5,
      maxStakeFraction: 0.1,
      // Marchés « rapides » autorisés : motifs sur le titre du marché (minuscules).
      quickMarkets: {
        football: [
          /prochain but/, /qui marquera le \d+(?:er|e|ème|eme)? but/, /quand sera marqu/,
          /sur la période/, /corner/, /carton/, /prochain buteur/
        ],
        basketball: [/prochain panier/, /total.*quart[- ]temps/, /quart[- ]temps.*total/]
      }
    },

    // Textes envoyés à JEV (génériques, aucun marché codé en dur).
    templates: {
      instructions: (title) =>
        `Marché de paris : « ${title} ». Quelle sélection est la plus susceptible de se réaliser ? ` +
        `Appuie-toi sur le contexte du match fourni dans l'état (forme récente, classement, face-à-face, ` +
        `statistiques live) quand il est disponible, pas seulement sur le libellé du marché.`,
      criterion: (title, option) => `La sélection « ${option} » se réalise pour le marché « ${title} ».`
    },
    // true => les marchés Oui/Non sont envoyés en `noul`. Par défaut `choice` (matching DOM plus fiable).
    useNoulForYesNo: false,
    yesNames: ['oui', 'yes'],
    noNames: ['non', 'no'],

    // Seuil minimal de score JEV (préférence, pas une probabilité) pour surligner. 0 = tout.
    minScore: 0,

    // Dynamique
    debounceMs: 1200,
    debounceMaxWaitMs: 5000, // exécution forcée même si le DOM bouge sans arrêt (page live)
    minIntervalMs: 3000, // intervalle minimal entre deux requêtes automatiques
    cooldownAfterRateLimitMs: 30000,
    cacheMaxEntries: 20,
    urlPollMs: 1000
  };

  if (typeof module === 'object' && module.exports) module.exports = { CONFIG };
  else (root.JEV = root.JEV || {}).CONFIG = CONFIG;
})(globalThis);

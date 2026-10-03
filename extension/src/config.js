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
      authScheme: 'Bearer', // header = `${authScheme} ${apiKey}` ; mettre '' pour envoyer la clé seule
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
        stakeInput: 'input[name="stakeField"], betting-slip-stake-field input, input[placeholder="Mise"]'
      }
    },

    // Suggestion de mise : JEV choisit une tranche de mise parmi plusieurs, puis on affine tranche par tranche.
    // Suggestion uniquement : l'extension ne remplit JAMAIS le champ de mise.
    stake: {
      cells: 10, // tranches proposées à chaque tour
      maxRounds: 3, // ex. solde 5,90 € : tranches de 1 € -> 0,10 € -> 0,01 €
      maxFractionOfWallet: 1, // plafond de mise = fraction du solde (1 = tout le solde)
      minStake: 0.1,
      debounceMs: 1500
    },

    // Textes envoyés à JEV (génériques, aucun marché codé en dur).
    templates: {
      instructions: (title) =>
        `Marché de paris : « ${title} ». Quelle sélection est la plus susceptible de se réaliser ?`,
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
    minIntervalMs: 3000, // intervalle minimal entre deux requêtes automatiques
    cooldownAfterRateLimitMs: 30000,
    cacheMaxEntries: 20,
    urlPollMs: 1000
  };

  if (typeof module === 'object' && module.exports) module.exports = { CONFIG };
  else (root.JEV = root.JEV || {}).CONFIG = CONFIG;
})(globalThis);

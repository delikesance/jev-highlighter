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
      suspended: '[data-qa="market-suspended"], .is-suspended'
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

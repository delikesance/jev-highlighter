# JEV Highlighter (Chrome, Manifest V3)

Analyse les marchés visibles sur une page de bookmaker, les envoie à JEV, puis **surligne** les sélections
préférées par le modèle. L'extension ne clique jamais, ne saisit aucune mise et ne valide aucun ticket.

> Le « score JEV » est le poids/préférence que JEV donne à une option. Ce n'est **pas** une probabilité
> réelle de gain : aucun EV n'est calculé.

## Architecture
```
Page → parser.js (DOM → Map<id, market>) → jev.js (buildRequest, JSON sans DOM)
     → background.js (seul à connaître la clé / appeler l'API, AbortController, retry 429/529)
     → matcher.js (answers[id].choice ↔ option DOM, normalizeText) → highlighter.js (classe CSS + badge)
content.js : MutationObserver + debounce + fingerprint + cache + vérif du fingerprint avant application
```
```
extension/
├── manifest.json
├── src/ config.js utils.js storage.js parser.js jev.js matcher.js highlighter.js content.js background.js
├── popup/ popup.html popup.js popup.css
└── styles/injected.css
tests/ (node:test + jsdom, fixture.html, mock-server.js)   backend-example/server.js
```

## Installer
1. `npm install && npm test`
2. `chrome://extensions` → activer **Mode développeur** → **Charger l'extension non empaquetée** → dossier `extension/`.
3. Recharger l'onglet du bookmaker (les onglets déjà ouverts n'ont pas le content script).

**Restreindre au bookmaker** : dans `extension/manifest.json`, remplacez `content_scripts[0].matches`
(`https://*/*`) par le domaine réel, ex. `["https://www.mon-bookmaker.fr/*"]`.

## Où configurer JEV
- **Valeurs par défaut** : `extension/src/config.js` → `CONFIG.JEV` (endpoint `https://api.typesafe.ai/v1/systemone`,
  header `Authorization: Bearer <clé>`). **À confirmer** : `model` (laissé à `null` = champ omis ; ex. `"jev-1.13.0"`)
  et `maxQuestionsPerRequest`.
- **Popup → Configuration** : mode, clé, endpoint (surcharge), URL du backend. Stocké dans `chrome.storage.local`.
- Sélecteurs du bookmaker, textes des questions, seuil `minScore`, délais : `config.js`.

## Sécurité de la clé
Une clé placée dans une extension distribuée **n'est pas secrète** : tout utilisateur peut la lire.
- **Développement** : clé dans `chrome.storage.local` (popup), lue uniquement par `background.js`, jamais par `content.js`.
- **Production** : `Extension → votre backend → JEV`. Mode « Production » du popup + URL du backend ;
  la clé reste dans `JEV_API_KEY` côté serveur (`backend-example/server.js`, à compléter avec auth/quotas).
  Le backend doit autoriser l'origine `chrome-extension://<id>` (CORS) ; pour un domaine autre que
  localhost/api.typesafe.ai, ajoutez-le à `host_permissions`.

## Tester sans clé
```bash
npm run mock   # http://localhost:8787/  (page fixture + faux JEV sur /jev)
```
Ouvrir `http://localhost:8787/`, popup → Configuration : mode dev, clé quelconque, endpoint
`http://localhost:8787/jev` → Enregistrer → **Analyser la page**. Activer le debug pour voir les logs `[JEV]`.

## Notes de conception
- IDs déterministes = slug du titre ; doublons → suffixe d'empreinte puis compteur.
- Sélections barrées (`.is-strikethrough`), désactivées, sans cote ou marché suspendu : `available:false`, exclues de la requête.
  Un marché avec moins de 2 options disponibles n'est pas envoyé.
- Marchés Oui/Non envoyés en `choice` (matching fiable) ; `CONFIG.useNoulForYesNo = true` pour utiliser `noul`.
- Si le DOM change pendant la requête (fingerprint différent), le résultat est écarté et une nouvelle analyse est planifiée.
- Sélecteur de marché suspendu (`CONFIG.selectors.suspended`) : valeur supposée, à adapter.

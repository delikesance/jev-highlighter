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
  header `Authorization: Bearer <clé>`). **À confirmer** : `model` (défaut `"jev-latest"`, obligatoire côté API)
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

## Suggestion de mise (selon le solde)
Quand le ticket contient une sélection, l'extension lit le solde (`CONFIG.selectors.wallet`) et le ticket
(`CONFIG.selectors.slip`), puis affine la mise par tranches : JEV choisit une tranche parmi plusieurs
(« Ne pas miser », 0–1 €, 1–2 €, …), la tranche choisie est redécoupée (0,10 €), puis encore (0,01 €) : 3 requêtes max.
Le montant s'affiche dans un panneau au-dessus du champ de mise (avec « Copier »). **Le champ de mise n'est jamais rempli
automatiquement** et aucun pari n'est lancé. Réglages dans `CONFIG.stake` (tranches, tours, plafond en % du solde,
mise minimale) ; case « Suggestion de mise » dans le popup. C'est la préférence du modèle, pas une garantie de gain.

## Interface « JEV Lens » (injectée dans la page)
Toute l'UI vit dans des **Shadow DOM** (`jev-lens`, `jev-picks`, `jev-stake`) : le CSS du site ne la touche pas. Seul l'anneau
sur la cote est une classe de page (`styles/injected.css`) ; le contenu des boutons du site n'est jamais modifié.
- **Marqueurs** : anneau menthe (reco) / ambre + halo (top pick), pastille `★ 62`, barre de score ; états analyse (…), cote modifiée (↻), erreur.
- **Carte de survol** : poids JEV de chaque option du marché + confidence (« pas une probabilité réelle »).
- **Sélection du moment** : bloc inséré au-dessus des marchés (top 3). Cliquer une carte fait défiler jusqu'à la cote (jamais de clic sur le site).
- **Dock** (bas-gauche) : classement, interrupteurs analyse auto / « Remonter les picks en tête », réduire/fermer (mémorisé).
- **Remonter les picks en tête** : réordonnancement visuel par CSS `order` (nœuds jamais déplacés, réversible) ; no-op si le conteneur contient autre chose que des marchés.
- **Assistant de mise** : module dans le ticket avant le champ de mise, « Copier », « Détail » = zoom en 3 étapes.
- Polices Sora + JetBrains Mono embarquées (`extension/fonts/`).

Tests : `npm test` (unitaires + tests de fumée jsdom qui exécutent tous les scripts de contenu).

## Contexte du match (match-center)
Pour que JEV ne juge pas que sur les cotes, l'extension lit la page `<url du match>/match-center` (widgets Sportradar du bookmaker) :
**Live** (stats du match en cours), **Performances** (probabilité Sportradar, face-à-face, forme par quart-temps, 5 derniers matchs)
et **Classement** (les deux équipes mises en évidence). Le résultat, compacté (≤ `CONFIG.context.maxChars`), est ajouté à l'état de chaque
requête (`state.match_context`) ; les instructions demandent à JEV de s'en servir en plus du libellé du marché.
- **Source active** : un iframe invisible same-origin charge le match-center et on lit ses 3 onglets (le clic ne concerne que cet iframe caché ; aucune action sur la page visible, aucun pari).
- **Source passive** : si tu ouvres toi-même le match-center, ce qui s'affiche est mémorisé (`chrome.storage.local`, 20 matchs).
- Rafraîchi au-delà de `CONFIG.context.ttlMs` (3 min). Si le contexte est indisponible (iframe bloqué, widget absent), l'analyse continue sans lui.
- Interrupteur « Contexte du match » dans le popup ; sélecteurs/parsers dans `src/context.js`.

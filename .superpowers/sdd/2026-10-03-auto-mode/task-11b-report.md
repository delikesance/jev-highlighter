# Task 11b — rapport de remise

## Statut

**DONE_WITH_CONCERNS** — l’implémentation est présente dans le commit `a23bc916e3372b27812645c2e21b459910cdb3fb` et toute la suite est verte. La réserve concerne la vérification sur le vrai site, inaccessible dans cet environnement.

## Fait

- Panneau Shadow DOM `jev-auto` : STOP, Échap en capture, armement explicite, première session à blanc, confirmation de l’absence de paris manuels, état, solde, bilan et journal borné à 50 lignes. Tous les textes dynamiques passent par `textContent`.
- `content.js` ne démarre Auto que pour `autoMode === true`, jamais dans un sous-cadre. Il récupère l’identifiant d’onglet, crée le runtime une seule fois, réutilise la requête/mise en correspondance JEV existante et planifie les `step()` séquentiellement.
- `autoMode` est désactivé par défaut dans le stockage et présenté avec son avertissement dans le popup. Le manifeste charge les modules Auto dans l’ordre requis avant `content.js`; `background.js` répond à `JEV_TAB_ID`.
- `CONFIG.auto.stepMs` vaut 1500 ms et `Guard.validateConfig` le borne à 500…10000 ms.
- Les tests UI et smoke couvrent notamment : panneau absent hors mode Auto, STOP, phrase/confirmation, à blanc, Échap, injection HTML, ordre manifeste, sous-cadre, runtime unique, absence d’armement automatique, planification sans chevauchement et déduplication Fast.

## Preuves TDD

La réalisation fonctionnelle et les tests ont été introduits dans `a23bc91`. La sortie historique RED d’avant ce commit n’est pas disponible dans le dépôt. Une vérification RED contrôlée, réversible et explicitement restaurée a été exécutée le 2026-10-03 : changement temporaire de la constante de phrase d’armement de `PARIER AUTO` vers `PARIER AUTOO`, puis :

```text
$ node --test tests/auto-ui.test.js
not ok 1 - tests/auto-ui.test.js
# fail 1
```

Après restauration exacte de la source, la validation GREEN finale a donné :

```text
$ node --test tests/*.test.js && git diff --check && git status --short
1..18
# pass 18
# fail 0
# duration_ms 8164.763788
```

`git diff --check` est silencieux et l’arbre est propre avant l’ajout de ce rapport.

## Fichiers concernés

- `extension/src/auto/auto-ui.js`, `extension/src/content.js`, `extension/src/config.js`, `extension/src/auto/guard.js`
- `extension/src/storage.js`, `extension/src/background.js`
- `extension/manifest.json`, `extension/popup/popup.html`, `extension/popup/popup.js`
- `tests/auto-ui.test.js`, `tests/smoke.test.js`, `tests/auto-guard.test.js`

## Auto-revue

- Les contrôles statiques passent : aucun identifiant sensible interdit dans les content scripts, aucun clic/événement synthétique hors `auto/executor.js`, aucun `eval`.
- L’analyse manuelle garde son flux et son rendu indépendants; l’adaptateur Auto appelle JEV sans appliquer de surlignage.
- `content.js` fait 488 lignes, sous le seuil indicatif de 550.
- Commit fonctionnel : `a23bc91`, avec la remorque `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Concerns / hypothèses non vérifiables

- Les sélecteurs, temps de rendu Angular, navigation SPA et réponses de Betclic restent validés uniquement par les fixtures jsdom et les faits consignés dans la spec; aucun accès au vrai site n’est disponible ici.
- Il faut une validation manuelle sur un compte de test, d’abord strictement en mode à blanc, avant toute activation réelle.

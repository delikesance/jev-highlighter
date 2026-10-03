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

## Refonte du cycle demandée le 2026-10-04

Status : DONE_WITH_CONCERNS (site réel et API distante non exécutés).

### Réalisé

- Sur `/live`, une question dédiée JEV choisit un événement parmi les candidats transmis. Une réponse ne peut pas injecter une URL : seuls les identifiants de la liste sont acceptés.
- Sur la page du live choisi, une deuxième question choisit une seule sélection parmi tous les marchés parsés, dédupliqués et non suspendus. Le filtre Fast et le classement déterministe ne décident plus dans le runtime de production.
- L'exécuteur ajoute la sélection au ticket, vérifie son identité, lit le wallet stable et demande la mise via `suggestStake` avec les vraies cotes du ticket. La mise n'est plus demandée avant son ouverture. Le transport inclut le modèle configuré.
- « Ne pas miser » retire la sélection sans validation. STOP pendant la requête de mise empêche toute saisie/validation et nettoie la sélection.
- Après simulation ou placement suivi, PAUSE puis retour `/live`. Aucun armement automatique ; à blanc reste le défaut. Reprise de session, suivi des paris réels, garde-fous financiers et anti-doublons conservés.

### Tests et preuves

- RED initial : les nouveaux tests de décisions/exécution précédaient les implémentations (`auto-decisions` absent, callback de mise du ticket non appelé). Les tests du contrôleur exigeaient le choix JEV du live et un marché non Fast.
- Vérification supplémentaire : `node --test tests/auto-flow.test.js` a d'abord échoué. `node tests/auto-flow.test.js` révélait une erreur du test : `Config auto invalide : pauseMs : 500 < minimum 1000`. Corrigé à 1000 et parsing `.list`, sans réduire la validation de configuration.
- GREEN : `node tests/auto-flow.test.js` → `tests 1`, `pass 1`, `fail 0`. Intégration du contrôleur, décisions, parser, garde, lecteurs et exécuteur : ordre live → pari → ticket → mise ; une sélection ajoutée, aucun clic Parier à blanc, ticket vide, retour `/live`.
- GREEN final : `node --test tests/*.test.js` → `tests 20`, `pass 20`, `fail 0` (le lanceur rapporte ici les 20 fichiers, pas le nombre de cas internes), durée 8488 ms.
- `git diff --check` → sortie vide. Tests statiques et analyse manuelle verts. Le smoke Auto attend désormais une sélection globale, et vérifie les trois adaptateurs et les données wallet/cote des requêtes de mise ; les attentes de l'analyse manuelle restent inchangées.

### Fichiers / auto-revue

`extension/src/auto/decisions.js` (nouveau), `controller.js`, `executor.js`, `wiring.js`, `extension/src/content.js`, `extension/manifest.json`, `tests/auto-decisions.test.js` (nouveau), `tests/auto-flow.test.js` (nouveau), `tests/auto-controller.test.js`, `tests/auto-executor.test.js`, `tests/smoke.test.js` et ce rapport.

`content.js` : 501 lignes. Le nouveau module ne clique pas, ne transporte aucune référence DOM dans la requête et valide les identifiants renvoyés. Les STOP sont revérifiés après les réponses asynchrones. L'ancien chemin injecté du contrôleur reste disponible pour compatibilité/tests ; le runtime content utilise le nouveau chemin.

### Concerns

- Validation uniquement jsdom/faux JEV : pas de preuve de rendu Angular, réponses API, suivi ou placement sur le vrai compte. Une sélection répétée dans plusieurs emplacements DOM peut toujours être refusée comme ambiguë par l'exécuteur.
- Sports actuellement pris en charge : football/basketball avec horloge active. Le choix JEV ne supprime pas les limites existantes : cote, confiance, délai minimal, exposition et fin de session (5 paris maximum). La mise JEV reste plafonnée par les limites financières existantes ; la boucle n'est pas illimitée.
- Aucun modèle ne garantit un bon pari ni un gain. Aucune mise réelle effectuée dans cette validation. Pas de push, tag ou release dans cette intervention.

## Correction anti-flood et diagnostic du placement (2026-10-04)

Status : DONE_WITH_CONCERNS pour l'anti-flood ; placement sur site réel toujours bloqué par la lecture de Mes paris.

- L'absence de pick passait directement d'ANALYSE à SCAN : passage désormais par PAUSE, avec motif visible. Pause par défaut 30 secondes au lieu de 5. Refus de l'exécuteur affiché dans le panneau.
- Une simulation réussie s'arrête après un cycle, sans paiement ni nouveau questionnaire. Le passage réel reste un choix explicite au réarmement ; aucun changement automatique de dryRun.
- Les assistants automatiques d'analyse et de mise sont suspendus pendant une session Auto active. Les requêtes anciennes sont annulées à l'armement/reprise ; un contexte tardif ne relance pas une analyse automatique. Hors session Auto, fonctionnement inchangé.
- Preuve RED : `node --test tests/auto-controller.test.js tests/auto-flow.test.js` → `pass 0`, `fail 2`. Tests modifiés pour exiger PAUSE et arrêt après simulation. Le smoke concurrent a également échoué avant correction : `3 !== 0` requêtes parasites.
- Preuve GREEN : `node --test tests/*.test.js` → `tests 20`, `pass 20`, `fail 0`, 16855 ms. Parcours intégré réel : mise 0,40 €, un clic Parier, confirmation, suivi, retour live. Parcours sans confirmation : STOPPED, pending conservé, dix step supplémentaires sans second clic. Tous ces paiements sont simulés par le faux site, jamais réels.
- L'attente du smoke dépasse le debounceMaxWait pour reproduire les requêtes concurrentes ; contrôle sans Auto démontre que les assistants restent opérationnels.
- Auto-revue : aucun contournement des limites financières, de pending ou de confirmation. `content.js` : 512 lignes, sous 550 ; tests statiques verts. Fichiers : controller.js, config.js, content.js, auto-controller.test.js, auto-flow.test.js, smoke.test.js, ce rapport.
- Pièce utilisateur `ef556c77-959b-4904-8106-c5884da865ac/Texte collé.txt`, lignes 2498–2499 : `tracker: snapshot impossible Mes paris : délai dépassé (page)` puis `ARRÊT suivi des paris indisponible`. L'arrêt survient avant executor.place(), donc avant saisie/validation réelle. L'erreur n'est pas un timeout JEV dans cette capture. Les erreurs analytics ERR_BLOCKED_BY_CLIENT présentes ailleurs sont distinctes.
- Root cause restant à confirmer : makeMyBetsDoc attend le composant `my-bets-page` dans une iframe `/mes-paris`. La capture ne donne pas le DOM réellement rendu ni la raison de son absence (navigation, composant changé, iframe). Le HTML de `/mes-paris` chargé est nécessaire pour corriger cette détection sans inventer de sélecteur ni désactiver le suivi à l'aveugle.

# Audit et corrections du runtime Auto

## Défauts confirmés et corrigés

- Retrait à blanc : lecture immédiate après le clic, incompatible avec un rendu Angular asynchrone. Le retrait attend désormais la disparition de la carte et un compteur nul, au plus `slipWaitMs`.
- Bouton de retrait : dépendance au wrapper cosmétique `.progressiveBettingSlip_card`. La croix est maintenant recherchée dans l'unique `betting-slip-selection-card`, après vérification de l'événement, du marché, de la fenêtre et de la sélection.
- Retrait sans réponse : le chemin d'arrêt pouvait recliquer la croix. Chaque exécution fait au plus une tentative de retrait.
- Chargement des marchés : `ANALYSE` pouvait abandonner un match avant le rendu Angular. Une attente bornée des marchés rapides est ajoutée, avec contrôle STOP.
- STOP pendant la pause : la transition pouvait réécrire SCAN. Le drapeau STOP est relu après l'attente.
- STOP et timer : le prochain step restait programmé. STOP annule maintenant le timer et empêche sa reprogrammation ; seul un armement effectivement réussi relance la boucle.
- Absence de candidat : PAUSE expose désormais la raison dans l'état et dans le journal.

## Vérification

Tests ajoutés avant les corrections : les fichiers `auto-executor.test.js`, `auto-controller.test.js` et `smoke.test.js` ont échoué en RED sur les nouveaux cas.

Après correction : `node --test tests/*.test.js` donne 18 fichiers de tests réussis, zéro échec. `git diff --check` est silencieux. `content.js` contient 502 lignes.

Les tests du faux site couvrent les clics, la saisie native, le retrait différé, le mode à blanc et la confirmation d'un pari. Les tests du contrôleur couvrent navigation, reprise, limites et suivi. Les tests smoke chargent tous les content scripts dans l'ordre du manifeste.

## Limites de la validation

Les HTML et journaux transmis permettent de confirmer plusieurs erreurs de compatibilité. Le dernier journal ne donne pas le HTML exact de la croix : les nouveaux sélecteurs reposent sur le composant de carte déjà documenté et fourni dans les fixtures. Aucun pari réel ni session authentifiée Betclic n'a été exécuté dans cet environnement.

L'analyse automatique utilise les marchés rapides actuellement rendus dans le DOM ; cette correction n'ajoute pas de clic automatique sur un onglet Fast absent des fixtures. Un match sans marché rapide rendu est abandonné après l'attente bornée. Le suivi réel via Mes paris nécessite que la page configurée et ses filtres restent compatibles avec les fixtures.

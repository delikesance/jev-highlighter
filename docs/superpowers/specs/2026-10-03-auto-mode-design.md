# Mode automatique (paris live rapides) — design

Statut : brouillon à relire. Aucune ligne de code n'est écrite avant validation de ce document.

## 1. Intention

Un mode « Auto » qui, une fois armé par l'utilisateur, choisit un événement live sur Betclic, fait analyser des paris
« rapides » par JEV (avec le contexte du match), puis **place lui-même les paris** dans des limites strictes.
But de l'utilisateur : « gain rapide » sur des marchés qui se règlent en quelques minutes.

Décisions de l'utilisateur (2026-10-03) :
- Portée : **l'extension parie seule** (sélectionne, saisit la mise, valide). Cela lève, **pour le mode Auto uniquement**, la règle
  d'origine « ne jamais cliquer un pari / saisir une mise / valider ». Toutes les autres fonctions restent en lecture seule.
- Profil de risque : **agressif** (voir §4).
- Marchés « rapides » : foot (prochain but, + de 0,5 sur la période, corner, carton, prochain buteur), basket (prochain panier,
  total du quart-temps), tennis (prochain jeu/set). Aujourd'hui /live ne liste ni tennis ni volley : à activer quand le HTML existe.

Limites connues, à ne pas masquer :
- Le score JEV est une préférence du modèle, pas une probabilité. Aucun calcul « probabilité × cote ».
- La marge du bookmaker rend l'espérance de gain négative en moyenne ; le live à cote élevée est la plus forte variance.
  Les garde-fous limitent la perte, ils ne créent pas de rendement.
- Les CGU d'un bookmaker interdisent généralement l'automatisation : risque de clôture de compte. Décision assumée par l'utilisateur.

Critères de réussite : (1) aucune limite du §4 ne peut être dépassée, quoi que réponde JEV ou que fasse la page ;
(2) toute anomalie arrête tout (jamais de nouvel essai silencieux) ; (3) un mode « à blanc » exécute tout sauf le clic final ;
(4) l'arrêt d'urgence fonctionne à tout moment.

## 2. Ce que montre le HTML fourni (faits, pas hypothèses)

- Liste live : `/live`, `sports-live-page`, un bloc par sport `sports-live-event-bucket` (`.sportlist_name`), cartes
  `a.cardEvent.is-live[href]` (+ `aria-label="Domicile - Extérieur"`), temps `scoreboards-timer` (« 18' • MT 1 », « 7:41 • Q1 »,
  « 5ème manche », « Débute »), score `[data-qa=scoreboard-score]` ou tableau `.scoreboard_tableRow`. Les cartes n'exposent que
  le marché principal (1X2 / vainqueur). Cote suspendue : bouton `disabled`, classe `is-strikethrough`, texte « - ».
- Page match : onglets de catégorie dont **« ⚡ Fast »** (sans doute les marchés rapides ; son HTML manque), « Le Top », « Résultats »,
  « Joueurs », « Buts », « Score exact ». Boutons de cote : `button[data-qa=market-selection]` ; sélection ajoutée = classe `is-active`.
- Ticket : `sports-betting-slip` ; carte `betting-slip-selection-card` (`.progressiveBettingSlip_cardMarketLabel` = sélection,
  `_cardMarketValue` = marché, `_cardEventName`), cote `betting-slip-odds-field .btn_label`, mise `input[name=stakeField]`
  (Angular : il faut le setter natif + événement `input`), gains `.progressiveBettingSlip_footerValue`, validation
  `#betBtn[data-qa=betting-slip-bet-button]` (désactivé tant que la mise est invalide), suppression `.icon_close` dans la carte.
- Signaux de confirmation disponibles sans voir le reçu : solde `bc-header-wallets` (6,53 €), compteur « Mes paris »
  `bc-header-my-bets-button bc-notification` (3 → 5 entre deux pages), carte du ticket qui disparaît.

## 3. Architecture

Dans le content script de l'onglet Betclic, machine à états persistée dans `chrome.storage.session` (survit aux rechargements).
La clé API reste dans le service worker, comme aujourd'hui. Nouveaux fichiers sous `extension/src/auto/` :

| Module | Rôle | Dépend de | Testable sans navigateur |
|---|---|---|---|
| `guard.js` | seul juge des limites ; calcule la mise max autorisée ; dit OUI/NON/ARRÊT | config | oui |
| `scanner.js` | lit `/live` : événements, sport, temps, scores, 1X2 disponible/suspendu | DOM | oui (jsdom) |
| `selector.js` | choisit l'événement puis les marchés rapides (liste blanche par sport, confiance JEV min., cote max.) | scanner, JEV | oui |
| `executor.js` | **seul module qui clique** : sélection, mise, validation, vérifications | DOM, guard | oui (jsdom + faux site) |
| `controller.js` | états `ARMÉ → SCAN → CHOIX → ANALYSE → GARDE-FOUS → EXÉCUTION → ATTENTE → PAUSE → SCAN`, `ARRÊT` collant | tout | oui |
| `auto-ui.js` | panneau « Auto » (état, journal, solde, bilan, STOP) dans un hôte Shadow DOM | controller | partiel |

Réutilisés tels quels : parser des marchés, requête JEV (`background.js`), contexte du match, lecture du ticket et du solde.

Le tri des événements est heuristique et simple (phase du match, marchés rapides disponibles, aucune cote suspendue) ; JEV ne sert
qu'à choisir la sélection d'un marché et le niveau de mise, comme aujourd'hui.

## 4. Garde-fous (profil agressif, codés en dur dans `guard.js`)

Sur le solde au démarrage de la session : mise ≤ 10 % ; perte de session ≤ 50 % (puis arrêt total) ; ≤ 20 paris ;
arrêt après 5 pertes d'affilée ; ≤ 3 paris ouverts à la fois (à confirmer) ; cote comprise entre `minOdds` et `maxOdds` (config) ;
refus si la cote a dérivé de plus de `maxDriftPct` entre l'analyse et le ticket ; refus si marché suspendu ; refus si le temps
restant est trop court pour que le pari soit sûr d'être pris ; jamais plus de la mise suggérée par `suggestStake`, elle-même plafonnée.
Ces valeurs vivent dans `CONFIG.auto`, mais `guard.js` rejette toute valeur qui dépasse les plafonds absolus du code
(l'utilisateur peut durcir, pas relâcher sans modifier le code).

## 5. Exécution d'un pari (executor), chaque étape vérifiée

1. Préconditions : ticket vide, solde lu, session non arrêtée, `guard` = OUI.
2. Clic sur la cote (page match) → attendre la carte du ticket ; vérifier **sélection, marché et événement** identiques à la décision ;
   cote du ticket vs cote analysée (dérive).
3. Mise : `guard` fixe le montant ; saisie via setter natif + `input` ; vérifier que les gains affichés = mise × cote (± arrondi).
4. Mode à blanc : s'arrêter ici, retirer la sélection, journaliser.
5. Clic sur `#betBtn` ; attendre jusqu'à `confirmTimeoutMs` : succès = (solde baisse ≈ mise ET/OU compteur « Mes paris » +1 ET ticket vidé).
   Sinon → ARRÊT (on ne reclique jamais).
6. Toute bannière du ticket (cotes modifiées, mise refusée, erreur) = ARRÊT + nettoyage (retirer la sélection).

## 6. Mise en route et arrêt d'urgence

Désactivé par défaut. Armement : taper une phrase de confirmation à chaque session (rien n'est mémorisé d'une session à l'autre).
La première session recommandée est à blanc. ARRÊT : bouton STOP, touche Échap, onglet masqué/fermé trop longtemps, toute exception,
toute vérification en échec. ARRÊT est collant : il faut réarmer à la main.

## 7. Suivi du résultat

Pertes/gains de session = variation du solde (en comptant les mises en cours). La détection « pari gagné/perdu » pour la règle des
5 pertes d'affilée exige le HTML de « Mes paris » ; en attendant, seule la limite de perte de session par le solde est appliquée
(et c'est dit dans l'UI).

## 8. Tests

`guard` (limites, fuzz : aucune entrée ne passe les plafonds), `selector`, `controller` (transitions, ARRÊT collant) en pur Node ;
`scanner` et `executor` sur des fixtures jsdom dérivées du HTML réel avec un faux site qui simule : succès, cote qui bouge,
marché suspendu, mise refusée, ticket qui ne se vide pas. Test explicite : en mode à blanc, `#betBtn` n'est jamais cliqué.

## 9. Hors périmètre

Plusieurs onglets, backend, dépôts/retraits, tennis tant qu'aucune page live tennis n'est fournie, apprentissage des résultats.

## 10. HTML encore nécessaire avant d'écrire `executor` et `selector`

1. L'onglet **« ⚡ Fast »** d'une page match live (marchés rapides).
2. L'écran **juste après le clic sur « Parier »** (reçu / confirmation / refus).
3. Le panneau **« Mes paris »** avec un pari en cours et un pari réglé.
4. Le ticket quand la **cote change** (bannière « cotes modifiées ») et quand un marché est **suspendu**.
5. Une page live **tennis** si tennis est voulu.

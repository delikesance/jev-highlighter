# Mode automatique (paris live rapides) — design

Statut : brouillon révisé à relire. Aucune ligne de code n'est écrite avant validation de ce document.

## 1. Intention

Un mode « Auto » qui, une fois armé par l'utilisateur, choisit un événement live sur Betclic, fait analyser des paris
« rapides » par JEV (avec le contexte du match), puis **place lui-même les paris** dans des limites strictes.
But de l'utilisateur : « gain rapide » sur des marchés qui se règlent en quelques minutes.

Décisions de l'utilisateur (2026-10-03) :
- Portée : **l'extension parie seule** (sélectionne, saisit la mise, valide). Cela lève, **pour le mode Auto uniquement**, la règle
  d'origine « ne jamais cliquer un pari / saisir une mise / valider ». Toutes les autres fonctions restent en lecture seule.
- Profil de risque : **agressif** (voir §4).
- Marchés « rapides » : foot (prochain but, + de 0,5 sur la période, corner, carton, prochain buteur), basket (prochain panier,
  total du quart-temps). **Tennis (prochain jeu/set) : différé**, hors v1 (aucun HTML live tennis fourni, voir §9 et §10).

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
- Page match : onglets de catégorie dont **« ⚡ Fast »** (marchés rapides, détaillé en §2 bis), « Le Top », « Résultats »,
  « Joueurs », « Buts », « Score exact ». Boutons de cote : `button[data-qa=market-selection]` ; sélection ajoutée = classe `is-active`.
- Ticket : `sports-betting-slip` ; carte `betting-slip-selection-card` (`.progressiveBettingSlip_cardMarketLabel` = sélection,
  `_cardMarketValue` = marché, `_cardEventName`), cote `betting-slip-odds-field .btn_label`, mise `input[name=stakeField]`
  (Angular : il faut le setter natif + événement `input`), gains `.progressiveBettingSlip_footerValue`, validation
  `#betBtn[data-qa=betting-slip-bet-button]` (désactivé tant que la mise est invalide), suppression `.icon_close` dans la carte.
- Solde et compteur « Mes paris » : voir §2 bis (le solde se lit en direct uniquement ; le compteur est informatif).

## 2 bis — Faits DOM supplémentaires

**Onglet ⚡ Fast.** Sous-filtres `sports-sub-category-filters .filters_item` : Top / But / Joueurs. Sections
`h2.marketBox_categoryTitle[data-section]` (ex. `subca_ftb_rt`, `subca_ftb_ntgl`, `subca_ftb_ntgr`). Les marchés à fenêtre de temps
(`sports-tabs-markets`) portent la fenêtre dans `.marketBox_marketHandler` (« 30:00 - 34:59 ») avec un bouton « Modifier ».
Titres observés : « Résultat sur la période (seule) », « Nombre total de buts sur la période (seule) », « But 1/But 2 sur la période
(seule) », « Quand sera marqué le 2ème but ? » (les sélections sont des fenêtres), « Buteur - But 2 », « Prochain buteur Canada - 2ème
but », « Premier buteur - Pérou ». Conséquences :
- constat parseur : `parser.js` n'extrait pas `.marketBox_marketHandler` ; l'id de marché = slug du titre + hash d'options (ou compteur
  `_2`, `_3`) en cas de collision, donc **instable** (deux fenêtres du même titre se distinguent par l'ordre d'apparition). À corriger :
  la fenêtre est extraite et entre dans la question posée à JEV et dans l'id ;
- le même marché apparaît dans plusieurs sections : dédupliquer sur (titre, fenêtre, sélection) ; en cas de doute, **fait foi la cote
  relue sur le ticket** (§5 étape 2), jamais la cote de la liste ;
- ne parier sur une fenêtre que si la minute courante (`scoreboards-timer`) est strictement avant le début de la fenêtre, avec la
  marge de §4.

**Ticket.** Vide : `.progressiveBettingSlip_headerTitle` = « 0 sélection » ; `#betBtn[data-qa=betting-slip-bet-button]`. Avec sélection :
`betting-slip-selection-card`, `.progressiveBettingSlip_cardMarketLabel` (sélection), `.progressiveBettingSlip_cardMarketValue`
(marché + fenêtre, ex. « Résultat sur la période 30:00 - 34:59 »), `input[name=stakeField]` (Angular : setter natif + évènement `input`),
gains `.progressiveBettingSlip_footerValue`, cote `betting-slip-footer-odds`. Le ticket sert à vérifier que le marché et la fenêtre
cliqués sont les bons avant toute saisie de mise.

**Modale après « Parier ».** `sports-bet-confirmation-modal` ; titre `[data-qa=bet-confirmation-title]` (« Super ! Ton pari est validé ») ;
`[data-qa=bet-confirmation-stake-amount]`, `[data-qa=bet-confirmation-odds]`, `[data-qa=bet-confirmation-winnings-amount]` ;
boutons `[data-qa=bet-confirmation-close-selections]` (« Fermer », à cliquer) et `[data-qa=bet-confirmation-keep-selections]`
(**ne jamais cliquer**). Les modales de refus ou de cotes modifiées n'ont pas été observées.

**En-tête.** Solde : `bc-header-wallets .header_walletBalance span`, lecture en direct uniquement ; l'état SSR `ng-state` est périmé et
n'est jamais utilisé. Badge `bc-header-my-bets-button bc-notification` : nombre global de paris en cours,
informatif seulement, il ne bloque rien.

**Mes paris.** `my-bets-page` ; filtres `[data-qa=my-bets-filter-ongoing|ended|won]` ; cartes `bet-card[data-qa=<id>]` avec
`[data-qa=bet-card-stake]`, `[data-qa=bet-card-winnings]`, `[data-qa=bet-card-reference]`. Cartes terminées : classes `is-ended` +
`is-lost` ou `is-won`, tag `[data-qa=bet-card-status-tag]` (`is-negative` « Perdu » / `is-positive` « Gagné »). Sert à compter les
pertes consécutives ; la liste n'est pas chronologique, il faut trier par date.

## 3. Architecture

Dans le content script de l'onglet Betclic, machine à états persistée dans `chrome.storage.session` (survit aux rechargements).
La clé API ne doit **jamais** atteindre le content script (voir §3 bis, condition d'activation du mode Auto). Nouveaux fichiers sous `extension/src/auto/` :

| Module | Rôle | Dépend de | Testable sans navigateur |
|---|---|---|---|
| `guard.js` | seul juge des limites ; calcule la mise max autorisée ; dit OUI/NON/ARRÊT | config | oui |
| `scanner.js` | lit `/live` : événements, sport, temps, scores, 1X2 disponible/suspendu | DOM | oui (jsdom) |
| `selector.js` | choisit l'événement puis les marchés rapides (liste blanche par sport, confiance JEV min., cote max.) | scanner, JEV | oui |
| `executor.js` | **seul module qui clique, saisit, valide ou appelle `dispatchEvent`** (voir §3 ter) | DOM, guard | oui (jsdom + faux site) |
| `controller.js` | états `ARMÉ → SCAN → CHOIX → ANALYSE → GARDE-FOUS → EXÉCUTION → ATTENTE → PAUSE → SCAN`, `ARRÊT` collant | tout | oui |
| `auto-ui.js` | panneau « Auto » (état, journal, solde, bilan, STOP) dans un hôte Shadow DOM | controller | partiel |

Réutilisés : parser des marchés (avec la correction de §2 bis), requête JEV via le service worker, contexte du match, lecture du
ticket et du solde.

**Tri des événements** (`selector.js`, déterministe, sans JEV) : on écarte tout événement dont le 1X2 est suspendu, sans marché
rapide disponible, dont la phase n'est pas « en cours » (« Débute », mi-temps, terminé), ou déjà tenté dans la session ; puis on
trie par (1) nombre de marchés rapides disponibles décroissant, (2) minute de jeu croissante (le plus de temps restant), (3) ordre
d'apparition sur /live. Le premier est choisi. JEV ne sert qu'à choisir la sélection d'un marché et le niveau de mise.
`confidence` (nombre 0-1 renvoyé par JEV, `null` si absent) : une sélection est retenue seulement si `confidence` est un nombre
≥ `minConfidence` ; `null` = refus. Un score JEV sans `confidence` n'est donc jamais joué.

**Navigation.** Le `controller` navigue vers l'événement choisi par `location.assign(a.cardEvent[href])` (même onglet, href relevé
par `scanner`, hôte vérifié = celui de Betclic). Ce n'est pas un clic de pari ; l'état de la machine est dans `chrome.storage.session`
et survit à ce chargement. Aucun `click()` n'est émis hors `executor.js`.

## 3 bis. Clé API : découpage imposé

Le mode Auto ne tourne **que** si : (a) `getSettings` côté content script renvoie les réglages **sans** `apiKey` ; (b) tout appel JEV
passe par le service worker (message runtime `JEV_EVALUATE`) ; (c) aucun fichier chargé en content script ne lit `apiKey`.
Au démarrage, le controller vérifie (a) (`'apiKey' in settings` → ARRÊT, mode Auto refusé).

État actuel (lu dans le dépôt) et écart à corriger, **tâche prérequise n° 1 du plan** :
- `background.js` est déjà le seul à faire le `fetch` JEV, via `JEV_EVALUATE` : conforme ;
- `storage.js` est chargé dans le content script (`manifest.json`) et son `getSettings()` renvoie `apiKey` (clé dans `chrome.storage.local`,
  lisible depuis le content script) : **écart** ;
- `jev.js` est chargé dans le content script et son `resolveTarget` lit `settings.apiKey` : **écart** (code mort côté page mais présent) ;
- `content.js` appelle `Storage.getSettings()` (ligne ~380) : reçoit donc la clé : **écart**.
Correctif prévu : `getSettings` filtré (variante content script sans `apiKey`, `isConfigured` basé sur un booléen `hasKey` fourni par le
service worker), `jev.js` retiré des `content_scripts` du manifeste (le service worker l'importe déjà), la saisie de la clé par le popup
via le service worker. Limite honnête : `chrome.storage.local` n'a pas de contrôle d'accès par contexte, la clé y restant lisible par du
code content script qui irait la chercher ; d'où un test statique (grep) interdisant `apiKey` dans tout fichier listé dans
`content_scripts`, et le contrôle (a) à l'exécution.

## 3 ter. Périmètre de `executor.js`

Seul `executor.js` appelle `.click()`, assigne une valeur de champ, soumet ou appelle `dispatchEvent`/`new Event`/`new MouseEvent`.
**Test statique** (grep sur `extension/src/**` hors `executor.js` et hors tests) qui échoue si `\.click\(`, `dispatchEvent`,
`new (Mouse|Input|Keyboard)?Event`, `\.submit\(` ou l'assignation `.value =` sur un `input` Betclic apparaît ailleurs. Les modules
existants qui en font déjà usage hors Auto sont à lister et exemptés explicitement, un par un, dans le test (liste fermée).

## 4. Garde-fous (profil agressif, codés en dur dans `guard.js`)

`CONFIG.auto` porte les valeurs réglables ; `guard.js` rejette (ARRÊT au démarrage) toute valeur hors plafond dur : l'utilisateur
peut durcir, pas relâcher sans modifier le code.

| Limite | Défaut | Plafond dur codé |
|---|---|---|
| Mise par pari | min(10 % du solde de départ, `suggestStake`) | 10 % du solde de départ (jamais plus que `suggestStake`, le plus bas gagne) |
| Perte de session (réserve incluse) | 50 % du solde de départ | 50 % |
| Paris Auto par session | 5 | 5 |
| Défaites consécutives avant ARRÊT | 3 | 3 |
| Cote `minOdds` / `maxOdds` | 1,30 / 4,00 | `minOdds` ≥ 1,20 ; `maxOdds` ≤ 6,00 |
| Dérive de cote `maxDriftPct` (analyse→ticket, puis relecture finale) | 3 % | 5 % |
| Marge de temps avant fenêtre/fin `minLeadSec` | 90 s | ≥ 60 s |
| `minConfidence` JEV | 0,60 | ≥ 0,50 |
| Attente de confirmation `confirmTimeoutMs` | 8000 ms | 15000 ms |
| Onglet masqué toléré avant un clic | 5 s | 10 s |

Règles :
- **Mise** ≤ min(10 % du solde de départ, `suggestStake`) ; le montant le plus bas gagne, arrondi à l'inférieur au centime.
- **Perte de session** ≤ 50 % du solde de départ (puis ARRÊT). Perte = solde de départ − solde en direct, **plus une réserve** :
  chaque pari dont le résultat n'est pas vérifié (en cours, ou « validation en cours » sans confirmation, §5bis) est compté comme
  entièrement perdu (mise engagée). Un nouveau pari n'est autorisé que si perte + réserve + sa mise ≤ 50 % du solde de départ.
- **3 défaites d'affilée → ARRÊT** (le « ≤ 20 paris » est supprimé : redondant avec ≤ 5 paris Auto/session ; le badge global « Mes paris »
  ne bloque rien).
- Refus si marché suspendu, si cote hors [`minOdds`, `maxOdds`], si dérive > `maxDriftPct`.
- **« Temps restant trop court »** : pour un marché à fenêtre, (début de fenêtre − minute courante) < `minLeadSec` ; pour un marché sans
  fenêtre (prochain but, etc.), la période ne doit pas être dans ses `minLeadSec` dernières secondes (mi-temps/fin de quart) ; minute
  illisible = trop court. Calculé en secondes à partir de `scoreboards-timer`.

## 5. Exécution d'un pari (executor), chaque étape vérifiée

Avant **chaque** étape : le drapeau STOP (`chrome.storage.session`, posé par STOP/Échap/ARRÊT) est relu ; s'il est levé, on s'arrête
et on retire la sélection du ticket si elle existe.

1. Préconditions : ticket **vide** (`.progressiveBettingSlip_headerTitle` = « 0 sélection »), solde lu, session non arrêtée, `guard` = OUI.
   Si le ticket contient déjà une sélection (ajoutée par l'utilisateur ou résidu) : **ARRÊT, rien n'est retiré ni modifié** (ce n'est pas
   notre sélection) et l'utilisateur est invité à vider le ticket lui-même.
2. Clic sur la cote (page match) → attendre la carte du ticket ; vérifier **sélection, marché, fenêtre (`_cardMarketValue`) et événement**
   identiques à la décision ; cote du ticket vs cote analysée (dérive ≤ `maxDriftPct`). La cote du ticket fait foi.
3. Mise : `guard` fixe le montant ; saisie via setter natif + `input` ; vérifier que les gains affichés = mise × cote (± 0,01) ;
   **relire la cote** après la saisie (elle peut bouger) : dérive recalculée.
4. Mode à blanc : s'arrêter ici, retirer la sélection, journaliser.
5. **Relecture finale juste avant `#betBtn`** : minute (`scoreboards-timer`), fenêtre affichée dans la carte du ticket, cote et gains.
   Recomparer la cote à l'analyse (`maxDriftPct`), la fenêtre à la décision, et vérifier « temps restant » ≥ `minLeadSec` (§4). Aussi :
   `#betBtn` présent, activé, libellé attendu (« Parier »), aucun élément inconnu dans `sports-betting-slip`, onglet visible. Un seul
   échec = ARRÊT + retrait de la sélection.
6. Écrire dans `chrome.storage.session` l'état **« validation en cours »** (marché, fenêtre, mise, heure) **avant** le clic ; puis clic sur `#betBtn` ;
   attendre jusqu'à `confirmTimeoutMs` : succès = modale « validé » (`bet-confirmation-title`) ET mise et cote relues dans la modale
   égales à celles saisies. Puis clic sur « Fermer » (`bet-confirmation-close-selections`), jamais sur `bet-confirmation-keep-selections`.
   Pas de modale « validé » dans le délai = échec : ARRÊT collant, aucun nouvel essai, texte du ticket journalisé ; l'état « validation en
   cours » est conservé.
7. **Anomalies** → ARRÊT + journal du texte + retrait de la sélection : bannière ou élément inconnu dans `sports-betting-slip` (cotes
   modifiées, erreur, mise refusée, etc., même non observés), bouton `#betBtn` au libellé changé (ex. « Accepter les cotes » : **jamais
   cliqué**), marché suspendu (cote désactivée / `is-strikethrough`). Onglet masqué : ARRÊT avant un clic seulement s'il reste masqué plus
   de 5 s (valeur §4) ; un onglet masqué ne déclenche jamais de clic.

## 5 bis. Double validation et reprise

L'état « validation en cours » écrit à l'étape 6 vit dans `chrome.storage.session`, dont le service worker doit ouvrir l'accès au
content script par `chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })` (par défaut, seul le contexte de confiance y accède).
Au démarrage ou rechargement de la page : si cet état est présent sans résultat (confirmation relevée ou clos par vérification manuelle),
le controller passe en **ARRÊT collant, sans aucun nouvel essai**, et demande une **vérification manuelle** (« Mes paris » + solde).
Ce pari compte dans `guard` même sans confirmation (réserve de §4 : mise engagée, +1 au compteur de 5). Seul l'utilisateur, en réarmant
avec la phrase de confirmation après vérification, efface l'état.

## 6. Mise en route et arrêt d'urgence

Désactivé par défaut. Armement : taper une phrase de confirmation à chaque session (rien n'est mémorisé d'une session à l'autre).
La première session recommandée est à blanc. À l'armement, rappel affiché et à confirmer : **aucun pari manuel pendant la session Auto**
(le suivi du §7 en dépend). ARRÊT : bouton STOP, touche Échap, onglet masqué plus de 5 s avant un clic ou fermé, toute exception, toute
vérification en échec. STOP/Échap lèvent le drapeau relu avant chaque étape du §5. ARRÊT est collant : il faut réarmer à la main.

## 7. Suivi du résultat

Méthode (c). Aucun pari manuel pendant la session. Avant le clic de validation, mémoriser les cartes `ongoing` de « Mes paris »
(`bet-card[data-qa]`) ; après la confirmation, relire : **exactement une nouvelle carte** = le pari Auto, dont on mémorise la
`bet-card-reference` (aussi journalisée). Le pari est ensuite suivi par cette référence (carte `is-ended` + `is-lost`/`is-won`, tag
`bet-card-status-tag`) ; la règle des 3 défaites d'affilée compte ces paris dans l'ordre de placement.

Secours (b) : si la comparaison est ambiguë (0 ou ≥ 2 nouvelles cartes) ou échoue, les défaites sont déduites du **solde lu en direct**
(solde < solde avant le pari + mises non réglées → défaite, en tenant compte des mises en cours). Si cela aussi est impossible
(solde illisible), ARRÊT.

Pertes/gains de session = variation du solde en direct, mises non vérifiées comptées comme engagées (§4).

## 8. Tests

`guard` (limites, fuzz : aucune entrée ne passe les plafonds), `selector`, `controller` (transitions, ARRÊT collant) en pur Node ;
`scanner` et `executor` sur des fixtures jsdom dérivées du HTML réel avec un faux site qui simule : succès, cote qui bouge,
marché suspendu, mise refusée, absence de modale « validé », modale « validé » avec mise/cote différentes, doublons de marchés entre
sections, fenêtre déjà commencée. Tests supplémentaires : reprise après rechargement pendant l'exécution (état « validation en cours » → ARRÊT collant, pas de
retry, réserve comptée) ; dérive de minute (la minute avance entre l'analyse et la relecture finale, fenêtre atteinte ou marge
< `minLeadSec` → ARRÊT) ; cote qui bouge après la saisie de la mise (dérive > `maxDriftPct` → ARRÊT) ; ticket non vide au départ
(ARRÊT sans toucher à la sélection) ; bouton `#betBtn` « Accepter les cotes » (jamais cliqué) ; suivi de la référence (une seule
nouvelle carte, ambiguïté → secours solde) ; `getSettings` côté content script sans `apiKey`. Test statique : **un seul module
clique** (grep de §3 ter). Test explicite : en mode à blanc, `#betBtn` n'est jamais cliqué.

## 9. Hors périmètre

Plusieurs onglets, backend, dépôts/retraits, tennis (différé, §1) tant qu'aucune page live tennis n'est fournie, apprentissage des résultats.

## 10. HTML encore nécessaire (uniquement ce qui manque)

1. Le ticket quand la **cote change** (bannière « cotes modifiées ») et quand un marché est **suspendu**.
2. Toute **modale ou bannière de refus** après « Parier » (mise refusée, erreur) : non observée.
3. Une page live **tennis**, si tennis est voulu plus tard.
4. La **référence du pari** (`bet-card-reference`) éventuellement présente dans la modale de confirmation, et sur la carte d'un pari
   terminé du mode Auto (déjà couverte pour « Mes paris », à confirmer sur un pari Auto réel) : sert à le suivre (§7).

Le contenu de l'onglet Fast, le ticket, la modale de confirmation, l'en-tête et « Mes paris » sont déjà couverts (§2 bis).

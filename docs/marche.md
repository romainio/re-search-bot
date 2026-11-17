# Indicateurs de marché (chantier 8)

Indices pour décider vite : combien de temps une annonce reste en ligne, à quel prix au m² se louent les biens de la zone, combien
d'annonces nouvelles arrivent par jour. Jamais un filtre : aucune alerte n'est retirée ou retardée à cause d'eux (règle commune 2).

Code : `src/market.ts` ; tables : migration `0009_market.sql` ; constantes : `src/config/market.ts` (`MARKET_*`) ; tests : `test/market.test.ts`.

## Ce qui est calculé

Fenêtre : 30 jours (`MARKET_WINDOW_DAYS`). Groupes : (zone, tranche de pièces) et zone entière (« toutes »). Zone : code
postal d'une zone de l'instance (`settings().zones`). Tranches : 1, 2, 3, 4 et plus (`MARKET_MAX_ROOMS_BUCKET`) ; nombre de pièces inconnu ou nul : compté
dans la zone entière seulement. Choix de la tranche de pièces plutôt que de surface : c'est l'unité de recherche (« 2 pièces »)
et la colonne `listings.rooms` (migration 0009, remplie à l'insertion par `process.ts`) évite de relire les payloads.

| Indicateur                  | Définition                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| Durée de vie médiane        | de `first_seen` à `gone_at` du cluster (toutes ses lignes disparues, dernière date), par groupe     |
| Loyer médian au m²          | `rent_cc / surface`, surfaces de 9 à 250 m² (`MARKET_SURFACE_RANGE`), par groupe                    |
| Nouvelles annonces par jour | annonces gardées détectées par jour UTC (le scan tourne de 7h à 19h UTC : jour UTC = jour de Paris) |

## Biais écartés

- **Annonces suivies seulement** : statuts `pending` et `sent` (durée de vie, nouvelles par jour) ; le prix au m² ajoute `silent`
  (stock d'une zone ajoutée : il renseigne le marché). Jamais `filtered`. `silent` est exclu de la durée de vie : son `first_seen`
  est la date du lancement, pas celle de la mise en ligne.
- **Doublons** : `duplicate` est exclu ; un appartement compte une fois (son cluster). Il est « disparu » seulement quand toutes
  ses lignes suivies le sont ; une annonce encore visible sur une autre source garde le cluster en ligne.
- **Censure** : une annonce encore en ligne n'a pas de durée connue. La compter à sa durée « jusqu'à maintenant » ou l'ignorer
  ferait paraître le marché plus rapide qu'il n'est. On retient donc une cohorte : les annonces détectées entre J-30 et J-10
  (`MARKET_LIFETIME_HORIZON_DAYS`), toutes observées sur l'horizon complet. Disparue dans l'horizon : sa durée. Sinon (encore en
  ligne, ou disparue plus tard) : « plus longue que l'horizon », classée après toutes les durées connues. La médiane n'existe
  que si la moitié de la cohorte au moins a disparu dans l'horizon ; sinon elle vaut `NULL` et s'affiche « > 10 j ».
  Contrepartie assumée : les annonces des 10 derniers jours n'entrent pas dans la durée de vie (elles entrent dans le prix et
  la tendance).
- **Effectif minimum** : `MARKET_MIN_SAMPLE` = 8 annonces par groupe. En dessous, ni médiane, ni indice, ni ligne de tableau
  (appliqué à la lecture, les effectifs sont stockés). Une tranche sous le minimum se rabat sur la zone entière pour l'écart de
  prix et le signal « part vite » (le libellé le dit : « vs médiane Paris 17 »).

## Calcul et coût

Les médianes se calculent **en SQL** (fonctions de fenêtre `ROW_NUMBER` et `COUNT` par groupe, moyenne des deux rangs centraux) :
le Worker ne reçoit qu'une vingtaine de lignes et ne lit aucun payload. Un recalcul fait 3 requêtes d'agrégat en un lot puis
un lot d'écritures (suppression et réinsertion des tables, une trentaine de lignes), soit environ 1 écriture par ligne
13 recalculs par jour (cron de 7h à 19h UTC). Lectures D1 par recalcul, avec K = annonces gardées détectées sur 30 jours : durée de vie
(cohorte, via l'index `listings_status_seen`) environ 3 lectures par annonce de cohorte (la ligne et les lignes de son cluster,
index `listings_cluster`), prix au m² K, nouvelles par jour K (index couvrant), soit environ 5 K lectures. Avec 20 annonces
gardées par jour (K = 600), environ 3 000 lectures par recalcul, 36 000 par jour pour 5 000 000 de lectures gratuites. Le
contrôle de fraîcheur coûte une lecture d'une ligne (`market_meta`) par minute du cron.

Le calcul n'est pas dans le tableau de bord : une visite publique ne fait aucune écriture. Le cron (`scheduled` de `src/index.ts`)
appelle `refreshMarketStats` à chaque minute : une lecture de `market_meta`, et un recalcul seulement si le dernier a plus de
`MARKET_REFRESH_MINUTES` (60) minutes. Le calcul se passe côté D1 : le CPU du Worker (10 ms) n'y contribue que par l'attente des
réponses.

## Où c'est affiché

- **Tableau de bord** : section « Marché (30 jours) » (tableau zone × tranche, tendance, barres des 30 jours en CSS, méthode en
  une phrase, heure du calcul). Toujours visible : elle ne coûte qu'un lot de trois lectures de petites tables (moins de 150
  lignes) et aucun calcul. Sur chaque carte : « 📊 −8 % vs médiane Paris 17 · 2 p. · part vite (médiane 30 h) ». Avant le
  premier calcul : « en cours de calcul ».
- **Alerte Telegram** : la même ligne (`formatTelegram`, 4e paramètre), seulement si `MARKET_HINTS` vaut `"true"`. Courte
  (moins de 100 caractères), placée avant la description : le rabotage existant raccourcit la description, puis le titre,
  puis l'adresse, sans toucher à cette ligne ; la légende reste à 1 024 caractères au plus (test).
- **Bilan du soir** : une ligne « 📈 Nouvelles annonces : 2,0/jour sur 7 j ↗ (1,0 les 7 précédents) » si `MARKET_HINTS` vaut
  `"true"` et que les 14 derniers jours complets comptent au moins 8 annonces.

## Réglages

Constantes de `src/config/market.ts` : `MARKET_WINDOW_DAYS` (30), `MARKET_LIFETIME_HORIZON_DAYS` (10), `MARKET_MIN_SAMPLE` (8),
`MARKET_REFRESH_MINUTES` (60), `MARKET_FAST_HOURS` (72, seuil « part vite »), `MARKET_MAX_ROOMS_BUCKET` (4),
`MARKET_SURFACE_RANGE` (9 à 250 m²), `MARKET_TREND_DAYS` (7), `MARKET_TREND_FLAT` (15 %, seuil de la flèche →).

Activer la ligne des alertes : `"MARKET_HINTS": "true"` dans `vars` de `wrangler.jsonc`, puis déploiement.

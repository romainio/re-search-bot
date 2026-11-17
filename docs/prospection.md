# Prospection des agences

Objectif : trouver, chaque mois, des agences des zones de `instance.config.json` que le registre (`src/sources.ts`) ne lit pas encore, et
dire si on sait déjà lire leur site. Un **indice pour l'utilisateur**, jamais une source ajoutée automatiquement. Éteinte par défaut.

## Sources ouvertes (gratuites)

| Source                                                                   | Usage                                                                                                                                            | Limites constatées le 09/11/2026                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Recherche d'entreprises (`recherche-entreprises.api.gouv.fr/search`) | `activite_principale=68.31Z`, `code_postal`, `etat_administratif=A`, 25 résultats par page (maximum)                                             | environ 7 requêtes par seconde (HTTP 429 au-delà) ; ~110 Ko par page. Le 17e : ~1 900 entreprises sur 77 pages, Levallois : ~470 sur 19 pages. Elle **ne donne ni site ni téléphone**.                                                                                                                                                                                                                         |
| OpenStreetMap Overpass (`overpass-api.de`)                               | `shop=estate_agent` et `office=estate_agent` dans l'emprise de chaque zone (`bbox` des zones, `settings().prospect.bbox`), `out center tags 200` | Serveur public souvent saturé (HTTP 502, 504) et qui réserve l'usage « automatisé intensif » à des instances locales : on n'envoie qu'une requête par zone et par mois, avec un `User-Agent` qui identifie l'outil (sans e-mail), et un échec est simplement retenté au pas suivant. Couverture OSM faible : 5 agences nommées dans l'emprise le 09/11. C'est la seule source de **site web** et de téléphone. |

Les fixtures `test/fixtures/prospect_*.json` sont de vraies réponses de ces deux API, réduites (prises une seule fois le 09/11/2026).

## Fonctionnement

Une campagne = suite de **pas** reprenables, état en D1 (`prospect_state`, une ligne) :

1. `entreprises` : `PROSPECT_PAGES_PER_STEP` (3) pages de l'API par pas, zone par zone ; les établissements fermés sont écartés.
2. `osm` : une zone Overpass par pas.
3. `sites` : pour chaque candidat avec site, lecture de la page d'accueil (300 Ko au plus, 8 sites par pas) et détection du gabarit.
   Sans site : `aucun_site`, aucune lecture.
4. `fin` : si des candidats nouveaux **avec site** existent, UN message Telegram récapitulatif ; la phase passe à `repos`
   avant l'envoi (jamais deux messages). Les agences sans site restent au tableau de bord sans déclencher de message.

Chaque pas : au plus `PROSPECT_STEP_BUDGET` (20) sous-requêtes (sous les 50 du plan gratuit), bail de 60 s (deux crons voisins ne
se chevauchent pas), jamais d'exception ; un pas en échec laisse le curseur et réessaie, la phase est abandonnée après 5 échecs
de suite. Une campagne complète, avec ~100 pages d'API, tient en une quarantaine de pas, soit une nuit de cron.

**Déclenchement** : `scheduled` (`src/index.ts`) lance un pas quand le passage n'est ni dans la fenêtre active (scan) ni dans le
créneau du résumé du soir, et seulement si `PROSPECT_ENABLED="true"`. Hors fenêtre : l'été 21h05-21h59 de Paris (cron `5-59 19`),
l'hiver 8h (cron `7`). Une nouvelle campagne démarre quand la précédente a commencé il y a 28 jours (`PROSPECT_INTERVAL_DAYS`).
Ni le scan ni le résumé ne sont touchés. Le CPU d'un pas reste très sous 10 ms (3 JSON de ~110 Ko au plus, réponse Overpass bornée à 400 Ko).

**Route admin** : `GET /prospect?k=CLE` lance un pas et renvoie le rapport JSON (`phase`, `subrequests`, `written`, `inRegistry`,
`sitesChecked`, `failed`) ; au repos, elle démarre une campagne. À appeler en boucle pour dérouler une campagne à la main.

## Rapprochement avec le registre

`src/prospect/match.ts` : un candidat est écarté si le nom normalisé (sans accents, formes juridiques, « immobilier », lieux…)
contient tous les mots d'identification d'une source (nom ou identifiant), ou si son site a le même domaine qu'une source. Les
hôtes de plateformes partagées (`PROSPECT_PLATFORM_DOMAINS` : La Boîte Immo, Orpi, Century 21…) ne se comparent qu'à l'hôte exact.
Les réseaux déjà lus (Orpi, Century 21, Laforêt, ERA, Foncia, Nestenn) écartent donc leurs agences. Les candidats de l'API et d'OSM
qui désignent la même agence sont fusionnés (le site OSM complète la ligne de l'API).

## Détection du gabarit

`src/prospect/template.ts`, signatures déterministes relevées dans les lecteurs et les fixtures : `bObcat` (La Boîte Immo, `lbi` ou
`lbi2` selon `property-listing-v2/v3`), `_TEMPLATE_DATA = JSON.parse(b64_to_utf8(` (Netty), `_siteOSL`, `_siteAT1605`, `apimo`
(avec `wp-content` : `wpapimo`), `immo-facile`/`office5`, `nestenn`, `century21`, `foncia`, `laforet`, `eraimmobilier`, `billie`.
Résultat : gabarit connu avec `parser` (lecteur réutilisable de `src/parsers/`), `inconnu`, ou `aucun_site`. La page d'accueil
suffit au gabarit ; le choix entre `lbi` et `lbi2` se confirme sur la page des locations avec `GET /test` une fois la source écrite.

## « Ce site publie-t-il des locations ? » (modèle, en dernier)

`classifyRental(env, markdown) => Promise<"oui"|"non"|"incertain"|null>` (`src/prospect/ai.ts`), appelée seulement pour un gabarit
`inconnu` dont la page a été lue. Elle renvoie `null` sans appel si `PROSPECT_ENABLED` ou `PROSPECT_AI` n'est pas `"true"` ou si le
binding `AI` manque, et sur toute erreur ou délai.

**Budget** : l'appel passe par le socle `src/ai/run.ts` (fonction `prospect`, plafond `settings().ai.featureCaps.prospect` = 500 neurons par jour,
estimation `PROSPECT_AI_ESTIMATE_NEURONS`, cumul dans `ai_usage`) ; modèle `PROSPECT_AI_MODEL` (celui du socle), réponse JSON
`{"verdict": ...}`.

## Activation

1. Migration `0008` : appliquée par le Worker lui-même.
2. Mettre `PROSPECT_ENABLED` à `"true"` dans `wrangler.jsonc`, déployer, ou dérouler une campagne à la main avec `/prospect`.
3. Lire la section « Agences candidates » du tableau de bord. Passer un candidat en `ignore` ou `ajoute` en D1 :
   `UPDATE agency_candidates SET status = 'ignore' WHERE id = '...'` (une campagne ne réécrit jamais le statut).

Aucune ressource Cloudflare à créer (D1 et binding `AI` existants).

## Ce qu'on peut attendre

Mesure du 09/11/2026 sur les vraies réponses de l'API Recherche d'entreprises : 1 495 établissements ouverts (17e et Levallois),
dont 60 déjà au registre (réseaux compris), soit ~1 435 candidats, presque tous **sans site** (l'API n'en donne pas : beaucoup
de sociétés de transaction, de gestion de patrimoine ou de domiciliation). Seuls les candidats trouvés aussi par OpenStreetMap ont
un site à analyser : peu de nouveautés par campagne, c'est voulu (un message seulement s'il y en a).

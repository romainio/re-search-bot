# Indices de cohérence géographique et réglementaire (09/11/2026)

Aide à décider vite : pour chaque annonce nouvelle gardée, quatre indices. **Ce ne sont que des indices** : `evaluate` n'en dépend
pas, aucune annonce n'est écartée ni retardée, et rien n'est calculé quand l'interrupteur est éteint.

## Activation

1. `wrangler.jsonc`, `vars` : `"GEO_HINTS": "true"` (défaut `"false"`).
2. Déployer. Aucune migration (les indices vivent dans le payload JSON de `listings`), aucun binding, aucune ressource Cloudflare.

Éteint, le Worker se comporte exactement comme avant : aucune requête, payload sans clé `geo`, alerte et carte inchangées. Les annonces
déjà enregistrées n'ont pas d'indices (ils ne sont calculés qu'à l'arrivée d'une annonce nouvelle).

## Ce qui est affiché

Une ligne courte dans l'alerte Telegram (avant la description, qui est raccourcie la première si la légende dépasse 1 024
caractères), un badge par indice sur la carte du tableau de bord (avertissements encadrés en couleur d'alerte).

| Indice                                      | Exemple                                                                  | Règle                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Station la plus proche                      | `🚇 Brochant (13) à ~4 min`                                              | position géocodée, station la plus proche à vol d'oiseau (données IDFM), marche = distance × 1,3 à 80 m/min ; rien au-delà de 1 500 m                                                                                                                            |
| Repli sans géocodage                        | `🚇 Brochant (13), citée par l'annonce`                                  | station nommée dans le titre ou la description (« métro Brochant », « à 2 min de Brochant »), sans distance ; un nom de station seul (« rue de Rome ») ne compte pas                                                                                             |
| Promesse non confirmée                      | `⚠️ proximité annoncée non confirmée (Brochant à ~12 min, annoncé 2)`    | l'annonce promet (« proche métro », « à 2 min de X ») et la marche réelle dépasse l'annonce de plus de 4 min (8 min sans durée annoncée) ; ou `⚠️ Rome citée, Villiers est plus proche` quand la station citée n'est pas la plus proche (4 min d'écart au moins) |
| Encadrement des loyers (Paris 17 seulement) | `⚠️ loyer au-dessus du plafond (≈ 36 €/m² pour un plafond de 32,5 €/m²)` | loyer hors charges au m² contre le loyer de référence majoré du quartier, du nombre de pièces (4 = 4 et plus), de l'époque et du meublé                                                                                                                          |
| DPE                                         | `⚠️ DPE G, interdit à la location depuis 2025` ; `DPE F`                 | classe lue dans le titre ou la description : « DPE G », « classe énergie : F »… (lettre majuscule isolée) ; E ou mieux : rien d'affiché                                                                                                                          |

Encadrement : époque inconnue (cas courant) = fourchette des plafonds des quatre époques ; l'alerte ne signale que le dépassement du
plafond le plus haut (« au-dessus de tout »), le tableau de bord montre aussi le cas intermédiaire (`loyer ≈ 30 €/m², plafond de
28,9 à 32,5 €/m² selon l'époque`). Meublé non précisé : non meublé. Quartier inconnu (pas de géocodage) : fourchette des quatre
quartiers du 17e. Loyer connu seulement charges comprises : comparé au plafond relevé de 15 % (`RENT_CHARGES_ALLOWANCE`).
L'époque est lue dans « construit en 1930 », « immeuble de 1965 », « haussmannien », « pierre de taille », « neuf ». Le complément
de loyer exceptionnel (légal sous conditions) est inconnu : un dépassement reste un indice à vérifier, pas un constat.
Levallois n'est pas concerné par l'encadrement de Paris : rien n'y est affiché.

## Géocodage et budget

- API Adresse de la Géoplateforme (IGN) : `https://data.geopf.fr/geocodage/search` (gratuite, sans clé). L'ancien hôte
  `api-adresse.data.gouv.fr` redirige vers celui-ci et est décommissionné (sunset du 31/01/2026) : on appelle le nouveau.
- Une sous-requête GET par annonce, délai `GEO_TIMEOUT_MS` (3 s), limitée par le temps restant avant l'échéance du sous-lot.
- Mêmes règles que les fiches : annonces **nouvelles gardées** seulement, au plus `GEO_MAX_PER_PART` (3) par source et par passage,
  jamais au premier passage d'une source (annonces « silent ») ni après un passage en échec. Sous-requêtes d'un `/part` :
  1 liste + 3 fiches au plus + 3 géocodages au plus, loin des 50.
- Seule une adresse contenant une voie (rue, avenue, boulevard, place…) est géocodée ; « Paris 17e » ou « Batignolles » seuls ne
  coûtent aucune requête. La réponse est retenue si son score atteint `GEO_MIN_SCORE` (0,5) et si son code postal est celui d'une
  zone (et celui de l'annonce quand il est connu).
- Jamais bloquant : erreur réseau, délai, HTTP non 200, réponse vide ou douteuse donnent « pas de point », l'annonce garde les
  indices qui n'ont pas besoin de position (station citée, DPE, loyer en fourchette).

## Données ouvertes embarquées (récupérées le 09/11/2026, licence ODbL)

- `src/data/stations.ts` : « Emplacement des gares de la région Île-de-France » (Île-de-France Mobilités,
  `data.iledefrance-mobilites.fr`, jeu `emplacement-des-gares-idf`). Métro, RER et Transilien (ni tramway ni TER), une entrée par
  zone de correspondance, stations à moins de 800 m du 17e ou de Levallois-Perret : 39 stations.
- `src/data/rent-cap.ts` : « Logement : encadrement des loyers » (Ville de Paris, `opendata.paris.fr`, jeu
  `logement-encadrement-des-loyers`), année **2025** (loyers applicables du 1er juillet 2025 au 30 juin 2026 ; le jeu n'avait pas
  encore l'année 2026 le 09/11/2026), quartiers 65 à 68 (Ternes, Plaine de Monceau, Batignolles, Épinettes), 128 lignes. Contours :
  champ `geo_shape` du même jeu, simplifiés (Douglas-Peucker, 25 m), de 10 à 13 sommets par quartier. Deux quartiers voisins
  peuvent laisser un interstice de quelques dizaines de mètres : le point n'est alors dans aucun quartier et la fourchette des quatre
  quartiers s'applique.
- Contour de Levallois-Perret (`geo.api.gouv.fr`, commune 92044) : seulement pour borner le choix des stations.

Mise à jour : relancer les mêmes requêtes (jeux ci-dessus, API Explore v2.1 de chaque portail, filtre `annee` et `id_quartier`
entre 65 et 68 pour les loyers), remplacer les tableaux, mettre à jour `RENT_DATA_YEAR` et la date en commentaire. À faire chaque
1er juillet (nouveaux loyers de référence). Autre zone (chantier de redéploiement) : refaire les deux fichiers pour ses quartiers.

## Limites connues

- Pas de repli « rue citée » : sans géocodage, seule une station nommée donne un repère (aucune table de rues embarquée).
- La station la plus proche est à vol d'oiseau : une voie ferrée ou le périphérique peuvent allonger la marche réelle.
- Les accès réels des stations (sorties) ne sont pas dans les données : position moyenne des quais.
- DPE lu dans le texte seulement (titre, description) ; une fiche qui ne l'écrit pas n'a pas d'indice DPE.

## Code

`src/geo/` : `geometry.ts` (distance, point dans un polygone), `stations.ts`, `proximity.ts`, `rent.ts`, `dpe.ts`, `geocode.ts`,
`hints.ts` (calcul et étape du passage `/part`, appelée par `runPart` après les fiches), `render.ts` (ligne d'alerte, badges).
Constantes dans `src/config/geo.ts` (`GEO_*`, `WALK_*`, `PROMISE_*`, `RENT_*`, `DPE_*`). Tests : `test/geo.test.ts`.

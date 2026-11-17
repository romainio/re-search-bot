# Recherche sémantique (chantier 7)

Un champ de recherche dans l'en-tête du tableau de bord (`/?q=2 pièces lumineux avec baignoire`) range les annonces par proximité de
sens avec la requête, puis applique les filtres existants (zone, prix, surface). Embeddings `@cf/baai/bge-m3` (Workers AI, multilingue,
1 024 dimensions) et index Vectorize. **Éteinte par défaut** : sans `SEMANTIC_SEARCH="true"` ET sans binding `VECTORIZE` (et `AI`), le
Worker se comporte exactement comme avant (aucun champ, aucun appel, `?q=` ignoré).

## Activation (à faire par l'orchestrateur ou le propriétaire, rien n'est créé par le code)

1. Créer l'index (dimensions = celles de bge-m3, métrique cosinus) :

   ```sh
   npx wrangler vectorize create re-search-annonces --dimensions=1024 --metric=cosine
   ```

2. Créer les index de métadonnées **avant d'insérer le moindre vecteur** (un champ ne se filtre que s'il est indexé avant l'insertion) :

   ```sh
   npx wrangler vectorize create-metadata-index re-search-annonces --property-name=zone --type=string
   npx wrangler vectorize create-metadata-index re-search-annonces --property-name=gone --type=number
   ```

   (`npx wrangler vectorize list-metadata-index re-search-annonces` pour vérifier. Les champs `source` et `lid` ne sont pas filtrés : ils
   ne sont qu'enregistrés pour retrouver la ligne D1.)
3. Ajouter à `wrangler.jsonc` le binding (absent tant que l'index n'existe pas : un binding vers une ressource inexistante fait
   échouer le déploiement) :

   ```jsonc
   "vectorize": [{ "binding": "VECTORIZE", "index_name": "re-search-annonces" }],
   ```

4. La migration `0013_semantic_search.sql` est appliquée par le Worker ; passer `"SEMANTIC_SEARCH": "true"` dans `vars`, déployer. Le cron indexe alors le stock existant de lui-même.

## Ce qui est indexé

- **Une annonce par cluster** (l'annonce de tête : `cluster = source:listing_id`), gardée et suivie (`sent`, `pending`, `silent`) ;
  jamais `filtered`, jamais `duplicate`.
- **Texte embarqué** (`src/search/text.ts`) : titre, type, pièces, surface, étage, loyer CC, adresse et quartier, code postal et zone,
  drapeau « quartier », station la plus proche (indices géo, `GEO_HINTS`), mini description ou description brute (600 caractères),
  critères « oui » de la grille photo si le payload les porte (clé `photo`, que l'alerte ne conserve pas aujourd'hui : voir
  « Pistes »). Au plus 1 500 caractères.
- **Métadonnées** du vecteur : `zone` (code postal, ou `inconnue`), `gone` (0 en ligne, 1 disparue), `source` et `lid`. Identifiant du
  vecteur : SHA-1 du cluster (40 caractères, limite Vectorize 64 octets).
- **Annonce disparue** (`gone_at`) : le vecteur reste, sa métadonnée `gone` passe à 1 (et revient à 0 si l'annonce réapparaît) par un
  nouvel upsert (re-embedding d'environ 0,16 neuron, plus simple et moins cher qu'une lecture `getByIds`).

## Indexation et rattrapage (cron)

Chaque minute du cron, `scheduled` appelle `POST /embed` par `ctx.exports` (ou le service binding `SELF` s'il est déclaré) (corps signé HMAC comme `/part`, instant vérifié) :
le pas tourne dans **sa propre invocation** (10 ms de CPU et 50 sous-requêtes à lui) et ne retire rien au passage de lecture. Un pas
(`runEmbedStep`, `src/search/embed.ts`) :

1. marque « à rafraîchir » les annonces indexées qui ont disparu ou réapparu (deux `UPDATE`, index partiels minuscules) ;
2. lit jusqu'à `EMBED_BATCH` (10) annonces jamais indexées, **les plus récentes d'abord** (stock existant compris), puis celles à
   rafraîchir ; lectures forcées sur des index partiels (`INDEXED BY`, migration 0013) : jamais le stock entier ;
3. un appel d'embedding (`runEmbed`, `src/ai/embed.ts`, budget `embed`), un `upsert` Vectorize, une écriture D1 groupée
   (`embedded_at`, `embedded_gone`, compteur `embed_state.vectors`).

Budget de neurons épuisé, panne d'IA ou de Vectorize : rien n'est marqué, le pas suivant réessaie, jamais d'exception ni d'effet sur
les alertes (l'indexation ne fait pas partie de `sendPendingAlerts`, donc ne peut jamais retarder ni bloquer une alerte). Un payload
illisible est marqué sans vecteur pour ne pas bloquer le rattrapage. Rythme : 10 annonces par minute, soit 600 par heure : un stock de
2 000 annonces est indexé en ~3 h 20 de cron (le cron ne tourne que 7 h-19 h UTC).

## Recherche

`semanticSearch(env, query, opts)` (`src/search/search.ts`) :

1. éteinte → `{ status: "off" }` sans aucun appel ; requête invalide (2 à 100 caractères, lettres, chiffres, espaces, `' ’ . , ; : ! ? € ² / + ( ) % & -`)
   → `"invalid"` ;
2. **cache D1** (`search_cache`, 60 min) sur (requête normalisée en minuscules, zone, disparues) : un rechargement ne coûte ni neuron,
   ni requête Vectorize, ni jeton ;
3. sinon **limite horaire** `SEMANTIC_MAX_PER_HOUR` (20 par heure UTC, tous visiteurs : le tableau de bord est public ; au-delà
   `"limited"` et le message « Recherche indisponible pour l’instant. », la liste habituelle reste affichée) ;
4. embedding de la requête (budget `embed` ; épuisé → `"unavailable"`) puis **une** requête Vectorize de `SEMANTIC_TOPK` (30)
   voisins, filtre `zone` (si une zone est choisie) et `gone = 0` (sauf `includeGone`), similarité ≥ `SEMANTIC_MIN_SCORE` (0,30, à
   étalonner à l'usage) ;
5. lecture D1 des annonces trouvées (clé primaire) avec les filtres du tableau de bord (zone, prix max, surface min, valeurs inconnues
   gardées) et la même règle de visibilité ; rangement par similarité décroissante ; score affiché discrètement (« pertinence 0,82 »).

```ts
semanticSearch(env: Env, query: string, opts?: {
  zone?: string | null;        // code postal d'une zone de l'instance (métadonnée + D1) ou "quartier" (D1 seulement)
  prix?: number | null;        // loyer CC maximal
  surface?: number | null;     // surface minimale
  includeGone?: boolean;       // inclure les disparues (défaut : non)
  limit?: number;              // résultats rendus, ≤ SEMANTIC_TOPK
  rateLimit?: boolean;         // false : pas de limite horaire (assistant déjà authentifié) ; le plafond de neurons reste
  now?: Date; sources?: readonly SourceDef[];
}): Promise<{
  status: "ok" | "off" | "invalid" | "limited" | "unavailable";
  query: string;               // requête normalisée
  rows: { source; listing_id; alert_status; alert_attempts; first_seen; payload /* JSON { listing, evaluation, geo } */;
          since; score; gone }[];
  cached: boolean;
}>
```

Jamais d'exception. Limite connue : la métadonnée `gone` est celle de l'annonce de tête du cluster ; un cluster dont seule la tête a
disparu est masqué par défaut de la recherche alors que le tableau de bord le montre (autre source encore en ligne). De même, une
annonce de zone indéterminée (`zone = inconnue`) n'apparaît pas quand une zone est choisie.

## Limites de l'offre gratuite (doc Cloudflare, vérifiée le 09/11/2026)

| Ressource               | Limite Workers Free                                                 | Usage prévu                                                                                   |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Dimensions stockées     | 5 millions                                                          | 1 024 par vecteur : 4 882 vecteurs au plus ; plafond `SEMANTIC_MAX_VECTORS` = 4 500           |
| Dimensions interrogées  | 30 millions par mois, comptées `(vecteurs + requêtes) x dimensions` | 4 500 vecteurs : ~24 800 requêtes par mois ; limite de 20 par heure = 14 400 par mois au plus |
| Index par compte        | 100                                                                 | 1                                                                                             |
| Dimensions par vecteur  | 1 536 au plus                                                       | 1 024                                                                                         |
| Identifiant             | 64 octets                                                           | 40 (SHA-1)                                                                                    |
| Métadonnées             | 10 KiB par vecteur, 10 index de métadonnées                         | 4 champs, 2 indexés (`zone`, `gone`)                                                          |
| `topK` avec métadonnées | 50 au plus                                                          | 30                                                                                            |

À vérifier à la création : la page « Workers pricing » indique encore « Vectorize is currently only available on the Workers paid
plan » alors que les pages Vectorize (pricing et limits, mises à jour le 30/10/2026) donnent des quotas pour Workers Free. Si
`wrangler vectorize create` refuse sur le plan gratuit, la fonction reste simplement éteinte.

## Coût en neurons (bge-m3 : 1 075 neurons par million de jetons, aucune sortie facturée)

- **Annonce** : ~150 jetons soit ~0,16 neuron (estimation prudente avant appel : 0,5). Un lot de 10 : ~1,6 neurons.
- **Recherche** : ~20 jetons soit ~0,02 neuron (estimation 0,5), pour 20 recherches par heure au plus : < 10 neurons par jour.
- **Rattrapage du stock** : 2 000 annonces ≈ 320 neurons, 4 500 ≈ 720 (une fois), étalés sur le plafond `embed` de 1 000 neurons par
  jour (plus de 2 000 annonces par jour) ; le plafond global de 8 000 reste partagé avec les autres fonctions.
- Consommation : `SELECT feature, neurons, calls FROM ai_usage WHERE day = date('now')` (ligne `embed`).

## Tests

`test/search.test.ts` : `env.AI` et un faux `VECTORIZE` en mémoire (cosinus, filtre d'égalité), sans réseau.

## Pistes

- Conserver la grille photo et la mini description dans le payload à l'envoi de l'alerte (`send.ts`) pour qu'elles entrent dans le
  texte embarqué (`EmbedPayload.photo` les lit déjà si elles sont présentes) ; les annonces déjà indexées passeraient alors en
  `embed_redo = 1`.
- Étalonner `SEMANTIC_MIN_SCORE` sur des requêtes réelles.

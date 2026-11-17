// Recherche sémantique (src/search/, docs/recherche-semantique.md).

/** Modèle d'embeddings (Workers AI, multilingue, 1 024 dimensions) et dimension de l'index Vectorize qui doit lui correspondre. */
export const SEMANTIC_MODEL = "@cf/baai/bge-m3";
export const SEMANTIC_DIMENSIONS = 1024;
/** Délai de l'appel d'embedding (la requête d'un visiteur ou le pas du cron n'attend pas plus longtemps). */
export const SEMANTIC_TIMEOUT_MS = 8_000;
/** Délai d'une opération Vectorize (upsert, query). */
export const SEMANTIC_VECTORIZE_TIMEOUT_MS = 5_000;
/** Annonces indexées par pas du cron : un appel modèle, un upsert, une écriture D1 groupée. */
export const EMBED_BATCH = 10;
export const EMBED_STEP_TIMEOUT_MS = 20_000;
/** Neurons estimés par texte (canSpend, repli sans `usage`) : 450 jetons au pire ; un texte réel en coûte ~0,16. */
export const EMBED_ESTIMATE_PER_TEXT = 0.5;
/** Vecteurs indexés au plus : l'offre gratuite stocke 5 M de dimensions (4 882 vecteurs de 1 024), moins une marge. */
export const SEMANTIC_MAX_VECTORS = 4_500;
/** Texte embarqué : taille maximale (caractères) du texte complet et de la description qu'il contient. */
export const SEMANTIC_TEXT_MAX = 1_500;
export const SEMANTIC_DESC_MAX = 600;
/** Requête saisie : longueurs minimale et maximale (caractères). */
export const SEMANTIC_QUERY_MIN = 2;
export const SEMANTIC_QUERY_MAX = 100;
/** Voisins demandés à Vectorize : 30 × 2 liaisons restent sous les 100 variables d'une requête D1. */
export const SEMANTIC_TOPK = 30;
/** Similarité cosinus minimale d'un résultat (en dessous, l'annonce n'a rien à voir avec la requête). */
export const SEMANTIC_MIN_SCORE = 0.3;
/**
 * Recherches coûteuses (embedding + Vectorize) par heure UTC, tous visiteurs confondus : l'offre gratuite (30 M de dimensions
 * interrogées par mois) laisse ~800 requêtes par jour avec 4 500 vecteurs. Une recherche en cache n'en consomme pas.
 */
export const SEMANTIC_MAX_PER_HOUR = 20;
/** Durée de vie d'un résultat en cache D1 (minutes). */
export const SEMANTIC_CACHE_TTL_MIN = 60;
/** Message affiché quand la recherche ne peut pas répondre (limite horaire, budget de neurons, erreur). */
export const SEMANTIC_UNAVAILABLE = "recherche indisponible pour l’instant";

/** User-Agent de toute requête sortante : le bot se présente comme tel, avec l'adresse du projet. */
export const USER_AGENT = "re-search/1.0 (+https://github.com/romainio/re-search-bot)";

/** Octets lus au plus dans une page liste, au-delà le corps est tronqué (les plus lourdes pèsent ~1,25 Mo). */
export const SOURCE_MAX_BYTES = 2_000_000;
/** Délai de lecture d'une source (raison « timeout »). */
export const SOURCE_TIMEOUT_MS = 10_000;

/** Fiches lues au plus par source et par passage ; sous-requêtes d'un sous-lot : PART_SIZE × (1 + MAX_ENRICH_PER_SOURCE). */
export const MAX_ENRICH_PER_SOURCE = 3;
/** Délai maximal de lecture d'une fiche (en-têtes et corps). */
export const DETAIL_TIMEOUT_MS = 10_000;
/** Octets lus au plus dans une fiche (bornes propres à une famille : src/detail/index.ts). */
export const DETAIL_MAX_BYTES = 300_000;
/** Longueur maximale de la description d'une fiche (caractères), source de la mini description IA ; l'alerte en montre DESCRIPTION_SHOWN. */
export const DESCRIPTION_MAX = 1200;
/** Photos de galerie gardées au plus par annonce. */
export const GALLERY_MAX = 5;

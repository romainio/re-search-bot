// Indices géographiques et réglementaires (src/geo/) : aucun n'écarte une annonce. Interrupteur GEO_HINTS.

/** API Adresse de la Géoplateforme (IGN), gratuite et sans clé. */
export const GEO_ADDRESS_API = "https://data.geopf.fr/geocodage/search";
/** Délai d'un géocodage : l'indice est facultatif, jamais d'attente longue. */
export const GEO_TIMEOUT_MS = 3_000;
/** Géocodages au plus par source et par passage (sous-requêtes d'un sous-lot, comme MAX_ENRICH_PER_SOURCE). */
export const GEO_MAX_PER_PART = 3;
/** Score minimal (0 à 1) d'une réponse de l'API Adresse pour retenir le point. */
export const GEO_MIN_SCORE = 0.5;
/** Marche : 80 m par minute (≈ 4,8 km/h) sur une distance à vol d'oiseau multipliée par 1,3 (détours du plan de rues). */
export const WALK_SPEED_M_PER_MIN = 80;
export const WALK_DETOUR_FACTOR = 1.3;
/** Au-delà de cette distance à vol d'oiseau, aucune station n'est affichée (les données couvrent les zones + 800 m). */
export const STATION_MAX_METERS = 1_500;
/** Promesse « proche métro » sans durée annoncée : non confirmée si la station la plus proche est à plus de ce nombre de minutes. */
export const PROMISE_MAX_MIN = 8;
/** Promesse avec durée annoncée (« à 2 min de X ») : non confirmée si la marche réelle dépasse l'annonce de plus de ce nombre de minutes. */
export const PROMISE_TOLERANCE_MIN = 4;
/** Station citée qui n'est pas la plus proche : signalée si la plus proche est plus près d'au moins ce nombre de minutes. */
export const OTHER_STATION_MARGIN_MIN = 4;
/** Loyer connu seulement charges comprises : comparé au plafond (hors charges) majoré de cette part, pour ne pas accuser à tort. */
export const RENT_CHARGES_ALLOWANCE = 0.15;
/** DPE : classe G interdite à la location depuis 2025 (loi Climat et résilience) ; F mentionnée seulement. */
export const DPE_BANNED_CLASS = "G";
export const DPE_BANNED_SINCE = 2025;
export const DPE_MENTION_CLASS = "F";
/** Longueur maximale de la ligne d'indices dans l'alerte (une ligne courte). */
export const GEO_LINE_MAX = 220;

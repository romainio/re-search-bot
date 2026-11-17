// Serveur MCP (src/mcp/, docs/mcp.md) : paramétrage de l'instance par un assistant IA.

/** Octets lus au plus pour reconnaître un gabarit ; annonces d'exemple rendues par un essai de source. */
export const MCP_PROBE_MAX_BYTES = 500_000;
export const MCP_SAMPLE_SIZE = 3;
/**
 * Communes voisines (completer_localisation) : API, délai, rayons (km), points sondés, population minimale et nombre maximal
 * (chaque commune exclue est cherchée dans le texte de chaque annonce : un coût CPU).
 */
export const GEO_API_URL = "https://geo.api.gouv.fr";
export const GEO_API_TIMEOUT_MS = 8_000;
export const NEIGHBOR_RADIUS_KM = 10;
export const NEIGHBOR_RADIUS_MAX_KM = 25;
export const NEIGHBOR_PROBE_POINTS = 8;
export const NEIGHBOR_MIN_POPULATION = 2_000;
export const NEIGHBOR_MAX = 30;

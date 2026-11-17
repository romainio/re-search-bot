// Lecteur universel (src/universal/) : page -> Markdown (toMarkdown) -> réduction déterministe -> un appel modèle.

/** Cadence minimale (minutes) d'une source universelle ; une page à empreinte inchangée ne coûte aucun neuron. */
export const UNIVERSAL_MIN_EVERY = 15;
/** Cadence proposée par défaut à une source universelle ajoutée par l'assistant (MCP). */
export const UNIVERSAL_DEFAULT_EVERY = 30;
/** Sources universelles actives au plus : 15 × ~6 lectures par jour × ~40 neurons ≈ 3 600 neurons par jour. */
export const UNIVERSAL_MAX_ACTIVE = 15;
/** Relecture forcée par le modèle d'une page à empreinte inchangée au bout de ce nombre de jours (filet). */
export const UNIVERSAL_RECHECK_DAYS = 3;
/** En dessous (caractères), un texte réduit n'est jamais « inchangé » : une page cassée ne fige pas le stock. */
export const UNIVERSAL_UNCHANGED_MIN_CHARS = 100;
/** Cadence minimale d'une source `render: "browser"`, rendue à chaque passage (Browser Run : 10 minutes gratuites par jour). */
export const UNIVERSAL_BROWSER_MIN_EVERY = 30;
export const UNIVERSAL_BROWSER_MAX = 2;
/** Délai du rendu navigateur (5 à 10 s en général). */
export const UNIVERSAL_BROWSER_TIMEOUT_MS = 15_000;
/** Modèle d'extraction (tarif dans AI_MODEL_RATES). */
export const UNIVERSAL_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const UNIVERSAL_TIMEOUT_MS = 12_000;
/** Délai de la conversion Markdown (env.AI.toMarkdown). */
export const UNIVERSAL_CONVERT_TIMEOUT_MS = 8_000;
/** Octets de HTML lus au plus pour une source universelle (la conversion Markdown les reçoit en entier). */
export const UNIVERSAL_HTML_MAX_BYTES = 1_000_000;
/** Caractères de Markdown examinés au plus par la réduction (borne le CPU). */
export const UNIVERSAL_MD_INPUT_MAX = 300_000;
/** Plafond de caractères du texte envoyé au modèle après réduction (~2 000 jetons) : borne le coût d'une lecture. */
export const UNIVERSAL_MAX_CHARS = 6_000;
/** Jetons de sortie au plus de l'appel (UNIVERSAL_MAX_LISTINGS annonces d'environ 80 jetons). */
export const UNIVERSAL_MAX_TOKENS = 1_200;
export const UNIVERSAL_MAX_LISTINGS = 15;
/** Coût pessimiste d'un appel (~2 500 jetons en entrée, 1 200 en sortie) ; ~40 en pratique. */
export const UNIVERSAL_ESTIMATE_NEURONS = 65;
/** Loyer mensuel plausible (€) : en dehors, l'annonce du modèle est refusée (prix lu de travers, ou vente). */
export const UNIVERSAL_PRICE_RANGE: readonly [number, number] = [200, 20_000];
/** Surface plausible (m²). */
export const UNIVERSAL_SURFACE_RANGE: readonly [number, number] = [5, 500];
export const UNIVERSAL_ROOMS_MAX = 12;

import type { UserPhotoCriterion } from "../instance";

// Budget Workers AI partagé (src/ai/) : 10 000 neurons par jour sur le plan gratuit, remis à zéro à 00:00 UTC.

/** Plancher du plafond quotidien de `universal` : UNIVERSAL_MAX_ACTIVE sources au pire (~3 600 neurons). */
export const UNIVERSAL_DAILY_CAP = 4_000;

/** Tarif en neurons par million de jetons (1 000 neurons = 0,011 $) ; un modèle absent paie AI_FALLBACK_RATE. */
export interface AiRate {
  inPerM: number;
  outPerM: number;
}
export const AI_MODEL_RATES: Readonly<Record<string, AiRate>> = {
  "@cf/google/gemma-4-26b-a4b-it": { inPerM: 9_091, outPerM: 27_273 },
  // Embeddings : 0,012 $/M jetons d'entrée ; aucune sortie facturée.
  "@cf/baai/bge-m3": { inPerM: 1_075, outPerM: 0 },
};
/** Tarif d'un modèle inconnu : celui des plus chers du catalogue. */
export const AI_FALLBACK_RATE: AiRate = { inPerM: 30_000, outPerM: 100_000 };

/** Modèle de vision (plan gratuit) de l'analyse des photos. */
export const PHOTO_MODEL = "@cf/google/gemma-4-26b-a4b-it";
/** Délai de l'appel d'analyse : l'alerte ne doit pas attendre. */
export const PHOTO_TIMEOUT_MS = 12_000;
/** Images envoyées au plus au modèle, parmi les GALLERY_MAX de la galerie. */
export const PHOTO_MAX_IMAGES = 4;
/** Jetons de sortie au plus (grille de critères + mini description). */
export const PHOTO_MAX_TOKENS = 600;
/** Mini description de l'alerte : longueur maximale (caractères). */
export const SUMMARY_MAX = 220;
/** Coût pessimiste d'une analyse (canSpend, repli sans `usage`) : ~5 600 jetons en entrée et 600 en sortie. */
export const PHOTO_ESTIMATE_NEURONS = 70;

/** Critère de la grille photo (settings().photoCriteria). */
export type PhotoCriterion = UserPhotoCriterion;

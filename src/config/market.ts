// Indicateurs de marché (src/market.ts, docs/marche.md).

/**
 * Fenêtre des indicateurs (jours). La durée de vie ne compte que les annonces détectées il y a plus de l'horizon : une annonce
 * encore en ligne a une durée inconnue, comptée « plus longue que l'horizon ».
 */
export const MARKET_WINDOW_DAYS = 30;
export const MARKET_LIFETIME_HORIZON_DAYS = 10;
/** Effectif minimum d'un groupe (zone, tranche) pour afficher une médiane ou un indice : en dessous, rien. */
export const MARKET_MIN_SAMPLE = 8;
/** Agrégats recalculés au plus toutes les MARKET_REFRESH_MINUTES minutes (budget de lectures D1). */
export const MARKET_REFRESH_MINUTES = 60;
/** « Part vite » : durée de vie médiane de la catégorie (zone, tranche) d'au plus MARKET_FAST_HOURS heures. */
export const MARKET_FAST_HOURS = 72;
/** Tranches de pièces : 1, 2, 3, et « 4 et plus » (dernière tranche). */
export const MARKET_MAX_ROOMS_BUCKET = 4;
/** Surfaces retenues pour le prix au m² (écarte les valeurs aberrantes d'une source). */
export const MARKET_SURFACE_RANGE: readonly [number, number] = [9, 250];
/** Tendance des nouvelles annonces : moyenne des MARKET_TREND_DAYS derniers jours complets contre les MARKET_TREND_DAYS précédents. */
export const MARKET_TREND_DAYS = 7;
/** Écart relatif sous lequel la tendance est jugée stable. */
export const MARKET_TREND_FLAT = 0.15;

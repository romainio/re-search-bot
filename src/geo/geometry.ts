import { WALK_DETOUR_FACTOR, WALK_SPEED_M_PER_MIN } from "../config/geo";

const EARTH_RADIUS_M = 6_371_000;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Distance à vol d'oiseau en mètres (formule de haversine). */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1),
    dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Minutes de marche (au moins 1) pour une distance à vol d'oiseau : × WALK_DETOUR_FACTOR, à WALK_SPEED_M_PER_MIN. */
export const walkMinutes = (meters: number): number =>
  Math.max(1, Math.round((meters * WALK_DETOUR_FACTOR) / WALK_SPEED_M_PER_MIN));

/** Point dans un polygone simple (tir de rayon) ; sommets [longitude, latitude], anneau non refermé. */
export function pointInPolygon(lon: number, lat: number, polygon: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i],
      [xj, yj] = polygon[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Texte comparable : minuscules, sans accents, tirets et apostrophes devenus des espaces, espaces réduits. */
export function fold(s: string): string {
  // Le même texte est replié par plusieurs lectures d'une même annonce : la dernière entrée est gardée (CPU).
  if (s === lastIn) return lastOut;
  lastIn = s;
  lastOut = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[-'’]/g, " ").replace(/\s+/g, " ").trim();
  return lastOut;
}
let lastIn = "",
  lastOut = "";

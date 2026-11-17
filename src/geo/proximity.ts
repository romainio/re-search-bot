import { OTHER_STATION_MARGIN_MIN, PROMISE_MAX_MIN, PROMISE_TOLERANCE_MIN } from "../config/geo";
import type { Station } from "../data/stations";
import { distanceMeters, fold, walkMinutes } from "./geometry";
import type { CitedStation, NearestStation } from "./stations";

/**
 * Promesse de proximité générique (sans nom de station) : « proche métro », « à proximité immédiate des transports », « à deux
 * pas du RER », « à 3 min du métro ». Durée annoncée : capturée quand elle est écrite.
 */
const GENERIC_CLAIM =
  /(?:\b(?:proche|pres|proximite|a\s+cote|a\s+deux\s+pas|a\s+quelques\s+pas|au\s+pied)(?:\s+immediate)?\s+(?:de\s+la\s+|de\s+l\s+|du\s+|des\s+|d\s+|de\s+)?(?:tous\s+)?(?:les\s+)?(?:metros?|transports?|rer|gares?|stations?)\b|\b(\d{1,2})\s*(?:min\w*|mn)(?:\s+a\s+pied)?\s+(?:de\s+la\s+|de\s+l\s+|du\s+|des\s+|d\s+)(?:metro|rer|gare|station|transports?)\b|\bmetro\s+a\s+(\d{1,2})\s*(?:min\w*|mn)\b)/;

export interface Claim {
  /** Station nommée par l'annonce (null : promesse générique). */
  station: Station | null;
  /** Durée annoncée en minutes (null : non précisée). */
  minutes: number | null;
}

/** Promesse de proximité de l'annonce : station nommée (citedStation) sinon formule générique ; null si l'annonce n'en fait pas. */
export function readClaim(text: string, cited: CitedStation | null): Claim | null {
  if (cited) return { station: cited.station, minutes: cited.minutes };
  const m = GENERIC_CLAIM.exec(fold(text));
  if (!m) return null;
  const minutes = m[1] ?? m[2];
  return { station: null, minutes: minutes ? Number(minutes) : null };
}

export interface ClaimVerdict {
  /** far : la station citée (ou la plus proche, pour une promesse générique) est plus loin que promis ; other : la station citée n'est pas la plus proche. */
  kind: "far" | "other";
  /** Station citée (null : promesse générique). */
  cited: string | null;
  /** Durée annoncée, null si non précisée. */
  claimed: number | null;
  /** Marche réelle estimée vers la station citée (promesse générique : vers la plus proche). */
  actual: number;
  nearest: string;
}

/**
 * Confronte la promesse à la position géocodée. Avec une durée annoncée D : « far » si la marche réelle dépasse D de plus de
 * PROMISE_TOLERANCE_MIN ; sans durée : si elle dépasse PROMISE_MAX_MIN. Station citée sans être la plus proche, à PLUS de
 * OTHER_STATION_MARGIN_MIN minutes de plus que la plus proche, et pas « far » : « other ». Null : promesse confirmée.
 */
export function judgeClaim(claim: Claim, lat: number, lon: number, nearest: NearestStation): ClaimVerdict | null {
  const nearestMin = walkMinutes(nearest.meters);
  const target = claim.station ?? nearest.station;
  const actual = claim.station
    ? walkMinutes(distanceMeters(lat, lon, claim.station.lat, claim.station.lon))
    : nearestMin;
  const limit = claim.minutes != null ? claim.minutes + PROMISE_TOLERANCE_MIN : PROMISE_MAX_MIN;
  const base = { cited: claim.station?.name ?? null, claimed: claim.minutes, actual, nearest: nearest.station.name };
  if (actual > limit) return { kind: "far", ...base };
  if (claim.station && target.name !== nearest.station.name && actual - nearestMin >= OTHER_STATION_MARGIN_MIN)
    return { kind: "other", ...base };
  return null;
}

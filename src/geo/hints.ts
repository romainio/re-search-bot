import { GEO_MAX_PER_PART, GEO_TIMEOUT_MS } from "../config/geo";
import { settings } from "../derive";
import type { Settings } from "../derive";
import { evaluate, postalOf, zoneOf } from "../filter";
import type { KnownState } from "../process";
import type { Env, Listing, SourceDef } from "../types";
import { walkMinutes } from "./geometry";
import { geocode, hasStreet } from "./geocode";
import type { GeoPoint } from "./geocode";
import { readDpe } from "./dpe";
import type { DpeClass } from "./dpe";
import { judgeClaim, readClaim } from "./proximity";
import type { ClaimVerdict } from "./proximity";
import { quarterAt, rentHint } from "./rent";
import type { RentHint } from "./rent";
import { citedStation, nearestStation } from "./stations";
import { errMsg } from "../guards";
import { MIN_LOOKUP_TIMEOUT_MS } from "../config/scan";

/** Station la plus proche (point géocodé) ou station citée par l'annonce (« text » : distance inconnue). */
export interface StationHint {
  name: string;
  lines: string[];
  meters: number | null;
  minutes: number | null;
  from: "geocode" | "text";
}

/** Indices d'une annonce, gardés dans le payload (clé `geo`). Chaque champ est null quand l'indice n'existe pas. */
export interface GeoHints {
  station: StationHint | null;
  /** Promesse de proximité non confirmée (null : aucune promesse, ou promesse confirmée, ou position inconnue). */
  claim: ClaimVerdict | null;
  rent: RentHint | null;
  dpe: DpeClass | null;
  /** Le point vient d'un géocodage réussi. */
  geocoded: boolean;
}

/** Indices d'une annonce (calcul pur, sans réseau) ; `point` : position géocodée, null si inconnue. Null si aucun indice. */
export function buildHints(
  l: Listing,
  src: SourceDef,
  point: GeoPoint | null,
  s: Settings = settings(),
): GeoHints | null {
  const text = [l.title, l.description, l.address, l.district]
    .filter((s): s is string => typeof s === "string" && !!s)
    .join(" . ");
  const zone = zoneOf(l, src, s);
  // Stations et quartiers embarqués : Île-de-France seulement. Hors geo.stationPostalCodes, aucun indice de station, de promesse
  // ni de quartier (jamais une station lointaine inventée).
  const postal = zone?.postalCode ?? postalOf(l, src, s);
  const hasStationData = !postal || s.geo.stationPostalCodes.includes(postal);
  const cited = hasStationData ? citedStation(text) : null;
  const claim = hasStationData ? readClaim(text, cited) : null;
  let station: StationHint | null = null;
  let verdict: ClaimVerdict | null = null;
  let quarter: { id: number; name: string } | null = null;
  if (point && hasStationData) {
    const near = nearestStation(point.lat, point.lon);
    if (near) {
      station = {
        name: near.station.name,
        lines: near.station.lines,
        meters: Math.round(near.meters),
        minutes: walkMinutes(near.meters),
        from: "geocode",
      };
      if (claim) verdict = judgeClaim(claim, point.lat, point.lon, near);
    }
    quarter = quarterAt(point.lat, point.lon);
  } else if (cited) {
    // Repli sans géocodage : la station nommée par l'annonce, sans distance (rien à confronter).
    station = { name: cited.station.name, lines: cited.station.lines, meters: null, minutes: null, from: "text" };
  }
  const rent = rentHint(
    { postalCode: postal, listing: l, text, quarterId: quarter?.id ?? null, quarterName: quarter?.name ?? null },
    s.geo.rentCapPostalCodes,
  );
  const dpe = readDpe(text);
  if (!station && !verdict && !rent && !dpe) return null;
  return { station, claim: verdict, rent, dpe, geocoded: point !== null };
}

/**
 * Indices des annonces nouvelles gardées par evaluate ; éteint (GEO_HINTS) : vide, aucune requête. Le géocodage ne concerne que
 * les GEO_MAX_PER_PART premières adresses de voie, jamais au premier passage ni après un échec (comme les fiches) ; les indices
 * sans réseau (station citée, DPE, loyer) valent pour toutes. Une annonce dont le calcul lève reste sans indice.
 */
export async function geoHintsFor(
  env: Env,
  src: SourceDef,
  listings: Listing[],
  state: KnownState,
  timeoutMs: number = GEO_TIMEOUT_MS,
  s: Settings = settings(),
): Promise<Map<string, GeoHints>> {
  const out = new Map<string, GeoHints>();
  if (env.GEO_HINTS !== "true") return out;
  const fresh: Listing[] = [];
  const seen = new Set<string>();
  for (const l of listings) {
    if (seen.has(l.id) || state.known.has(l.id)) continue;
    seen.add(l.id);
    try {
      if (evaluate(l, src, s).keep) fresh.push(l);
    } catch {
      /* sans indice */
    }
  }
  const canGeocode = state.wasInitialized && !state.lastFailed && timeoutMs >= MIN_LOOKUP_TIMEOUT_MS;
  const toGeocode = canGeocode ? fresh.filter((l) => hasStreet(l.address)).slice(0, GEO_MAX_PER_PART) : [];
  const points = await Promise.all(
    toGeocode.map((l) => geocode(l.address!, postalOf(l, src, s), Math.min(GEO_TIMEOUT_MS, timeoutMs))),
  );
  const pointOf = new Map(toGeocode.map((l, i): [string, GeoPoint | null] => [l.id, points[i]]));
  for (const l of fresh) {
    try {
      const h = buildHints(l, src, pointOf.get(l.id) ?? null, s);
      if (h) out.set(l.id, h);
    } catch (e) {
      console.error(`indices ${src.id} ${l.id}:`, errMsg(e));
    }
  }
  return out;
}

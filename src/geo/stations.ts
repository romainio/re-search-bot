import { STATION_MAX_METERS } from "../config/geo";
import { STATIONS } from "../data/stations";
import type { Station } from "../data/stations";
import { distanceMeters, fold } from "./geometry";

export interface NearestStation {
  station: Station;
  meters: number;
}

/** Station la plus proche d'un point, null au-delà de STATION_MAX_METERS (une cinquantaine de stations : une boucle suffit). */
export function nearestStation(lat: number, lon: number): NearestStation | null {
  let best: NearestStation | null = null;
  for (const station of STATIONS) {
    const meters = distanceMeters(lat, lon, station.lat, station.lon);
    if (!best || meters < best.meters) best = { station, meters };
  }
  return best && best.meters <= STATION_MAX_METERS ? best : null;
}

/** Libellé court : « Brochant (13) », « Péreire (3, RER C) » ; au plus trois lignes (les grandes gares en ont davantage). */
export function stationLabel(s: Station): string {
  const lines = s.lines.slice(0, 3).join(", ");
  return `${s.name} (${lines}${s.lines.length > 3 ? ", …" : ""})`;
}

/**
 * Mots qui annoncent une station avant son nom : « métro », « RER », « gare », « ligne 13 », « 2 min de », « proche », « près de »,
 * « à côté de ». Un nom de station seul ne compte pas (« Rome », « Europe », « Wagram », « Villiers » sont aussi des rues).
 */
const CITE_PREFIX =
  String.raw`(?:metros?|stations?|rer(?:\s+[a-e])?|gare|ligne\s*\d{1,2}|\d{1,2}\s*(?:min\w*|mn)(?:\s*a\s*pied)?|proche|pres|proximite|a\s+cote|au\s+pied|a\s+deux\s+pas)\s*:?\s*` +
  String.raw`(?:(?:de\s+la|de\s+l|du|des|de|d|a\s+la|au|a)\s+)?(?:la\s+station\s+|station\s+|metro\s+|gare\s+(?:de\s+)?)?`;

let cited: { station: Station; name: string; re: RegExp }[] | null = null;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface CitedStation {
  station: Station;
  minutes: number | null;
}

/**
 * Station citée comme repère dans un texte (titre, description, adresse) : correspondance sur le nom, précédée d'un mot de
 * transport (CITE_PREFIX). Premier repère dans le texte ; `minutes` : durée annoncée juste avant (« à 2 min de Brochant »).
 */
export function citedStation(text: string): CitedStation | null {
  const t = fold(text);
  if (!t) return null;
  cited ??= STATIONS.map((station) => {
    const name = fold(station.name);
    return { station, name, re: new RegExp(`\\b${CITE_PREFIX}${escapeRe(name)}\\b`) };
  });
  let best: { station: Station; index: number; len: number } | null = null;
  for (const c of cited) {
    // Recherche de sous-chaîne d'abord (bon marché) : l'expression régulière complète ne tourne que si le nom apparaît (CPU).
    if (!t.includes(c.name)) continue;
    const m = c.re.exec(t);
    if (m && (!best || m.index < best.index)) best = { station: c.station, index: m.index, len: m[0].length };
  }
  if (!best) return null;
  const before = t.slice(Math.max(0, best.index - 12), best.index + best.len);
  const mins = /(\d{1,2})\s*(?:min\w*|mn)/.exec(before);
  return { station: best.station, minutes: mins ? Number(mins[1]) : null };
}

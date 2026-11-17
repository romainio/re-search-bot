import { RENT_CHARGES_ALLOWANCE } from "../config/geo";
import { settings } from "../derive";
import { RENT_DATA_YEAR, RENT_QUARTERS, RENT_ROWS } from "../data/rent-cap";
import type { RentRow } from "../data/rent-cap";
import type { Listing } from "../types";
import { fold, pointInPolygon } from "./geometry";

/** Quartier administratif (données embarquées) contenant le point ; null s'il n'est dans aucun. */
export function quarterAt(lat: number, lon: number): { id: number; name: string } | null {
  for (const q of RENT_QUARTERS) if (pointInPolygon(lon, lat, q.polygon)) return { id: q.id, name: q.name };
  return null;
}

/** Époque de construction (0 avant 1946, 1 de 1946 à 1970, 2 de 1971 à 1990, 3 après 1990) selon l'année citée ; null si inconnue. */
export function eraOfYear(year: number): 0 | 1 | 2 | 3 {
  return year < 1946 ? 0 : year <= 1970 ? 1 : year <= 1990 ? 2 : 3;
}

/** Époque lue dans le texte (« construit en 1965 », « haussmannien », « immeuble neuf »…). */
export function readEra(text: string): 0 | 1 | 2 | 3 | null {
  const t = fold(text);
  const y = /(?:construit\w*|construction|immeuble|datant|date)\s+(?:de\s+|en\s+|:\s*)?(1[89]\d\d|20[0-2]\d)\b/.exec(t);
  if (y) return eraOfYear(Number(y[1]));
  if (/\bhaussmann|pierre de taille|\bxixe?\b/.test(t)) return 0;
  if (/\bneuf\b|\bliv\w+\s+en\s+20\d\d|programme neuf|construction recente/.test(t)) return 3;
  return null;
}

/** Meublé (true), non meublé (false) ou inconnu (null) d'après le texte. « Non meublé » avant « meublé ». */
export function readFurnished(text: string): boolean | null {
  const t = fold(text);
  if (/\bnon meuble|\bvide\b|\bsans meuble/.test(t)) return false;
  if (/\bmeuble/.test(t)) return true;
  return null;
}

export interface RentHint {
  /** Loyer constaté en €/m² (hors charges si connues, sinon charges comprises : basis "cc"). */
  perM2: number;
  /** Plafond (loyer de référence majoré) en €/m² : fourchette si l'époque, le meublé ou le quartier sont inconnus. */
  capMin: number;
  capMax: number;
  /** above : au-dessus de tous les plafonds possibles ; maybe : au-dessus de certains ; ok : sous tous. */
  status: "above" | "maybe" | "ok";
  basis: "hc" | "cc";
  quarter: string | null;
  year: number;
}

export interface RentInput {
  /** Code postal de l'annonce ; hors des codes encadrés (geo.rentCapPostalCodes de l'instance) : aucun indice. */
  postalCode: string | null;
  listing: Pick<Listing, "price" | "priceIsCC" | "charges" | "surface" | "rooms">;
  /** Texte de l'annonce (titre, description) : époque et meublé. */
  text: string;
  /** Quartier connu (point géocodé) ; sinon la fourchette couvre les quatre quartiers du 17e. */
  quarterId: number | null;
  quarterName: string | null;
}

/** Loyer au m² : hors charges quand on peut le savoir (HC annoncé, ou CC avec charges), sinon tel quel (basis "cc"). */
function perM2Of(l: RentInput["listing"]): { perM2: number; basis: "hc" | "cc" } | null {
  if (l.price == null || l.surface == null || l.surface <= 0) return null;
  if (l.priceIsCC === false) return { perM2: l.price / l.surface, basis: "hc" };
  if (l.priceIsCC === true && l.charges != null) return { perM2: (l.price - l.charges) / l.surface, basis: "hc" };
  return { perM2: l.price / l.surface, basis: "cc" };
}

/**
 * Encadrement des loyers : compare le loyer au m² au loyer de référence majoré (quartier, pièces, époque, meublé). Une inconnue
 * élargit la fourchette : « above » seulement au-dessus du plus haut plafond possible. Loyer seulement CC : plafond relevé de
 * RENT_CHARGES_ALLOWANCE. Le complément de loyer exceptionnel n'est pas connu : un indice, pas un constat.
 */
export function rentHint(i: RentInput, capped: readonly string[] = settings().geo.rentCapPostalCodes): RentHint | null {
  if (!i.postalCode || !capped.includes(i.postalCode)) return null;
  const rooms = i.listing.rooms;
  const m2 = perM2Of(i.listing);
  if (!m2 || rooms == null || rooms < 1) return null;
  const size = Math.min(4, Math.round(rooms));
  const era = readEra(i.text);
  // Meublé non précisé : non meublé (la grande majorité des baux, et une annonce meublée le dit) ; le plafond meublé est plus haut.
  const furnished = readFurnished(i.text) ?? false;
  const rows: RentRow[] = RENT_ROWS.filter(
    (r) =>
      r.rooms === size &&
      (i.quarterId === null || r.quarter === i.quarterId) &&
      (era === null || r.era === era) &&
      r.furnished === furnished,
  );
  if (!rows.length) return null;
  const caps = rows.map((r) => r.max);
  const capMin = Math.min(...caps),
    capMax = Math.max(...caps);
  const allowance = m2.basis === "cc" ? 1 + RENT_CHARGES_ALLOWANCE : 1;
  const status = m2.perM2 > capMax * allowance ? "above" : m2.perM2 > capMin * allowance ? "maybe" : "ok";
  return {
    perM2: Math.round(m2.perM2 * 10) / 10,
    capMin,
    capMax,
    status,
    basis: m2.basis,
    quarter: i.quarterName,
    year: RENT_DATA_YEAR,
  };
}

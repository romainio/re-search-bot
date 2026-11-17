import type { Zone } from "./config/criteria";
import { settings } from "./derive";
import type { Settings } from "./derive";
import type { Evaluation, Flag, Listing, SourceDef } from "./types";
import { findPostalCode, townZone } from "./util";

// Pluriels compris (« Bureaux », « Parkings ») : sinon un type au pluriel passerait pour un logement.
const TYPE_WORDS =
  "parkings?|box|garages?|caves?|locaux commerciaux|local commercial|locaux|local|bureaux?|commerces?|boutiques?";
const TYPE_ANYWHERE = new RegExp(String.raw`\b(?:${TYPE_WORDS})\b`);
const TYPE_AT_START = new RegExp(String.raw`^\s*(?:${TYPE_WORDS})\b`);

const GROUND_FLOOR = /\b(?:rez[- ]de[- ]chaussee|rdc)\b/;

/** Sans accents, en minuscules : comparaison des mots-clés de quartier. */
export const norm = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Code postal de l'annonce : le sien, sinon celui lu dans l'adresse et le titre (ou la zone d'une source filtrée sur une zone). */
export function postalOf(l: Listing, src?: SourceDef, s: Settings = settings()): string | null {
  return l.postalCode ?? findPostalCode(`${l.address ?? ""} ${l.title ?? ""}`, src ? townZone(src) : null, s);
}

/**
 * Zone d'une annonce : celle de son code postal ; code inconnu : celle de la source si elle n'en couvre qu'une (src.zones),
 * sinon null (source à deux zones, ou source inconnue). Un code hors zones donne null.
 */
export function zoneOf(l: Listing, src: SourceDef | undefined, s: Settings = settings()): Zone | null {
  const postal = postalOf(l, src, s);
  const code = postal ?? (src?.zones.length === 1 ? src.zones[0] : null);
  return s.zones.find((z) => z.postalCode === code) ?? null;
}

/** Le filtre : seuls les critères de l'instance (`s`) écartent une annonce ; les drapeaux sont des indices. */
export function evaluate(l: Listing, src: SourceDef, s: Settings = settings()): Evaluation {
  const c = s.criteria;
  const flags: Flag[] = [];
  const drop = (reason: string, rentCC: number | null = null): Evaluation => ({ keep: false, rentCC, flags, reason });

  const excluded =
    l.propertyType != null ? TYPE_ANYWHERE.test(norm(l.propertyType)) : TYPE_AT_START.test(norm(l.title ?? ""));
  if (excluded) return drop("type");

  const postal = postalOf(l, src, s);
  if (postal && !s.allowedPostalCodes.includes(postal)) return drop("localisation");
  if (!postal && !src.filteredToZones) flags.push("localisation_non_confirmee");

  if (typeof l.surface === "number" && l.surface < c.surfaceMin) return drop("surface");

  if (typeof l.rooms === "number" && l.rooms > 0 && l.rooms < c.roomsMin) return drop("pieces");
  if (c.excludeGroundFloor && (l.floor === 0 || GROUND_FLOOR.test(norm(l.title ?? "")))) return drop("rdc");

  let rentCC: number | null = null;
  if (l.price == null) flags.push("prix_inconnu");
  else if (l.priceIsCC === true) rentCC = l.price;
  else if (l.priceIsCC === false && l.charges != null) rentCC = l.price + l.charges;
  else {
    rentCC = l.price;
    flags.push("charges_inconnues");
  }

  if (rentCC != null) {
    if (rentCC < c.rentMin) return drop("prix_bas", rentCC);
    if (rentCC > c.rentMax) return drop("prix_haut", rentCC);
  }

  // Mots-clés de quartier : seulement dans leur zone ou en zone inconnue (un nom de rue courant ne vaut rien dans une autre commune).
  const zone = postal ?? (src.zones.length === 1 ? src.zones[0] : null);
  const hay = norm(`${l.address ?? ""} ${l.district ?? ""} ${l.title ?? ""}`);
  if ((zone === null || zone === s.neighborhood.zone) && s.neighborhood.normalizedKeywords.some((k) => hay.includes(k)))
    flags.push("quartier");

  return { keep: true, rentCC, flags };
}

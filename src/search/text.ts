import { settings } from "../derive";
import { SEMANTIC_DESC_MAX, SEMANTIC_TEXT_MAX } from "../config/semantic";
import { postalOf, zoneOf } from "../filter";
import type { GeoHints } from "../geo/hints";
import { clip } from "../format";
import type { Evaluation, Listing, SourceDef } from "../types";

/** Contenu du payload utile à l'embedding ; `photo` : analyse des photos, gardée à l'envoi de l'alerte. */
export interface EmbedPayload {
  listing: Listing;
  evaluation?: Evaluation;
  geo?: GeoHints | null;
  photo?: { grid?: Record<string, { answer?: string }>; summary?: string | null } | null;
}

const one = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Zone (code postal) d'une annonce pour la métadonnée Vectorize ; « inconnue » si elle ne se déduit pas. */
export const ZONE_UNKNOWN = "inconnue";
export function zoneCode(l: Listing, src: SourceDef | undefined): string {
  return zoneOf(l, src)?.postalCode ?? postalOf(l, src) ?? ZONE_UNKNOWN;
}

/**
 * Texte embarqué d'une annonce : une ligne par information (titre, pièces, loyer, lieu, station, description, grille photo), au
 * plus SEMANTIC_TEXT_MAX caractères.
 */
export function embedText(p: EmbedPayload, src?: SourceDef): string {
  const l = p.listing;
  const lines: string[] = [];
  if (l.title) lines.push(one(l.title));
  const dims = [
    l.propertyType,
    typeof l.rooms === "number" ? `${l.rooms} pièce${l.rooms > 1 ? "s" : ""}` : null,
    typeof l.surface === "number" ? `${l.surface} m²` : null,
    typeof l.floor === "number" ? (l.floor === 0 ? "rez-de-chaussée" : `étage ${l.floor}`) : null,
  ].filter(Boolean);
  if (dims.length) lines.push(dims.join(", "));
  const rent = p.evaluation?.rentCC ?? l.price;
  if (typeof rent === "number") lines.push(`Loyer ${Math.round(rent)} € charges comprises`);
  const zone = zoneOf(l, src);
  const where = [l.address, l.district, l.postalCode, zone?.label].filter((s): s is string => !!s);
  if (where.length) lines.push(one(where.join(", ")));
  if (p.evaluation?.flags?.includes("quartier")) lines.push(settings().neighborhood.label);
  const st = p.geo?.station;
  if (st?.name)
    lines.push(
      `Station ${st.name}${st.lines?.length ? ` (${st.lines.join(", ")})` : ""}${st.minutes ? `, à ${st.minutes} min à pied` : ""}`,
    );
  const summary = p.photo?.summary ? one(p.photo.summary) : null;
  const desc = summary ?? (l.description ? clip(one(l.description), SEMANTIC_DESC_MAX) : null);
  if (desc) lines.push(desc);
  if (p.photo?.grid) {
    const yes = settings()
      .photoCriteria.filter((c) => p.photo!.grid![c.id]?.answer === "oui")
      .map((c) => c.label.toLowerCase());
    if (yes.length) lines.push(`Photos : ${yes.join(", ")}`);
  }
  return clip(lines.join("\n"), SEMANTIC_TEXT_MAX);
}

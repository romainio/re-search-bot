import { DPE_BANNED_CLASS, DPE_BANNED_SINCE, DPE_MENTION_CLASS, GEO_LINE_MAX } from "../config/geo";
import type { GeoHints } from "./hints";
import { stationLabel } from "./stations";
import { STATIONS } from "../data/stations";

/** Un élément d'indice : texte brut (non échappé) et nature (warn : avertissement, sinon information). */
export interface GeoPart {
  text: string;
  warn: boolean;
  /** Détail réservé au tableau de bord (pas dans la ligne de l'alerte) : un loyer possiblement au-dessus de certains plafonds seulement. */
  detail?: true;
}

/** 31.2 -> « 31,2 » ; 31 -> « 31 ». */
const eur = (n: number): string => String(Math.round(n * 10) / 10).replace(".", ",");

const labelOf = (name: string, lines: string[]): string => {
  const s = STATIONS.find((x) => x.name === name);
  return s ? stationLabel(s) : `${name} (${lines.slice(0, 3).join(", ")})`;
};

/**
 * Éléments à afficher (station, promesse non confirmée, loyer, DPE). Lecture défensive (payload de D1, champs parfois absents) ;
 * un indice « tout va bien » n'est pas affiché.
 */
export function geoParts(h: GeoHints | null | undefined): GeoPart[] {
  const out: GeoPart[] = [];
  if (!h || typeof h !== "object") return out;
  const s = h.station;
  if (s && typeof s.name === "string") {
    const label = labelOf(s.name, Array.isArray(s.lines) ? s.lines : []);
    out.push({
      text:
        s.from === "geocode" && s.minutes != null
          ? `🚇 ${label} à ~${s.minutes} min`
          : `🚇 ${label}, citée par l'annonce`,
      warn: false,
    });
  }
  const c = h.claim;
  if (c && (c.kind === "far" || c.kind === "other")) {
    if (c.kind === "far") {
      const who = c.cited ?? c.nearest;
      out.push({
        text: `⚠️ proximité annoncée non confirmée (${who} à ~${c.actual} min${c.claimed != null ? `, annoncé ${c.claimed}` : ""})`,
        warn: true,
      });
    } else {
      out.push({ text: `⚠️ ${c.cited} citée, ${c.nearest} est plus proche`, warn: true });
    }
  }
  const r = h.rent;
  if (r && (r.status === "above" || r.status === "maybe")) {
    const cap =
      r.capMin === r.capMax ? `${eur(r.capMax)} €/m²` : `${eur(r.capMin)} à ${eur(r.capMax)} €/m² selon l'époque`;
    out.push(
      r.status === "above"
        ? { text: `⚠️ loyer au-dessus du plafond (≈ ${eur(r.perM2)} €/m² pour un plafond de ${cap})`, warn: true }
        : { text: `loyer ≈ ${eur(r.perM2)} €/m², plafond de ${cap}`, warn: false, detail: true },
    );
  }
  if (h.dpe === DPE_BANNED_CLASS)
    out.push({ text: `⚠️ DPE ${h.dpe}, interdit à la location depuis ${DPE_BANNED_SINCE}`, warn: true });
  else if (h.dpe === DPE_MENTION_CLASS) out.push({ text: `DPE ${h.dpe}`, warn: false });
  return out;
}

/** Ligne unique de l'alerte (éléments joints par « · », au plus GEO_LINE_MAX caractères), null s'il n'y a rien à dire. */
export function geoLine(h: GeoHints | null | undefined): string | null {
  const parts = geoParts(h).filter((p) => !p.detail);
  if (!parts.length) return null;
  const line = parts.map((p) => p.text).join(" · ");
  return line.length <= GEO_LINE_MAX
    ? line
    : `${line
        .slice(0, GEO_LINE_MAX - 1)
        .replace(/[\uD800-\uDBFF]$/, "")
        .trimEnd()}…`;
}

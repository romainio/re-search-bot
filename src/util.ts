import { settings } from "./derive";
import type { Settings } from "./derive";
import type { SourceDef } from "./types";

const NAMED: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  euro: "€",
  laquo: "«",
  raquo: "»",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  agrave: "à",
  acirc: "â",
  auml: "ä",
  icirc: "î",
  iuml: "ï",
  ocirc: "ô",
  ouml: "ö",
  ugrave: "ù",
  ucirc: "û",
  uuml: "ü",
  ccedil: "ç",
  oelig: "œ",
  Eacute: "É",
  Egrave: "È",
  Agrave: "À",
  Ccedil: "Ç",
  deg: "°",
  sup2: "²",
  rsquo: "’",
  lsquo: "‘",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
};

export function decodeEntities(html: string): string {
  return html.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (m, dec, hex, name) => {
    const cp = dec !== undefined ? parseInt(dec, 10) : hex !== undefined ? parseInt(hex, 16) : null;
    if (cp !== null) return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    return NAMED[name] ?? m;
  });
}

// TextDecoder natif (table WHATWG) : bien plus rapide qu'une conversion caractère par caractère.
const CP1252 = new TextDecoder("windows-1252");
export function decodeWindows1252(bytes: Uint8Array): string {
  return CP1252.decode(bytes);
}

function toNumber(raw: string): number | null {
  const s = raw.replace(/[.,]+$/, "");
  const m = s.match(/^(.*)[.,](\d{1,2})$/);
  const n = m ? Number(`${m[1].replace(/[.,]/g, "")}.${m[2]}`) : Number(s.replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parseEuro(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.replace(/(?<!\d)(\d{1,3})[\s  ]+(?=\d{3}(?!\d))/g, "$1");
  const m =
    t.match(/(\d[\d.,]*)(?:\s+\d[\d.,]*)*\s*(?:€|eur\b|euros?\b)/i) ??
    t.match(/(?:€|\beur\b|\beuros?\b)\s*(\d[\d.,]*)/i);
  return m ? toNumber(m[1]) : null;
}

export function parseSurface(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:m²|m2(?![\w]))/i);
  return m ? Number(m[1].replace(",", ".")) : null;
}

export function parseRooms(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/(\d+)\s*(?:pi[èe]ces?|p\b)/i) ?? text.match(/\bT(\d+)\b/i);
  if (m) return Number(m[1]);
  return /\bstudio\b/i.test(text) ? 1 : null;
}

/**
 * Zone unique d'une source filtrée sur une zone, sinon null : elle l'emporte sur une commune nommée sans code postal (« Pont de
 * Levallois » dans une liste filtrée sur le 17e).
 */
export function townZone(src: SourceDef): string | null {
  return src.filteredToZones && src.zones.length === 1 ? src.zones[0] : null;
}

/**
 * Villes à arrondissements : code postal = préfixe + numéro sur deux chiffres (75017, 69003, 13008). `bare` : un numéro sans suffixe
 * après le nom vaut arrondissement (« Paris 17 », « Lyon 3 ») ; pas pour Marseille, où « Marseille 13 » ou « (13) » est le département.
 */
const ARR_CITIES = [
  { name: "paris", prefix: "750", max: 20, bare: true },
  { name: "lyon", prefix: "690", max: 9, bare: true },
  { name: "marseille", prefix: "130", max: 16, bare: false },
] as const;
type ArrCity = (typeof ARR_CITIES)[number];
const arrCode = (c: ArrCity, n: number): string | null =>
  Number.isInteger(n) && n >= 1 && n <= c.max ? c.prefix + String(n).padStart(2, "0") : null;
const isArrCode = (c: ArrCity, code: string): boolean =>
  code.startsWith(c.prefix) && arrCode(c, Number(code.slice(3))) === code;
/** Code d'arrondissement écrit en toutes lettres (75017, 69003, 13008) : prioritaire sur tout le reste. */
const ARR_CODE = /\b(750\d\d|6900[1-9]|130(?:0[1-9]|1[0-6]))\b/;
// « Paris 2 pièces » : le chiffre est un nombre de pièces, pas un arrondissement.
const ARR_NAMED =
  /\b(paris|lyon|marseille)\s*\(?\s*(\d{1,2})\s*(e|ème|eme|er)?\b(?!\s*(?:e|ème|eme|er)?\s*(?:pi[eè]ces?|p\b|m²|m2|chambres?|[eé]tages?|[eé]t\b|min(?:ute)?s?\b|couchages?|personnes?|km\b))/gi;
// « Paris XIV », « LYON IIIe » : chiffres romains (majuscules seules : « Paris vie » n'en est pas un).
const ARR_ROMAN = /\b(Paris|PARIS|Lyon|LYON|Marseille|MARSEILLE)\s+([IVX]{1,4})(?:e|[èe]me|er)?\b/;
/** « Lyon 3e », « Marseille 8ème », « Paris (17e) », « LYON IIIe » ; « 17e arr. » sans ville : la ville à arrondissements de l'instance. */
function arrondissement(text: string, zones: Settings["zones"]): string | null {
  for (const m of text.matchAll(ARR_NAMED)) {
    const c = ARR_CITIES.find((x) => x.name === m[1]!.toLowerCase())!;
    if (!m[3] && !c.bare) continue;
    const code = arrCode(c, Number(m[2]));
    if (code) return code;
  }
  const roman = text.match(ARR_ROMAN);
  if (roman) {
    const c = ARR_CITIES.find((x) => x.name === roman[1]!.toLowerCase())!;
    const code = arrCode(c, ROMAN[roman[2]!] ?? 0);
    if (code) return code;
  }
  const bare = text.match(/\b(\d{1,2})\s*(?:e|ème|eme|er)\s*arr/i);
  if (bare) {
    // Ville à arrondissements dont une zone est suivie (Lyon pour une recherche à Lyon) ; à défaut Paris, la plus citée ainsi.
    const city = ARR_CITIES.find((c) => zones.some((z) => isArrCode(c, z.postalCode))) ?? ARR_CITIES[0];
    return arrCode(city, Number(bare[1]));
  }
  return null;
}

// « 44000 Nantes » : code plausible (département 01 à 95 ou 97x) suivi d'un nom capitalisé ; jamais après « Réf », « n° », « mandat ».
const CODE_TOWN = /\b((?:0[1-9]|[1-8]\d|9[0-5]|97)\d{3}) ([A-ZÀ-Ý][\p{L}'’-]{2,})/gu;
const REF_BEFORE = /(?:r[eé]f|n°|mandat|#)[\s.:]*$/i;
const NOT_TOWN = /^(?:EUR|Euros?|Appartements?|Studios?|Maisons?|Pi[eè]ces?|Locations?|Loyers?|Annonces?)$/i;
function codeBeforeTown(text: string): string | null {
  for (const m of text.matchAll(CODE_TOWN)) {
    if (NOT_TOWN.test(m[2]!) || REF_BEFORE.test(text.slice(Math.max(0, m.index - 10), m.index))) continue;
    return m[1]!;
  }
  return null;
}

/**
 * Code postal lu dans un texte (« 75017 », « Paris 17e », « Lyon 3e », « (92300) », « 44000 Nantes »…) ; à défaut, commune d'une
 * zone nommée sans code (son code, ou `townZone` pour une source filtrée sur une zone).
 */
export function findPostalCode(
  text: string | null | undefined,
  townZone: string | null = null,
  s: Settings = settings(),
): string | null {
  if (!text) return null;
  const explicit = text.match(ARR_CODE);
  if (explicit) return explicit[1]!;
  const arr = arrondissement(text, s.zones);
  if (arr) return arr;
  // « (92300) », « Ville 94400 », puis « 44000 Nantes » (jamais après « Réf » ou « n° », ni devant un montant).
  const other =
    text.match(/\((\d{5})\)/)?.[1] ??
    text.match(/\b(?!R[eé]f\b)[A-ZÀ-Ý][\p{L}-]{3,}\s+(\d{5})\b/u)?.[1] ??
    codeBeforeTown(text);
  if (other) return other;
  // Commune d'une zone suivie nommée sans code postal (« Levallois-Perret », « LEVALLOIS PERRET 92 ») : après tout code explicite.
  const zoneHit = s.zones
    .map((z) => ({ postalCode: z.postalCode, at: z.town ? text.search(z.town) : -1 }))
    .filter((h) => h.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  // Source filtrée sur une seule zone : l'URL fait foi, une commune voisine citée dans le texte n'y change rien.
  if (townZone !== null) return zoneHit ? townZone : null;
  const out = outOfZoneTown(text, s.outOfZoneTowns);
  // Zone et commune voisine nommées toutes deux : la première citée est celle de l'annonce (« Clichy, près de Levallois »).
  if (out && (!zoneHit || out.at < zoneHit.at)) return out.postalCode;
  return zoneHit?.postalCode ?? null;
}

const ROMAN: Record<string, number> = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12,
  XIII: 13,
  XIV: 14,
  XV: 15,
  XVI: 16,
  XVII: 17,
  XVIII: 18,
  XIX: 19,
  XX: 20,
};

// Voies et repères qui portent le nom d'une commune sans y être (« Avenue de Clichy » est dans le 17e, « Porte de Clichy »,
// « métro Clichy », « proche Neuilly ») : la commune citée ainsi ne situe pas l'annonce.
const LANDMARK_BEFORE =
  /\b(?:rue|avenue|av\.?|boulevard|bd|blvd|place|pl\.?|porte|route|quai|pont|villa|cit[eé]|impasse|passage|square|all[eé]e|m[eé]tro|gare|rer|proche|pr[eè]s|limite|bordure|c[oô]t[eé]|vers|direction|entre|face)\s*(?:(?:de\s+la|de\s+l|du|des|de|d)['’\s]*)?$/i;

/** Première commune voisine hors zones nommée dans le texte comme lieu de l'annonce (hors voie ou repère). */
function outOfZoneTown(text: string, towns: Settings["outOfZoneTowns"]): { postalCode: string; at: number } | null {
  let best: { postalCode: string; at: number } | null = null;
  for (const { postalCode, town } of towns) {
    const re = new RegExp(town.source, "gi");
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (LANDMARK_BEFORE.test(before)) continue;
      if (!best || m.index < best.at) best = { postalCode, at: m.index };
      break;
    }
  }
  return best;
}

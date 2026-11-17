import { UNIVERSAL_PRICE_RANGE, UNIVERSAL_ROOMS_MAX, UNIVERSAL_SURFACE_RANGE } from "../config/universal";
import type { Listing } from "../types";
import { isObj } from "../guards";

// Validation stricte de la réponse du modèle : refuser plutôt que corriger. Une annonce n'est gardée que sans champ inconnu, avec
// des nombres plausibles, un prix et une surface écrits dans le texte envoyé (sinon inventés). Les champs facultatifs absents du
// texte deviennent null ; CC ou HC seulement si le texte le dit.

/** Contexte de validation : la source (ou l'expéditeur) et le texte effectivement envoyé au modèle. */
export interface ExtractContext {
  /** Identifiant de source des annonces (`Listing.source`). */
  source: string;
  /** Nom de l'agence et téléphone (SourceDef.name, SourceDef.phone). */
  agency: string | null;
  phone: string | null;
  /** URL de la page (ou de la source) : base des liens relatifs, et lien de repli d'une annonce sans lien. */
  baseUrl: string;
  /** Texte réduit envoyé au modèle. */
  text: string;
  /** Plafond d'annonces (UNIVERSAL_MAX_LISTINGS, MAIL_MAX_LISTINGS). */
  max: number;
  /** Garder la partie « ?query » des liens (page de liste : l'identifiant y est parfois) ; faux pour les liens de mail (suivi). */
  keepQuery: boolean;
}

export interface Extraction {
  listings: Listing[];
  empty: boolean;
  rejected: number;
}

const ALLOWED = new Set([
  "url",
  "title",
  "price",
  "price_kind",
  "charges",
  "surface",
  "rooms",
  "floor",
  "address",
  "postal_code",
  "district",
  "photo",
  "property_type",
]);
const TRACKING = /^(?:utm_|fbclid|gclid|mc_|_hs|xtor|at_)/i;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 300): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t && t.length <= max ? t : null;
};

/** Texte aplati pour retrouver un nombre : « 1 350 », « 1.350 », « 1 350 » (espace insécable) deviennent 1350. */
function flatten(text: string): string {
  return text.replace(/(\d)[\s .](?=\d{3}(?!\d))/g, "$1");
}

/** Le nombre est écrit dans le texte (comme entier, ou décimal avec point ou virgule). */
export function appearsIn(flat: string, n: number): boolean {
  const forms = Number.isInteger(n) ? [String(n)] : [String(n), String(n).replace(".", ",")];
  return forms.some((f) => new RegExp(`(?<![\\d.,])${f.replace(/[.]/g, "\\.")}(?![\\d])`).test(flat));
}

/** FNV-1a 32 bits en hexadécimal : identifiant de repli, déterministe et synchrone (pas de crypto asynchrone ici). */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * URL d'annonce normalisée : absolue, http(s), hôte en minuscules, sans ancre ni paramètre de suivi (ni aucun si !keepQuery),
 * paramètres triés, sans « / » final. null si ce n'est pas une URL.
 */
export function normalizeUrl(raw: string, base: string, keepQuery = true): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    if (!keepQuery) u.search = "";
    else {
      const kept = [...u.searchParams.entries()]
        .filter(([k]) => !TRACKING.test(k))
        .sort(([a], [b]) => a.localeCompare(b));
      u.search = "";
      for (const [k, v] of kept) u.searchParams.append(k, v);
    }
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    const s = u.toString();
    return u.pathname === "/" && !u.search ? s.replace(/\/$/, "") : s;
  } catch {
    return null;
  }
}

/**
 * Identifiant stable d'une annonce : son URL normalisée (la même annonce garde le même id d'un passage à l'autre) ; sans URL,
 * un hachage du titre, du prix et de la surface (préfixé « h: »). Sans URL ni titre : null (annonce inidentifiable, refusée).
 */
export function stableId(
  url: string | null,
  title: string | null,
  price: number | null,
  surface: number | null,
): string | null {
  if (url) return url;
  if (!title) return null;
  return `h:${fnv(`${title.toLowerCase()}|${price ?? ""}|${surface ?? ""}`)}`;
}

const CC = /\bCC\b|charges\s+comprises|toutes\s+charges/i;
const HC = /\bHC\b|hors\s+charges|\+\s*charges/i;

/**
 * Valide la réponse du modèle `{ "listings": [...], "empty": boolean }`. null si la forme générale est fausse ; une annonce
 * invalide est écartée et comptée dans `rejected`.
 */
export function validateExtraction(json: unknown, ctx: ExtractContext): Extraction | null {
  if (!isObj(json) || !Array.isArray(json.listings) || json.listings.length > ctx.max * 2) return null;
  if (Object.keys(json).some((k) => k !== "listings" && k !== "empty")) return null;
  if (json.empty !== undefined && typeof json.empty !== "boolean") return null;
  const flat = flatten(ctx.text);
  const out = new Map<string, Listing>();
  let rejected = 0;
  for (const it of json.listings) {
    const l = isObj(it) ? toListing(it, ctx, flat) : null;
    if (!l) {
      rejected++;
      continue;
    }
    if (out.has(l.id)) continue;
    if (out.size < ctx.max) out.set(l.id, l);
  }
  return { listings: [...out.values()], empty: json.empty === true, rejected };
}

function toListing(it: Record<string, unknown>, ctx: ExtractContext, flat: string): Listing | null {
  if (Object.keys(it).some((k) => !ALLOWED.has(k))) return null; // champ inventé
  const [pMin, pMax] = UNIVERSAL_PRICE_RANGE,
    [sMin, sMax] = UNIVERSAL_SURFACE_RANGE;

  const price = it.price === null || it.price === undefined ? null : num(it.price);
  if (it.price !== null && it.price !== undefined && price === null) return null;
  if (price !== null && (price < pMin || price > pMax || !appearsIn(flat, price))) return null;

  const surface = it.surface === null || it.surface === undefined ? null : num(it.surface);
  if (it.surface !== null && it.surface !== undefined && surface === null) return null;
  if (surface !== null && (surface < sMin || surface > sMax || !appearsIn(flat, surface))) return null;

  const roomsRaw = it.rooms === null || it.rooms === undefined ? null : num(it.rooms);
  if (
    it.rooms !== null &&
    it.rooms !== undefined &&
    (roomsRaw === null || !Number.isInteger(roomsRaw) || roomsRaw < 0 || roomsRaw > UNIVERSAL_ROOMS_MAX)
  )
    return null;

  // Charges : un nombre écrit dans le texte et inférieur au loyer, sinon null ; une valeur absurde (charges >= loyer) refuse l'annonce.
  let charges = it.charges === null || it.charges === undefined ? null : num(it.charges);
  if (it.charges !== null && it.charges !== undefined && charges === null) return null;
  if (charges !== null && (charges < 0 || (price !== null && charges >= price))) return null;
  if (charges !== null && !appearsIn(flat, charges)) charges = null;

  // CC / HC : seulement si le texte le dit ; sans prix, rien.
  const kind = it.price_kind === null || it.price_kind === undefined ? null : it.price_kind;
  if (kind !== null && kind !== "CC" && kind !== "HC") return null;
  const priceIsCC =
    price === null || kind === null
      ? null
      : kind === "CC"
        ? CC.test(ctx.text)
          ? true
          : null
        : HC.test(ctx.text)
          ? false
          : null;

  const title = str(it.title);
  const rawUrl = str(it.url, 500);
  // Lien : écrit dans le texte (tel quel, ou son chemin pour un lien résolu par la conversion).
  let url: string | null = null;
  if (rawUrl && (ctx.text.includes(rawUrl) || ctx.text.includes(rawUrl.replace(/^https?:\/\/[^/]+/, ""))))
    url = normalizeUrl(rawUrl, ctx.baseUrl, ctx.keepQuery);
  const id = stableId(url, title, price, surface);
  if (id === null) return null;

  const postal = str(it.postal_code, 5);
  const photoRaw = str(it.photo, 500);
  const photo = photoRaw && /^https:\/\//.test(photoRaw) && ctx.text.includes(photoRaw) ? photoRaw : null;
  const floor = it.floor === null || it.floor === undefined ? null : num(it.floor);
  return {
    source: ctx.source,
    id,
    url: url ?? ctx.baseUrl,
    price,
    charges: priceIsCC === true ? null : charges,
    priceIsCC,
    surface,
    rooms: roomsRaw,
    floor,
    title,
    address: str(it.address),
    district: str(it.district),
    postalCode: postal && /^\d{5}$/.test(postal) ? postal : null,
    photo,
    agency: ctx.agency,
    phone: ctx.phone,
    propertyType: str(it.property_type, 60),
    publishedAt: null,
  };
}

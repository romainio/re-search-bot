import { DETAIL_MAX_BYTES, DETAIL_TIMEOUT_MS, GALLERY_MAX, MAX_ENRICH_PER_SOURCE, USER_AGENT } from "./config/fetch";
import { DETAIL_PARSERS } from "./detail/index";
import { settings } from "./derive";
import type { Settings } from "./derive";
import { evaluate } from "./filter";
import type { KnownState } from "./process";
import { readCapped } from "./read-body";
import type { Listing, SourceDef } from "./types";
import { decodeWindows1252 } from "./util";
import { errMsg } from "./guards";

/** Champs qu'une fiche peut compléter : une valeur non nulle de la fiche remplace celle de la liste. */
const FIELDS = [
  "charges",
  "surface",
  "rooms",
  "address",
  "district",
  "postalCode",
  "agency",
  "phone",
  "publishedAt",
  "description",
] as const;

/**
 * Annonce de la liste complétée par sa fiche : un champ non nul de la fiche remplace celui de la liste ; `price` et `priceIsCC`
 * ne s'appliquent qu'ensemble. La photo de la liste est gardée ; source, id et url ne changent jamais.
 */
export function mergeDetail(l: Listing, d: Partial<Listing>): Listing {
  const out: Listing = { ...l };
  for (const k of FIELDS) {
    const v = d[k];
    if (v !== null && v !== undefined) Object.assign(out, { [k]: v });
  }
  if (d.price != null && d.priceIsCC != null) {
    out.price = d.price;
    out.priceIsCC = d.priceIsCC;
  }
  if (out.photo == null && d.photo != null) out.photo = d.photo;
  // Galerie : celle de la liste d'abord, puis celle de la fiche, sans doublon, GALLERY_MAX au plus.
  if (d.photos?.length) {
    const photos = [...new Set([...(l.photos ?? []), ...d.photos])].slice(0, GALLERY_MAX);
    out.photos = photos;
  }
  return out;
}

const UTF8 = new TextDecoder("utf-8");

/** Fiche d'une annonce, lue en flux jusqu'à `maxBytes` octets et décodée une fois ; null hors 200, sur erreur ou délai. */
export async function fetchDetail(
  url: string,
  maxBytes: number,
  encoding: SourceDef["encoding"],
  timeoutMs: number,
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "fr-FR,fr;q=0.9",
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      },
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const { bytes } = await readCapped(res, maxBytes);
    return encoding === "windows-1252" ? decodeWindows1252(bytes) : UTF8.decode(bytes);
  } catch {
    return null;
  }
}

export interface Enriched {
  listing: Listing;
  enriched: boolean;
  fields: string[];
}

/** Fiche lisible : un lecteur existe pour la famille (et accepte ce gabarit), l'URL est une fiche et pas la page de recherche. */
function readable(src: SourceDef, l: Listing): boolean {
  const reader = DETAIL_PARSERS[src.parser];
  return !!reader && /^https?:\/\//.test(l.url) && l.url !== src.url && (!reader.accepts || reader.accepts(l));
}

/** Fiches lues au plus par passage pour cette source (plafond de sa famille, sinon MAX_ENRICH_PER_SOURCE). */
export function detailCap(src: SourceDef): number {
  return DETAIL_PARSERS[src.parser]?.maxPerPass ?? MAX_ENRICH_PER_SOURCE;
}

/**
 * Lit la fiche d'une annonce et la fusionne ; sur tout échec, l'annonce de la liste (enriched = false). Aucune requête sans
 * lecteur, ou si l'URL n'est pas une fiche. `fields` : champs réellement changés.
 */
export async function enrichOne(src: SourceDef, l: Listing, timeoutMs: number = DETAIL_TIMEOUT_MS): Promise<Enriched> {
  const reader = DETAIL_PARSERS[src.parser];
  const same: Enriched = { listing: l, enriched: false, fields: [] };
  if (!reader || !readable(src, l)) return same;
  const body = await fetchDetail(l.url, reader.maxBytes ?? DETAIL_MAX_BYTES, src.encoding, timeoutMs);
  if (body === null) {
    console.error(`fiche ${src.id} ${l.id}: illisible`);
    return same;
  }
  try {
    const d = reader.read(body, l, src);
    if (!Object.keys(d).some((k) => d[k as keyof Listing] != null)) {
      // Fiche lue (200) sans aucun champ : gabarit changé, ou repère au-delà de la lecture bornée.
      console.warn(`fiche ${src.id} ${l.id}: aucun champ lu (gabarit changé ou lecture coupée ?)`);
      return same;
    }
    const merged = mergeDetail(l, d);
    const fields = (Object.keys(merged) as (keyof Listing)[]).filter((k) => merged[k] !== l[k]).sort();
    return { listing: merged, enriched: true, fields };
  } catch (e) {
    console.error(`fiche ${src.id} ${l.id}:`, errMsg(e));
    return same;
  }
}

/**
 * Fiches des annonces nouvelles que `evaluate` garde, detailCap(src) au plus, en parallèle. Aucune fiche au premier passage
 * (annonces « silent »), ni après un passage en échec : une invocation tuée (CPU) n'a rien écrit, et rejouer les mêmes fiches
 * la tuerait à chaque passage.
 */
export async function enrichListings(
  src: SourceDef,
  listings: Listing[],
  state: KnownState,
  timeoutMs: number = DETAIL_TIMEOUT_MS,
  s: Settings = settings(),
): Promise<Listing[]> {
  if (!state.wasInitialized || state.lastFailed || !DETAIL_PARSERS[src.parser]) return listings;
  const cap = detailCap(src);
  const picked: Listing[] = [];
  const seen = new Set<string>();
  for (const l of listings) {
    if (picked.length >= cap) break;
    if (seen.has(l.id) || state.known.has(l.id)) continue;
    seen.add(l.id);
    if (readable(src, l) && evaluate(l, src, s).keep) picked.push(l);
  }
  if (!picked.length) return listings;
  const done = await Promise.all(picked.map((l) => enrichOne(src, l, timeoutMs)));
  const byId = new Map(done.filter((d) => d.enriched).map((d) => [d.listing.id, d.listing]));
  return byId.size ? listings.map((l) => byId.get(l.id) ?? l) : listings;
}

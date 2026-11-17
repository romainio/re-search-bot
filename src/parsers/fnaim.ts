import type { Listing, SourceDef } from "../types";
import { findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// État vide d'une vraie recherche sans résultat : « Nous n'avons pour l'instant pas d'offres... ».
export const FNAIM_EMPTY = /<div class="noResultMsg">/;

export function parseFnaim(body: string, src: SourceDef): Listing[] {
  const items = cards(body, '<li class="item"', { maxLen: 20000 });
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const a of items) {
    const id = a.match(/\bdata-id="(\d+)"/)?.[1];
    const href = a.match(/href="(\/annonce-immobiliere\/[^"]+)"/)?.[1];
    if (!id || !href || seen.has(id)) continue;
    seen.add(id);
    const title = text(a.match(/<h3>([\s\S]*?)<\/h3>/)?.[1]);
    const priceTxt = text(a.match(/<p class="price">([\s\S]*?)<\/p>/)?.[1]);
    const desc = text(a.match(/<p class="description">([\s\S]*?)<\/p>/)?.[1]);
    const lieu = text(a.match(/<p class="picto lieu[^"]*">([\s\S]*?)<\/p>/)?.[1]);
    const photo = a.match(/<img[^>]*?\ssrc="(https?:[^"]+)"/)?.[1];
    out.push({
      source: src.id,
      id,
      url: abs(href, src.url),
      price: parseEuro(priceTxt),
      charges: null,
      // CC lu dans le seul élément du prix, jamais dans la description libre.
      priceIsCC: priceTxt && /charges comprises|€\s*CC\b/i.test(priceTxt) ? true : null,
      surface: parseSurface(title),
      rooms: parseRooms(title),
      title,
      address: desc ? desc.slice(0, 200) : null,
      district: null,
      postalCode: lieu?.match(/\b(\d{5})\b/)?.[1] ?? findPostalCode(title, townZone(src)),
      photo: photo ?? null,
      agency: text(a.match(/<div class="nom">[\s\S]*?<b>([\s\S]*?)<\/b>/)?.[1]),
      phone: text(a.match(/class="telNumber"[^>]*>([\s\S]*?)<\/span>/)?.[1]),
      propertyType: title?.split(" ")[0] ?? null,
      publishedAt: null,
    });
  }
  if (out.length === 0 && !FNAIM_EMPTY.test(body)) throw new Error("fnaim: aucune carte trouvée");
  return out;
}

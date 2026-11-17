import type { Listing, SourceDef } from "../types";
import { findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Seul état vide fiable, vérifié sur une page filtrée vide : cette phrase. Sans elle, zéro carte lève.
export const LBI_EMPTY = /aucun bien n(?:'|&#0?39;|’)est disponible pour le moment/i;

// Sites La Boîte Immo / Hektor au gabarit « item » : une carte = <article class="item ...">.
export function parseLbi(body: string, src: SourceDef): Listing[] {
  const arts = cards(body, '<article class="item', { endMarker: "</article>", maxLen: 40000 });
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const a of arts) {
    const id = a.match(/idbien=(\d+)/)?.[1];
    const href = a.match(/href="(\/location\/[^"]+)"/)?.[1];
    if (!id || !href || seen.has(id)) continue; // article de pagination ou promo, ou doublon
    seen.add(id);
    const title = text(a.match(/item__block--title[^>]*>([\s\S]*?)<\/p>/)?.[1]);
    const city = text(a.match(/item__block--city[\s\S]*?title-v1__part1[^>]*>([^<]*)</)?.[1]);
    const priceTxt = text(a.match(/class="item__price[^>]*>([\s\S]*?)<\/div>/)?.[1]);
    const photo = a.match(/<img[^>]*?\ssrc="([^"]+)"/)?.[1];
    out.push({
      source: src.id,
      id,
      url: abs(href, src.url),
      price: parseEuro(priceTxt),
      charges: null,
      // « 1 340 € CC* » : la page dit charges comprises.
      priceIsCC: priceTxt && /\bCC\b/.test(priceTxt) ? true : null,
      surface: parseSurface(title),
      rooms: parseRooms(title),
      title,
      address: null,
      district: null,
      postalCode: findPostalCode(city, townZone(src)),
      photo: photo ? abs(photo, src.url) : null,
      agency: text(a.match(/identity__name[^>]*>([\s\S]*?)<\/div>/)?.[1]),
      phone: null,
      propertyType: title?.split(" ")[0] ?? null,
      publishedAt: null,
    });
  }
  if (out.length === 0 && !LBI_EMPTY.test(body)) throw new Error("lbi: aucune carte trouvée");
  return out;
}

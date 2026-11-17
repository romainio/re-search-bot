import type { Listing, SourceDef } from "../types";
import { decodeEntities, findPostalCode, townZone, parseEuro, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Famille « _siteAT1605 » (thème /theme/_siteAT1605…) : liste rendue côté serveur, une page. Une carte =
// <article class="annonce_listing"> : lien …/ref-<réf>/<slug>/ (la référence est l'identifiant), <span itemprop="price">Loyer :
// 1 050 € par mois</span>, <span itemprop="address">, « <strong>appartement</strong><strong> de 32 m²</strong> », « Pièces : 2 ».
// Seul un prix mensuel (« par mois ») est un loyer : « 21 600 € /an HC HT* » est un local d'activité. CC/HC lu dans le bloc du
// prix ; « bureaux » devient « Bureau » (type exclu par evaluate). État vide prouvé, absent des pages peuplées : <p class="no-result">.
export const AT1605_EMPTY = /<p class="no-result">\s*Aucune de nos annonces ne correspond/;
const CARD = '<article class="annonce_listing"';

export function parseAt1605(body: string, src: SourceDef): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const a of cards(body, CARD, { endMarker: "</article>", maxLen: 8000 })) {
    const link = a.match(/<a href="([^"]*\/ref-([^/"]+)\/[^"]*)" title="([^"]*)"/);
    const id = link?.[2];
    if (!link || !id || seen.has(id)) continue; // carte sans lien, ou doublon
    seen.add(id);
    // « Loyer : 1 050 € par mois Charges comprises * » : prix et mention des charges, rien d'autre.
    const offer = text(a.match(/<div itemprop="offers"[^>]*>([\s\S]*?)<span class="ref_listing">/)?.[1]);
    const monthly = offer !== null && /par mois|\/\s*mois/i.test(offer);
    const price = monthly ? parseEuro(offer) : null;
    const address = text(a.match(/<span itemprop="address">([\s\S]*?)<\/span>/)?.[1]);
    const good = a.match(/itemprop="typeOfGood"><strong>([\s\S]*?)<\/strong>(?:<strong>([\s\S]*?)<\/strong>)?/);
    const type = text(good?.[1])?.replace(/^bureaux$/i, "bureau") ?? null;
    const rooms = a.match(/<span>Pi(?:è|&egrave;)ces :<\/span>\s*<strong>(\d+)<\/strong>/)?.[1];
    const photo = a.match(/<img class="autoScale" src="([^"]+)"/)?.[1];
    out.push({
      source: src.id,
      id,
      url: abs(link[1], src.url),
      price,
      charges: null,
      priceIsCC:
        price === null
          ? null
          : /charges comprises/i.test(offer!)
            ? true
            : /hors charges|\bHC\b/i.test(offer!)
              ? false
              : null,
      surface: parseSurface(text(good?.[2])),
      rooms: rooms ? Number(rooms) : null,
      title: text(decodeEntities(link[3])),
      address,
      district: null,
      postalCode: findPostalCode(address, townZone(src)),
      photo: photo ? abs(photo, src.url) : null,
      agency: null,
      phone: null,
      propertyType: type ? type.charAt(0).toUpperCase() + type.slice(1) : null,
      publishedAt: null,
    });
  }
  if (out.length === 0 && !AT1605_EMPTY.test(body)) throw new Error("at1605: aucune carte trouvée");
  return out;
}

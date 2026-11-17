import type { Listing, SourceDef } from "../types";
import { findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Oralia (oralia.fr/location/nos-biens-a-louer/…) : liste rendue côté serveur, filtrée par l'URL. Une carte =
// <div class="estate-item search-item" data-id="<id>"> : lien estate-item__link, prix « 3 990 € » + « par mois / CC »,
// estate-item__infos « Appartement · 5 pièces · 157m² », lieu « Paris (75017) ». Pas d'état vide connu : zéro carte lève.
const CARD = '<div class="estate-item search-item"';

export function parseOralia(body: string, src: SourceDef): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const a of cards(body, CARD, {
    endMarker: '<div class="d-flex justify-content-center agencies-city__btn-wrapper">',
    maxLen: 8000,
  })) {
    const id = a.match(/\sdata-id="(\d+)"/)?.[1];
    const href = a.match(/<a class="estate-item__link" href="([^"]+)"/)?.[1];
    if (!id || !href || seen.has(id)) continue; // carte sans identifiant ou sans lien, ou doublon
    seen.add(id);
    // « 3 990 € par mois / CC » : la mention CC/HC n'est lue que dans le bloc du prix.
    const priceTxt = text(a.match(/<p class="price-for-map">([\s\S]*?)<\/p>/)?.[1]);
    const price = parseEuro(priceTxt);
    const infos = text(a.match(/<p class="estate-item__infos">([\s\S]*?)<\/p>/)?.[1]); // « Appartement · 5 pièces · 157m² »
    const place = text(a.match(/<p class="estate-item__location">([\s\S]*?)<\/p>/)?.[1]); // « Paris (75017) »
    const photo = a.match(/<img class="estate-item__img" src="([^"]+)"/)?.[1];
    out.push({
      source: src.id,
      id,
      url: abs(href, src.url),
      price,
      charges: null,
      priceIsCC:
        priceTxt && price !== null
          ? /\bCC\b|charges comprises/i.test(priceTxt)
            ? true
            : /\bHC\b|hors charges/i.test(priceTxt)
              ? false
              : null
          : null,
      surface: parseSurface(infos),
      rooms: parseRooms(infos),
      title: infos,
      address: place,
      district: null,
      postalCode: findPostalCode(place, townZone(src)),
      photo: photo ? abs(photo, src.url) : null,
      agency: null,
      phone: null,
      propertyType: infos?.split("·")[0].trim() || null,
      publishedAt: null,
    });
  }
  if (out.length === 0) throw new Error("oralia: aucune carte trouvée");
  return out;
}

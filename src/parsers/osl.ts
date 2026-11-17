import type { Listing, SourceDef } from "../types";
import { decodeEntities, findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Famille « _siteOSL2208 » (thème /theme/_siteOSL2208.<agence>/) : liste rendue côté serveur, une page. Une carte =
// <div class="section container_grid container_grid_mob"> : lien …/ref-<réf>-<agence>/… (la référence est l'identifiant),
// surface et pièces en pictogrammes, <h2 class="t3 city">, <span class="price">2 708 € / mois</span>. Seul un prix mensuel est
// un loyer (« Prix sur demande », « … /an HC HT* » écartés). Aucune mention de charges. Pas d'état vide connu : zéro carte lève.
const CARD = '<div class="section container_grid container_grid_mob">';

export function parseOsl(body: string, src: SourceDef): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const a of cards(body, CARD, { endMarker: '<div class="section container_pagination">', maxLen: 8000 })) {
    const link = a.match(/<a href="([^"]+\/ref-([^/"]+)\/[^"]*)" title="([^"]*)" class="ctn_img/);
    const id = link?.[2];
    if (!link || !id || seen.has(id)) continue; // carte sans lien, ou doublon
    seen.add(id);
    const label = (picto: string): string | null => {
      // <span class="picto picto_surface"> </span><span class="label">67.25 m²</span>
      const i = a.indexOf(`picto_${picto}"`);
      return i < 0 ? null : text(a.slice(i, i + 400).match(/<span class="label">([\s\S]*?)<\/span>/)?.[1]);
    };
    const priceTxt = text(a.match(/<span class="price">([\s\S]*?)<\/span>/)?.[1]); // « 2 708 € / mois »
    const city = text(a.match(/<h2 class="t3 city">([\s\S]*?)<\/h2>/)?.[1]); // « Paris (75017) »
    const type = text(a.match(/<div class="t5">\s*<span>([\s\S]*?)<\/span>/)?.[1]);
    const photo = a.match(/\sdata-src="([^"]+)"/)?.[1];
    out.push({
      source: src.id,
      id,
      url: abs(link[1], src.url),
      price: priceTxt && /\/\s*mois/i.test(priceTxt) ? parseEuro(priceTxt) : null,
      charges: null,
      priceIsCC: null,
      surface: parseSurface(label("surface")),
      rooms: parseRooms(label("pieces")),
      title: text(decodeEntities(link[3])),
      address: city,
      district: null,
      postalCode: findPostalCode(city, townZone(src)),
      photo: photo ? abs(photo, src.url) : null,
      agency: null,
      phone: null,
      propertyType: type ? type.charAt(0).toUpperCase() + type.slice(1) : null,
      publishedAt: null,
    });
  }
  if (out.length === 0) throw new Error("osl: aucune carte trouvée");
  return out;
}

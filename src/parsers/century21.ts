import type { Listing, SourceDef } from "../types";
import { decodeEntities, findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Century 21 (century21.fr/annonces/location-appartement/<lieu>/) : liste rendue côté serveur. Une carte =
// <div class="c-the-property-thumbnail-with-content js-…" data-uid="<id>"> ; les « Biens se rapprochant » après la pagination
// ont une autre classe et ne sont jamais lus. Pas d'état vide connu : zéro carte lève.
const CARD = 'class="c-the-property-thumbnail-with-content js-the-property-thumbnail-with-content';

export function parseCentury21(body: string, src: SourceDef): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const a of cards(body, CARD, { endMarker: "c-the-pagination-bar", maxLen: 30000 })) {
    const id = a.match(/^[^>]*\sdata-uid="(\d+)"/)?.[1]; // attribut de la carte elle-même
    const href = a.match(/href="(\/trouver_logement\/detail\/\d+\/)"/)?.[1];
    if (!id || !href || seen.has(id)) continue; // carte sans identifiant, ou doublon
    seen.add(id);
    // « LEVALLOIS PERRET&nbsp; 92 <br/> 38,07 m<sup>2</sup>, 1 pièce <div>Ref : 3298</div> »
    const head = a.match(/<div class="c-text-theme-heading-4[^"]*">([\s\S]*?)<div/)?.[1] ?? "";
    const [placeHtml, factsHtml] = head.split(/<br\s*\/?>/);
    const place = text(placeHtml);
    const facts = text(factsHtml?.replace(/m<sup>2<\/sup>/g, "m²"));
    const type = text(a.match(/<div class="c-text-theme-heading-3[^"]*">([\s\S]*?)<\/div>/)?.[1]); // « Appartement F1 à louer »
    // « 1 146&nbsp;&euro; <p>par mois charges comprises</p> » : la mention CC/HC n'est lue que dans le bloc du prix.
    const priceTxt = text(a.match(/<div class="c-text-theme-heading-1[^"]*">([\s\S]*?)<\/div>/)?.[1]);
    const price = parseEuro(priceTxt);
    // Extrait de l'annonce : sa première ligne est un titre (« GRAND STUDIO … - RUE EDOUARD VAILLANT »).
    const excerpt = a.match(/<div class="c-text-theme-base tw-truncate-safe">([\s\S]*?)<\/div>/)?.[1];
    const headline = excerpt
      ? decodeEntities(excerpt.replace(/<[^>]*>/g, " "))
          .trim()
          .split(/\n/)[0]
          .replace(/\s+/g, " ")
          .trim()
      : "";
    const alt = a.match(/aria-label="([^"]*)"/)?.[1];
    const photo = a.match(/<img\s+(?:data-)?src="([^"]+)"/)?.[1];
    out.push({
      source: src.id,
      id,
      url: abs(href, src.url),
      price,
      charges: null,
      priceIsCC:
        priceTxt && price !== null
          ? /charges comprises/i.test(priceTxt)
            ? true
            : /hors charges/i.test(priceTxt)
              ? false
              : null
          : null,
      surface: parseSurface(facts),
      rooms: parseRooms(facts),
      title: headline.slice(0, 200) || (alt ? decodeEntities(alt).trim() || null : null),
      address: place,
      district: null,
      // Ville d'une zone suivie, ou code ; autre ville sans code : sentinelle "00000" ; « PARIS » seul : inconnu.
      postalCode: findPostalCode(place, townZone(src)) ?? (place && !/paris/i.test(place) ? "00000" : null),
      photo: photo ? abs(photo, src.url) : null,
      // La carte ne nomme pas l'agence (plusieurs agences publient sur une ville) : nom de la source.
      agency: null,
      phone: null,
      propertyType: type?.split(" ")[0] ?? null,
      publishedAt: null,
    });
  }
  if (out.length === 0) throw new Error("century21: aucune carte trouvée");
  return out;
}

import type { Listing, SourceDef } from "../types";
import { findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Sites maison alimentés par Apimo, sans rien de commun avec les CMS de apimo.ts (lecteur séparé pour ne pas mêler leurs
// marqueurs). Une variante par site, toutes appliquées au corps de page.
//  - Consultants Immobilier (WordPress) : liste filtrée par l'URL. Une carte = <div class="property_snippet"> : lien
//    /annonces/louer/<agence>/<id Apimo>/, col_title (type, pièces, surface, ville), col_price. Pas de code postal : lu dans
//    la ville, autre ville = « 00000 ». La suite de la liste arrive en AJAX : seule la première tranche est lue.
//  - Paris Neuilly Immobilier (« finder ») : <div class="finder-item hidden" data-finderzipcode data-finderprice
//    data-finderarea data-finderrooms>, lien /louer/<id Apimo>.html. data-finderrooms compte les CHAMBRES : pièces inconnues ;
//    emplacements vides de la grille et zones de la carte SVG, sans lien, ignorés.
// État vide strict, Consultants seulement : <p class="noresults">. Paris Neuilly : le panneau « finder-empty » est toujours
// présent (masqué) : pas d'état vide connu, zéro carte lève.
export const WPAPIMO_EMPTY = /<p class="noresults">\s*Aucun bien ne correspond à votre recherche/;

type Fields = {
  id: string | undefined;
  href: string | undefined;
  title: string | null;
  priceTxt: string | null;
  surface: number | null;
  rooms: number | null;
  place: string | null;
  postal: string | null;
  type: string | null;
  photo: string | undefined;
};
type Variant = { marker: string; endMarker?: string; fields: (a: string, src: SourceDef) => Fields };

const num = (v: string | undefined): number | null => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const VARIANTS: Variant[] = [
  {
    // Consultants Immobilier
    marker: '<div class="property_snippet">',
    endMarker: '<div class="attribs">',
    fields: (a, src) => {
      const href = a.match(/<a href="([^"]*\/annonces\/louer\/\d+\/(\d+)\/)"/);
      const col = a.match(/<div class="col_title">\s*<strong>([\s\S]*?)<\/strong>\s*<span>([\s\S]*?)<\/span>/);
      const facts = text(col?.[1].match(/<span>([\s\S]*?)<\/span>/)?.[1]); // « 2 pièces de 35.00 m² »
      const place = text(col?.[2]);
      return {
        id: href?.[2],
        href: href?.[1],
        title: text(col?.[1]),
        priceTxt: text(a.match(/<div class="col_price">([\s\S]*?)<\/div>/)?.[1]),
        surface: parseSurface(facts),
        rooms: parseRooms(facts),
        place,
        postal: place ? (findPostalCode(place, townZone(src)) ?? (/paris/i.test(place) ? null : "00000")) : null,
        type: text(col?.[1].replace(/<span>[\s\S]*?<\/span>/, "")),
        photo: a.match(/\sdata-bg="([^"]+)"/)?.[1],
      };
    },
  },
  {
    // Paris Neuilly Immobilier
    marker: '<div class="finder-item ',
    endMarker: "</a>",
    fields: (a) => {
      // Attributs lus sur la balise ouvrante seulement : un emplacement vide n'en a pas.
      const tag = a.slice(0, a.indexOf(">"));
      const href = tag.includes("data-finderzipcode=") ? a.match(/<a href="(\/louer\/(\d+)\.html)"/) : null;
      const place = text(a.match(/<div class="finder-item-location">([\s\S]*?)<\/div>/)?.[1]);
      const price = num(tag.match(/data-finderprice="(\d+)"/)?.[1]);
      return {
        id: href?.[2],
        href: href?.[1],
        title: place,
        priceTxt: price !== null ? `${price} €` : null,
        surface: num(tag.match(/data-finderarea="([\d.]+)"/)?.[1]),
        rooms: null,
        place,
        postal: tag.match(/data-finderzipcode="(\d{5})"/)?.[1] ?? null,
        type: null,
        photo: a.match(/\sdata-original="([^"]+)"/)?.[1],
      };
    },
  },
];

export function parseWpapimo(body: string, src: SourceDef): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const v of VARIANTS) {
    for (const a of cards(body, v.marker, { endMarker: v.endMarker, maxLen: 30000 })) {
      const f = v.fields(a, src);
      if (!f.id || !f.href || seen.has(f.id)) continue; // emplacement vide, zone de la carte, ou doublon
      seen.add(f.id);
      out.push({
        source: src.id,
        id: f.id,
        url: abs(f.href, src.url),
        price: parseEuro(f.priceTxt),
        charges: null,
        priceIsCC: null,
        surface: f.surface,
        rooms: f.rooms,
        title: f.title,
        address: f.place,
        district: null,
        postalCode: f.postal,
        photo: f.photo ? abs(f.photo, src.url) : null,
        agency: null,
        phone: null,
        propertyType: f.type,
        publishedAt: null,
      });
    }
  }
  if (out.length === 0 && !WPAPIMO_EMPTY.test(body)) throw new Error("wpapimo: aucune carte trouvée");
  return out;
}

import type { Listing, SourceDef } from "../types";
import { decodeEntities, findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text, titleType } from "./html";

// Famille immo-facile « office5 » (pages ISO-8859-1 : encoding "windows-1252" ; liens relatifs « ../fiches/… »). Liste rendue
// côté serveur dans <div id="listing_bien">, terminée par « barre-navigation-bottom », une fois par page après la dernière
// carte : borne de lecture et stopMarker. Trois habillages :
// - Imax : <div class="listing__item">, listing__title, listing__location « 92300 LEVALLOIS PERRET », listing__price, pied <li> ;
// - Mister Property : <div class="box-listing__item">, card-bien__content__title / __location / __price, pied <li> (« 0 m² »
//   d'un parking : inconnu) ;
// - F.G.D.I Pereire, Safar : <div class="listing-item">, product-name (ville seule : pas de code inventé ; autre ville :
//   "00000"), ui-price__value et ui-price__text « charges comprises », data-list__item--NbPiece / --Surface.
// Identifiant : le numéro du lien « ../fiches/<catégorie>_<id>/<slug>.html », jamais la référence d'agence. La catégorie donne le
// type (3 appartement, 4 maison, 7 parking, 24 local professionnel). Seul un loyer mensuel hors « HT » est lu ; CC/HC : texte du
// prix seulement. État vide de la plateforme, absent des pages peuplées : <div id="page_no_products">.
export const OFFICE5_EMPTY = '<div id="page_no_products">';
const CARD_MARKERS = ['<div class="listing__item">', '<div class="box-listing__item">', '<div class="listing-item">'];
const LIST_END = "barre-navigation-bottom";
const CATEGORY: Record<string, string> = {
  "3": "Appartement",
  "4": "Maison",
  "7": "Parking",
  "24": "Local professionnel",
};

export function parseOffice5(body: string, src: SourceDef): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  const end = body.indexOf(LIST_END);
  const list = end >= 0 ? body.slice(0, end) : body;
  const marker = CARD_MARKERS.find((m) => list.includes(m));
  const baseHref = body.match(/<base href="([^"]+)"/)?.[1];
  const base = baseHref ? abs(baseHref, src.url) : new URL("/catalog/", src.url).toString();
  for (const a of marker ? cards(list, marker, { maxLen: 12000 }) : []) {
    const link = a.match(/href="([^"]*\/fiches\/(\d+)[\d-]*_(\d+)\/[^"]*)"[^>]*?\stitle="([^"]*)"/); // title juste après href, ou après class="listing__link" (deux versions du gabarit)
    const id = link?.[3];
    if (!link || !id || seen.has(id)) continue; // carte sans lien de fiche, ou doublon
    seen.add(id);
    const title = text(decodeEntities(link[4]));
    // Lieu : « 92300 LEVALLOIS PERRET » (Imax, Mister) ou dernière <span> du nom (« Paris », « Vincennes ») de Pereire / Safar.
    const name = a.match(/<div class="product-name[^"]*">([\s\S]*?)<\/div>/)?.[1];
    const place =
      text(a.match(/class="(?:listing__location|card-bien__content__location)">([\s\S]*?)<\/(?:span|div)>/)?.[1]) ??
      (name ? text([...name.matchAll(/<span>([\s\S]*?)<\/span>/g)].pop()?.[1]) : null);
    const priceTxt = text(
      a.match(
        /class="(?:listing__price|card-bien__content__price|ui-price__value[^"]*)">([\s\S]*?)<\/(?:span|div)>/,
      )?.[1],
    );
    const priceNote = text(a.match(/class="ui-price__text[^"]*">([\s\S]*?)<\/span>/)?.[1]);
    const priceAll = `${priceTxt ?? ""} ${priceNote ?? ""}`;
    const monthly = priceTxt !== null && /\/\s*mois/i.test(priceTxt) && !/\bHT\b/.test(priceAll);
    const priceIsCC = /charges comprises|\bCC\b/i.test(priceAll)
      ? true
      : /hors charges|\bHC\b/i.test(priceAll)
        ? false
        : null;
    // Surface et pièces : champs data-list (Pereire, Safar), sinon puces du pied de carte (Imax, Mister), sinon titre Imax.
    const field = (k: string): string | null =>
      text(a.match(new RegExp(`data-list__item--${k}">[\\s\\S]*?data-list__item--value">([\\s\\S]*?)</span>`))?.[1]);
    const lis = [
      ...(a.match(/(?:listing__infos__footer|card-bien__content__footer)"?>([\s\S]*?)<\/ul>/)?.[1] ?? "").matchAll(
        /<li>([\s\S]*?)<\/li>/g,
      ),
    ].map((m) => text(m[1]) ?? "");
    const surfaceNum = field("Surface");
    const surface =
      surfaceNum !== null
        ? parseSurface(`${surfaceNum} m²`)
        : parseSurface(lis.find((t) => /\d\s*m(?:²|2)?$/i.test(t)));
    const roomsNum = field("NbPiece");
    const rooms =
      roomsNum !== null
        ? parseRooms(`${roomsNum} pièces`)
        : parseRooms(
            lis.find((t) => /pi[èe]ce/i.test(t)) ?? text(a.match(/class="listing__title">([\s\S]*?)<\/span>/)?.[1]),
          );
    const photo = a.match(/<img src="([^"]*\/catalog\/images\/[^"]+)"/)?.[1];
    out.push({
      source: src.id,
      id,
      url: abs(link[1], base),
      price: monthly ? parseEuro(priceTxt) : null,
      charges: null,
      priceIsCC,
      surface: surface || null,
      rooms: rooms || null,
      title,
      address: place,
      district: null,
      postalCode:
        place?.match(/^(\d{5})\b/)?.[1] ??
        findPostalCode(`${title ?? ""}, ${place ?? ""}`, townZone(src)) ??
        (place && !/paris/i.test(place) ? "00000" : null),
      photo: photo ? abs(photo, base) : null,
      agency: null,
      phone: null,
      propertyType: CATEGORY[link[2]] ?? titleType(title),
      publishedAt: null,
    });
  }
  if (out.length === 0 && !body.includes(OFFICE5_EMPTY)) throw new Error("office5: aucune carte trouvée");
  return out;
}

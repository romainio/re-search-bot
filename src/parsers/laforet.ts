import type { Listing, SourceDef } from "../types";
import { decodeEntities, findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Laforêt (laforet.com/ville/location-appartement-<ville>-<cp>) : la page pèse 1,2 Mo, la liste n'en occupe que le début, entre
// le premier <article … data-counter-model-value="property"> et la section « à proximité » (id="nearest--area--0", cartes
// d'autres villes). Un indexOf borne cette tranche, jamais de regex sur la page. Sans ce repère, toute la page est lue et les
// cartes voisines gardent leur code postal pour le filtre. État vide prouvé : LAFORET_EMPTY ; sans lui, zéro carte lève.
const CARD = 'data-counter-model-value="property"';
/** Début de la section « à proximité » : fin des cartes, et stopMarker de la source. */
export const NEARBY = 'id="nearest--area--';
/** État vide strict, vérifié sur une vraie page à zéro résultat. */
export const LAFORET_EMPTY = /<p class="text-primary font-bold">\s*Aucune annonce ne correspond à votre recherche/;

// data-gtm-item-<name>-param="…" du bouton favori de la carte (valeurs structurées de la fiche).
function gtm(a: string, name: string): string | null {
  const k = `data-gtm-item-${name}-param="`;
  const i = a.indexOf(k);
  if (i < 0) return null;
  const from = i + k.length;
  const v = a.slice(from, a.indexOf('"', from)).trim();
  return v === "" ? null : decodeEntities(v);
}
const num = (v: string | null): number | null => {
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function parseLaforet(body: string, src: SourceDef): Listing[] {
  // Liste vide : la première carte est une voisine (autre ville). Seules comptent les cartes avant la section « à proximité ».
  const nearby = body.indexOf(NEARBY);
  const first = body.indexOf(CARD);
  const slice =
    first < 0 || (nearby >= 0 && first > nearby) ? "" : body.slice(first, nearby < 0 ? body.length : nearby);
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const a of cards(slice, CARD, { maxLen: 40000 })) {
    const id = a.match(/data-counter-id-value="(\d+)"/)?.[1];
    const href = a.match(/href="([^"]+)"\s+target="_blank"\s+class="after:absolute/)?.[1];
    if (!id || !href || seen.has(id)) continue; // carte sans identifiant, ou doublon
    seen.add(id);
    const where = text(a.match(/class="font-bold text-gray-600">([\s\S]*?)<\/span>/)?.[1]); // « PARIS (75017) »
    const priceTxt = text(a.match(/text-tertiary font-bold ml-auto text-right"\s*>([\s\S]*?)<\/span>/)?.[1]); // « 2 500 €/mois »
    const facts = text(a.match(/<div class="text flex flex-wrap"\s*>([\s\S]*?)<\/div>/)?.[1]); // « 65 m² • 3 pièces • 1 chambre »
    const tel = a.match(/href="tel:(\d{10})"/)?.[1];
    const photo = a.match(/<img\s[^>]*?src="(\/glide\/[^"]+)"/)?.[1];
    const city = gtm(a, "city");
    out.push({
      source: src.id,
      id,
      url: abs(href, src.url),
      // Aucune mention CC/HC : priceIsCC inconnu.
      price: parseEuro(priceTxt),
      charges: null,
      priceIsCC: null,
      surface: num(gtm(a, "size")) ?? parseSurface(facts),
      rooms: num(gtm(a, "rooms-nb")) ?? parseRooms(facts),
      title: text(a.match(/data-gtm-click-vignette-param="([^"]*)"/)?.[1])?.replace(/\s+à louer$/, "") ?? null,
      address: where,
      district: null,
      // Ville hors Paris sans code postal : sentinelle "00000", rejetée en « localisation ».
      postalCode:
        gtm(a, "zipcode") ?? findPostalCode(where, townZone(src)) ?? (city && !/paris/i.test(city) ? "00000" : null),
      photo: photo ? abs(photo, src.url) : null,
      agency: "Laforêt",
      phone: tel ? tel.replace(/(\d\d)(?=\d)/g, "$1 ") : null,
      propertyType: gtm(a, "type"),
      publishedAt: null,
    });
  }
  if (out.length === 0 && !LAFORET_EMPTY.test(body)) throw new Error("laforet: aucune carte trouvée");
  return out;
}

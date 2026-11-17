import type { Listing, SourceDef } from "../types";
import { findPostalCode, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Plateforme Billie.immo : liste rendue côté serveur, 24 cartes par page, triée par prix ; les filtres GET sont ignorés, tout le
// réseau est lu et trié dans le code. Une carte = <div class="item-property inline"> : <img src> (première photo), <a class="title"
// href="/fr/immobilier/location/<type>/<ville>/<slug>/<id>">PARIS 17 - TERNES</a>, <div class="subtitle">, <div class="price">.
// Une carte « loué » (lien /fr/immobilier/loue/…) est en vitrine : ignorée. Pas de code postal sur la carte : la ville vient du
// lien, l'arrondissement du titre (« PARIS 16e », « Paris XV »), sinon un code du titre ou la sentinelle "00000". « 0 pièce(s) »
// (parking) : pièces inconnues. État vide prouvé, absent des pages peuplées : <div class="no-results">.
export const BILLIE_EMPTY = /<div class="no-results">\s*Il n'y a actuellement aucun bien correspondant/;
const CARD = '<div class="item-property';
const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10 };

/** Arrondissement en chiffres romains (« Paris XV », « PARIS - XVII ») : 750xx, sinon null. */
function romanArr(title: string): string | null {
  const r = title.match(/\bparis\s*-?\s*([XVI]{1,5})\b/i)?.[1]?.toUpperCase();
  if (!r) return null;
  let n = 0;
  for (let i = 0; i < r.length; i++) {
    const v = ROMAN[r[i]],
      next = ROMAN[r[i + 1]] ?? 0;
    n += v < next ? -v : v;
  }
  return n >= 1 && n <= 20 ? `750${String(n).padStart(2, "0")}` : null;
}

/** Code postal d'après la ville du lien et le titre ; jamais un code d'une zone suivie pour une autre ville. */
function postalOf(city: string, title: string | null): string | null {
  if (city === "paris") {
    const p = findPostalCode(title) ?? (title ? romanArr(title) : null);
    return p?.startsWith("750") ? p : null; // « Paris » sans arrondissement : inconnu
  }
  // Autre ville : code du titre, sinon la commune du lien reconnue par la configuration (zone ou commune exclue).
  return title?.match(/\b(\d{5})\b/)?.[1] ?? findPostalCode(city.replace(/-/g, " ")) ?? "00000";
}

export function parseBillie(body: string, src: SourceDef): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  let rented = 0;
  // 3 à 12 Ko par carte (carrousel) ; pas d'endMarker, dont l'indexOf jusqu'au bas de page coûterait 1 ms par carte.
  for (const a of cards(body, CARD, { maxLen: 40000 })) {
    const link = a.match(
      /<a class="title" href="([^"]*\/fr\/immobilier\/(location|loue)\/([^/"]+)\/([^/"]+)\/[^/"]+\/(\d+))">([\s\S]*?)<\/a>/,
    );
    if (link?.[2] === "loue") {
      rented++;
      continue;
    } // bien déjà loué, en vitrine
    const id = link?.[5];
    if (!link || !id || seen.has(id)) continue; // carte sans lien, ou doublon
    seen.add(id);
    const title = text(link[6]);
    const subtitle = text(a.match(/<div class="subtitle">([\s\S]*?)<\/div>/)?.[1]); // « Appartement 2 pièce(s) »
    const priceTxt = text(a.match(/<div class="price">([\s\S]*?)<\/div>/)?.[1]); // « 1 279 €/mois CC »
    const monthly = priceTxt !== null && /\/\s*mois/i.test(priceTxt);
    const price = monthly ? parseEuro(priceTxt) : null;
    const surfaceTxt = text(
      a.match(/<div class="critere"><i class="fas fa-expand-arrows-alt"><\/i>([\s\S]*?)<\/div>/)?.[1],
    );
    const rooms = parseRooms(subtitle);
    const type = subtitle?.replace(/\s*\d+\s*pi[èe]ce.*$/i, "").trim();
    const photo = a.match(/<img\s[^>]*?src="([^"]+)"/)?.[1];
    out.push({
      source: src.id,
      id,
      url: abs(link[1], src.url),
      price,
      charges: null,
      priceIsCC:
        price !== null
          ? /\bCC\b|charges comprises/i.test(priceTxt!)
            ? true
            : /\bHC\b|hors charges/i.test(priceTxt!)
              ? false
              : null
          : null,
      surface: parseSurface(surfaceTxt),
      rooms: rooms ? rooms : null,
      title,
      address: null,
      district: null,
      postalCode: postalOf(link[4], title),
      photo: photo ? abs(photo, src.url) : null,
      agency: null,
      phone: null,
      propertyType: type || null,
      publishedAt: null,
    });
  }
  if (out.length === 0 && rented === 0 && !BILLIE_EMPTY.test(body)) throw new Error("billie: aucune carte trouvée");
  return out;
}

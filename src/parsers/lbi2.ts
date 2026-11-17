import type { Listing, SourceDef } from "../types";
import { findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Autres gabarits La Boîte Immo / Hektor : « starteo », « articleBienT* », « property-v2 », « panelBien », « property-listing-v2/v3 ».
// Seul état vide observé : <p class="no-good">Désolé, aucun bien ne correspond…</p> ; sans lui, zéro carte lève.
export const LBI2_EMPTY = /<p class="no-good"[^>]*>\s*Désolé, aucun bien ne correspond/i;
// « property-listing-v2 » et « -v3 » : cartes en <div> (sans <article>), id = « idbien » du bouton de sélection, lieu
// « Ville (92500) » dans title-subtitle__subtitle, surface dans son propre item__info-extra.
type Fields = {
  id: string | undefined;
  href: string | undefined;
  title: string | null;
  sub: string | null;
  priceTxt: string | null;
  photo: string | undefined;
  type?: string | null; // type porté par le chemin de l'URL quand la carte n'en nomme pas
  surfaceTxt?: string | null; // surface dans un élément à part, lue avant le texte libre
};
type Variant = { marker: string; fields: (a: string) => Fields; endMarker?: string; maxLen?: number };

// URL property-v2 : /location/<lieu>/[<arr>/]<type>/[t<n>/]<id>-<slug> : le type est le segment avant l'id (et avant « t<n> »).
function typeFromUrl(href: string | undefined): string | null {
  const seg = href?.split("?")[0].split("/").filter(Boolean);
  if (!seg || seg.length < 3) return null;
  let i = seg.length - 2;
  if (/^t\d*$/i.test(seg[i])) i--;
  const t = seg[i]?.replace(/^\d+-/, "");
  return t && i >= 2 ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}

// Cartes property-listing-v2 / v3 (génération « Qleia ») : mêmes champs, seul le lien diffère (<div href> ou <a>).
function listingV2V3(a: string): Fields {
  const href = a.match(/href="(\/location\/[^"]+)"/)?.[1];
  const price = a.match(
    /<span class="__price-value">([\s\S]*?)<\/span>\s*<span class="__price-charge">([\s\S]*?)<\/span>/,
  );
  return {
    id: a.match(/idbien=(\d+)/)?.[1],
    href,
    type: typeFromUrl(href),
    title: text(a.match(/<h[23] class="title-subtitle__content"><span>([\s\S]*?)<\/span>/)?.[1]),
    sub: text(a.match(/class="title-subtitle__subtitle">([\s\S]*?)<\/span>/)?.[1]), // "Rueil-Malmaison (92500)", "Paris (75013)"
    priceTxt: price ? text(`${price[1]} ${price[2]}`) : null, // "1 735,27 € CC*"
    surfaceTxt: text(a.match(/<div class="item__info-extra">\s*(\d[\d.,\s ]*m(?:²|&sup2;))\s*<\/div>/)?.[1]),
    photo: a.match(/<img[^>]*?\sdata-src="([^"]+)"/)?.[1],
  };
}

const VARIANTS: Variant[] = [
  {
    // SPR
    marker: '<article itemscope itemtype="https://schema.org/Product"',
    fields: (a) => {
      const href = a.match(/<h1[^>]*>\s*<a href="([^"]+)"/)?.[1];
      const h2 = a.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? "";
      return {
        id: href?.match(/\/(\d+)-[^/"]*$/)?.[1],
        href,
        title: text(h2.replace(/<span class="prix"[\s\S]*$/, "")),
        sub: null,
        priceTxt: text(h2.match(/<span class="prix"[^>]*>([\s\S]*?)<\/span>\s*(?:<\/span>)?/)?.[0]),
        photo: a.match(/<img[^>]*?\ssrc="([^"]+)"/)?.[1],
      };
    },
  },
  {
    // ODI, Armaille
    marker: '<article itemprop="itemListElement"',
    fields: (a) => {
      const href = a.match(/class="titreArticleListing"[^>]*href=['"]([^'"]+)['"]/)?.[1];
      return {
        id: href?.match(/\/(\d+)-[^/'"]*$/)?.[1],
        href,
        title: text(a.match(/class="titreArticleListing"[^>]*>([\s\S]*?)<\/a>/)?.[1]),
        sub: text(a.match(/class="sousTitreArticleListing"[^>]*>([\s\S]*?)<\/h3>/)?.[1]),
        priceTxt: text(a.match(/class="priceArticle[^>]*>([\s\S]*?)<\/p>/)?.[1]),
        photo: a.match(/<img[^>]*?\sdata-src="([^"]+)"/)?.[1],
      };
    },
  },
  {
    // « property-v2 » : la carte ne nomme pas le type de bien, le chemin de l'URL si
    marker: '<article class="property-v2',
    fields: (a) => {
      const href = a.match(/<a href="([^"]+)" class="property-v2__link"/)?.[1];
      return {
        id: a.match(/idbien=(\d+)/)?.[1],
        href,
        type: typeFromUrl(href),
        title: text(a.match(/<h2 class="title__content">([\s\S]*?)<\/h2>/)?.[1]),
        sub: text(a.match(/class="title__subtitle">([\s\S]*?)<\/span>/)?.[1]),
        priceTxt: text(a.match(/class="property-v2__price[^>]*>([\s\S]*?)<\/div>/)?.[1]),
        photo: a.match(/<img[^>]*?\sdata-src="([^"]+)"/)?.[1],
      };
    },
  },
  {
    // Agence Immediat (property-listing-v2) : sans </article>, une carte finit à la suivante
    marker: '<div class="property-listing-v2__item item">',
    fields: listingV2V3,
    endMarker: '<div class="listing-bandeau',
    maxLen: 12000,
  },
  {
    // Sainte Aubane (property-listing-v3)
    marker: '<div class="property-listing-v3__item item">',
    fields: listingV2V3,
    endMarker: '<div class="listing-bandeau',
    maxLen: 12000,
  },
  {
    // Sector Immobilier: <article class="row panelBien" itemscope ... onclick="location.href='/2143-paris-18eme-....html'">
    marker: '<article class="row panelBien"',
    fields: (a) => {
      const href = a.match(/class="btn-primary"\s*href="([^"]+)"/)?.[1] ?? a.match(/<a href="(\/\d+-[^"]+)"/)?.[1];
      const ville = text(a.match(/class="ville[^>]*>([\s\S]*?)<\/div>/)?.[1]);
      return {
        id: href?.match(/^\/(\d+)-/)?.[1],
        href,
        title: text(a.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]),
        // h2 = « Parking Paris » (type + ville) ; le code postal n'apparaît qu'à côté de la ville, en pied de carte.
        sub: [text(a.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1]), ville].filter(Boolean).join(" ") || null,
        priceTxt: text(a.match(/class="left-caption">([\s\S]*?)<\/div>/)?.[1]),
        photo: a.match(/<img[^>]*?\ssrc="([^"]+)"/)?.[1],
      };
    },
  },
];

export function parseLbi2(body: string, src: SourceDef): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const v of VARIANTS) {
    for (const a of cards(body, v.marker, { endMarker: v.endMarker ?? "</article>", maxLen: v.maxLen ?? 40000 })) {
      const f = v.fields(a);
      if (!f.id || !f.href || seen.has(f.id)) continue; // carte promo sans id, ou doublon
      seen.add(f.id);
      const head = [f.title, f.sub].filter(Boolean).join(" ");
      out.push({
        source: src.id,
        id: f.id,
        url: abs(f.href, src.url),
        price: parseEuro(f.priceTxt),
        charges: null,
        // « 1 453 € CC* » : CC ne compte qu'à côté d'un montant.
        priceIsCC: f.priceTxt && parseEuro(f.priceTxt) !== null && /\bCC\b/.test(f.priceTxt) ? true : null,
        surface: parseSurface(f.surfaceTxt) ?? parseSurface(head),
        // Les URL property-v2 portent la typologie (« /t4/ ») quand le texte de la carte n'a pas de nombre de pièces.
        rooms: parseRooms(head) ?? (f.href.match(/\/t(\d)\//i)?.[1] ? Number(f.href.match(/\/t(\d)\//i)![1]) : null),
        title: f.title,
        address: null,
        district: null,
        postalCode: findPostalCode(head, townZone(src)),
        photo: f.photo && !f.photo.startsWith("data:") ? abs(f.photo, src.url) : null,
        agency: null,
        phone: null,
        propertyType: f.type ?? (f.sub ?? f.title)?.split(" ")[0] ?? null,
        publishedAt: null,
      });
    }
  }
  if (out.length === 0 && !LBI2_EMPTY.test(body)) throw new Error("lbi2: aucune carte trouvée");
  return out;
}

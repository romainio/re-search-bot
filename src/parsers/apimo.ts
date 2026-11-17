import type { Listing, SourceDef } from "../types";
import { findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Sites propulsés par Apimo : pas de gabarit commun, une variante par CMS, toutes appliquées au corps de page. Les cartes sont
// découpées par indexOf, seules leurs tranches passent par des regex.
//  - « Realtix » : <li class="property initial" data-property-id="ID"> avec h2 + h3.
//  - « Mira » : <li class=" col-1 property initial"data-property-id="ID"> dans un seul lien, titre dans l'alt de la photo, lieu
//    dans le <h3>. Marqueur : le guillemet collé à data-property-id, car Apimo ajoute parfois une classe avant.
//  - « Zenia » : <li id="ID" class=" col-1 property initial" data-property-id="ID">, <h3>Type, Lieu</h3>. Seules les premières
//    cartes sont dans le HTML (data-loaded), les suivantes sont des squelettes remplis en JavaScript : assez pour une alerte.
// État vide strict, absent des pages peuplées : Realtix « Aucun produit ne correspond… » (div.message.no-results).
export const APIMO_EMPTY = /class="message no-results"><p>Aucun produit ne correspond/;

type Fields = {
  id: string | undefined;
  href: string | undefined;
  title: string | null;
  priceTxt: string | null;
  facts: string | null;
  type: string | null;
  photo: string | undefined;
  /** Code postal quand la variante le lit mieux que le titre (lieu du <h3>) ; absent : lu dans le titre. */
  postal?: string | null;
};
type Variant = { marker: string; endMarker?: string; fields: (a: string, src: SourceDef) => Fields };

/**
 * Code postal d'un lieu seul (« Paris 17ème ») : celui de la zone reconnue, sinon la sentinelle "00000" pour une autre ville
 * (écartée en « localisation »), sinon null (« Paris » sans arrondissement).
 */
function placePostal(place: string | null, src: SourceDef): string | null {
  if (!place) return null;
  return findPostalCode(place, townZone(src)) ?? (/paris/i.test(place) ? null : "00000");
}

/** « Appartement, Paris 17ème » -> type et lieu (le lieu est tout ce qui suit la première virgule). */
function typeAndPlace(h3: string | null): { type: string | null; place: string | null } {
  if (!h3) return { type: null, place: null };
  const i = h3.indexOf(",");
  return i < 0
    ? { type: h3, place: null }
    : { type: h3.slice(0, i).trim() || null, place: h3.slice(i + 1).trim() || null };
}

const VARIANTS: Variant[] = [
  {
    // Realtix
    marker: 'class="property initial" data-property-id="',
    endMarker: "</li>",
    fields: (a) => {
      const h3 = a.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? "";
      return {
        id: a.match(/data-property-id="(\d+)"/)?.[1],
        href: a.match(/<a href="(\/fr\/annonce-immobiliere\/\d+)"/)?.[1],
        title: text(a.match(/<h2>\s*<div>([\s\S]*?)<\/div>/)?.[1]),
        priceTxt: text(a.match(/class="price">([\s\S]*?)<\/span>/)?.[1]),
        facts: text(h3),
        type: text(h3.match(/<span>([\s\S]*?)<\/span>/)?.[1]),
        photo: a.match(/<img[^>]*?\ssrc="([^"]+)"/)?.[1],
      };
    },
  },
  {
    // Mira
    marker: '"data-property-id="',
    endMarker: "</a></li>",
    fields: (a, src) => {
      const alt = a.match(/<img class="first"[^>]*?\salt="([^"]*)"/)?.[1];
      return {
        id: a.match(/data-property-id="(\d+)"/)?.[1],
        href: a.match(/<a href="([^"]+)"/)?.[1],
        title: alt ? text(alt) : null,
        priceTxt: text(a.match(/<span class="price">([\s\S]*?)<\/span>/)?.[1]),
        facts: text(a.match(/<li class="area">([\s\S]*?)<\/li>/)?.[1]),
        type:
          text(a.match(/<p>([\s\S]*?)<\/p>/)?.[1])
            ?.split("/")[0]
            .trim() || null, // « Appartement / Réf. L0018 »
        photo: a.match(/<img class="first"[^>]*?\ssrc="([^"]+)"/)?.[1],
        postal: placePostal(text(a.match(/<h3>([\s\S]*?)<\/h3>/)?.[1]), src),
      };
    },
  },
  {
    // Zenia
    marker: '" class=" col-1 property initial',
    endMarker: "</article>",
    fields: (a, src) => {
      const { type, place } = typeAndPlace(text(a.match(/<h3>([\s\S]*?)<\/h3>/)?.[1]));
      const list = a.match(/<ul>([\s\S]*?)<\/ul>/)?.[1] ?? "";
      // Squelette (data-loaded absent de la balise ouvrante) : sans lien ; sa tranche, la dernière surtout, court jusqu'au pied de page.
      const loaded = a.slice(0, a.indexOf(">")).includes('data-loaded="true"');
      return {
        id: a.match(/data-property-id="(\d+)"/)?.[1],
        href: loaded ? a.match(/<a href="([^"]+)"/)?.[1] : undefined,
        title: text(a.match(/<h2>([\s\S]*?)<\/h2>/)?.[1]),
        priceTxt: text(list.match(/<li class="price">([\s\S]*?)<\/li>/)?.[1]),
        facts: text(list.replace(/<li class="price">[\s\S]*?<\/li>/, "")),
        type,
        photo: a.match(/<img[^>]*?\ssrc="([^"]+)"/)?.[1],
        postal: placePostal(place, src),
      };
    },
  },
];

// CC seulement si le texte du prix le dit, sinon inconnu.
function ccFlag(priceTxt: string | null): boolean | null {
  if (!priceTxt || parseEuro(priceTxt) === null) return null;
  if (/charges comprises|\bC\.?C\b/i.test(priceTxt)) return true;
  return /hors charges|\bHC\b/i.test(priceTxt) ? false : null;
}

export function parseApimo(body: string, src: SourceDef): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const v of VARIANTS) {
    for (const a of cards(body, v.marker, { endMarker: v.endMarker, maxLen: 30000 })) {
      const f = v.fields(a, src);
      if (!f.id || !f.href || seen.has(f.id)) continue; // carte sans identifiant (squelette, promo), ou doublon
      seen.add(f.id);
      const head = [f.title, f.facts].filter(Boolean).join(" ");
      out.push({
        source: src.id,
        id: f.id,
        url: abs(f.href, src.url),
        price: parseEuro(f.priceTxt),
        charges: null,
        priceIsCC: ccFlag(f.priceTxt),
        surface: parseSurface(f.facts) ?? parseSurface(f.title),
        rooms: parseRooms(f.facts) ?? parseRooms(head),
        title: f.title,
        address: null,
        district: null,
        postalCode: f.postal !== undefined ? f.postal : findPostalCode(f.title, townZone(src)),
        photo: f.photo && !f.photo.startsWith("data:") ? abs(f.photo, src.url) : null,
        agency: null,
        phone: null,
        propertyType: f.type,
        publishedAt: null,
      });
    }
  }
  if (out.length === 0 && !APIMO_EMPTY.test(body)) throw new Error("apimo: aucune carte trouvée");
  return out;
}

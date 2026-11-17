import { text } from "../parsers/html";
import type { Listing } from "../types";
import { parseEuro } from "../util";
import { between, excerpt } from "./common";

// Fiche Laforêt (~377 Ko) : objet dataLayer « viewItem » (code postal, surface, pièces du bien ; le premier objet du dataLayer
// porte le code de l'agence, jamais lu) ; description et sa phrase légale « Loyer hors charges … provision charges … loyer
// charges comprises … » ; à défaut, la mention « Charges comprises » sous le prix prouve le CC, sans montant.
const amount = (t: string, label: RegExp): number | null => {
  const m = t.match(label);
  return m ? parseEuro(`${m[1]} €`) : null;
};

export function detailLaforet(body: string): Partial<Listing> {
  const out: Partial<Listing> = {};

  const item = between(body, '"event":"viewItem"', "}", 3000);
  if (item) {
    const zip = item.match(/"itemZipcode":"(\d{5})"/)?.[1];
    if (zip) out.postalCode = zip;
    const size = Number(item.match(/"itemSize":(\d+(?:\.\d+)?)/)?.[1]);
    if (size > 0) out.surface = size;
    const rooms = Number(item.match(/"itemRoomsNb":(\d+)/)?.[1]);
    if (rooms > 0) out.rooms = rooms;
  }

  const desc = between(body, 'id="section-description"', 'data-controller="show"', 30_000);
  if (desc) {
    const t = text(desc) ?? "";
    const cc = amount(t, /loyer charges comprises\s+(\d[\d\s.,]*?)\s*€/i);
    const hc = amount(t, /loyer hors charges\s+(\d[\d\s.,]*?)\s*€/i);
    const charges = amount(t, /provision (?:sur |pour )?charges\s+(\d[\d\s.,]*?)\s*€/i);
    if (cc !== null) {
      out.price = cc;
      out.priceIsCC = true;
      if (charges !== null) out.charges = charges;
    } else if (hc !== null && charges !== null) {
      out.price = hc;
      out.priceIsCC = false;
      out.charges = charges;
    }
    const prose = desc.indexOf('<div class="prose">');
    const description = excerpt(prose >= 0 ? desc.slice(prose) : null);
    if (description) out.description = description;
  }

  if (out.priceIsCC === undefined) {
    const m = between(body, '<p class="text-primary text-2xl font-bold">', "</div>", 1000)?.match(
      /font-bold">([\s\S]*?)<\/p>\s*<p class="text-tertiary text-sm">([\s\S]*?)<\/p>/,
    );
    const price = m && /charges comprises/i.test(text(m[2]) ?? "") ? parseEuro(text(m[1])) : null;
    if (price !== null) {
      out.price = price;
      out.priceIsCC = true;
    }
  }

  const photo = between(body, '<meta property="og:image" content="', '"', 1000)?.slice(35);
  if (photo && /^https?:\/\//.test(photo)) out.photo = photo;
  return out;
}

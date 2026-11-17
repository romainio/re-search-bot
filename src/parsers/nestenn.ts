import type { Listing, SourceDef } from "../types";
import { decodeEntities, findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Agences Nestenn (Immo-facile) : une page « /louer » par agence. Une carte = <div class="bien_item …"> ; la page liste aussi
// des biens hors zone. Aucun état vide observé.

/** Agence de la page : titre « Louer à <Ville> et ses environs avec Nestenn » -> « Nestenn <Ville> » ; sinon le nom de la source. */
function agencyOf(body: string, src: SourceDef): string {
  const i = body.indexOf("<title>");
  const j = i < 0 ? -1 : body.indexOf("</title>", i);
  const title = j < 0 || j - i > 300 ? "" : body.slice(i + 7, j);
  const city = title.match(/^\s*Louer\s+à\s+(.+?)\s+et ses environs avec Nestenn\s*$/)?.[1];
  return city ? `Nestenn ${decodeEntities(city).trim()}` : src.name;
}

export function parseNestenn(body: string, src: SourceDef): Listing[] {
  const agency = agencyOf(body, src);
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const a of cards(body, '<div class="bien_item', { maxLen: 20000 })) {
    const href = a.match(/<a href="([^"]+-ref-\d+)"/)?.[1];
    const id = href?.match(/-ref-(\d+)$/)?.[1];
    if (!id || !href || seen.has(id)) continue; // carte sans identifiant, ou doublon
    seen.add(id);
    const alt = a.match(/class="img_bien"[^>]*\salt="([^"]*)"/)?.[1];
    const place = text(a.match(/<p class="fs_0-8rem[^"]*">([\s\S]*?)<\/p>/)?.[1]);
    const type = text(a.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1])?.replace(/\s*à (?:louer|vendre)\s*$/i, "") ?? null;
    const carac = [...a.matchAll(/class="[^"]*\bcaracteritiques\b[^"]*">([\s\S]*?)<\/p>/g)].map(
      (m) => text(m[1]) ?? "",
    );
    const priceTxt = text(a.match(/class="[^"]*\bprice\b[^"]*">([\s\S]*?)<\/p>/)?.[1]);
    const photo = a.match(/class="img_bien" style="background-image:\s*url\('([^']+)'\)/)?.[1];
    out.push({
      source: src.id,
      id,
      url: abs(href, src.url),
      price: parseEuro(priceTxt),
      charges: null,
      // « 1 844 € CC/Mois » ; « 833 € HT HC/Mois » : HC = hors charges. Sinon inconnu.
      priceIsCC:
        priceTxt && parseEuro(priceTxt) !== null
          ? /\bCC\b/.test(priceTxt)
            ? true
            : /\bHC\b/.test(priceTxt)
              ? false
              : null
          : null,
      surface: carac.map(parseSurface).find((s) => s !== null) ?? null,
      rooms: carac.map(parseRooms).find((r) => r !== null) ?? null,
      title: alt ? decodeEntities(alt).trim() || null : type,
      address: place,
      district: null,
      postalCode: place?.match(/^(\d{5})\b/)?.[1] ?? findPostalCode(place, townZone(src)), // « 75017 PARIS », « 95800 CERGY »
      photo: photo ? abs(photo, src.url) : null,
      agency,
      phone: null,
      propertyType: type,
      publishedAt: null,
    });
  }
  if (out.length === 0) throw new Error("nestenn: aucune carte trouvée");
  return out;
}

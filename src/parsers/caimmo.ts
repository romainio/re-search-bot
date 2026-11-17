import type { Listing, SourceDef } from "../types";
import { findPostalCode, townZone, parseEuro, parseRooms, parseSurface } from "../util";
import { abs, cards, text } from "./html";

// Crédit Agricole Immobilier (ca-immobilier.fr/louer/location/appartement/<code INSEE>/<commune>) : liste rendue côté serveur,
// filtrée par commune dans l'URL, une page. Une carte = <article class="sub_card-entities"> (le guillemet fermant écarte les encarts
// « --push », « --blocliens ») : lien /biens/location/C3A/<lot> (le lot est l'identifiant), <b>T2 - 35m²</b>, prix, lieu.
// Seul le « Loyer hors charges » est qualifié : plus bas que le prix affiché, price = loyer HC et charges = la différence ; seul,
// price = loyer HC ; absent, prix affiché, CC inconnu. État vide prouvé : <span>0</span> résultat dans #nombre-resultat.
export const CAIMMO_EMPTY = /id="nombre-resultat"><span>0<\/span> résultat</;
const CARD = '<article class="sub_card-entities">';

export function parseCaImmo(body: string, src: SourceDef): Listing[] {
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const a of cards(body, CARD, { endMarker: "</article>", maxLen: 8000 })) {
    const href = a.match(/href="((?:\/|&#x2F;)biens(?:\/|&#x2F;)location(?:\/|&#x2F;)[^"]*?(?:\/|&#x2F;)(\d+))"/);
    const id = href?.[2];
    if (!href || !id || seen.has(id)) continue; // carte sans lien, ou doublon
    seen.add(id);
    const shown = parseEuro(text(a.match(/<div class="infos-price">([\s\S]*?)<\/div>/)?.[1])); // « au prix de (par mois) 1 017 € »
    const hc = parseEuro(text(a.match(/Loyer hors charges :<\/span>\s*<span>([\s\S]*?)<\/span>/)?.[1])); // « 897 € »
    const label = text(a.match(/<span class="infos-main-label">([\s\S]*?)<\/span>/)?.[1]); // « T2 - 35m² », « Studio - 21m² »
    const where = text(a.match(/class="sub_card-entities--infos_where">([\s\S]*?)<\/span>\s*<\/div>/)?.[1]); // « PARIS 17EME (75017) »
    const type = text(a.match(/<div class="infos-link">([\s\S]*?)<\/div>/)?.[1]);
    const photo = a.match(/<img data-src="([^"]+)"/)?.[1];
    const split = shown !== null && hc !== null && shown > hc;
    out.push({
      source: src.id,
      id,
      url: abs(href[1], src.url),
      price: hc ?? shown,
      charges: split ? Math.round((shown! - hc!) * 100) / 100 : null,
      priceIsCC: hc !== null ? false : null,
      surface: parseSurface(label),
      rooms: parseRooms(label),
      title: label,
      address: where,
      district: null,
      postalCode: findPostalCode(where, townZone(src)),
      photo: photo ? abs(photo, src.url) : null,
      agency: null,
      phone: null,
      propertyType: type,
      publishedAt: null,
    });
  }
  if (out.length === 0 && !CAIMMO_EMPTY.test(body)) throw new Error("caimmo: aucune carte trouvée");
  return out;
}

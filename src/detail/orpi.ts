import { decodeAttr } from "../parsers/orpi";
import { text } from "../parsers/html";
import { at, isObj } from "../guards";
import type { Listing } from "../types";
import { parseEuro } from "../util";
import { between, excerpt, gallery, isPostal, num, str } from "./common";

// Fiche Orpi : attribut data-estate (JSON en entités HTML, fin vers 276 Ko), décodé par decodeAttr. CC prouvé par
// price - priceHC = chargeReserve > 0, ou par la mention « Charges comprises » sous le même prix. Code postal : zipCode du
// bien, jamais celui de l'agence.
const ATTR = 'data-estate="';
const PRICE = '<strong class="h2 text-primary">';

/** Prix affiché en tête de fiche suivi de la mention « Charges comprises », égal au prix de data-estate. */
function labelledCC(body: string, price: number): boolean {
  const m = between(body, PRICE, "<ul", 1500)?.match(
    /^<strong class="h2 text-primary">([^<]*)<\/strong>[\s\S]*?<small class="text-xs text-dark-grey">([^<]*)<\/small>/,
  );
  return !!m && /^charges comprises$/i.test(text(m[2]) ?? "") && parseEuro(text(m[1])) === price;
}

export function detailOrpi(body: string): Partial<Listing> {
  const i = body.indexOf(ATTR);
  if (i < 0) return {};
  const from = i + ATTR.length;
  const end = body.indexOf('"', from); // dans l'attribut, les guillemets sont en &quot; : le premier " le termine
  if (end < 0) return {}; // attribut coupé par la lecture bornée
  let j: unknown;
  try {
    j = JSON.parse(decodeAttr(body.slice(from, end)));
  } catch {
    return {};
  }
  if (!isObj(j)) return {};

  const out: Partial<Listing> = {};
  // chargeReserve 0 avec price = priceHC ne prouve rien (champ non renseigné) : il faut des charges > 0, ou la mention.
  const price = num(j.price),
    hc = num(j.priceHC),
    charges = num(j.chargeReserve);
  const byMath = price !== null && hc !== null && charges !== null && Math.abs(price - hc - charges) < 0.01;
  if (price !== null && (byMath || labelledCC(body, price))) {
    out.price = price;
    out.priceIsCC = true;
    if (charges !== null) out.charges = charges;
  }
  const surface = num(j.surface) ?? num(j.liveableSurface);
  if (surface !== null) out.surface = surface;
  const rooms = num(j.nbRooms);
  if (rooms !== null) out.rooms = rooms;
  if (isPostal(j.zipCode)) out.postalCode = j.zipCode;
  const district = str(at(j, "district", "name"));
  if (district) out.district = district;
  const photo = str(Array.isArray(j.images) ? j.images[0] : null);
  if (photo) out.photo = photo;
  const photos = gallery(j.images);
  if (photos.length) out.photos = photos;
  const description = excerpt(str(j.longAd));
  if (description) out.description = description;
  const agency = str(at(j, "agency", "name")),
    phone = str(at(j, "agency", "phone"));
  if (agency) out.agency = agency;
  if (phone) out.phone = phone;
  return out;
}

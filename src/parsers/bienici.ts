import { at, hasValue } from "../guards";
import type { Listing, SourceDef } from "../types";
import { num, str } from "./json-fields";

export function parseBienici(body: string, src: SourceDef): Listing[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("bienici: invalid JSON");
  }
  const ads = at(json, "realEstateAds");
  if (!Array.isArray(ads)) throw new Error("bienici: realEstateAds missing");
  return ads
    .filter((a: unknown) => hasValue(at(a, "id")))
    .map((a: unknown): Listing => {
      const id = String(at(a, "id"));
      const price = num(at(a, "price")),
        charges = num(at(a, "charges")),
        rent = num(at(a, "rentWithoutCharges"));
      // CC seulement si le JSON le prouve : rentWithoutCharges + charges === price.
      const isCC =
        price !== null && charges !== null && rent !== null && Math.abs(rent + charges - price) < 0.01 ? true : null;
      const pub = str(at(a, "publicationDate"));
      return {
        source: src.id,
        id,
        url: `https://www.bienici.com/annonce/${id}`,
        price,
        charges,
        priceIsCC: isCC,
        surface: num(at(a, "surfaceArea")),
        rooms: num(at(a, "roomsQuantity")),
        floor: num(at(a, "floor")),
        // Ville en adresse seulement sans code postal : la zone se lit alors dans la ville.
        title: str(at(a, "title")),
        address: str(at(a, "postalCode")) === null ? str(at(a, "city")) : null,
        district: str(at(a, "district", "libelle")),
        postalCode: str(at(a, "postalCode")),
        photo: str(at(a, "photos", 0, "url")),
        agency: str(at(a, "accountDisplayName")),
        phone: null,
        propertyType: str(at(a, "propertyType")),
        publishedAt: pub && !pub.startsWith("1970-") ? pub : null,
      };
    });
}

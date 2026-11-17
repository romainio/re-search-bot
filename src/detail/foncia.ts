import { at, isObj } from "../guards";
import type { Listing } from "../types";
import { parseEuro } from "../util";
import { between, excerpt, isPostal, str } from "./common";

// Fiche Foncia : JSON-LD du bien (id="seo-annonce-structured-data", vers 62 Ko de la page) : « address » (celle du bien, pas de
// l'agence) et « description » (« Dont 99€ de provision pour charges locatives »). Loyer et CC viennent déjà de la liste.
const LD = '<script id="seo-annonce-structured-data" type="application/ld+json">';

export function detailFoncia(body: string): Partial<Listing> {
  const block = between(body, LD, "</script>", 20_000);
  if (!block) return {};
  let j: unknown;
  try {
    j = JSON.parse(block.slice(LD.length));
  } catch {
    return {};
  }
  if (!isObj(j)) return {};

  const out: Partial<Listing> = {};
  const postalCode = at(j, "address", "postalCode");
  const postal = isPostal(postalCode) ? postalCode : null;
  const street = str(at(j, "address", "streetAddress"));
  if (postal) out.postalCode = postal;
  if (street)
    out.address = postal ? `${street}, ${postal} ${str(at(j, "address", "addressLocality")) ?? "Paris"}` : street;

  const desc = str(j.description);
  const ch = desc?.match(/Dont\s+(\d[\d\s.,]*?)\s*€\s*de provision pour charges/i)?.[1];
  const charges = ch ? parseEuro(`${ch} €`) : null;
  if (charges !== null) out.charges = charges;
  const description = excerpt(desc);
  if (description) out.description = description;
  return out;
}

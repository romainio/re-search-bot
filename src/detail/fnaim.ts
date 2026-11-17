import { text } from "../parsers/html";
import type { Listing } from "../types";
import { parseEuro, parseSurface } from "../util";
import { between, excerpt } from "./common";

// Fiche FNAIM (fnaim.fr/annonce-immobiliere/<id>/…htm, données vers 150 Ko) : « Informations sur les prix » (<span
// class="loyerChargeComprise">Loyer : <strong>1 490 €</strong> par mois charges comprises</span>, puis la provision pour charges ;
// le « Complément de loyer » n'est pas une charge), « Caractéristiques du bien » (pièces, surface), meta itemprop="postalcode".
export function detailFnaim(body: string): Partial<Listing> {
  const out: Partial<Listing> = {};

  const prix = between(body, "<h2>Informations sur les prix</h2>", "</p>", 3000);
  if (prix) {
    const loyer = text(prix.match(/class="loyerChargeComprise">([\s\S]*?)<\/span>/)?.[1]);
    const cc = loyer && /charges comprises/i.test(loyer) ? parseEuro(loyer) : null;
    if (cc !== null) {
      out.price = cc;
      out.priceIsCC = true;
      const ch = text(prix)?.match(/(\d[\d\s.,]*?)\s*€\s*par mois de provision pour charges/i)?.[1];
      const charges = ch ? parseEuro(`${ch} €`) : null;
      if (charges !== null) out.charges = charges;
    }
  }

  const carac = between(body, 'id="caracteristiques"', 'id="localisation"', 10_000);
  if (carac) {
    const surface = parseSurface(carac.match(/Surface habitable[^<]*<\/span>\s*([^<]+)/)?.[1]);
    if (surface !== null) out.surface = surface;
    const rooms = carac.match(/Nombre de pi[eè]ce\(s\)[^<]*<\/span>\s*(\d+)/)?.[1];
    if (rooms) out.rooms = Number(rooms);
  }

  const postal = between(body, 'id="localisation"', 'id="consommation_energetique"', 5000)?.match(
    /itemprop="postalcode" content="(\d{5})"/,
  )?.[1];
  if (postal) out.postalCode = postal;

  const desc = between(body, '<p itemprop="description">', "</p>", 20_000);
  const description = excerpt(desc?.slice(desc.indexOf(">") + 1));
  if (description) out.description = description;
  return out;
}

import { at, hasValue } from "../guards";
import type { Listing, SourceDef } from "../types";

// ERA Immobilier : API JSON publique (api.eraimmobilier.com/api/v2/annonces/search), filtrée par code postal côté serveur.
// Réponse { data: [annonce…], meta: { total… } } ; une annonce : id (celui de la fiche /annonces/<id>), code_postal, ville, prix,
// surface_habitable, nb_pieces, libelle, images, agence. Aucun champ de charges : charges et priceIsCC inconnus.
// État vide strict : data [] avec meta.total 0 ; JSON invalide, champs absents ou data vide avec un total non nul : lève.

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export function parseEra(body: string, src: SourceDef): Listing[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error("era: JSON invalide");
  }
  const ads = at(json, "data");
  const total = at(json, "meta", "total");
  if (!Array.isArray(ads) || typeof total !== "number") throw new Error("era: data ou meta absents");
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const a of ads as unknown[]) {
    const rawId = at(a, "id");
    const id = hasValue(rawId) ? String(rawId) : null;
    if (!id || seen.has(id)) continue; // annonce sans identifiant, ou doublon
    seen.add(id);
    const tel = str(at(a, "agence", "telephone"))?.replace(/\s/g, "");
    const pub = str(at(a, "date_publication"));
    const photo = str(at(a, "images", "big", 0)) ?? str(at(a, "photo", 0));
    out.push({
      source: src.id,
      id,
      url: `https://www.eraimmobilier.com/annonces/${encodeURIComponent(id)}`,
      price: num(at(a, "prix")),
      charges: null,
      priceIsCC: null,
      surface: num(at(a, "surface_habitable")),
      rooms: num(at(a, "nb_pieces")),
      title: str(at(a, "libelle")),
      address: str(at(a, "ville")),
      district: null,
      postalCode: str(at(a, "code_postal"))?.match(/^\d{5}$/)?.[0] ?? null,
      photo: photo?.startsWith("https://") ? photo : null,
      agency: str(at(a, "agence", "enseigne")),
      phone: tel && /^0\d{9}$/.test(tel) ? tel.replace(/(\d\d)(?=\d)/g, "$1 ") : null,
      propertyType: str(at(a, "type_bien")),
      publishedAt: pub && /^\d{4}-\d\d-\d\d$/.test(pub) ? pub : null,
    });
  }
  if (out.length === 0 && total !== 0) throw new Error("era: aucune carte trouvée");
  return out;
}

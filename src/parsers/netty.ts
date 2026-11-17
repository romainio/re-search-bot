import type { Listing, SourceDef } from "../types";
import { findPostalCode, townZone } from "../util";
import { text } from "./html";

// Sites Netty : les annonces ne sont pas dans le HTML (React) mais dans window._TEMPLATE_DATA = JSON.parse(b64_to_utf8("…")).
// Seul ce bloc (~50 Ko sur 660 Ko) est repéré par indexOf et décodé, sans regex sur la page.
// prodId = { "<ref>": { rent, charges, rent_total, surface, rooms, cp, city, image, title_auto, prod_type, … } }.
const MARK = '_TEMPLATE_DATA = JSON.parse(b64_to_utf8("';
const TYPES: Record<string, string> = {
  appt: "Appartement",
  house: "Maison",
  park: "Parking",
  land: "Terrain",
  comm: "Local commercial",
  bail: "Local commercial",
  pro: "Bureau",
};

const SHAPE = ["prodId", "prodResults", "prodCount", "agenceId", "prodUrl", "metas"]; // clés de premier niveau de la page peuplée
type Prod = {
  prod_ref?: string;
  ref?: string;
  rent?: unknown;
  charges?: unknown;
  rent_total?: unknown;
  pricePrimary?: unknown;
  surface?: unknown;
  rooms?: unknown;
  cp?: unknown;
  city?: unknown;
  geo_label?: unknown;
  image?: unknown;
  title_auto?: unknown;
  prod_type?: unknown;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

function decodeTemplateData(body: string): { prodId?: Record<string, Prod>; prodCount?: number } | null {
  const i = body.indexOf(MARK);
  if (i < 0) return null;
  const from = i + MARK.length;
  const to = body.indexOf('"', from);
  if (to < 0) return null;
  try {
    const bin = atob(body.slice(from, to));
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function parseNetty(body: string, src: SourceDef): Listing[] {
  const data = decodeTemplateData(body);
  const prods = data?.prodId && typeof data.prodId === "object" ? data.prodId : {};
  const out: Listing[] = [];
  const seen = new Set<string>();
  for (const [key, p] of Object.entries(prods)) {
    const id = str(p.prod_ref) ?? str(p.ref) ?? key;
    if (!id || seen.has(id)) continue; // sans référence, ou doublon
    seen.add(id);
    const rent = num(p.rent),
      charges = num(p.charges),
      total = num(p.rent_total) ?? num(p.pricePrimary);
    // Loyer HC prouvé par rent_total = rent + charges ; sinon le total affiché, CC inconnu.
    const hc = rent !== null && charges !== null && total === rent + charges;
    const image = str(p.image);
    // Le détail est /location/<slug>,<RÉF> ; le slug est ignoré par le site, on reprend celui du nom de fichier de l'image.
    const slug = image?.match(/\/([a-z0-9-]+?)-\d{8,}-[^/-]+_\d+_original\.\w+$/i)?.[1] ?? "bien";
    const type = str(p.prod_type);
    const title = text(str(p.title_auto));
    const cp = str(p.cp),
      city = str(p.city);
    out.push({
      source: src.id,
      id,
      url: new URL(`/location/${slug},${id}`, src.url).toString(),
      price: hc ? rent : (total ?? rent),
      charges,
      priceIsCC: hc ? false : null,
      surface: num(p.surface),
      rooms: num(p.rooms),
      title,
      address: str(p.geo_label),
      district: null,
      // Ville d'une zone suivie : son code ; autre ville hors Paris : sentinelle "00000", rejetée en « localisation ».
      postalCode: cp ?? findPostalCode(city, townZone(src)) ?? (city && !/paris/i.test(city) ? "00000" : null),
      photo: image,
      agency: "Domiere",
      phone: "+33 1 45 74 08 08",
      propertyType: (type && TYPES[type]) || title?.split(/[\s,]/)[0] || null,
      publishedAt: null,
    });
  }
  // État vide non vérifié sur une vraie page : [] seulement si le bloc a la forme de la page peuplée (mêmes clés de premier
  // niveau), prodCount 0 et aucun produit. Tout autre cas sans carte lève.
  const emptyState =
    data !== null && data.prodCount === 0 && Object.keys(prods).length === 0 && SHAPE.every((k) => k in data);
  if (out.length === 0 && !emptyState) throw new Error("netty: aucune carte trouvée");
  return out;
}

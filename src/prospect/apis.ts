import { USER_AGENT } from "../config/fetch";
import {
  PROSPECT_API_TIMEOUT_MS,
  PROSPECT_ENTREPRISES_PER_PAGE,
  PROSPECT_ENTREPRISES_URL,
  PROSPECT_NAF,
  PROSPECT_OVERPASS_LIMIT,
  PROSPECT_OVERPASS_MAX_BYTES,
  PROSPECT_OVERPASS_TIMEOUT_MS,
  PROSPECT_OVERPASS_URL,
} from "../config/prospect";
import { settings } from "../derive";
import { readCapped } from "../read-body";
import type { Candidate } from "./types";
import { isObj } from "../guards";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Majuscules de l'INSEE ramenées à une casse lisible (« FONCIA TRANSACTION » -> « Foncia Transaction »). */
export function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s\-'(])([a-zà-ÿ])/g, (_, a: string, b: string) => a + b.toUpperCase());
}

export interface EntreprisesPage {
  candidates: Candidate[];
  totalPages: number;
}

/**
 * Réponse de l'API Recherche d'entreprises : établissements ouverts (etat_administratif "A") d'un code postal accepté. Réponse
 * invalide : lève (le pas compte un échec). L'API ne donne ni site ni téléphone : ils viennent d'OpenStreetMap.
 */
export function parseEntreprises(
  body: unknown,
  postalCodes: readonly string[] = settings().allowedPostalCodes,
): EntreprisesPage {
  if (!isObj(body) || !Array.isArray(body.results)) throw new Error("réponse Recherche d'entreprises invalide");
  const totalPages = typeof body.total_pages === "number" ? body.total_pages : 0;
  const out: Candidate[] = [];
  for (const r of body.results) {
    if (!isObj(r) || !Array.isArray(r.matching_etablissements)) continue;
    const company = str(r.nom_complet) ?? str(r.nom_raison_sociale);
    for (const e of r.matching_etablissements) {
      if (!isObj(e) || e.etat_administratif !== "A") continue;
      const siret = str(e.siret);
      const cp = str(e.code_postal);
      if (!siret || !cp || !postalCodes.includes(cp)) continue;
      const enseignes = Array.isArray(e.liste_enseignes)
        ? e.liste_enseignes.map(str).filter((x): x is string => !!x)
        : [];
      const names = [str(e.nom_commercial), ...enseignes, company].filter((x): x is string => !!x).map(titleCase);
      if (!names.length) continue;
      const adresse = str(e.adresse);
      out.push({
        id: siret,
        names,
        address: adresse ? titleCase(adresse) : null,
        postalCode: cp,
        website: null,
        phone: null,
        origin: "entreprises",
      });
    }
  }
  return { candidates: out, totalPages };
}

/** Code postal de la zone dont l'emprise contient le point (sinon null). */
function zoneOfPoint(lat: number, lon: number): string | null {
  for (const [cp, [s, w, n, e]] of Object.entries(settings().prospect.bbox))
    if (lat >= s && lat <= n && lon >= w && lon <= e) return cp;
  return null;
}

/** Site OSM : http(s) seulement, ramené à la racine (elle suffit au gabarit). */
function siteOf(tags: Record<string, unknown>): string | null {
  const raw = str(tags.website) ?? str(tags["contact:website"]) ?? str(tags.url);
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.origin}/` : null;
  } catch {
    return null;
  }
}

/**
 * Réponse d'Overpass (out json) : éléments `shop=estate_agent` (ou `office=estate_agent`) avec leurs étiquettes. Un élément sans
 * nom est ignoré (inexploitable). Le code postal vient des étiquettes, sinon de l'emprise de la zone qui contient le point.
 */
export function parseOverpass(body: unknown): Candidate[] {
  if (!isObj(body) || !Array.isArray(body.elements)) throw new Error("réponse Overpass invalide");
  const out: Candidate[] = [];
  for (const el of body.elements) {
    if (!isObj(el) || !isObj(el.tags)) continue;
    const t = el.tags;
    const name = str(t.name) ?? str(t.brand) ?? str(t.operator);
    if (!name || typeof el.id !== "number" || typeof el.type !== "string") continue;
    const c = isObj(el.center) ? el.center : el;
    const lat = typeof c.lat === "number" ? c.lat : null;
    const lon = typeof c.lon === "number" ? c.lon : null;
    const cp =
      str(t["addr:postcode"]) ??
      str(t["contact:postcode"]) ??
      (lat !== null && lon !== null ? zoneOfPoint(lat, lon) : null);
    const street = [
      str(t["addr:housenumber"]) ?? str(t["contact:housenumber"]),
      str(t["addr:street"]) ?? str(t["contact:street"]),
    ]
      .filter(Boolean)
      .join(" ");
    const city = str(t["addr:city"]) ?? str(t["contact:city"]);
    const address = [street, [cp, city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null;
    out.push({
      id: `osm:${el.type}/${el.id}`,
      names: [name],
      address,
      postalCode: cp,
      website: siteOf(t),
      phone: str(t.phone) ?? str(t["contact:phone"]),
      origin: "osm",
    });
  }
  return out;
}

const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };

/** Une page de l'API Recherche d'entreprises ; null sur échec réseau, délai ou HTTP 4xx/5xx (429 compris) : jamais d'exception. */
export async function fetchEntreprisesPage(postalCode: string, page: number): Promise<EntreprisesPage | null> {
  const q = new URLSearchParams({
    activite_principale: PROSPECT_NAF,
    code_postal: postalCode,
    etat_administratif: "A",
    per_page: String(PROSPECT_ENTREPRISES_PER_PAGE),
    page: String(page),
  });
  try {
    const res = await fetch(`${PROSPECT_ENTREPRISES_URL}?${q}`, {
      headers,
      signal: AbortSignal.timeout(PROSPECT_API_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return parseEntreprises(await res.json(), [postalCode]);
  } catch {
    return null;
  }
}

/** Requête Overpass d'une zone : emprise, shop ou office estate_agent, sortie bornée (centre et étiquettes seulement). */
export function overpassQuery(postalCode: string): string | null {
  const b = settings().prospect.bbox[postalCode];
  if (!b) return null;
  const box = b.join(",");
  return `[out:json][timeout:25];(nwr["shop"="estate_agent"](${box});nwr["office"="estate_agent"](${box}););out center tags ${PROSPECT_OVERPASS_LIMIT};`;
}

/** Une zone via Overpass ; serveur public souvent saturé : null, le pas suivant réessaie. Réponse bornée à PROSPECT_OVERPASS_MAX_BYTES. */
export async function fetchOverpass(postalCode: string): Promise<Candidate[] | null> {
  const query = overpassQuery(postalCode);
  if (!query) return [];
  try {
    const res = await fetch(PROSPECT_OVERPASS_URL, {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(PROSPECT_OVERPASS_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const { bytes, truncated } = await readCapped(res, PROSPECT_OVERPASS_MAX_BYTES);
    if (truncated) return null;
    return parseOverpass(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

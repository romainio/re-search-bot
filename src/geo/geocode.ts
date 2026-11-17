import { USER_AGENT } from "../config/fetch";
import { GEO_ADDRESS_API, GEO_MIN_SCORE, GEO_TIMEOUT_MS } from "../config/geo";
import { settings } from "../derive";
import { fold } from "./geometry";

export interface GeoPoint {
  lat: number;
  lon: number /** « housenumber » (numéro) ou « street » (rue : milieu de la voie). */;
  precision: string;
}

/** Mots de voie : une adresse sans voie (« Paris 17e », un nom de quartier) n'est pas géocodée (sous-requête économisée). */
const STREET_WORD =
  /\b(?:rue|avenue|av|boulevard|bd|bld|place|pl|passage|villa|cite|square|quai|impasse|allee|chaussee|cour|route|porte|sente|ruelle|pont|parvis|esplanade|rond point)\b/;

/** L'adresse nomme une voie (rue, avenue…) : seule une telle adresse vaut une sous-requête de géocodage. */
export const hasStreet = (address: string | null | undefined): address is string =>
  !!address && STREET_WORD.test(fold(address));

/**
 * Géocode une adresse par l'API Adresse, au plus `timeoutMs`. Jamais d'exception : null sur erreur, score sous GEO_MIN_SCORE
 * ou code postal hors zones. `doFetch` : remplaçable dans les tests.
 */
export async function geocode(
  address: string,
  postalCode: string | null,
  timeoutMs: number = GEO_TIMEOUT_MS,
  doFetch: typeof fetch = fetch,
): Promise<GeoPoint | null> {
  try {
    const q = new URLSearchParams({ q: address.slice(0, 200), limit: "1", autocomplete: "0" });
    if (postalCode) q.set("postcode", postalCode);
    const res = await doFetch(`${GEO_ADDRESS_API}?${q}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const body = (await res.json()) as {
      features?: {
        geometry?: { coordinates?: unknown };
        properties?: { score?: unknown; postcode?: unknown; type?: unknown };
      }[];
    };
    const f = body?.features?.[0];
    const c = f?.geometry?.coordinates;
    const score = f?.properties?.score;
    const postcode = f?.properties?.postcode;
    if (
      !Array.isArray(c) ||
      typeof c[0] !== "number" ||
      typeof c[1] !== "number" ||
      !Number.isFinite(c[0]) ||
      !Number.isFinite(c[1])
    )
      return null;
    if (typeof score !== "number" || score < GEO_MIN_SCORE) return null;
    // Une réponse hors des zones surveillées (homonyme dans une autre commune) ne vaut rien : l'indice serait faux.
    if (
      typeof postcode !== "string" ||
      !settings().allowedPostalCodes.includes(postcode) ||
      (postalCode && postcode !== postalCode)
    )
      return null;
    return { lon: c[0], lat: c[1], precision: typeof f?.properties?.type === "string" ? f.properties.type : "street" };
  } catch {
    return null;
  }
}

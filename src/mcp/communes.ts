import { USER_AGENT } from "../config/fetch";
import {
  GEO_API_TIMEOUT_MS,
  GEO_API_URL,
  NEIGHBOR_MAX,
  NEIGHBOR_MIN_POPULATION,
  NEIGHBOR_PROBE_POINTS,
} from "../config/mcp";
import { distanceMeters } from "../geo/geometry";

/**
 * Communes autour des zones, par geo.api.gouv.fr (gratuite, sans clé), au paramétrage seulement (completer_localisation) :
 * commune et centre de chaque code postal ; départements sous NEIGHBOR_PROBE_POINTS points du cercle (une zone en bordure a ses
 * voisines dans le département d'à côté) ; communes à moins du rayon et d'au moins NEIGHBOR_MIN_POPULATION habitants, les
 * NEIGHBOR_MAX plus proches. Moins de 50 sous-requêtes.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface ApiCommune {
  nom: string;
  code: string;
  codesPostaux?: string[];
  centre?: { coordinates?: [number, number] };
  codeDepartement?: string;
  population?: number;
}

export interface Neighbor {
  nom: string;
  postalCode: string;
  km: number;
  population: number | null;
}
export interface Localisation {
  /** Commune de chaque zone quand le code postal ne couvre qu'elle et qu'elle n'en a qu'un ; sinon null. */
  zoneTowns: Record<string, string | null>;
  neighbors: Neighbor[];
}

const MAX_CENTRES = 4;
const MAX_DEPARTMENTS = 6;

export async function getJson(doFetch: Fetch, path: string): Promise<unknown> {
  const res = await doFetch(`${GEO_API_URL}${path}`, {
    signal: AbortSignal.timeout(GEO_API_TIMEOUT_MS),
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`geo.api.gouv.fr : HTTP ${res.status}`);
  return res.json();
}
export const communes = (v: unknown): ApiCommune[] =>
  Array.isArray(v)
    ? v.filter((c): c is ApiCommune => !!c && typeof c === "object" && typeof (c as ApiCommune).nom === "string")
    : [];
const centreOf = (c: ApiCommune): [number, number] | null => {
  const p = c.centre?.coordinates;
  return Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" ? [p[1], p[0]] : null; // [lat, lon]
};

export async function localise(
  zoneCodes: readonly string[],
  radiusKm: number,
  doFetch: Fetch = fetch,
): Promise<Localisation> {
  const zoneSet = new Set(zoneCodes);
  const zoneTowns: Record<string, string | null> = {};
  const zoneCommunes = new Set<string>();
  const centres = new Map<string, [number, number]>();
  const departments = new Set<string>();

  const byCode = await Promise.all(
    zoneCodes.map((code) =>
      getJson(doFetch, `/communes?codePostal=${code}&fields=nom,code,centre,codesPostaux,codeDepartement`).then(
        communes,
      ),
    ),
  );
  zoneCodes.forEach((code, i) => {
    const list = byCode[i]!;
    // Une commune à un seul code postal désigne la zone sans ambiguïté (pas « Lyon » pour 69003).
    zoneTowns[code] = list.length === 1 && list[0]!.codesPostaux?.length === 1 ? list[0]!.nom : null;
    for (const c of list) {
      zoneCommunes.add(c.code);
      if (c.codeDepartement) departments.add(c.codeDepartement);
      const p = centreOf(c);
      if (p && centres.size < MAX_CENTRES) centres.set(c.code, p);
    }
  });
  if (!centres.size) throw new Error(`aucune commune trouvée pour ${zoneCodes.join(", ")}`);

  // Départements voisins : commune sous des points du cercle (un point en mer ou hors de France ne rend rien).
  const probes = [...centres.values()].flatMap(([lat, lon]) =>
    Array.from({ length: NEIGHBOR_PROBE_POINTS }, (_, k) => {
      const a = (2 * Math.PI * k) / NEIGHBOR_PROBE_POINTS;
      return [
        lat + (radiusKm / 111) * Math.sin(a),
        lon + (radiusKm / (111 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a),
      ] as const;
    }),
  );
  const hits = await Promise.all(
    probes.map(([lat, lon]) =>
      getJson(doFetch, `/communes?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&fields=nom,codeDepartement`)
        .then(communes)
        .catch(() => [] as ApiCommune[]),
    ),
  );
  for (const h of hits.flat())
    if (h.codeDepartement && departments.size < MAX_DEPARTMENTS) departments.add(h.codeDepartement);

  const all = (
    await Promise.all(
      [...departments].map((d) =>
        getJson(doFetch, `/departements/${d}/communes?fields=nom,code,codesPostaux,centre,population`).then(communes),
      ),
    )
  ).flat();
  const near: Neighbor[] = [];
  for (const c of all) {
    if (zoneCommunes.has(c.code) || (c.codesPostaux ?? []).some((p) => zoneSet.has(p))) continue;
    const p = centreOf(c);
    const postalCode = c.codesPostaux?.[0];
    if (!p || !postalCode || (c.population ?? 0) < NEIGHBOR_MIN_POPULATION) continue;
    const km = Math.min(...[...centres.values()].map(([lat, lon]) => distanceMeters(lat, lon, p[0], p[1]) / 1000));
    if (km <= radiusKm)
      near.push({ nom: c.nom, postalCode, km: Math.round(km * 10) / 10, population: c.population ?? null });
  }
  near.sort((a, b) => a.km - b.km || a.nom.localeCompare(b.nom));
  return { zoneTowns, neighbors: near.slice(0, NEIGHBOR_MAX) };
}

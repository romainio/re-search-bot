import { USER_AGENT } from "../config/fetch";
import { GEO_API_TIMEOUT_MS } from "../config/mcp";
import { ARR_INSEE, BIENICI, bieniciUrl, NETWORKS, slugOf } from "../data/networks";
import type { Place } from "../data/networks";
import type { ParserId } from "../types";
import { communes, getJson } from "./communes";
import type { Fetch } from "./communes";

/**
 * Sources proposées pour les zones (proposer_sources) : réseaux nationaux du catalogue et Bien'ici. Rien n'est lu ni enregistré :
 * l'assistant ajoute chaque proposition par ajouter_source, qui la lit d'abord.
 */

export interface Proposal {
  id: string;
  nom: string;
  adresse: string;
  lecteur: ParserId;
  zones: string[];
  filtree_sur_les_zones: boolean;
  verifie: boolean;
  note?: string;
}

/** Lieu d'un code postal d'arrondissement (75017, 69003, 13008), sans requête ; null sinon. */
export function arrPlace(postalCode: string): Place | null {
  for (const [town, a] of Object.entries(ARR_INSEE)) {
    const n = Number(postalCode.slice(3));
    if (postalCode.startsWith(a.postalPrefix) && Number.isInteger(n) && n >= 1 && n <= a.max) {
      return {
        name: `${town} ${n}${n === 1 ? "er" : "e"}`,
        town,
        slug: slugOf(town),
        postalCode,
        insee: a.insee(n),
        arr: n,
      };
    }
  }
  return null;
}

const idOf = (...parts: string[]): string =>
  parts
    .map((p) => slugOf(p).replace(/-/g, "_"))
    .join("_")
    .slice(0, 60);

export async function proposeSources(
  zoneCodes: readonly string[],
  rent: { min: number; max: number },
  doFetch: Fetch = fetch,
): Promise<{ proposals: Proposal[]; unknown: string[] }> {
  // Lieux : arrondissement calculé, sinon la commune la plus peuplée du code postal (un code peut couvrir plusieurs villages).
  const unknown: string[] = [];
  const places = await Promise.all(
    zoneCodes.map(async (code): Promise<{ place: Place; allCodes: string[] } | null> => {
      const arr = arrPlace(code);
      if (arr) return { place: arr, allCodes: [code] };
      const list = communes(
        await getJson(doFetch, `/communes?codePostal=${code}&fields=nom,code,codesPostaux,population`).catch(() => []),
      );
      const c = [...list].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))[0];
      if (!c) {
        unknown.push(code);
        return null;
      }
      return {
        place: { name: c.nom, town: c.nom, slug: slugOf(c.nom), postalCode: code, insee: c.code },
        allCodes: c.codesPostaux ?? [code],
      };
    }),
  );

  // Une source par lieu ; filtrée si la commune n'a pas d'autre code postal que ceux de la recherche.
  const zoneSet = new Set(zoneCodes);
  const byPlace = new Map<string, { place: Place; zones: string[]; filtered: boolean }>();
  for (const p of places) {
    if (!p) continue;
    const key = p.place.insee;
    const e = byPlace.get(key);
    if (e) e.zones.push(p.place.postalCode);
    else
      byPlace.set(key, {
        place: p.place,
        zones: [p.place.postalCode],
        filtered: p.allCodes.every((c) => zoneSet.has(c)),
      });
  }

  const proposals: Proposal[] = [];
  for (const net of NETWORKS) {
    const targets =
      net.scope === "postal"
        ? places
            .filter((p): p is { place: Place; allCodes: string[] } => !!p)
            .map((p) => ({ place: p.place, zones: [p.place.postalCode], filtered: true }))
        : [...byPlace.values()];
    for (const t of targets) {
      proposals.push({
        id: idOf(net.id, net.scope === "postal" ? t.place.postalCode : t.place.name),
        nom: `${net.name} ${t.place.name}`,
        adresse: net.url(t.place),
        lecteur: net.parser,
        zones: t.zones,
        filtree_sur_les_zones: net.filtered && t.filtered,
        verifie: net.verified,
        ...(net.note ? { note: net.note } : {}),
      });
    }
  }

  // Bien'ici : identifiant de zone de chaque code postal (l'entrée de la suggestion qui porte ce code), une source pour toutes.
  const ids = await Promise.all(
    zoneCodes.map(async (code) => {
      try {
        const res = await doFetch(`${BIENICI.suggest}${code}`, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(GEO_API_TIMEOUT_MS),
        });
        if (!res.ok) return [];
        const list = (await res.json()) as { postalCodes?: string[]; zoneIds?: string[] }[];
        return (Array.isArray(list) ? list : []).find((e) => e.postalCodes?.includes(code))?.zoneIds ?? [];
      } catch {
        return [];
      }
    }),
  );
  const zoneIds = [...new Set(ids.flat())];
  if (zoneIds.length) {
    proposals.unshift({
      id: BIENICI.id,
      nom: BIENICI.name,
      adresse: bieniciUrl(zoneIds, Math.max(0, rent.min - 100), rent.max + 100),
      lecteur: BIENICI.parser,
      zones: [...zoneCodes],
      filtree_sur_les_zones: true,
      verifie: true,
    });
  }
  return { proposals, unknown };
}

import { settings } from "../derive";
import { isObj } from "../guards";
import type { Obj } from "../guards";
import { BUNDLED_RAW } from "../instance";
import { loadLiveConfig, saveInstance, storedInstanceVersion } from "../live-config";
import type { Env } from "../types";

// Configuration modifiée par les outils MCP : JSON brut, celui de D1, sinon le fichier embarqué comme point de départ.

/** `version` : celle de la ligne lue (null : aucune), rendue à commit pour une écriture conditionnelle. */
export async function rawConfig(db: D1Database): Promise<{ raw: Obj; version: string | null }> {
  const stored = await storedInstanceVersion(db);
  return {
    raw: structuredClone((stored && isObj(stored.raw) ? stored.raw : BUNDLED_RAW) as Obj),
    version: stored?.version ?? null,
  };
}
export const rawSources = (raw: Obj): Obj[] =>
  Array.isArray(raw.sources) ? (raw.sources as unknown[]).filter(isObj) : [];
/** Valide, enregistre et met en vigueur dans cet isolat (les autres la chargent à leur prochaine invocation). */
export async function commit(env: Env, raw: Obj, version: string | null, now: Date): Promise<void> {
  await saveInstance(env.DB, raw, now, version);
  await loadLiveConfig(env);
}

export const searchOf = (): Obj => {
  const i = settings().instance;
  return {
    zones: i.zones.map((z) => ({ code_postal: z.postalCode, libelle: z.label })),
    communes_exclues: i.outOfZoneTowns.map((t) => t.postalCode),
    loyer_min: i.criteria.rentMin,
    loyer_max: i.criteria.rentMax,
    surface_min: i.criteria.surfaceMin,
    pieces_min: i.criteria.roomsMin,
    exclure_rez_de_chaussee: i.criteria.excludeGroundFloor,
    quartiers: i.neighborhoodKeywords,
    nom_du_quartier: i.neighborhoodLabel,
    heures_d_alerte: `${i.window.startHour} h à ${i.window.endHour} h (Paris)`,
  };
};

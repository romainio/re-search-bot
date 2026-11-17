import { settings } from "./derive";
import { TRACKED_STATUSES } from "./store";
import { FOLLOW_FILTERS } from "./telegram/feedback";
import type { SourceDef } from "./types";

// Filtres et tri des annonces affichées, partagés par le tableau de bord, la recherche sémantique et l'assistant : valeurs validées
// par liste blanche, jamais concaténées dans le SQL (paramètres liés).

/** Tris proposés (paramètre tri) et leurs libellés. */
export const SORT_LABELS = {
  recentes: "plus récentes",
  prix: "prix croissant",
  m2: "€/m² croissant",
  surface: "surface décroissante",
} as const;
export type SortKey = keyof typeof SORT_LABELS;
/** Filtre « <quartier> seulement » (paramètre zone) : annonces portant le drapeau « quartier ». */
export const NEIGHBORHOOD = "quartier";

/** `suivi` : retour posé par les boutons Telegram (aime, appelee, visite ; src/telegram/feedback.ts). */
export interface View {
  zone: string | null;
  prix: number | null;
  surface: number | null;
  tri: SortKey;
  auto: boolean;
  suivi: string | null;
  /** Recherche sémantique en cours (les liens de filtres la conservent). */
  q?: string | null;
}
/** Partie d'une vue qui filtre les lignes (le reste ne règle que l'ordre et l'affichage). */
export type ViewFilter = Pick<View, "zone" | "prix" | "surface" | "suivi">;

/** Plafonds de prix proposés : 80, 90 et 100 % du loyer maximal, arrondis à 50 €. */
export const priceCaps = (): number[] => {
  const max = settings().criteria.rentMax;
  return [...new Set([0.8, 0.9, 1].map((f) => Math.round((max * f) / 50) * 50))].filter((p) => p > 0);
};
/** Surfaces minimales proposées : celle de la recherche, +5 et +15 m² ; sans minimum, à partir de 20 m². */
export const surfaceMins = (): number[] => {
  const min = settings().criteria.surfaceMin;
  const b = min > 0 ? min : 20;
  return [b, b + 5, b + 15];
};

/** Le nom du quartier en minuscules (liens déjà partagés) vaut aussi « quartier ». */
const neighborhoodAlias = (zone: string | null): string | null =>
  zone !== null && zone === settings().neighborhood.label.toLowerCase() ? NEIGHBORHOOD : zone;
/** Valeur d'un paramètre si elle est dans la liste blanche, sinon null (paramètre ignoré). */
const pick = (v: string | null, allowed: readonly string[]): string | null =>
  v !== null && allowed.includes(v) ? v : null;

/**
 * Paramètres d'URL validés par liste blanche : zone (code postal d'une zone, ou « quartier »), prix (priceCaps), surface
 * (surfaceMins), tri (SORT_LABELS), auto (1), suivi (FOLLOW_FILTERS). Toute autre valeur est ignorée.
 */
export function parseView(q: URLSearchParams): View {
  const zone = pick(neighborhoodAlias(q.get("zone")), [...settings().allowedPostalCodes, NEIGHBORHOOD]);
  const prix = pick(q.get("prix"), priceCaps().map(String));
  const surface = pick(q.get("surface"), surfaceMins().map(String));
  const tri = (pick(q.get("tri"), Object.keys(SORT_LABELS)) ?? "recentes") as SortKey;
  const suivi = pick(q.get("suivi"), Object.keys(FOLLOW_FILTERS));
  return {
    zone,
    prix: prix ? Number(prix) : null,
    surface: surface ? Number(surface) : null,
    tri,
    auto: q.get("auto") === "1",
    suivi,
  };
}

export const isFiltered = (v: View): boolean =>
  v.zone !== null || v.prix !== null || v.surface !== null || v.suivi !== null;

/**
 * Filtres en SQL (alias l) : zone par code postal, ou sans code sur une source qui couvre la zone ; quartier par le drapeau de
 * l'évaluation ; prix max et surface min, valeurs inconnues gardées ; suivi (affichage seulement, jamais les alertes).
 */
export function viewFilters(v: ViewFilter, sources: readonly SourceDef[]): { sql: string; binds: (string | number)[] } {
  const parts: string[] = [];
  const binds: (string | number)[] = [];
  if (v.zone === NEIGHBORHOOD) {
    parts.push(
      `CASE WHEN json_valid(l.payload) THEN EXISTS (SELECT 1 FROM json_each(l.payload, '$.evaluation.flags') f WHERE f.value = '${NEIGHBORHOOD}') ELSE 0 END`,
    );
  } else if (v.zone) {
    const zone = v.zone;
    parts.push("(l.postal_code = ? OR (l.postal_code IS NULL AND l.source IN (SELECT value FROM json_each(?))))");
    binds.push(zone, JSON.stringify(sources.filter((s) => s.zones.includes(zone)).map((s) => s.id)));
  }
  if (v.prix != null) {
    parts.push("(l.rent_cc IS NULL OR l.rent_cc <= ?)");
    binds.push(v.prix);
  }
  if (v.surface != null) {
    parts.push("(l.surface IS NULL OR l.surface >= ?)");
    binds.push(v.surface);
  }
  const follow = v.suivi ? FOLLOW_FILTERS[v.suivi] : null;
  if (follow) {
    parts.push(
      "EXISTS (SELECT 1 FROM feedback fb WHERE fb.source = l.source AND fb.listing_id = l.listing_id AND fb.type = ? AND fb.value = ?)",
    );
    binds.push(follow.type, follow.value);
  }
  return { sql: parts.map((p) => ` AND ${p}`).join(""), binds };
}

/** Ordre SQL d'un tri (alias a) : valeurs inconnues en dernier, puis plus récentes d'abord, ordre stable. */
export function orderBy(tri: SortKey, a: string): string {
  const tail = `${a}.first_seen DESC, ${a}.source, ${a}.listing_id`;
  const m2 = `${a}.rent_cc / NULLIF(${a}.surface, 0)`;
  switch (tri) {
    case "prix":
      return `${a}.rent_cc IS NULL, ${a}.rent_cc, ${tail}`;
    case "m2":
      return `${m2} IS NULL, ${m2}, ${tail}`;
    case "surface":
      return `${a}.surface IS NULL, ${a}.surface DESC, ${tail}`;
    default:
      return tail;
  }
}

/** Une ligne de cluster suivie est encore en ligne (alias l) : une annonce reste visible tant qu'une source la montre. */
const CLUSTER_ONLINE = `EXISTS (SELECT 1 FROM listings c WHERE c.cluster = l.cluster AND c.gone_at IS NULL AND +c.alert_status IN ${TRACKED_STATUSES})`;
/** Annonce en ligne (alias l) : elle-même, ou une autre ligne de son cluster. */
export const ONLINE_SQL = `(l.gone_at IS NULL OR ${CLUSTER_ONLINE})`;
/** Annonce disparue (alias l) : elle et toutes les lignes suivies de son cluster. */
export const GONE_SQL = `(l.gone_at IS NOT NULL AND NOT ${CLUSTER_ONLINE})`;

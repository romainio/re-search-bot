import { runEmbed } from "../ai/embed";
import {
  SEMANTIC_CACHE_TTL_MIN,
  SEMANTIC_MAX_PER_HOUR,
  SEMANTIC_MIN_SCORE,
  SEMANTIC_QUERY_MAX,
  SEMANTIC_QUERY_MIN,
  SEMANTIC_TOPK,
  SEMANTIC_VECTORIZE_TIMEOUT_MS,
} from "../config/semantic";
import { settings } from "../derive";
import { viewFilters } from "../listings-query";
import { TRACKED_STATUSES } from "../store";
import type { Env, SourceDef } from "../types";
import { semanticOn, vectorId } from "./embed";
import { errMsg } from "../guards";
import { withTimeout } from "../timeout";
import { MINUTE_MS } from "../time";

// Recherche sémantique : embedding de la requête -> Vectorize (topK constant, filtre de zone et d'état) -> lecture D1 avec les
// filtres du tableau de bord -> rangement par similarité.

export type SearchStatus =
  | "ok"
  | "off"
  /** Saisie refusée (longueur, caractères). */
  | "invalid"
  | "limited"
  /** Budget de neurons épuisé, erreur ou délai d'Workers AI, de Vectorize ou de D1. */
  | "unavailable";

/** Annonce trouvée : colonnes lues pour le tableau de bord (`payload` : JSON { listing, evaluation, geo }) + similarité et état. */
export interface SearchRow {
  source: string;
  listing_id: string;
  alert_status: string;
  alert_attempts: number;
  first_seen: string;
  payload: string;
  /** Première détection du cluster (toutes sources). */
  since: string | null;
  /** Similarité cosinus de Vectorize (0 à 1, plus haut = plus proche). */
  score: number;
  /** L'annonce de tête est disparue (le cluster peut rester en ligne par une autre source). */
  gone: boolean;
}

export interface SearchResult {
  status: SearchStatus /** Requête normalisée (vide si refusée). */;
  query: string;
  rows: SearchRow[];
  cached: boolean;
}

export interface SearchOpts {
  /** Code postal d'une zone de l'instance (filtre de métadonnées ET filtre D1), ou « quartier » (filtre D1 seulement). */
  zone?: string | null;
  /** Loyer CC maximal / surface minimale (filtres D1 du tableau de bord : valeur inconnue gardée). */
  prix?: number | null;
  surface?: number | null;
  /** Inclure les annonces disparues (défaut : non). */
  includeGone?: boolean;
  /** Résultats rendus au plus (défaut et plafond : SEMANTIC_TOPK). */
  limit?: number;
  /** Limite horaire (défaut : oui, tableau de bord) ; `false` pour un appelant déjà protégé (assistant). Le plafond de neurons reste. */
  rateLimit?: boolean;
  now?: Date;
  /** Registre des sources (zone des annonces sans code postal) ; défaut : les lecteurs dédiés. */
  sources?: readonly SourceDef[];
}

/** Caractères admis : lettres, chiffres, espaces et ponctuation courante d'une recherche en français. */
const QUERY_CHARS = /^[\p{L}\p{N}\s'’.,;:!?€²/+()%&-]+$/u;

/** Requête nettoyée (espaces réduits, SEMANTIC_QUERY_MIN à SEMANTIC_QUERY_MAX caractères, caractères admis) ; null si refusée. */
export function normalizeQuery(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.replace(/\s+/g, " ").trim();
  if (q.length < SEMANTIC_QUERY_MIN || q.length > SEMANTIC_QUERY_MAX || !QUERY_CHARS.test(q)) return null;
  return q;
}

type Hit = [string, string, number];

/** Voisins en cache D1 (moins de SEMANTIC_CACHE_TTL_MIN minutes), ou null. */
async function cacheGet(db: D1Database, key: string, now: Date): Promise<Hit[] | null> {
  const cutoff = new Date(now.getTime() - SEMANTIC_CACHE_TTL_MIN * MINUTE_MS).toISOString();
  const r = await db
    .prepare("SELECT hits FROM search_cache WHERE key = ? AND created_at > ?")
    .bind(key, cutoff)
    .first<{ hits: string }>();
  if (!r) return null;
  try {
    const h = JSON.parse(r.hits) as unknown;
    return Array.isArray(h) ? (h as Hit[]) : null;
  } catch {
    return null;
  }
}

/** Écrit le cache et purge les entrées et compteurs horaires périmés, en un lot (une seule aller-retour D1). */
async function cachePut(db: D1Database, key: string, hits: Hit[], now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - SEMANTIC_CACHE_TTL_MIN * MINUTE_MS).toISOString();
  await db.batch([
    db
      .prepare("INSERT OR REPLACE INTO search_cache (key, created_at, hits) VALUES (?, ?, ?)")
      .bind(key, now.toISOString(), JSON.stringify(hits)),
    db.prepare("DELETE FROM search_cache WHERE created_at < ?").bind(cutoff),
    db.prepare("DELETE FROM search_rate WHERE hour < ?").bind(now.toISOString().slice(0, 13)),
  ]);
}

/** Prend un jeton de la limite horaire (UPSERT atomique, une écriture) ; faux si SEMANTIC_MAX_PER_HOUR est atteinte. */
async function takeToken(db: D1Database, now: Date): Promise<boolean> {
  const r = await db
    .prepare(
      "INSERT INTO search_rate (hour, n) VALUES (?, 1) ON CONFLICT (hour) DO UPDATE SET n = n + 1 WHERE n < ? RETURNING n",
    )
    .bind(now.toISOString().slice(0, 13), SEMANTIC_MAX_PER_HOUR)
    .first<{ n: number }>();
  return r !== null;
}

/**
 * Recherche sémantique, sans exception : le statut dit pourquoi il n'y a pas de résultat. Un résultat en cache ne coûte ni
 * neuron, ni requête Vectorize, ni jeton horaire ; sinon jeton, embedding budgété, une requête Vectorize, puis lecture D1 avec
 * les filtres de la vue. Limite : « gone » est l'état de l'annonce de tête, un cluster en ligne ailleurs peut être masqué.
 */
export async function semanticSearch(env: Env, query: string, opts: SearchOpts = {}): Promise<SearchResult> {
  const out = (status: SearchStatus, q = "", rows: SearchRow[] = [], cached = false): SearchResult => ({
    status,
    query: q,
    rows,
    cached,
  });
  if (!semanticOn(env)) return out("off");
  const q = normalizeQuery(query);
  if (q === null) return out("invalid");
  const now = opts.now ?? new Date();
  const zoneMeta = opts.zone && settings().allowedPostalCodes.includes(opts.zone) ? opts.zone : null;
  const includeGone = opts.includeGone === true;
  try {
    const key = await vectorId(`${q.toLowerCase()}|${zoneMeta ?? ""}|${includeGone ? 1 : 0}`);
    let hits = await cacheGet(env.DB, key, now);
    const cached = hits !== null;
    if (!hits) {
      if (opts.rateLimit !== false && !(await takeToken(env.DB, now))) return out("limited", q);
      const vectors = await runEmbed(env, [q], now);
      if (!vectors) return out("unavailable", q);
      const filter: Record<string, unknown> = {};
      if (zoneMeta) filter.zone = zoneMeta;
      if (!includeGone) filter.gone = 0;
      const res = await withTimeout(
        Promise.resolve(env.VECTORIZE!.query(vectors[0], { topK: SEMANTIC_TOPK, returnMetadata: "all", filter })),
        SEMANTIC_VECTORIZE_TIMEOUT_MS,
      );
      hits = [];
      for (const m of res?.matches ?? []) {
        const md = m.metadata ?? {};
        if (
          typeof m.score === "number" &&
          m.score >= SEMANTIC_MIN_SCORE &&
          typeof md.source === "string" &&
          typeof md.lid === "string"
        )
          hits.push([md.source, md.lid, m.score]);
      }
      hits.sort((a, b) => b[2] - a[2]);
      await cachePut(env.DB, key, hits, now).catch((e) => console.error("search: cache non écrit", errMsg(e)));
    }
    if (!hits.length) return out("ok", q, [], cached);

    const sources = opts.sources ?? settings().sources.dedicated;
    const f = viewFilters(
      { zone: opts.zone ?? null, prix: opts.prix ?? null, surface: opts.surface ?? null, suivi: null },
      sources,
    );
    const sql = `SELECT l.source, l.listing_id, l.alert_status, l.alert_attempts, l.first_seen, l.payload, l.gone_at,
        (SELECT MIN(c.first_seen) FROM listings c WHERE c.cluster = l.cluster AND +c.alert_status IN ${TRACKED_STATUSES}) AS since
      FROM listings l
      WHERE (l.source, l.listing_id) IN (VALUES ${hits.map(() => "(?, ?)").join(", ")}) AND l.alert_status IN ('sent','pending','silent')
        ${includeGone ? "" : `AND (l.gone_at IS NULL OR EXISTS (SELECT 1 FROM listings c WHERE c.cluster = l.cluster AND c.gone_at IS NULL AND +c.alert_status IN ${TRACKED_STATUSES}))`}${f.sql}`;
    const { results } = await env.DB.prepare(sql)
      .bind(...hits.flatMap((h) => [h[0], h[1]]), ...f.binds)
      .all<Omit<SearchRow, "score" | "gone"> & { gone_at: string | null }>();
    const byKey = new Map(results.map((r) => [`${r.source}\u0000${r.listing_id}`, r]));
    const rows: SearchRow[] = [];
    for (const [s, id, score] of hits) {
      const r = byKey.get(`${s}\u0000${id}`);
      if (!r) continue;
      const { gone_at, ...rest } = r;
      rows.push({ ...rest, score, gone: gone_at !== null });
    }
    return out("ok", q, rows.slice(0, Math.max(1, Math.min(opts.limit ?? SEMANTIC_TOPK, SEMANTIC_TOPK))), cached);
  } catch (e) {
    console.error("search:", errMsg(e));
    return out("unavailable", q);
  }
}

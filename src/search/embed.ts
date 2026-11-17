import { runEmbed } from "../ai/embed";
import { EMBED_BATCH, SEMANTIC_MAX_VECTORS, SEMANTIC_VECTORIZE_TIMEOUT_MS } from "../config/semantic";
import { settings } from "../derive";
import type { Env, SourceDef } from "../types";
import { embedText, zoneCode } from "./text";
import type { EmbedPayload } from "./text";
import { errMsg } from "../guards";
import { withTimeout } from "../timeout";

// Indexation dans Vectorize : un pas par minute (POST /embed), au plus EMBED_BATCH annonces, une par cluster (celle de tête,
// gardée et suivie). Le plafond de neurons « embed » borne la dépense du jour.

/** Option active : SEMANTIC_SEARCH="true", binding VECTORIZE et binding Workers AI présents. Sinon aucun appel, aucun effet. */
export const semanticOn = (env: Env): boolean => env.SEMANTIC_SEARCH === "true" && !!env.VECTORIZE && !!env.AI;

/** Identifiant Vectorize d'un cluster : SHA-1 hexadécimal (un cluster peut dépasser la limite de 64 octets). */
export async function vectorId(cluster: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(cluster)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface EmbedReport {
  /** "éteint" : interrupteur ou binding absent ; "rien" : rien à indexer ; "budget" : plafond de neurons ; "erreur" ; "pas" : lot indexé. */
  result: "éteint" | "rien" | "budget" | "erreur" | "pas";
  embedded: number;
  refreshed: number;
  skipped: number;
}

interface Todo {
  source: string;
  listing_id: string;
  cluster: string;
  payload: string;
  gone_at: string | null;
  embedded_at: string | null;
}

// Les WHERE reprennent les termes des index partiels de la migration 0013 (condition pour que SQLite les utilise), et INDEXED BY les
// impose : sans lui le planificateur préfère listings_status (tout le stock de statut « sent » trié à chaque minute).
export const TODO_SQL = `SELECT source, listing_id, cluster, payload, gone_at, embedded_at FROM listings INDEXED BY listings_embed_todo
  WHERE embedded_at IS NULL AND alert_status IN ('silent','pending','sent') AND cluster = source || ':' || listing_id
  ORDER BY first_seen DESC LIMIT ?`;
export const REDO_SQL = `SELECT source, listing_id, cluster, payload, gone_at, embedded_at FROM listings INDEXED BY listings_embed_redo WHERE embed_redo = 1 ORDER BY first_seen DESC LIMIT ?`;
export const MARK_GONE_SQL = `UPDATE listings INDEXED BY listings_embed_gone SET embed_redo = 1 WHERE embedded_gone = 0 AND embedded_at IS NOT NULL AND gone_at IS NOT NULL AND embed_redo = 0`;
export const MARK_BACK_SQL = `UPDATE listings INDEXED BY listings_embed_back SET embed_redo = 1 WHERE embedded_gone = 1 AND gone_at IS NULL AND embed_redo = 0`;

/**
 * Un pas d'indexation, sans exception : marque à rafraîchir les annonces disparues ou réapparues, puis embarque jusqu'à
 * EMBED_BATCH annonces (jamais indexées d'abord, sous SEMANTIC_MAX_VECTORS, puis à rafraîchir : un nouvel upsert coûte moins
 * qu'un getByIds), upsert, marquage D1. Échec : rien n'est marqué. Un payload illisible est marqué sans vecteur.
 */
export async function runEmbedStep(
  env: Env,
  now: Date,
  sources: readonly SourceDef[] = settings().sources.dedicated,
): Promise<EmbedReport> {
  const report: EmbedReport = { result: "éteint", embedded: 0, refreshed: 0, skipped: 0 };
  if (!semanticOn(env)) return report;
  report.result = "rien";
  try {
    await env.DB.batch([env.DB.prepare(MARK_GONE_SQL), env.DB.prepare(MARK_BACK_SQL)]);
    const count =
      (await env.DB.prepare("SELECT v FROM embed_state WHERE k = 'vectors'").first<{ v: number }>())?.v ?? 0;
    const todo: Todo[] =
      count < SEMANTIC_MAX_VECTORS
        ? (
            await env.DB.prepare(TODO_SQL)
              .bind(Math.min(EMBED_BATCH, SEMANTIC_MAX_VECTORS - count))
              .all<Todo>()
          ).results
        : [];
    const redo: Todo[] =
      todo.length < EMBED_BATCH
        ? (
            await env.DB.prepare(REDO_SQL)
              .bind(EMBED_BATCH - todo.length)
              .all<Todo>()
          ).results
        : [];
    const rows = [...todo, ...redo];
    if (!rows.length) return report;

    const byId = new Map(sources.map((s) => [s.id, s]));
    const items: { row: Todo; text: string; payload: EmbedPayload }[] = [];
    const stmts: D1PreparedStatement[] = [];
    const iso = now.toISOString();
    const mark = (r: Todo, gone: number): D1PreparedStatement =>
      env.DB.prepare(
        "UPDATE listings SET embedded_at = ?, embedded_gone = ?, embed_redo = 0 WHERE source = ? AND listing_id = ?",
      ).bind(iso, gone, r.source, r.listing_id);
    for (const r of rows) {
      let p: EmbedPayload | null = null;
      try {
        p = JSON.parse(r.payload) as EmbedPayload;
      } catch {
        /* ignorée ci-dessous */
      }
      if (!p || typeof p !== "object" || !p.listing || typeof p.listing !== "object") {
        stmts.push(mark(r, r.gone_at ? 1 : 0));
        report.skipped++;
        continue;
      }
      items.push({ row: r, text: embedText(p, byId.get(r.source)), payload: p });
    }
    if (items.length) {
      const vectors = await runEmbed(
        env,
        items.map((i) => i.text),
        now,
      );
      if (!vectors) {
        report.result = "budget";
        return report;
      }
      const upserts = await Promise.all(
        items.map(async (it, i) => ({
          id: await vectorId(it.row.cluster),
          values: vectors[i],
          // zone et gone : métadonnées indexées (create-metadata-index) ; source et lid retrouvent la ligne D1.
          metadata: {
            source: it.row.source,
            lid: it.row.listing_id,
            zone: zoneCode(it.payload.listing, byId.get(it.row.source)),
            gone: it.row.gone_at ? 1 : 0,
          },
        })),
      );
      await withTimeout(Promise.resolve(env.VECTORIZE!.upsert(upserts)), SEMANTIC_VECTORIZE_TIMEOUT_MS);
      for (const it of items) {
        stmts.push(mark(it.row, it.row.gone_at ? 1 : 0));
        if (it.row.embedded_at === null) report.embedded++;
        else report.refreshed++;
      }
      if (report.embedded) {
        stmts.push(
          env.DB.prepare(
            "INSERT INTO embed_state (k, v) VALUES ('vectors', ?) ON CONFLICT (k) DO UPDATE SET v = v + excluded.v",
          ).bind(report.embedded),
        );
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
    report.result = "pas";
    return report;
  } catch (e) {
    console.error("embed:", errMsg(e));
    report.result = "erreur";
    return report;
  }
}

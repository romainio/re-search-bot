import { MAX_ALERT_ATTEMPTS, TRACKED_LIMIT } from "./config/scan";
import type { GeoHints } from "./geo/hints";
import type { Evaluation, Listing } from "./types";

export interface PendingAlert {
  source: string;
  id: string;
  kind: "new" | "price_drop";
  listing: Listing;
  evaluation: Evaluation;
  detectedAt: string;
  /** Indices géographiques du payload (absents si GEO_HINTS était éteint). */
  geo?: GeoHints;
  /** rowid de la ligne : callback_data des boutons Telegram. */
  rowid?: number;
}

export interface ListingRow {
  source: string;
  listing_id: string;
  cluster: string;
  alert_status: string;
  first_seen: string;
  last_seen: string | null;
  gone_at: string | null;
  /** Absent des lignes suivies (getTrackedRows, jamais filtrées) : seul le traitement d'une annonce filtrée relit le payload. */
  payload?: string;
}

/** Statuts des annonces suivies (présence, disparition) : toutes sauf les filtrées. */
export const TRACKED_STATUSES = "('silent','pending','sent','duplicate')";

export interface MatchQuery {
  postalCode: string;
  surface: number;
  rentCC: number;
  surfaceTol: number;
  priceTol: number;
  selfSource: string;
}

const CHUNK = 49; // + 1 paramètre pour la source, sous la limite de 50

export async function getKnownRows(db: D1Database, source: string, ids: string[]): Promise<Map<string, ListingRow>> {
  const out = new Map<string, ListingRow>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const marks = part.map(() => "?").join(",");
    const { results } = await db
      .prepare(
        `SELECT source, listing_id, cluster, alert_status, first_seen, last_seen, gone_at, payload FROM listings WHERE source = ? AND listing_id IN (${marks})`,
      )
      .bind(source, ...part)
      .all<ListingRow>();
    for (const r of results) out.set(r.listing_id, r);
  }
  return out;
}

/**
 * Lignes suivies encore en ligne d'une source, sans payload, bornées à TRACKED_LIMIT dans l'ordre des listing_id (les mêmes
 * d'un passage à l'autre si la borne est atteinte).
 */
// « +listing_id » : un ORDER BY listing_id nu fait choisir la clé primaire (source, listing_id), qui parcourt TOUTES les lignes
// de la source (filtrées et disparues comprises) ; le + garde l'index listings_gone et trie les seules lignes suivies.
export const TRACKED_ROWS_SQL = `SELECT source, listing_id, cluster, alert_status, first_seen, last_seen, gone_at FROM listings
     WHERE gone_at IS NULL AND source = ? AND alert_status IN ${TRACKED_STATUSES} ORDER BY +listing_id LIMIT ?`;

export async function getTrackedRows(db: D1Database, source: string): Promise<Map<string, ListingRow>> {
  const { results } = await db.prepare(TRACKED_ROWS_SQL).bind(source, TRACKED_LIMIT).all<ListingRow>();
  return new Map(results.map((r) => [r.listing_id, r]));
}

/** Instructions qui posent `set` (`value` en premier paramètre) sur les annonces `ids`, par paquets sous la limite de 50 paramètres. */
export function updateByIds(
  db: D1Database,
  set: string,
  value: string,
  source: string,
  ids: string[],
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += CHUNK - 1) {
    const part = ids.slice(i, i + CHUNK - 1);
    out.push(
      db
        .prepare(`UPDATE listings SET ${set} WHERE source = ? AND listing_id IN (${part.map(() => "?").join(",")})`)
        .bind(value, source, ...part),
    );
  }
  return out;
}

/** État d'une source avant traitement, en une lecture ; `zones` null si elles n'ont jamais été enregistrées. */
export async function getSourceStatus(
  db: D1Database,
  source: string,
): Promise<{ initialized: boolean; failing: boolean; lastRun: string | null; zones: string[] | null }> {
  const r = await db
    .prepare("SELECT initialized, consecutive_failures, last_run, zones FROM source_state WHERE source = ?")
    .bind(source)
    .first<{ initialized: number; consecutive_failures: number; last_run: string | null; zones: string | null }>();
  const initialized = r?.initialized === 1;
  const zones = !initialized ? [] : r?.zones != null ? r.zones.split(",").filter(Boolean) : null;
  return { initialized, failing: (r?.consecutive_failures ?? 0) > 0, lastRun: r?.last_run ?? null, zones };
}

/** Cluster d'une annonce d'une autre source (non filtrée) correspondant au même appartement. */
export async function findMatchCluster(db: D1Database, q: MatchQuery): Promise<string | null> {
  const r = await db
    .prepare(
      `SELECT cluster FROM listings
     WHERE postal_code = ?1 AND surface IS NOT NULL AND rent_cc IS NOT NULL
       AND ABS(surface - ?2) <= ?3 AND ABS(rent_cc - ?4) < ?5
       AND alert_status IN ('silent','pending','sent','duplicate')
       AND source <> ?6
     ORDER BY first_seen LIMIT 1`,
    )
    .bind(q.postalCode, q.surface, q.surfaceTol + 1e-9, q.rentCC, q.priceTol, q.selfSource)
    .first<{ cluster: string }>();
  return r?.cluster ?? null;
}

/** Alertes en attente, hors alertes abandonnées (MAX_ALERT_ATTEMPTS rejets Telegram). */
export async function getPendingAlerts(db: D1Database, limit: number): Promise<PendingAlert[]> {
  const { results } = await db
    .prepare(
      "SELECT rowid AS rid, source, listing_id, alert_kind, first_seen, payload FROM listings WHERE alert_status = 'pending' AND alert_attempts < ? ORDER BY first_seen, source, listing_id LIMIT ?",
    )
    .bind(MAX_ALERT_ATTEMPTS, limit)
    .all<{
      rid: number;
      source: string;
      listing_id: string;
      alert_kind: string;
      first_seen: string;
      payload: string;
    }>();
  const out: PendingAlert[] = [];
  const corrupt: D1PreparedStatement[] = [];
  for (const r of results) {
    let p: { listing?: Listing; evaluation?: Evaluation; geo?: GeoHints } | null = null;
    try {
      p = JSON.parse(r.payload);
    } catch {
      /* traité ci-dessous */
    }
    if (
      !p ||
      typeof p !== "object" ||
      !p.listing ||
      typeof p.listing !== "object" ||
      !p.evaluation ||
      typeof p.evaluation !== "object"
    ) {
      // Ligne corrompue : ignorée et sortie de la file (sinon elle bloquerait les suivantes), sans journaliser le contenu.
      console.error("alerts: payload illisible ignoré", r.source, r.listing_id);
      corrupt.push(
        db
          .prepare("UPDATE listings SET alert_attempts = ? WHERE source = ? AND listing_id = ?")
          .bind(MAX_ALERT_ATTEMPTS, r.source, r.listing_id),
      );
      continue;
    }
    out.push({
      source: r.source,
      id: r.listing_id,
      kind: r.alert_kind === "price_drop" ? "price_drop" : "new",
      listing: p.listing,
      evaluation: p.evaluation,
      detectedAt: r.first_seen,
      rowid: r.rid,
      ...(p.geo && typeof p.geo === "object" ? { geo: p.geo } : {}),
    });
  }
  if (corrupt.length) {
    try {
      await db.batch(corrupt);
    } catch {
      /* réessayé au prochain passage */
    }
  }
  return out;
}

/** Alerte envoyée ; `photo` (analyse des photos) entre dans le payload par la même écriture. */
export async function markAlertSent(
  db: D1Database,
  source: string,
  id: string,
  now: Date,
  photo: unknown = null,
): Promise<void> {
  if (photo == null) {
    await db
      .prepare("UPDATE listings SET alert_status = 'sent', alerted_at = ? WHERE source = ? AND listing_id = ?")
      .bind(now.toISOString(), source, id)
      .run();
    return;
  }
  await db
    .prepare(
      "UPDATE listings SET alert_status = 'sent', alerted_at = ?, payload = CASE WHEN json_valid(payload) THEN json_set(payload, '$.photo', json(?)) ELSE payload END WHERE source = ? AND listing_id = ?",
    )
    .bind(now.toISOString(), JSON.stringify(photo), source, id)
    .run();
}

/** Rejet définitif de Telegram (400) : une tentative de plus. */
export async function recordAlertRejected(db: D1Database, source: string, id: string): Promise<void> {
  await db
    .prepare("UPDATE listings SET alert_attempts = alert_attempts + 1 WHERE source = ? AND listing_id = ?")
    .bind(source, id)
    .run();
}

export interface ClusterStat {
  cluster: string;
  sources: { source: string; first_seen: string }[];
  fastest: string;
}

/** Par cluster avec au moins une alerte envoyée : sources, first_seen, source la plus rapide ; `limit` garde les plus récents. */
export async function getClusterStats(db: D1Database, limit?: number): Promise<ClusterStat[]> {
  const { results } = await db
    .prepare(
      `SELECT cluster, source, first_seen FROM listings
     WHERE cluster IN (SELECT cluster FROM listings WHERE alert_status = 'sent' GROUP BY cluster ORDER BY MIN(first_seen) DESC, cluster LIMIT ?)
     ORDER BY cluster, first_seen, source`,
    )
    .bind(limit ?? -1)
    .all<{ cluster: string; source: string; first_seen: string }>();
  const out = new Map<string, ClusterStat>();
  for (const r of results) {
    let c = out.get(r.cluster);
    if (!c) {
      c = { cluster: r.cluster, sources: [], fastest: r.source };
      out.set(r.cluster, c);
    }
    c.sources.push({ source: r.source, first_seen: r.first_seen });
  }
  return [...out.values()];
}

export async function getSourceStates(db: D1Database): Promise<unknown[]> {
  const { results } = await db.prepare("SELECT * FROM source_state ORDER BY source").all();
  return results;
}

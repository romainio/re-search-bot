import { EMPTY_SUSPECT_MIN_PREV, FAILURES_BEFORE_BROKEN } from "./config/scan";
import { STALE_AFTER_MINUTES, staleAfterMinutes } from "./config/schedule";
import { settings } from "./derive";
import { isActiveHour, parisMinuteOfDay } from "./schedule";
import type { SourceDef } from "./types";
import { MINUTE_MS } from "./time";

/** `emptyOk` : zéro annonce est un état normal pour cette source (page de pagination, SourceDef.extraPage), jamais suspect. */
export type Outcome = { ok: true; count: number; emptyOk?: boolean } | { ok: false; reason: string };

export interface HealthEvent {
  type: "broken" | "restored";
  sourceId: string;
  reason: string;
}

interface HealthRow {
  consecutive_failures: number;
  last_count: number | null;
  broken: number;
  last_error: string | null;
}

/** Enregistre le résultat d'un passage et signale panne ou rétablissement ; n'écrit que si une valeur change (écritures D1). */
export async function recordOutcome(
  db: D1Database,
  sourceId: string,
  o: Outcome,
  now: Date,
): Promise<HealthEvent | null> {
  const prev = await db
    .prepare("SELECT consecutive_failures, last_count, broken, last_error FROM source_state WHERE source = ?")
    .bind(sourceId)
    .first<HealthRow>();
  const prevFailures = prev?.consecutive_failures ?? 0;
  const prevCount = prev?.last_count ?? null;
  const wasBroken = (prev?.broken ?? 0) === 1;

  // Zéro annonce n'est suspect qu'après un stock d'au moins EMPTY_SUSPECT_MIN_PREV : passer de 1 ou 2 biens à 0 est courant, et
  // le compter en échec laisserait la source « en panne » pour toujours.
  const emptyAfterStock =
    o.ok && !o.emptyOk && o.count === 0 && prevCount !== null && prevCount >= EMPTY_SUSPECT_MIN_PREV;
  const failed = !o.ok || emptyAfterStock;

  let failures = prevFailures;
  let count = prevCount;
  let broken = wasBroken;
  let error = prev?.last_error ?? null;
  let event: HealthEvent | null = null;

  if (failed) {
    const reason = !o.ok ? o.reason : `0 annonce (contre ${prevCount} au passage précédent)`;
    failures = Math.min(prevFailures + 1, FAILURES_BEFORE_BROKEN);
    error = reason;
    if (failures >= FAILURES_BEFORE_BROKEN && !wasBroken) {
      broken = true;
      event = { type: "broken", sourceId, reason };
    }
  } else if (o.ok) {
    failures = 0;
    count = o.count;
    error = null;
    if (wasBroken) {
      broken = false;
      event = { type: "restored", sourceId, reason: "source rétablie" };
    }
  }

  const changed =
    !prev ||
    failures !== prevFailures ||
    count !== prevCount ||
    broken !== wasBroken ||
    error !== (prev.last_error ?? null);
  if (!changed) return event;

  // last_ok n'est écrit qu'avec un autre changement : pas d'écriture sur un passage sain et stable.
  const lastOk = failed ? null : now.toISOString();
  await db
    .prepare(
      `INSERT INTO source_state (source, consecutive_failures, last_count, broken, last_ok, last_error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(source) DO UPDATE SET
       consecutive_failures = excluded.consecutive_failures,
       last_count = excluded.last_count,
       broken = excluded.broken,
       last_ok = COALESCE(excluded.last_ok, source_state.last_ok),
       last_error = excluded.last_error`,
    )
    .bind(sourceId, failures, count, broken ? 1 : 0, lastOk, error)
    .run();
  return event;
}

/** Fenêtre active ouverte depuis au moins STALE_AFTER_MINUTES : le premier passage du jour a eu lieu. */
function staleCheckOpen(now: Date): boolean {
  const window = settings().window;
  return isActiveHour(now, window) && parisMinuteOfDay(now) >= window.startHour * 60 + STALE_AFTER_MINUTES;
}

/** Passage complet (lecture + traitement réussis) : écrit à chaque passage, pour détecter les invocations mortes. */
export async function markRun(db: D1Database, sourceId: string, now: Date): Promise<void> {
  await db
    .prepare(
      "INSERT INTO source_state (source, last_run) VALUES (?1, ?2) ON CONFLICT(source) DO UPDATE SET last_run = excluded.last_run",
    )
    .bind(sourceId, now.toISOString())
    .run();
}

/**
 * Minutes depuis le dernier passage si la source est en retard (fenêtre ouverte depuis STALE_AFTER_MINUTES, dernier passage plus
 * ancien que staleAfterMinutes(every)), sinon null. Sans last_run : jamais en retard.
 */
export function staleMinutes(lastRun: string | null | undefined, now: Date, every?: number): number | null {
  if (!lastRun || !staleCheckOpen(now)) return null;
  const t = Date.parse(lastRun);
  if (Number.isNaN(t)) return null;
  const min = Math.floor((now.getTime() - t) / MINUTE_MS);
  return min > staleAfterMinutes(every) ? min : null;
}

/** Sources actives en retard : passées en panne (une seule fois, même mécanisme de réarmement que les autres pannes). */
export async function detectStale(
  db: D1Database,
  sources: readonly Pick<SourceDef, "id" | "active" | "every">[],
  now: Date,
): Promise<HealthEvent[]> {
  if (!staleCheckOpen(now)) return [];
  const cutoff = new Date(now.getTime() - STALE_AFTER_MINUTES * MINUTE_MS).toISOString();
  const { results } = await db
    .prepare("SELECT source, last_run FROM source_state WHERE broken = 0 AND last_run IS NOT NULL AND last_run < ?")
    .bind(cutoff)
    .all<{ source: string; last_run: string }>();
  const active = new Map(sources.filter((s) => s.active).map((s) => [s.id, s.every]));
  const events: HealthEvent[] = [];
  for (const r of results) {
    if (!active.has(r.source)) continue;
    const min = staleMinutes(r.last_run, now, active.get(r.source));
    if (min === null) continue;
    const reason = `aucun passage depuis ${min} min`;
    const res = await db
      .prepare("UPDATE source_state SET broken = 1, last_error = ? WHERE source = ? AND broken = 0")
      .bind(reason, r.source)
      .run();
    if (res.meta.changes > 0) events.push({ type: "broken", sourceId: r.source, reason });
  }
  return events;
}

/** Événement non livré : remet l'état dans la situation d'avant pour que le prochain passage le réémette. */
export async function rearmHealthEvent(db: D1Database, e: HealthEvent): Promise<void> {
  await db
    .prepare("UPDATE source_state SET broken = ? WHERE source = ?")
    .bind(e.type === "broken" ? 0 : 1, e.sourceId)
    .run();
}

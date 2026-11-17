import { DETAIL_TIMEOUT_MS } from "./config/fetch";
import { GEO_TIMEOUT_MS } from "./config/geo";
import {
  ENRICH_RESERVE_MS,
  MIN_LOOKUP_TIMEOUT_MS,
  PART_MAX_SKEW_MS,
  PART_SIZE,
  PART_TIMEOUT_MS,
  PASS_DEADLINE_MS,
  SUBREQUEST_LIMIT,
  SUBREQUEST_MARGIN,
} from "./config/scan";
import { settings } from "./derive";
import type { Settings } from "./derive";
import { enrichListings } from "./enrich";
import { fetchSource } from "./fetch-source";
import { postInternal } from "./internal";
import type { FetchResult } from "./fetch-source";
import { geoHintsFor } from "./geo/hints";
import type { GeoHints } from "./geo/hints";
import type { HealthEvent, Outcome } from "./health";
import { detectStale, markRun, recordOutcome } from "./health";
import { sendPendingAlerts } from "./notify/send";
import { PARSERS } from "./parsers/index";
import { loadKnown, processListings } from "./process";
import type { KnownState } from "./process";
import { isDue } from "./schedule";
import { readUniversal } from "./universal/read";
import type { UniversalResult } from "./universal/read";
import type { Env, Listing, SourceDef } from "./types";
import { errMsg } from "./guards";
import { TIMEOUT_MESSAGE, withTimeout } from "./timeout";

export interface ScanReport {
  /** truncated : plafond atteint sans marqueur de fin ; les cartes au-delà sont perdues. */
  sources: {
    id: string;
    ok: boolean;
    count?: number;
    reason?: string;
    ms: number;
    truncated?: true;
    skipped?: string;
    unchanged?: true;
    savedNeurons?: number;
    neurons?: number;
  }[];
  alertsSent: number;
}

/** Résultat d'un sous-lot (route /part) : rapport par source et événements de santé, à envoyer par l'orchestrateur. */
export interface PartResult {
  sources: ScanReport["sources"];
  events: HealthEvent[];
}

/** Lance un sous-lot (ids de sources, instant commun du passage) et renvoie son résultat. */
export type PartRunner = (sourceIds: string[], now: Date) => Promise<PartResult>;

/** Raison enregistrée pour chaque source d'un sous-lot qui n'a pas répondu correctement. */
export const PART_FAILED = "sous-lot en échec";
/** Raison d'un sous-lot non lancé : échéance du passage atteinte. */
export const PASS_TOO_LATE = TIMEOUT_MESSAGE;

/** Raison d'échec d'une page tronquée où le parseur ne trouve aucune carte. */
export const PAGE_TRUNCATED = "page tronquée";

/**
 * Annonces d'une page. Tronquée, zéro carte ou un parseur qui lève est un échec « page tronquée », jamais un [] silencieux ;
 * les cartes lues sont gardées mais signalées.
 */
export function parseSource(
  src: SourceDef,
  body: string,
  truncated = false,
): { ok: true; listings: Listing[]; truncated?: true } | { ok: false; reason: string } {
  try {
    const listings = PARSERS[src.parser](body, src);
    if (!truncated) return { ok: true, listings };
    if (listings.length === 0) return { ok: false, reason: PAGE_TRUNCATED };
    console.warn(
      `${src.id}: page tronquée au plafond, ${listings.length} annonces lues (cartes au-delà du plafond perdues)`,
    );
    return { ok: true, listings, truncated: true };
  } catch {
    // Page de pagination (extraPage) sans carte : le site a moins d'annonces, ce n'est pas une panne.
    if (src.extraPage && !truncated) return { ok: true, listings: [] };
    return { ok: false, reason: truncated ? PAGE_TRUNCATED : "parse_error" };
  }
}

/** Découpe en sous-lots de `size` éléments, dans l'ordre donné. */
export function splitParts<T>(items: T[], size: number = PART_SIZE): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}

/**
 * Sous-lots (ids) des sources actives d'un groupe, dans l'ordre du registre. Avec `now`, les sources à cadence réduite qui ne
 * sont pas dues sont écartées (detectStale tolère leur intervalle).
 */
export function groupParts(group: number, now?: Date, { sources }: Settings = settings()): string[][] {
  return splitParts(
    sources.cron
      .filter((s) => sources.readable.has(s.id) && s.group === group && (!now || isDue(s, now)))
      .map((s) => s.id),
  );
}

/**
 * Corps de /part : { ids, now }, ou null si invalide. `now` est l'instant commun du passage ; à plus de PART_MAX_SKEW_MS de
 * l'horloge, la requête est refusée (rejeu).
 */
export function parsePartRequest(
  body: unknown,
  { sources: registry }: Settings = settings(),
): { sources: SourceDef[]; now: Date } | null {
  if (!body || typeof body !== "object") return null;
  const { ids, now } = body as { ids?: unknown; now?: unknown };
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > PART_SIZE || new Set(ids).size !== ids.length) return null;
  const sources: SourceDef[] = [];
  for (const id of ids) {
    const src = registry.cron.find((s) => registry.readable.has(s.id) && s.id === id);
    if (!src) return null;
    sources.push(src);
  }
  if (typeof now !== "string") return null;
  const at = Date.parse(now);
  if (Number.isNaN(at) || Math.abs(Date.now() - at) > PART_MAX_SKEW_MS) return null;
  return { sources, now: new Date(at) };
}

/**
 * Sous-lot : lecture en parallèle et analyse des sources, annonces connues, fiches et indices, puis traitement et santé par
 * source. N'envoie rien sur Telegram : les événements de santé reviennent à l'orchestrateur.
 */
export async function runPart(
  env: Env,
  sources: SourceDef[],
  now: Date,
  cfg: Settings = settings(),
): Promise<PartResult> {
  const result: PartResult = { sources: [], events: [] };
  const started = Date.now();
  const fetched = await Promise.allSettled(
    sources.map(
      async (
        s,
      ): Promise<
        { ms: number; uni: UniversalResult; res?: undefined } | { ms: number; res: FetchResult; uni?: undefined }
      > => {
        const t = Date.now();
        if (s.parser === "universal") return { uni: await readUniversal(env, s), ms: Date.now() - t };
        return { res: await fetchSource(s), ms: Date.now() - t };
      },
    ),
  );
  // Invariant : toute l'analyse (l'essentiel du CPU) avant la première écriture D1. Une invocation tuée pendant l'analyse
  // n'a rien écrit, et l'orchestrateur compte tout le sous-lot en échec.
  const read = sources.map(
    (
      src,
      i,
    ): {
      ms: number;
      outcome: Outcome;
      listings: Listing[];
      truncated?: true;
      skipped?: string;
      uni?: { unchanged?: true; savedNeurons?: number; neurons?: number };
    } => {
      const f = fetched[i];
      if (f.status === "rejected") return { ms: 0, outcome: { ok: false, reason: "réseau" }, listings: [] };
      if (f.value.uni) {
        const { uni, ms } = f.value;
        if (uni.status === "skipped") return { ms, outcome: { ok: true, count: 0 }, listings: [], skipped: uni.reason };
        if (uni.status === "fail") return { ms, outcome: { ok: false, reason: uni.reason }, listings: [] };
        return {
          ms,
          outcome: { ok: true, count: uni.listings.length },
          listings: uni.listings,
          uni: {
            ...(uni.unchanged ? { unchanged: true as const } : {}),
            ...(uni.savedNeurons !== undefined ? { savedNeurons: uni.savedNeurons } : {}),
            ...(uni.neurons !== undefined ? { neurons: uni.neurons } : {}),
          },
        };
      }
      const { res, ms } = f.value;
      if (!res.ok) return { ms, outcome: { ok: false, reason: res.reason }, listings: [] };
      const p = parseSource(src, res.body, res.truncated);
      if (!p.ok) return { ms, outcome: { ok: false, reason: p.reason }, listings: [] };
      return {
        ms,
        outcome: { ok: true, count: p.listings.length, ...(src.extraPage ? { emptyOk: true } : {}) },
        listings: p.listings,
        ...(p.truncated ? { truncated: p.truncated } : {}),
      };
    },
  );

  // Fiches et indices, encore avant la première écriture, finissent ENRICH_RESERVE_MS avant PART_TIMEOUT_MS. Sous
  // MIN_LOOKUP_TIMEOUT_MS, l'alerte part avec les données de la liste.
  const detailTimeout = Math.min(DETAIL_TIMEOUT_MS, started + PART_TIMEOUT_MS - ENRICH_RESERVE_MS - Date.now());
  const prepared = await Promise.all(
    sources.map(
      async (src, i): Promise<{ state: KnownState; listings: Listing[]; geo: Map<string, GeoHints> } | null> => {
        const { outcome, listings } = read[i];
        if (!outcome.ok || read[i].skipped) return null;
        try {
          const state = await loadKnown(env.DB, src, listings);
          // Un enrichissement en échec ne fait jamais échouer la source : on garde la liste.
          const enriched =
            detailTimeout >= MIN_LOOKUP_TIMEOUT_MS
              ? await enrichListings(src, listings, state, detailTimeout, cfg).catch((e: unknown) => {
                  console.error(`fiches ${src.id}:`, errMsg(e));
                  return listings;
                })
              : listings;
          // Indices géographiques après les fiches (adresse complétée) ; un échec laisse les annonces sans indice.
          const geoTimeout = Math.min(GEO_TIMEOUT_MS, started + PART_TIMEOUT_MS - ENRICH_RESERVE_MS - Date.now());
          const geo = await geoHintsFor(env, src, enriched, state, geoTimeout, cfg).catch((e: unknown) => {
            console.error(`indices ${src.id}:`, errMsg(e));
            return new Map<string, GeoHints>();
          });
          return { state, listings: enriched, geo };
        } catch (e) {
          console.error(`known ${src.id}:`, errMsg(e));
          return null;
        }
      },
    ),
  );

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const { ms } = read[i];
    let outcome = read[i].outcome;
    try {
      // Lecture non tentée (lecteur universel éteint, budget de neurons épuisé) : last_run avance sans succès ni échec, pour
      // qu'une source ne passe pas « en panne » faute de neurons.
      if (read[i].skipped) {
        await markRun(env.DB, src.id, now);
        result.sources.push({ id: src.id, ok: true, count: 0, ms, skipped: read[i].skipped });
        continue;
      }
      // L'état de santé n'est écrit qu'après le traitement : un traitement qui lève est un passage en échec.
      let processed = false;
      if (outcome.ok) {
        try {
          const p = prepared[i];
          if (!p) throw new Error("lecture D1 des annonces connues");
          // Prix de la liste, avant fiche : référence d'une future baisse de prix.
          const listPrices = new Map(read[i].listings.map((l): [string, number | null] => [l.id, l.price]));
          await processListings(env.DB, src, p.listings, now, p.state, listPrices, p.geo, cfg);
          processed = true;
        } catch (e) {
          console.error(`process ${src.id}:`, errMsg(e));
          outcome = { ok: false, reason: "erreur interne" };
        }
      }
      const ev = await recordOutcome(env.DB, src.id, outcome, now);
      if (ev) result.events.push(ev);
      if (processed) await markRun(env.DB, src.id, now);
      result.sources.push(
        outcome.ok
          ? {
              id: src.id,
              ok: true,
              count: outcome.count,
              ms,
              ...(read[i].truncated ? { truncated: true as const } : {}),
              ...read[i].uni,
            }
          : { id: src.id, ok: false, reason: outcome.reason, ms },
      );
    } catch (e) {
      console.error(`scan ${src.id}:`, errMsg(e));
      result.sources.push({ id: src.id, ok: false, reason: "erreur interne", ms });
    }
  }
  return result;
}

/** Sous-lot lancé dans une invocation séparée du Worker (POST /part signé, src/internal.ts), avec son propre budget CPU. */
export function selfRunner(env: Env, ctx?: { exports?: unknown }): PartRunner {
  return async (ids, now) => {
    const res = await postInternal(env, ctx, "/part", { ids, now: now.toISOString() });
    if (!res) throw new Error("aucun appel interne possible (ni SELF ni ctx.exports)");
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    const out = (await res.json()) as Partial<PartResult> | null;
    if (!out || !Array.isArray(out.sources) || !Array.isArray(out.events)) throw new Error("réponse invalide");
    return out as PartResult;
  };
}

/**
 * Sources d'un sous-lot perdu (ou non lancé) : chacune compte un passage en échec, sauf celles dont le passage est déjà
 * complet (last_run = now : l'invocation est morte après les avoir écrites), qui gardent leur état.
 */
async function failSources(
  env: Env,
  ids: string[],
  reason: string,
  now: Date,
  report: ScanReport,
  events: HealthEvent[],
): Promise<void> {
  let done = new Set<string>();
  try {
    const { results } = await env.DB.prepare(
      `SELECT source FROM source_state WHERE last_run = ? AND source IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(now.toISOString(), ...ids)
      .all<{ source: string }>();
    done = new Set(results.map((r) => r.source));
  } catch (e) {
    console.error("last_run:", errMsg(e));
  }
  for (const id of ids) {
    if (done.has(id)) {
      report.sources.push({ id, ok: true, ms: 0 });
      continue;
    }
    report.sources.push({ id, ok: false, reason, ms: 0 });
    try {
      const ev = await recordOutcome(env.DB, id, { ok: false, reason }, now);
      if (ev) events.push(ev);
    } catch (e) {
      console.error(`health ${id}:`, errMsg(e));
    }
  }
}

/**
 * Orchestrateur d'un passage : sous-lots de PART_SIZE lus par `runner` (une invocation /part par défaut), puis santé et
 * alertes. Plusieurs groupes (un par voie) : une chaîne de sous-lots par groupe, en parallèle, même échéance.
 */
export async function runScan(
  env: Env,
  group: number | number[],
  now: Date,
  runner: PartRunner = selfRunner(env),
  cfg: Settings = settings(),
): Promise<ScanReport> {
  // Les échéances partent de l'horloge réelle, pas de `now` : cet instant de données peut être en retard, et une échéance
  // calculée dessus serait déjà dépassée.
  const started = Date.now();
  const report: ScanReport = { sources: [], alertsSent: 0 };
  try {
    const chains = (Array.isArray(group) ? group : [group]).map((g) => groupParts(g, now, cfg));
    const parts = chains.flat();
    const events: HealthEvent[] = [];
    // Dans une chaîne, les sous-lots se suivent dans l'ordre du registre : chacun voit les annonces écrites par les précédents
    // (doublons). Le CPU de chaque sous-lot compte dans sa propre invocation ; attendre ne coûte rien ici.
    await Promise.all(
      chains.map(async (chain) => {
        for (const ids of chain) {
          if (Date.now() - started >= PASS_DEADLINE_MS) {
            console.error(`part ${ids.join(",")}: non lancé, ${PASS_TOO_LATE}`);
            await failSources(env, ids, PASS_TOO_LATE, now, report, events);
            continue;
          }
          let r: PartResult;
          try {
            r = await withTimeout(runner(ids, now), PART_TIMEOUT_MS);
          } catch (e) {
            console.error(`part ${ids.join(",")}:`, errMsg(e));
            // Sous-lot perdu : ses sources comptent un passage en échec.
            await failSources(env, ids, PART_FAILED, now, report, events);
            continue;
          }
          report.sources.push(...r.sources);
          events.push(...r.events);
        }
      }),
    );

    // Sources sans passage complet récent : invocations mortes avant d'écrire leur état.
    try {
      events.push(
        ...(await detectStale(
          env.DB,
          cfg.sources.cron.filter((s) => cfg.sources.readable.has(s.id)),
          now,
        )),
      );
    } catch (e) {
      console.error("stale:", errMsg(e));
    }

    try {
      // Sous-requêtes restantes : un appel par sous-lot, moins une marge.
      report.alertsSent = (
        await sendPendingAlerts(env, cfg.sources.all, now, SUBREQUEST_LIMIT - parts.length - SUBREQUEST_MARGIN)
      ).sent;
    } catch (e) {
      console.error("alerts:", errMsg(e));
    }
  } catch (e) {
    console.error("runScan:", errMsg(e));
  }
  return report;
}

import { GONE_WINDOW_DAYS } from "../config/scan";
import { errMsg } from "../guards";
import { attr, esc, safeUrl } from "../html";
import { rentText } from "../notify/format";
import { TRACKED_STATUSES } from "../store";
import type { SourceDef } from "../types";
import { DAY_MS } from "../time";
import { dimsText, payloadOf } from "./cards";
import { between, days, parisDateTime } from "./common";
import type { Row } from "./common";

/** Cluster entièrement disparu : dernière disparition, première détection, une ligne « déjà en ligne au lancement » ? */
export interface GoneCluster {
  cluster: string;
  gone: string;
  since: string;
  silent: number;
}
interface HeadRow extends Row {
  cluster: string;
}

/** Annonces de la section « Disparues récemment ». */
const GONE_SHOWN = 20;
/** Clusters disparus lus au plus pour les chiffres de tête (fenêtre de GONE_WINDOW_DAYS jours). */
const GONE_STATS_LIMIT = 1000;

/**
 * Clusters entièrement disparus depuis moins de GONE_WINDOW_DAYS, du plus récent au plus ancien : candidats par l'index
 * listings_gone, puis lignes de chaque cluster (le + sur alert_status écarte l'index des statuts).
 */
export async function goneClusters(db: D1Database, now: Date): Promise<GoneCluster[]> {
  const cutoff = new Date(now.getTime() - GONE_WINDOW_DAYS * DAY_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT cluster, MAX(gone_at) AS gone, MIN(first_seen) AS since, MAX(alert_status = 'silent') AS silent FROM listings
     WHERE cluster IN (SELECT cluster FROM listings WHERE gone_at > ?1) AND +alert_status IN ${TRACKED_STATUSES}
     GROUP BY cluster HAVING COUNT(gone_at) = COUNT(*)
     ORDER BY gone DESC, cluster LIMIT ${GONE_STATS_LIMIT}`,
    )
    .bind(cutoff)
    .all<GoneCluster>();
  return results;
}

/**
 * Médiane (jours) de la durée en ligne des clusters détectés après le lancement (une annonce déjà en ligne au lancement n'a
 * qu'une durée minimale) ; « – » sans données.
 */
export function medianText(gone: GoneCluster[]): string {
  const d = gone
    .filter((g) => !g.silent)
    .map((g) => between(g.since, g.gone))
    .sort((a, b) => a - b);
  if (!d.length) return "–";
  const m = d.length % 2 ? d[(d.length - 1) / 2] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2;
  return days(m);
}

/** Section repliée « Disparues récemment » : les GONE_SHOWN clusters disparus les plus récents, annonce de tête de chacun. */
export async function goneSection(
  db: D1Database,
  gone: GoneCluster[],
  sources: Map<string, SourceDef>,
): Promise<string> {
  const shown = gone.slice(0, GONE_SHOWN);
  const heads = new Map<string, HeadRow>();
  if (shown.length) {
    const { results } = await db
      .prepare(
        `SELECT source, listing_id, cluster, alert_status, alert_attempts, first_seen, payload FROM listings
       WHERE cluster IN (${shown.map(() => "?").join(",")}) AND +alert_status IN ('sent','pending','silent')`,
      )
      .bind(...shown.map((g) => g.cluster))
      .all<HeadRow>();
    for (const r of results) if (!heads.has(r.cluster)) heads.set(r.cluster, r);
  }
  const rows = shown
    .map((g) => {
      const r = heads.get(g.cluster);
      if (!r) return "";
      try {
        const p = payloadOf(r);
        if (!p) return "";
        const { listing: l, evaluation: ev } = p;
        const url = safeUrl(l.url);
        const what = [rentText(l, ev), dimsText(l)].filter(Boolean).join(" · ");
        const where = l.address ?? l.district;
        const agency = l.agency ?? sources.get(r.source)?.name ?? r.source;
        return (
          `<tr><td>${esc(parisDateTime(g.gone))}</td><td>${url ? `<a href="${attr(url)}" rel="noopener noreferrer" target="_blank">${esc(what)}</a>` : esc(what)}` +
          `${where ? `<div class="mute">${esc(where)}</div>` : ""}</td><td>${esc(agency)}</td>` +
          `<td>en ligne ${g.silent ? "≥ " : ""}${days(between(g.since, g.gone))}</td></tr>`
        );
      } catch (e) {
        console.error("dashboard: disparue ignorée", r.source, r.listing_id, errMsg(e));
        return "";
      }
    })
    .filter(Boolean);
  const body = rows.length
    ? `<div class="tw"><table><thead><tr><th>Plus vue le</th><th>Annonce</th><th>Agence</th><th>Durée</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` +
      '<p class="mute">« Plus vue sur la source » : retirée, louée, ou passée au-delà de la page lue, sur toutes les sources qui la montraient. « ≥ » : déjà en ligne au lancement.</p>'
    : `<p class="mute">Aucune annonce disparue sur les ${GONE_WINDOW_DAYS} derniers jours.</p>`;
  return `<details><summary>Disparues récemment (${rows.length})</summary>${body}</details>`;
}

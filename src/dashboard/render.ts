import { settings } from "../derive";
import { GONE_WINDOW_DAYS } from "../config/scan";
import { errMsg } from "../guards";
import { esc } from "../html";
import { NEIGHBORHOOD, ONLINE_SQL, isFiltered, orderBy, parseView, viewFilters } from "../listings-query";
import { loadMarket, marketSection } from "../market";
import type { Market } from "../market";
import { TRACKED_STATUSES } from "../store";
import type { FeedbackState } from "../telegram/callback";
import { feedbackMarkers } from "../telegram/feedback";
import type { SourceDef } from "../types";
import { card } from "./cards";
import { parisDateTime } from "./common";
import type { Row } from "./common";
import { AUTO_REFRESH_S, filterBar, searchForm, searchNote } from "./filters";
import type { SearchPanel } from "./filters";
import { goneClusters, goneSection, medianText } from "./gone";
import { candidatesSection, filteredSection, lastPassLine, leadSection, sourcesTable } from "./sections";
import type { StateRow } from "./sections";
import { CSS } from "./style";

/** Cartes affichées au plus (alertées d'abord, puis « silent »). */
const LISTING_LIMIT = 100;
/** Retours (boutons Telegram) lus au plus pour marquer les cartes : les plus récents. */
const FOLLOW_LIMIT = 500;
/** Sources lues au plus dans source_state. */
const STATES_LIMIT = 100;

/** Libellés des zones en une phrase : « Paris 17 et Levallois », « Lyon 3e, Lyon 6e et Villeurbanne » ; sans zone, un rappel. */
export const zonesText = (): string => {
  const l = settings().zones.map((z) => z.label);
  if (!l.length) return "Recherche à paramétrer";
  return l.length === 1 ? l[0] : `${l.slice(0, -1).join(", ")} et ${l[l.length - 1]}`;
};

/** `search` : recherche sémantique (champ et résultat de `?q=`) ; `opts.interactive` : marqueurs de retours et filtre « Suivi ». */
export async function renderDashboard(
  db: D1Database,
  sources: readonly SourceDef[],
  now: Date,
  params: URLSearchParams = new URLSearchParams(),
  search: SearchPanel | null = null,
  opts: { interactive?: boolean; mcpAddress?: string | null } = {},
): Promise<string> {
  const interactive = opts.interactive === true;
  const view = parseView(params);
  if (!interactive) view.suivi = null;
  if (search?.result?.status === "ok") view.q = search.result.query; // saisie validée seulement : les liens de filtres la conservent
  // Alertées d'abord, puis les « silent », chacune par first_seen DESC : deux requêtes bornées fusionnées puis tronquées à
  // LISTING_LIMIT. Un tri autre que « plus récentes » fait une seule requête sur les trois statuts.
  const filters = viewFilters(view, sources);
  const listingsSql = (statuses: string): string =>
    `SELECT r.source, r.listing_id, r.alert_status, r.alert_attempts, r.first_seen, r.payload,
       (SELECT MIN(c.first_seen) FROM listings c WHERE c.cluster = r.cluster AND +c.alert_status IN ${TRACKED_STATUSES}) AS since
     FROM (
       SELECT l.source, l.listing_id, l.cluster, l.alert_status, l.alert_attempts, l.first_seen, l.payload, l.rent_cc, l.surface FROM listings l
       WHERE l.alert_status IN (${statuses})
         AND ${ONLINE_SQL}${filters.sql}
       ORDER BY ${orderBy(view.tri, "l")} LIMIT ${LISTING_LIMIT}
     ) r
     ORDER BY ${orderBy(view.tri, "r")}`;
  const listingQuery = (statuses: string) =>
    db
      .prepare(listingsSql(statuses))
      .bind(...filters.binds)
      .all<Row>();
  // Agrégats de marché ; une lecture en échec ne donne aucun indice, jamais d'erreur.
  const marketP = loadMarket(db).catch((e): Market | null => {
    console.error("dashboard: marché ignoré", errMsg(e));
    return null;
  });
  // Retours des boutons Telegram ; une lecture en échec ne donne aucun marqueur.
  const marksP = interactive
    ? feedbackMarkers(db, FOLLOW_LIMIT).catch((): Map<string, FeedbackState> => new Map())
    : Promise.resolve(new Map<string, FeedbackState>());
  const [alerted, silent, stateRes, gone, market, marks] = await Promise.all([
    listingQuery(view.tri === "recentes" ? "'sent','pending'" : "'sent','pending','silent'"),
    view.tri === "recentes" ? listingQuery("'silent'") : Promise.resolve({ results: [] as Row[] }),
    db
      .prepare(
        `SELECT source, broken, initialized, last_ok, last_error, last_count, last_run FROM source_state LIMIT ${STATES_LIMIT}`,
      )
      .all<StateRow>(),
    goneClusters(db, now),
    marketP,
    marksP,
  ]);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const states = new Map(stateRes.results.map((r) => [r.source, r]));
  const names = new Map(sources.map((s) => [s.id, s.name]));
  // Recherche sémantique (?q=) : les résultats, rangés par similarité, remplacent la liste (mêmes cartes, mêmes filtres).
  const found = search?.result?.status === "ok" ? search.result.rows : null;
  const cards = (found ?? [...alerted.results, ...silent.results].slice(0, LISTING_LIMIT))
    .map((r) => {
      try {
        return card(
          r,
          byId,
          now,
          view.zone === NEIGHBORHOOD ? null : view.zone,
          market,
          marks.get(`${r.source}\u0000${r.listing_id}`) ?? null,
        );
      } catch (e) {
        console.error("dashboard: annonce ignorée", r.source, r.listing_id, errMsg(e));
        return "";
      }
    })
    .filter(Boolean);
  const emptyText =
    found !== null
      ? "Aucune annonce ne correspond à cette recherche."
      : isFiltered(view)
        ? "Aucune annonce ne correspond à ces filtres."
        : "Aucune annonce pour l’instant.";
  const listHtml = cards.length ? `<div class="grid">${cards.join("")}</div>` : `<p class="mute">${emptyText}</p>`;
  const lead = await leadSection(db, names);
  const goneHtml = await goneSection(db, gone, byId);
  const filteredHtml = await filteredSection(db);
  const candidatesHtml = await candidatesSection(db);
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${view.auto ? `<meta http-equiv="refresh" content="${AUTO_REFRESH_S}">\n` : ""}<title>RE-SEARCH · Dernières annonces</title>
<style>${CSS}</style></head><body><main>
<h1>Dernières annonces</h1>
<p class="sub">${esc(zonesText())} · mis à jour le ${esc(parisDateTime(now.toISOString()))}</p>
${lastPassLine(sources, states, now)}
<div class="kpis"><div class="kpi"><b>${gone.length}</b> disparues sur ${GONE_WINDOW_DAYS} jours</div><div class="kpi"><b>${medianText(gone)}</b> délai médian avant disparition</div></div>
${search ? searchForm(view, search.q) : ""}
${filterBar(view, interactive)}
${search?.result ? searchNote(search.result) : ""}
${listHtml}
${goneHtml}
${marketSection(market, now)}
<h2>Sources</h2>
${sourcesTable(sources, states, now)}
<h2>Avance par source</h2>
${lead}
<h2>Annonces écartées</h2>
${filteredHtml}
${candidatesHtml}
${opts.mcpAddress ? `<details class="mcp"><summary>Paramétrer avec un assistant IA</summary><p>Adresse du connecteur MCP, à ajouter dans votre assistant (connecteur personnalisé, sans authentification). Ne la partagez pas : elle permet de modifier la configuration.</p><code>${esc(opts.mcpAddress)}</code></details>` : ""}
</main></body></html>`;
}

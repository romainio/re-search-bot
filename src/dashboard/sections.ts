import { PROSPECT_DASHBOARD_LIMIT } from "../config/prospect";
import { settings } from "../derive";
import { errMsg } from "../guards";
import { staleMinutes } from "../health";
import { attr, esc, safeUrl } from "../html";
import { isActiveHour } from "../schedule";
import { getClusterStats } from "../store";
import type { SourceDef } from "../types";
import { MINUTE_MS } from "../time";
import { between, parisDateTime } from "./common";

/** État d'une source (table source_state). */
export interface StateRow {
  source: string;
  broken: number;
  initialized: number;
  last_ok: string | null;
  last_error: string | null;
  last_count: number | null;
  last_run: string | null;
}

/** Clusters les plus récents lus pour la section « avance » (borne la requête publique). */
const CLUSTER_WINDOW = 50;
/** Annonces vues par plusieurs sources montrées dans la section « avance ». */
const LEAD_SHOWN = 20;
/** Motifs d'écart lus au plus. */
const REASONS_SHOWN = 20;

export function sourcesTable(sources: readonly SourceDef[], states: Map<string, StateRow>, now: Date): string {
  const rows = sources.map((s) => {
    const st = states.get(s.id);
    let state: string;
    const late = staleMinutes(st?.last_run, now, s.every);
    if (!s.active) state = '<span class="mute">Désactivée</span>';
    // Source virtuelle (alertes par mail) : aucun passage attendu, donc ni « en retard » ni « en panne » ni « jamais lue ».
    else if (s.virtual) state = '<span class="mute">Par mail</span>';
    else if (late !== null)
      state = `<span class="bad">En retard</span> <span class="mute">(aucun passage depuis ${late} min)</span>`;
    else if (st?.broken)
      state = `<span class="bad">En panne</span> <span class="mute">(${esc(st.last_error ?? "motif inconnu")})</span>`;
    else if (st && (st.last_ok || st.initialized)) state = '<span class="ok">OK</span>';
    else state = '<span class="never">Jamais lue</span>';
    const count = st?.last_count != null ? String(st.last_count) : "–";
    return `<tr><td>${esc(s.name)}</td><td>${state}</td><td>${esc(count)}</td></tr>`;
  });
  return `<div class="tw"><table><thead><tr><th>Source</th><th>État</th><th>Annonces au dernier passage</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

const REASON_LABELS: Record<string, string> = {
  type: "Type de bien (parking, local, bureau…)",
  localisation: "Hors zones",
  surface: "Surface trop petite",
  prix_bas: "Loyer trop bas",
  prix_haut: "Loyer trop haut",
  inconnu: "Motif non enregistré",
};

/** Annonces écartées par motif (alert_kind des lignes filtrées ; NULL : motif non enregistré), plus nombreux d'abord. */
export async function filteredSection(db: D1Database): Promise<string> {
  const { results } = await db
    .prepare(
      "SELECT COALESCE(alert_kind, 'inconnu') AS kind, COUNT(*) AS n FROM listings WHERE alert_status = 'filtered' GROUP BY 1 ORDER BY n DESC, kind LIMIT ?",
    )
    .bind(REASONS_SHOWN)
    .all<{ kind: string; n: number }>();
  if (!results.length) return '<p class="mute">Aucune annonce écartée pour l’instant.</p>';
  const total = results.reduce((t, r) => t + r.n, 0);
  const rows = results.map((r) => `<tr><td>${esc(REASON_LABELS[r.kind] ?? r.kind)}</td><td>${r.n}</td></tr>`);
  return `<div class="tw"><table id="ecartees"><thead><tr><th>Motif d’écart</th><th>Annonces (${total})</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

/** Section « Agences candidates » : agences vues par les sources ouvertes, absentes du registre ; rien sans données. */
export async function candidatesSection(db: D1Database): Promise<string> {
  try {
    const { results } = await db
      .prepare(
        `SELECT name, address, website, phone, template, parser, rental, status, first_seen FROM agency_candidates WHERE status != 'ignore'
       ORDER BY (status = 'nouveau') DESC, (parser IS NOT NULL) DESC, (website IS NOT NULL) DESC, first_seen DESC, name LIMIT ?`,
      )
      .bind(PROSPECT_DASHBOARD_LIMIT)
      .all<{
        name: string;
        address: string | null;
        website: string | null;
        phone: string | null;
        template: string | null;
        parser: string | null;
        rental: string | null;
        status: string;
        first_seen: string;
      }>();
    if (!results.length) return "";
    const tpl = (r: { template: string | null; parser: string | null }): string =>
      r.template === "aucun_site"
        ? "pas de site"
        : r.template === "inconnu"
          ? "gabarit inconnu"
          : r.template
            ? `${r.template}${r.parser ? " (lecteur existant)" : ""}`
            : "à regarder";
    const rows = results.map((r) => {
      const url = safeUrl(r.website);
      const link = url
        ? `<a href="${attr(url)}" rel="noopener noreferrer">${esc(url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a>`
        : "";
      return `<tr><td>${r.status === "nouveau" ? "<strong>nouvelle</strong> " : ""}${esc(r.name)}<br><span class="mute">${esc(r.address ?? "")}</span></td><td>${esc(tpl(r))}${r.rental ? `<br><span class="mute">locations : ${esc(r.rental)}</span>` : ""}</td><td>${link}</td><td>${esc(r.phone ?? "")}</td></tr>`;
    });
    return `<h2>Agences candidates</h2>
<div class="tw"><table id="agences-candidates"><thead><tr><th>Agence</th><th>Gabarit</th><th>Site</th><th>Téléphone</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  } catch (e) {
    console.error("dashboard: agences candidates ignorées", errMsg(e));
    return "";
  }
}

export async function leadSection(db: D1Database, names: Map<string, string>): Promise<string> {
  const multi = (await getClusterStats(db, CLUSTER_WINDOW))
    .filter((c) => c.sources.length >= 2)
    .sort((a, b) => (b.sources[0]?.first_seen ?? "").localeCompare(a.sources[0]?.first_seen ?? ""))
    .slice(0, LEAD_SHOWN);
  if (!multi.length) return '<p class="mute">Aucune annonce vue par plusieurs sources pour l’instant.</p>';
  const name = (id: string): string => names.get(id) ?? id;
  const rows = multi.map((c) => {
    const first = c.sources[0]!;
    const t0 = new Date(first.first_seen).getTime();
    const others = c.sources
      .slice(1)
      .map((s) => {
        const min = Math.round((new Date(s.first_seen).getTime() - t0) / MINUTE_MS);
        return `${esc(name(s.source))} +${min} min`;
      })
      .join(", ");
    return `<tr><td>${esc(parisDateTime(first.first_seen))}</td><td><strong>${esc(name(c.fastest))}</strong></td><td>${others}</td></tr>`;
  });
  return `<div class="tw"><table><thead><tr><th>Détectée</th><th>Vue en premier par</th><th>Puis</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

/**
 * « Dernier passage : il y a N min » ; hors fenêtre, le prochain. En rouge seulement quand detectStale signalerait le retard,
 * jamais pour « aucun ».
 */
export function lastPassLine(sources: readonly SourceDef[], states: Map<string, StateRow>, now: Date): string {
  const window = settings().window;
  if (!isActiveHour(now, window))
    return `<p class="sub" id="dernier-passage">Prochain passage à ${window.startHour}h00</p>`;
  let last = "";
  for (const s of sources) {
    const r = s.active && !s.virtual ? states.get(s.id)?.last_run : null;
    if (r && r > last) last = r;
  }
  if (!last) return '<p class="sub" id="dernier-passage">Dernier passage : aucun</p>';
  const min = Math.max(0, Math.floor(between(last, now) / MINUTE_MS));
  return `<p class="sub${staleMinutes(last, now) !== null ? " bad" : ""}" id="dernier-passage">Dernier passage : il y a ${min} min</p>`;
}

import {
  MARKET_FAST_HOURS,
  MARKET_LIFETIME_HORIZON_DAYS,
  MARKET_MAX_ROOMS_BUCKET,
  MARKET_MIN_SAMPLE,
  MARKET_REFRESH_MINUTES,
  MARKET_SURFACE_RANGE,
  MARKET_TREND_DAYS,
  MARKET_TREND_FLAT,
  MARKET_WINDOW_DAYS,
} from "./config/market";
import { settings } from "./derive";
import type { Zone } from "./config/criteria";
import { decimal } from "./format";
import { esc } from "./html";
import { TRACKED_STATUSES } from "./store";
import type { Env, Evaluation, Listing } from "./types";
import { MINUTE_MS, DAY_MS } from "./time";

/**
 * Indicateurs de marché (des indices, jamais un filtre) : durée de vie et prix au m² médians par zone et tranche de pièces,
 * nouvelles annonces par jour. Tout se calcule en SQL (le Worker reçoit une vingtaine de lignes) dans trois petites tables,
 * seules lues par le tableau de bord, les alertes et le bilan.
 *
 * Seules comptent les annonces gardées et suivies (ni « filtered », ni « silent », dont first_seen n'est pas la mise en ligne),
 * un appartement une fois (cluster). Durée de vie : une annonce encore en ligne est censurée ; la compter courte ferait croire à
 * un marché rapide. Seule la cohorte détectée avant l'horizon compte, une annonce non disparue dans l'horizon valant « plus
 * longue » : sans moitié disparue, la médiane est NULL, jamais une durée courte fabriquée.
 */

/** Durée de vie sentinelle d'une annonce censurée : se range après toute durée réelle. */
const CENSORED = 1e9;

/** Tranche de pièces (« 4 » = 4 et plus) ; null si le nombre de pièces est inconnu ou nul (parking, local). */
export function roomsBucket(rooms: number | null | undefined): string | null {
  if (typeof rooms !== "number" || !(rooms >= 1)) return null;
  return String(Math.min(Math.round(rooms), MARKET_MAX_ROOMS_BUCKET));
}
export const ALL_BUCKET = "all";
const BUCKETS = ["1", "2", "3", String(MARKET_MAX_ROOMS_BUCKET)];
export const bucketLabel = (b: string): string => (b === String(MARKET_MAX_ROOMS_BUCKET) ? `${b} p. et +` : `${b} p.`);

export interface MarketCell {
  zone: string;
  bucket: string;
  lifeN: number;
  lifeMedianH: number | null;
  m2N: number;
  m2Median: number | null;
}
export interface Market {
  computedAt: string;
  cells: Map<string, MarketCell>;
  daily: Map<string, number>;
}
const cellKey = (zone: string, bucket: string): string => `${zone}|${bucket}`;

const BUCKET_SQL = `CASE WHEN l.rooms IS NULL OR l.rooms < 1 THEN NULL WHEN l.rooms >= ${MARKET_MAX_ROOMS_BUCKET} THEN '${MARKET_MAX_ROOMS_BUCKET}' ELSE CAST(l.rooms AS TEXT) END`;

/**
 * Médiane d'une colonne `v` par (zone, tranche) et par zone entière : moyenne des deux rangs centraux. Une sentinelle CENSORED
 * au centre donne une moyenne au-delà de CENSORED / 2 : médiane inconnue.
 */
const MEDIAN_SQL = `
  g AS (SELECT zone, bucket, v FROM src WHERE bucket IS NOT NULL UNION ALL SELECT zone, '${ALL_BUCKET}', v FROM src),
  r AS (SELECT zone, bucket, v, ROW_NUMBER() OVER (PARTITION BY zone, bucket ORDER BY v) AS rn,
               COUNT(*) OVER (PARTITION BY zone, bucket) AS n FROM g)
  SELECT zone, bucket, MAX(n) AS n, AVG(v) AS med FROM r WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY zone, bucket`;

/**
 * Durée de vie (heures) de la cohorte détectée entre ?1 et ?2. Un cluster n'est disparu que si toutes ses lignes suivies le
 * sont, à la date de la dernière. ?3 = horizon en heures, ?4 = zones (JSON).
 */
const LIFE_SQL = `
  WITH h AS (
    SELECT l.postal_code AS zone, ${BUCKET_SQL} AS bucket, l.first_seen,
      (SELECT CASE WHEN COUNT(c.gone_at) = COUNT(*) THEN MAX(c.gone_at) END FROM listings c
        WHERE c.cluster = l.cluster AND +c.alert_status IN ${TRACKED_STATUSES}) AS gone
    FROM listings l
    WHERE l.alert_status IN ('pending', 'sent') AND l.first_seen >= ?1 AND l.first_seen <= ?2
      AND l.postal_code IN (SELECT value FROM json_each(?4))
  ), src AS (
    SELECT zone, bucket, CASE WHEN gone IS NOT NULL AND (julianday(gone) - julianday(first_seen)) * 24 <= ?3
      THEN MAX(0, (julianday(gone) - julianday(first_seen)) * 24) ELSE ${CENSORED} END AS v FROM h
  ), ${MEDIAN_SQL}`;

/**
 * Prix au m² des annonces détectées depuis ?1, silent comprises (le stock d'une zone ajoutée renseigne le marché) ; surface
 * dans [?2, ?3] ; ?4 = zones (JSON).
 */
const M2_SQL = `
  WITH src AS (
    SELECT l.postal_code AS zone, ${BUCKET_SQL} AS bucket, l.rent_cc / l.surface AS v FROM listings l
    WHERE l.alert_status IN ('pending', 'sent', 'silent') AND l.first_seen >= ?1 AND l.rent_cc > 0
      AND l.surface >= ?2 AND l.surface <= ?3 AND l.postal_code IN (SELECT value FROM json_each(?4))
  ), ${MEDIAN_SQL}`;

type Agg = { zone: string; bucket: string; n: number; med: number };

/** Calcule les agrégats et les range dans les tables, en un seul lot d'écritures. */
async function recompute(db: D1Database, now: Date): Promise<void> {
  const since = new Date(now.getTime() - MARKET_WINDOW_DAYS * DAY_MS).toISOString();
  const cohortEnd = new Date(now.getTime() - MARKET_LIFETIME_HORIZON_DAYS * DAY_MS).toISOString();
  const zonesJson = settings().marketZonesJson;
  const [life, m2, daily] = await db.batch([
    db.prepare(LIFE_SQL).bind(since, cohortEnd, MARKET_LIFETIME_HORIZON_DAYS * 24, zonesJson),
    db.prepare(M2_SQL).bind(since, MARKET_SURFACE_RANGE[0], MARKET_SURFACE_RANGE[1], zonesJson),
    db
      .prepare(
        "SELECT substr(first_seen, 1, 10) AS day, COUNT(*) AS n FROM listings WHERE alert_status IN ('pending', 'sent') AND first_seen >= ? GROUP BY 1",
      )
      .bind(since),
  ]);
  const cells = new Map<string, MarketCell>();
  const cell = (zone: string, bucket: string): MarketCell => {
    let c = cells.get(cellKey(zone, bucket));
    if (!c) {
      c = { zone, bucket, lifeN: 0, lifeMedianH: null, m2N: 0, m2Median: null };
      cells.set(cellKey(zone, bucket), c);
    }
    return c;
  };
  for (const r of life.results as Agg[]) {
    const c = cell(r.zone, r.bucket);
    c.lifeN = r.n;
    c.lifeMedianH = r.med < CENSORED / 2 ? r.med : null;
  }
  for (const r of m2.results as Agg[]) {
    const c = cell(r.zone, r.bucket);
    c.m2N = r.n;
    c.m2Median = r.med;
  }
  const iso = now.toISOString();
  await db.batch([
    db.prepare("DELETE FROM market_stats"),
    db.prepare("DELETE FROM market_daily"),
    ...[...cells.values()].map((c) =>
      db
        .prepare(
          "INSERT INTO market_stats (zone, bucket, life_n, life_median_h, m2_n, m2_median) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(c.zone, c.bucket, c.lifeN, c.lifeMedianH, c.m2N, c.m2Median),
    ),
    ...(daily.results as { day: string; n: number }[]).map((d) =>
      db.prepare("INSERT INTO market_daily (day, n) VALUES (?, ?)").bind(d.day, d.n),
    ),
    db
      .prepare(
        "INSERT INTO market_meta (id, computed_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET computed_at = excluded.computed_at",
      )
      .bind(iso),
  ]);
}

/** Recalcule les agrégats s'ils ont plus de MARKET_REFRESH_MINUTES (appelé par le cron : le tableau de bord n'écrit jamais). */
export async function refreshMarketStats(db: D1Database, now: Date): Promise<"recalculé" | "à jour"> {
  const meta = await db.prepare("SELECT computed_at FROM market_meta WHERE id = 1").first<{ computed_at: string }>();
  const age = meta ? now.getTime() - Date.parse(meta.computed_at) : Infinity;
  if (age < MARKET_REFRESH_MINUTES * MINUTE_MS) return "à jour";
  await recompute(db, now);
  return "recalculé";
}

/** Agrégats enregistrés ; null avant le premier calcul. */
export async function loadMarket(db: D1Database): Promise<Market | null> {
  const [meta, stats, daily] = await db.batch([
    db.prepare("SELECT computed_at FROM market_meta WHERE id = 1"),
    db.prepare("SELECT zone, bucket, life_n, life_median_h, m2_n, m2_median FROM market_stats LIMIT 100"),
    db.prepare("SELECT day, n FROM market_daily ORDER BY day DESC LIMIT 100"),
  ]);
  const computedAt = (meta.results[0] as { computed_at?: string } | undefined)?.computed_at;
  if (!computedAt) return null;
  const cells = new Map<string, MarketCell>();
  for (const r of stats.results as {
    zone: string;
    bucket: string;
    life_n: number;
    life_median_h: number | null;
    m2_n: number;
    m2_median: number | null;
  }[]) {
    cells.set(cellKey(r.zone, r.bucket), {
      zone: r.zone,
      bucket: r.bucket,
      lifeN: r.life_n,
      lifeMedianH: r.life_median_h,
      m2N: r.m2_n,
      m2Median: r.m2_median,
    });
  }
  return {
    computedAt,
    cells,
    daily: new Map((daily.results as { day: string; n: number }[]).map((d) => [d.day, d.n])),
  };
}

/** Médiane de prix au m² d'une cellule, seulement si l'effectif atteint le minimum. */
export const m2Of = (c: MarketCell | undefined): number | null =>
  c && c.m2N >= MARKET_MIN_SAMPLE && c.m2Median !== null ? c.m2Median : null;
/** Durée de vie médiane (heures) d'une cellule, si l'effectif atteint le minimum ; null aussi au-delà de l'horizon. */
export const lifeOf = (c: MarketCell | undefined): number | null =>
  c && c.lifeN >= MARKET_MIN_SAMPLE && c.lifeMedianH !== null ? c.lifeMedianH : null;

export interface MarketHint {
  /** « −8 % vs médiane Paris 17 · 2 p. » ; null si aucune médiane de prix fiable. */
  gap: string | null;
  /** « part vite (médiane 2,1 j) » quand la catégorie disparaît vite ; null sinon. */
  fast: string | null;
}

const pct = (n: number): string => `${n < 0 ? "−" : "+"}${Math.abs(n)} %`;

/** Durée en jours (une décimale) ou en heures sous 48 h : « 2,1 j », « 30 h ». */
export function lifeText(hours: number): string {
  return hours < 48 ? `${Math.round(hours)} h` : `${decimal(hours / 24)} j`;
}

/**
 * Indices d'une annonce : écart de son prix au m² à la médiane de sa zone et de sa tranche (repli sur la zone entière sous
 * l'effectif minimum) et « part vite » si la durée de vie médiane est d'au plus MARKET_FAST_HOURS.
 */
export function marketHint(m: Market | null, l: Listing, ev: Evaluation, zone: Zone | null): MarketHint | null {
  if (!m || !zone) return null;
  const bucket = roomsBucket(l.rooms);
  const own = bucket ? m.cells.get(cellKey(zone.postalCode, bucket)) : undefined;
  const all = m.cells.get(cellKey(zone.postalCode, ALL_BUCKET));
  const rent = ev.rentCC ?? l.price;
  let gap: string | null = null;
  const priceCell = m2Of(own) !== null ? own : all;
  const median = m2Of(priceCell);
  if (median !== null && priceCell && typeof rent === "number" && typeof l.surface === "number" && l.surface > 0) {
    const label = priceCell.bucket === ALL_BUCKET ? zone.label : `${zone.label} · ${bucketLabel(priceCell.bucket)}`;
    const delta = Math.round((rent / l.surface / median - 1) * 100);
    gap = delta === 0 ? `≈ médiane ${label}` : `${pct(delta)} vs médiane ${label}`;
  }
  const lifeCell = lifeOf(own) !== null ? own : all;
  const life = lifeOf(lifeCell);
  const fast = life !== null && life <= MARKET_FAST_HOURS ? `part vite (médiane ${lifeText(life)})` : null;
  return gap || fast ? { gap, fast } : null;
}

/** Ligne de l'alerte (texte brut, échappé par formatTelegram). */
export const marketLine = (h: MarketHint | null): string | null =>
  h ? `📊 ${[h.gap, h.fast ? `⏱ ${h.fast}` : null].filter(Boolean).join(" · ")}` : null;

/** Interrupteur des alertes et du bilan ; le tableau de bord montre toujours le marché. */
export const marketHintsOn = (env: Env): boolean => env.MARKET_HINTS === "true";

/** Annonces nouvelles par jour sur les derniers jours UTC complets, zéros compris. */
export function dailySeries(m: Market, now: Date): { day: string; n: number }[] {
  const out: { day: string; n: number }[] = [];
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = MARKET_WINDOW_DAYS; i >= 1; i--) {
    const day = new Date(today - i * DAY_MS).toISOString().slice(0, 10);
    out.push({ day, n: m.daily.get(day) ?? 0 });
  }
  return out;
}

export interface Trend {
  recent: number;
  before: number;
  arrow: "↗" | "↘" | "→";
}

/** Moyennes par jour des MARKET_TREND_DAYS derniers jours complets et des précédents ; null sous l'effectif minimum. */
export function trendOf(series: { day: string; n: number }[]): Trend | null {
  const last = series.slice(-MARKET_TREND_DAYS);
  const prev = series.slice(-2 * MARKET_TREND_DAYS, -MARKET_TREND_DAYS);
  const sum = (a: { n: number }[]): number => a.reduce((t, d) => t + d.n, 0);
  if (last.length < MARKET_TREND_DAYS || prev.length < MARKET_TREND_DAYS || sum(last) + sum(prev) < MARKET_MIN_SAMPLE)
    return null;
  const recent = sum(last) / MARKET_TREND_DAYS,
    before = sum(prev) / MARKET_TREND_DAYS;
  const ratio = before === 0 ? Infinity : recent / before;
  return { recent, before, arrow: ratio > 1 + MARKET_TREND_FLAT ? "↗" : ratio < 1 - MARKET_TREND_FLAT ? "↘" : "→" };
}

/** Ligne de tendance du bilan du soir (HTML de Telegram échappé) ; null sans données suffisantes. */
export function trendLine(m: Market | null, now: Date): string | null {
  const t = m ? trendOf(dailySeries(m, now)) : null;
  return t
    ? esc(
        `📈 Nouvelles annonces : ${decimal(t.recent)}/jour sur ${MARKET_TREND_DAYS} j ${t.arrow} (${decimal(t.before)} les ${MARKET_TREND_DAYS} précédents)`,
      )
    : null;
}

const parisHm = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Section « Marché » du tableau de bord : tableau zone × tranche, nouvelles annonces par jour, méthode en une phrase. */
export function marketSection(m: Market | null, now: Date): string {
  const title = `<h2>Marché (${MARKET_WINDOW_DAYS} jours)</h2>`;
  if (!m) return `${title}<p class="mute">Indicateurs en cours de calcul (premier calcul dans l’heure).</p>`;
  const rows: string[] = [];
  for (const z of settings().zones) {
    for (const b of [ALL_BUCKET, ...BUCKETS]) {
      const c = m.cells.get(cellKey(z.postalCode, b));
      const life = lifeOf(c);
      const price = m2Of(c);
      const beyond = c && c.lifeN >= MARKET_MIN_SAMPLE && c.lifeMedianH === null;
      if (life === null && price === null && !beyond) continue;
      const n = (k: number): string => ` <span class="mute">(n=${k})</span>`;
      const lifeCell =
        life !== null
          ? `${lifeText(life)}${n(c!.lifeN)}`
          : beyond
            ? `&gt; ${MARKET_LIFETIME_HORIZON_DAYS} j${n(c!.lifeN)}`
            : "–";
      const fastMark = life !== null && life <= MARKET_FAST_HOURS ? ' <span class="badge">part vite</span>' : "";
      rows.push(
        `<tr><td>${esc(z.label)}</td><td>${b === ALL_BUCKET ? "toutes" : esc(bucketLabel(b))}</td><td>${lifeCell}${fastMark}</td>` +
          `<td>${price !== null ? `${esc(decimal(price))} €${n(c!.m2N)}` : "–"}</td></tr>`,
      );
    }
  }
  const series = dailySeries(m, now);
  const trend = trendOf(series);
  const max = Math.max(1, ...series.map((d) => d.n));
  const bars =
    `<div class="bars" role="img" aria-label="Nouvelles annonces par jour, ${MARKET_WINDOW_DAYS} derniers jours">` +
    series
      .map((d) => `<span style="height:${Math.round((d.n / max) * 100)}%" title="${esc(d.day)} : ${d.n}"></span>`)
      .join("") +
    "</div>";
  const table = rows.length
    ? `<div class="tw"><table id="marche"><thead><tr><th>Zone</th><th>Tranche</th><th>Durée de vie médiane</th><th>Loyer médian au m²</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`
    : `<p class="mute">Pas encore assez d’annonces (minimum ${MARKET_MIN_SAMPLE} par groupe) pour afficher des médianes.</p>`;
  const trendText = trend
    ? `<p>Nouvelles annonces : <b>${decimal(trend.recent)}</b> par jour sur ${MARKET_TREND_DAYS} jours ${trend.arrow} (${decimal(trend.before)} sur les ${MARKET_TREND_DAYS} précédents).</p>`
    : '<p class="mute">Tendance des nouvelles annonces : pas encore assez de données.</p>';
  const stamp = parisHm.format(new Date(m.computedAt));
  return (
    `${title}${table}${trendText}${bars}` +
    `<p class="mute">Annonces gardées, doublons comptés une fois. Durée de vie : annonces détectées entre ${MARKET_WINDOW_DAYS} et ${MARKET_LIFETIME_HORIZON_DAYS} jours, ` +
    `celles encore en ligne après ${MARKET_LIFETIME_HORIZON_DAYS} jours comptent « plus long », jamais court. Groupes de moins de ${MARKET_MIN_SAMPLE} annonces non affichés. Calculé le ${esc(stamp)}.</p>`
  );
}

/** Indice d'une carte du tableau de bord (HTML), vide sans indice. */
export function marketCardHtml(h: MarketHint | null): string {
  if (!h) return "";
  const parts = [h.gap ? esc(h.gap) : null, h.fast ? `<span class="fastmk">${esc(h.fast)}</span>` : null].filter(
    Boolean,
  );
  return `<div class="mkt">📊 ${parts.join(" · ")}</div>`;
}

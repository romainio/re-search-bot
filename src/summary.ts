import { settings } from "./derive";
import type { Settings } from "./derive";
import { loadMarket, marketHintsOn, trendLine } from "./market";
import { esc } from "./html";
import { sendTelegramMessage } from "./notify/send";
import { feedbackCounts } from "./telegram/feedback";
import { parisMinuteOfDay } from "./schedule";
import { TRACKED_STATUSES } from "./store";
import type { Env, SourceDef } from "./types";
import { errMsg } from "./guards";
import { MINUTE_MS } from "./time";

const parisDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Date de Paris, AAAA-MM-JJ : clé du garde-fou « une fois par jour ». */
export function parisDate(now: Date): string {
  return parisDay.format(now);
}

/**
 * Créneau du résumé du soir, heure de Paris : de summaryHour h summaryMinute à la fin de cette heure. Les crons de
 * wrangler.jsonc le couvrent l'été (cron de chaque minute) comme l'hiver (« 5-59 19 * * * »).
 */
export function isSummaryTime(now: Date, window: Settings["window"] = settings().window): boolean {
  const m = parisMinuteOfDay(now);
  return m >= window.summaryHour * 60 + window.summaryMinute && m < (window.summaryHour + 1) * 60;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`;

/** Bilan du jour (HTML de Telegram, échappé) en trois lectures bornées : alertes envoyées, clusters disparus, sources en panne. */
export async function buildDailySummary(
  db: D1Database,
  sources: readonly SourceDef[],
  now: Date,
  withMarket = false,
  withFeedback = false,
): Promise<string> {
  const dayStart = new Date(
    now.getTime() - parisMinuteOfDay(now) * MINUTE_MS - (now.getTime() % MINUTE_MS),
  ).toISOString();
  const [alerts, gone, broken] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM listings WHERE alert_status = 'sent' AND alerted_at >= ?")
      .bind(dayStart)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
         SELECT cluster FROM listings
         WHERE cluster IN (SELECT cluster FROM listings WHERE gone_at >= ?1) AND +alert_status IN ${TRACKED_STATUSES}
         GROUP BY cluster HAVING COUNT(gone_at) = COUNT(*) AND MAX(gone_at) >= ?1
       )`,
      )
      .bind(dayStart)
      .first<{ n: number }>(),
    db.prepare("SELECT source FROM source_state WHERE broken = 1 ORDER BY source LIMIT 100").all<{ source: string }>(),
  ]);
  const down = new Set(broken.results.map((r) => r.source));
  const names = sources.filter((s) => s.active && down.has(s.id)).map((s) => esc(s.name));
  // Tendance du marché (MARKET_HINTS) : une ligne de plus, sans effet sur erreur.
  let trend: string | null = null;
  if (withMarket) {
    try {
      trend = trendLine(await loadMarket(db), now);
    } catch {
      /* bilan sans tendance */
    }
  }
  // Retours du jour sur les boutons Telegram : une ligne seulement s'il y en a.
  let follow: string | null = null;
  if (withFeedback) {
    try {
      const c = await feedbackCounts(db, dayStart);
      const items = [
        c.aime ? `👍 ${c.aime}` : "",
        c.deteste ? `👎 ${c.deteste}` : "",
        c.appel ? `📞 ${plural(c.appel, "appelée", "appelées")}` : "",
        c.visite ? `🗓 ${plural(c.visite, "visite", "visites")}` : "",
      ].filter(Boolean);
      if (items.length) follow = `Suivi du jour : ${items.join(" · ")}`;
    } catch {
      /* bilan sans suivi */
    }
  }
  return (
    `<b>Bilan du jour</b> : ${plural(alerts?.n ?? 0, "alerte", "alertes")}, ` +
    `${plural(gone?.n ?? 0, "annonce disparue", "annonces disparues")}, ` +
    `sources en panne : ${names.length ? names.join(", ") : "aucune"}, prochain passage à ${settings().window.startHour}h00.` +
    (trend ? `\n${trend}` : "") +
    (follow ? `\n${follow}` : "")
  );
}

export type SummaryResult = "envoyé" | "déjà envoyé" | "échec";

/**
 * Résumé du soir, une fois par jour : la date est posée en D1 avant l'envoi. Refus de Telegram (4xx) : la ligne est retirée et
 * la minute suivante réessaie ; 5xx ou délai : le message a pu partir, la ligne reste (jamais deux résumés le même jour).
 */
export async function sendDailySummary(env: Env, sources: readonly SourceDef[], now: Date): Promise<SummaryResult> {
  const date = parisDate(now);
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO daily_summary (date, sent_at) VALUES (?, ?)")
    .bind(date, now.toISOString())
    .run();
  if (!claim.meta.changes) return "déjà envoyé";
  const release = () => env.DB.prepare("DELETE FROM daily_summary WHERE date = ?").bind(date).run();
  let text: string;
  try {
    text = await buildDailySummary(env.DB, sources, now, marketHintsOn(env), env.TELEGRAM_INTERACTIVE === "true");
  } catch (e) {
    console.error("résumé du soir:", errMsg(e));
    await release();
    return "échec";
  }
  const res = await sendTelegramMessage(env, text);
  if (res?.ok) return "envoyé";
  if (res && res.status >= 400 && res.status < 500) await release();
  return "échec";
}

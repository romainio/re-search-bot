import { ALERT_BUDGET } from "../config/scan";
import type { HealthEvent } from "../health";
import { getPendingAlerts, markAlertSent } from "../process";
import { recordAlertRejected } from "../store";
import type { Env, SourceDef } from "../types";
import { analyzePhoto, photoImages, photoScoringOn } from "./photo";
import type { PhotoAnalysis } from "./photo";
import { loadMarket, marketHint, marketHintsOn, marketLine } from "../market";
import type { Market } from "../market";
import { zoneOf } from "../filter";
import { esc } from "../html";
import { formatHealth, formatTelegram, formatWhatsApp } from "./format";
import { feedbackRow } from "../telegram/callback";
import { chatId } from "../telegram/chat";
import { loadProfile, profileCriteria, profileLine } from "../telegram/profile";
import type { Profile } from "../telegram/profile";
import { USER_AGENT } from "../config/fetch";
import { SUBREQUEST_LIMIT } from "../config/scan";
import { TELEGRAM_API_TIMEOUT_MS, WHATSAPP_TIMEOUT_MS } from "../config/telegram";

const api = (env: Env, method: string): string => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

/** POST JSON vers Telegram ; compte la sous-requête dans `used`. */
async function tg(env: Env, method: string, body: unknown, used: { n: number }): Promise<Response | null> {
  used.n++;
  try {
    return await fetch(api(env, method), {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/** Envoie les alertes en attente ; `calls` = sous-requêtes consommées, `sent` = alertes réellement marquées envoyées. */
export async function sendPendingAlerts(
  env: Env,
  sources: readonly SourceDef[],
  now: Date,
  budget: number = SUBREQUEST_LIMIT,
): Promise<{ calls: number; sent: number }> {
  const used = { n: 0 };
  const waOn = env.WHATSAPP_ENABLED === "true" && !!env.CALLMEBOT_PHONE && !!env.CALLMEBOT_APIKEY;
  const photoOn = photoScoringOn(env);
  const worstCase = 2 + (waOn ? 1 : 0);
  let sent = 0;
  if (budget < worstCase) return { calls: 0, sent };
  // Aucune conversation liée : les alertes restent en attente.
  const chat = await chatId(env);
  if (!chat) return { calls: 0, sent };
  const alerts = await getPendingAlerts(env.DB, ALERT_BUDGET);
  // Indice de marché : agrégats lus une fois par envoi (D1, aucune sous-requête externe).
  let market: Market | null = null;
  if (marketHintsOn(env) && alerts.length) {
    try {
      market = await loadMarket(env.DB);
    } catch {
      /* alertes sans indice */
    }
  }
  // Telegram interactif : profil lu une fois par envoi (D1).
  const interactive = env.TELEGRAM_INTERACTIVE === "true";
  let profile: Profile | null = null;
  if (interactive && alerts.length) {
    try {
      profile = (await loadProfile(env.DB))?.profile ?? null;
    } catch {
      /* alertes sans profil */
    }
  }
  const criteria = profile ? profileCriteria(profile) : undefined;
  for (const a of alerts) {
    if (used.n + worstCase > budget) break;
    const src = sources.find((s) => s.id === a.source);
    // Analyse des photos : un appel par alerte envoyée, compté dans les sous-requêtes (réservées pour le pire cas). Tout échec
    // laisse partir l'alerte sans bloc photo.
    let photo: PhotoAnalysis | null = null;
    if (photoOn && photoImages(a.listing).length && used.n + 1 + worstCase <= budget) {
      used.n++;
      photo = await analyzePhoto(env, a.listing, criteria);
    }
    const mline = market ? marketLine(marketHint(market, a.listing, a.evaluation, zoneOf(a.listing, src))) : null;
    const { caption, buttonUrl } = formatTelegram(
      a,
      src,
      photo,
      mline,
      profile ? { criteria, line: profileLine(profile, photo, a) } : undefined,
    );
    // Boutons de retour sous « Voir l'annonce » : un clavier ne coûte aucune sous-requête.
    const inline_keyboard: { text: string; url?: string; callback_data?: string }[][] = [
      [{ text: "Voir l'annonce", url: buttonUrl }],
    ];
    if (interactive && a.rowid != null) inline_keyboard.push(feedbackRow(a.rowid));
    const reply_markup = { inline_keyboard };
    const message = {
      chat_id: chat,
      text: caption,
      parse_mode: "HTML",
      reply_markup,
      link_preview_options: { is_disabled: true },
    };

    let res: Response | null = null;
    if (a.listing.photo) {
      res = await tg(
        env,
        "sendPhoto",
        { chat_id: chat, photo: a.listing.photo, caption, parse_mode: "HTML", reply_markup },
        used,
      );
      if (res && res.status === 400) res = await tg(env, "sendMessage", message, used);
    } else {
      res = await tg(env, "sendMessage", message, used);
    }
    if (!res?.ok) {
      // 400 = message refusé tel quel (rejouer ne changera rien) ; 5xx, 429 et réseau restent transitoires.
      if (res && res.status === 400) {
        try {
          await recordAlertRejected(env.DB, a.source, a.id);
        } catch {
          /* retentée au passage suivant */
        }
      }
      continue;
    }
    try {
      await markAlertSent(env.DB, a.source, a.id, now, photo);
      sent++;
    } catch {
      continue; // reste pending, la boucle continue
    }

    if (waOn) {
      used.n++;
      try {
        const q = new URLSearchParams({
          phone: env.CALLMEBOT_PHONE!,
          text: formatWhatsApp(a, src),
          apikey: env.CALLMEBOT_APIKEY!,
        });
        await fetch(`https://api.callmebot.com/whatsapp.php?${q}`, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(WHATSAPP_TIMEOUT_MS),
        });
      } catch {
        /* sans effet sur l'état de l'alerte */
      }
    }
  }
  return { calls: used.n, sent };
}

/** Message texte (HTML de Telegram, déjà échappé) : la réponse de Telegram, ou null sur erreur réseau ou délai. */
export async function sendTelegramMessage(env: Env, html: string): Promise<Response | null> {
  const chat = await chatId(env);
  if (!chat) return null;
  return tg(
    env,
    "sendMessage",
    { chat_id: chat, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    { n: 0 },
  );
}

export async function sendHealthEvents(
  env: Env,
  events: HealthEvent[],
  sources: readonly SourceDef[],
): Promise<{ calls: number; delivered: HealthEvent[] }> {
  const used = { n: 0 };
  const delivered: HealthEvent[] = [];
  const chat = await chatId(env);
  if (!chat) return { calls: 0, delivered };
  for (const e of events) {
    const name = sources.find((s) => s.id === e.sourceId)?.name ?? e.sourceId;
    const res = await tg(
      env,
      "sendMessage",
      { chat_id: chat, text: esc(formatHealth(e, name)), parse_mode: "HTML" },
      used,
    );
    if (res?.ok) delivered.push(e);
  }
  return { calls: used.n, delivered };
}

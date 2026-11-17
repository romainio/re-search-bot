import { USER_AGENT } from "../config/fetch";
import { TELEGRAM_API_TIMEOUT_MS } from "../config/telegram";
import type { Env } from "../types";
import { chatId } from "./chat";

/** Appel de l'API Bot de Telegram (JSON). Réponse de Telegram, ou null sur erreur réseau ou délai : jamais d'exception. */
export async function telegramCall(env: Env, method: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/** Réponse de Telegram lue en JSON ({ ok, result, description }) ; un échec réseau ou un corps illisible donnent { ok: false }. */
export async function telegramJson(
  env: Env,
  method: string,
  body: unknown,
): Promise<{ ok: boolean; [k: string]: unknown }> {
  const res = await telegramCall(env, method, body);
  if (!res) return { ok: false, description: "pas de réponse de Telegram" };
  try {
    return (await res.json()) as { ok: boolean };
  } catch {
    return { ok: false, description: `réponse illisible (HTTP ${res.status})` };
  }
}

/** Message HTML (déjà échappé) dans le chat autorisé (rien si aucune conversation n'est liée). */
export const sendReply = async (env: Env, html: string): Promise<Response | null> => {
  const chat = await chatId(env);
  return chat
    ? telegramCall(env, "sendMessage", {
        chat_id: chat,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      })
    : null;
};

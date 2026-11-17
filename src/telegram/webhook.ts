import { TELEGRAM_ALLOWED_UPDATES, TELEGRAM_COMMANDS, TELEGRAM_MAX_BODY } from "../config/telegram";
import type { Env } from "../types";
import { adminAuthorized } from "../access";
import { authorized } from "../crypto";
import { telegramCall, telegramJson } from "./api";
import { chatId, ensureLinkCode, tryLink, webhookSecret } from "./chat";
import { handleUpdate } from "./router";
import type { TelegramUpdate } from "./router";
import { errMsg } from "../guards";
import { json, notFound } from "../http";

// Routes Telegram : POST /telegram (webhook) et GET /telegram/setup ; éteintes, 404.

export const interactiveOn = (env: Env): boolean => env.TELEGRAM_INTERACTIVE === "true";

/** Secret accepté par Telegram (setWebhook secret_token) : 1 à 256 caractères parmi A-Z a-z 0-9 _ -. */
export const validSecret = (s: string | undefined): s is string => !!s && /^[A-Za-z0-9_-]{1,256}$/.test(s);

/** Chat d'un update (message ou clic) : seule la conversation liée (chatId) est écoutée. */
const chatOf = (u: TelegramUpdate): string | null => {
  const id = u.callback_query ? u.callback_query.message?.chat?.id : u.message?.chat?.id;
  return typeof id === "number" || typeof id === "string" ? String(id) : null;
};

/** Liaison de la conversation par /start <code> : confirmation dans le chat qui vient d'être lié. Jamais d'exception. */
async function linkChat(env: Env, text: string, chat: number | string | undefined): Promise<void> {
  if (chat === undefined || !(await tryLink(env, text, chat))) return;
  await telegramCall(env, "sendMessage", {
    chat_id: chat,
    text: "Conversation liée : les alertes arriveront ici. /aide pour la liste des commandes.",
  });
}

/**
 * POST /telegram : secret (403, temps constant), taille (413), JSON (400), puis 200 immédiat pour tout update valide (Telegram
 * rejoue sinon), le traitement partant en `ctx.waitUntil`. Un autre chat est ignoré en silence ; sans conversation liée, seul
 * un « /start <code> » exact est traité.
 */
export async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!authorized(request.headers.get("x-telegram-bot-api-secret-token"), (await webhookSecret(env)) ?? undefined))
    return json({ error: "forbidden" }, 403);
  if (Number(request.headers.get("content-length") ?? 0) > TELEGRAM_MAX_BODY)
    return json({ error: "corps trop long" }, 413);
  const raw = await request.text();
  if (raw.length > TELEGRAM_MAX_BODY) return json({ error: "corps trop long" }, 413);
  let update: TelegramUpdate;
  try {
    update = JSON.parse(raw) as TelegramUpdate;
  } catch {
    return json({ error: "corps invalide" }, 400);
  }
  if (!update || typeof update !== "object" || Array.isArray(update)) return json({ error: "corps invalide" }, 400);
  const bound = await chatId(env);
  if (bound) {
    if (chatOf(update) === bound) ctx.waitUntil(handleUpdate(env, update));
  } else {
    const m = update.message;
    if (m && typeof m.text === "string") ctx.waitUntil(linkChat(env, m.text, m.chat?.id));
  }
  return json({ ok: true });
}

/**
 * GET /telegram/setup (clé d'administration) : installe le webhook (URL déduite de la requête, secret) et les commandes. Ni le
 * jeton ni le secret ne sortent du Worker ; sans conversation liée, rend aussi `link`, le code à envoyer au bot.
 */
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  if (!adminAuthorized(request, env)) return json({ error: "forbidden" }, 403);
  const r = await setupTelegram(env, new URL(request.url).origin);
  return json(r.body, r.status);
}

/** Installation du webhook et code de liaison (route /telegram/setup et outil MCP lier_telegram) : l'appelant est déjà authentifié. */
export async function setupTelegram(
  env: Env,
  origin: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const json = (body: Record<string, unknown>, status = 200) => ({ status, body });
  // Secret explicite : doit être valide pour Telegram ; dérivé, il l'est toujours (64 caractères hexadécimaux).
  const secret = await webhookSecret(env);
  if (!validSecret(secret ?? undefined)) {
    return json(
      {
        error: env.TELEGRAM_WEBHOOK_SECRET
          ? "TELEGRAM_WEBHOOK_SECRET invalide (1 à 256 caractères : lettres, chiffres, _ et -)"
          : "ADMIN_KEY absent : secret du webhook impossible à dériver",
      },
      400,
    );
  }
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "TELEGRAM_BOT_TOKEN absent" }, 400);
  const webhookUrl = `${origin}/telegram`;
  const [webhook, commands] = await Promise.all([
    telegramJson(env, "setWebhook", {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
    }),
    telegramJson(env, "setMyCommands", { commands: TELEGRAM_COMMANDS }),
  ]);
  let link: { code: string; instruction: string } | undefined;
  if (!(await chatId(env))) {
    try {
      const code = await ensureLinkCode(env.DB);
      link = { code, instruction: `Envoyez /start ${code} à votre bot Telegram pour lier cette conversation` };
    } catch (e) {
      console.error("code de liaison:", errMsg(e));
    }
  }
  return json(
    { url: webhookUrl, setWebhook: webhook, setMyCommands: commands, ...(link ? { link } : {}) },
    webhook.ok && commands.ok ? 200 : 502,
  );
}

/** Routes Telegram : null si le chemin n'en est pas une, sinon la réponse. */
export async function telegramRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== "/telegram" && pathname !== "/telegram/setup") return null;
  if (!interactiveOn(env)) return notFound();
  if (pathname === "/telegram") return request.method === "POST" ? handleWebhook(request, env, ctx) : notFound();
  return request.method === "GET" ? handleSetup(request, env) : notFound();
}

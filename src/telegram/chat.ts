import { deleteSettingIf, getSetting, setSetting } from "../settings";
import type { Env } from "../types";
import { authorized, hmacHex } from "../crypto";

// Conversation Telegram et secret du webhook sans configuration : sans TELEGRAM_CHAT_ID, la conversation est celle liée en D1 ;
// sans TELEGRAM_WEBHOOK_SECRET, le secret est dérivé d'ADMIN_KEY (HMAC-SHA256). Toute lecture du chat passe par chatId(env).

export const CHAT_KEY = "telegram_chat_id";
export const LINK_CODE_KEY = "telegram_link_code";
/** Alphabet du code de liaison : 31 caractères sans ambiguïté (ni 0/O ni 1/I/L), tirés avec rejet pour rester uniformes. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LINK_CODE_LENGTH = 8;

/** Conversation autorisée : le secret TELEGRAM_CHAT_ID s'il existe (prioritaire), sinon celle liée en D1, sinon null (rien n'est envoyé). */
export async function chatId(env: Pick<Env, "DB" | "TELEGRAM_CHAT_ID">): Promise<string | null> {
  const fromEnv = env.TELEGRAM_CHAT_ID;
  if (fromEnv !== undefined && fromEnv !== null && String(fromEnv) !== "") return String(fromEnv);
  return getSetting(env.DB, CHAT_KEY);
}

/** Secret attendu dans l'en-tête du webhook : TELEGRAM_WEBHOOK_SECRET, sinon HMAC-SHA256(ADMIN_KEY, « re-search:telegram-webhook »). */
export async function webhookSecret(env: Pick<Env, "ADMIN_KEY" | "TELEGRAM_WEBHOOK_SECRET">): Promise<string | null> {
  if (env.TELEGRAM_WEBHOOK_SECRET) return env.TELEGRAM_WEBHOOK_SECRET;
  if (!env.ADMIN_KEY) return null;
  return hmacHex(env.ADMIN_KEY, "re-search:telegram-webhook");
}

/** Code aléatoire de `length` caractères de CODE_ALPHABET, par tirage cryptographique avec rejet (uniforme). */
export function randomCode(length: number): string {
  const limit = 256 - (256 % CODE_ALPHABET.length); // 248 : plus grand multiple de 31 sous 256
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

/** Code de liaison en attente, créé au besoin (tirage cryptographique), stable tant qu'il n'est pas consommé. */
export async function ensureLinkCode(db: D1Database, now: Date = new Date()): Promise<string> {
  const existing = await getSetting(db, LINK_CODE_KEY);
  if (existing) return existing;
  const code = randomCode(LINK_CODE_LENGTH);
  await setSetting(db, LINK_CODE_KEY, code, now);
  return code;
}

/**
 * Premier `/start <code>` exact reçu quand aucune conversation n'est liée : fixe la conversation en D1 et efface le code (usage unique,
 * l'effacement conditionnel départage deux messages simultanés). Vrai si la liaison vient d'être faite.
 */
export async function tryLink(
  env: Pick<Env, "DB">,
  text: string,
  chat: number | string,
  now: Date = new Date(),
): Promise<boolean> {
  const m = /^\/start(?:@[A-Za-z0-9_]+)?\s+(\S+)\s*$/.exec(text.trim());
  if (!m) return false;
  try {
    const code = await getSetting(env.DB, LINK_CODE_KEY);
    if (!code || !authorized(m[1]!, code)) return false;
    if (!(await deleteSettingIf(env.DB, LINK_CODE_KEY, code))) return false;
    await setSetting(env.DB, CHAT_KEY, String(chat), now);
    return true;
  } catch {
    return false;
  }
}

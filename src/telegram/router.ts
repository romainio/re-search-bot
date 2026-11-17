import { FEEDBACK_ACTIVE_MARK, PROFILE_TEXT_MAX } from "../config/telegram";
import type { Env } from "../types";
import { sendReply, telegramCall } from "./api";
import { handleFreeMessage } from "./assistant";
import { decodeCallback, feedbackRow, isFeedbackRow } from "./callback";
import type { InlineButton, Keyboard } from "./callback";
import { applyClick, listingByRowid } from "./feedback";
import { clearProfile, generateProfile, loadProfile, renderProfile, saveProfile } from "./profile";
import { errMsg } from "../guards";

// Aiguillage d'un update déjà authentifié : bouton -> retour sur une annonce ; /profil, /aide, /start ; tout autre texte ->
// crochet de l'assistant, sinon l'aide. Aucune de ces actions ne filtre ni ne masque une alerte.

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  chat: { id: number | string };
}
export interface TelegramCallback {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number | string }; reply_markup?: { inline_keyboard?: unknown } };
}
export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallback;
}

export const HELP = [
  "<b>RE-SEARCH</b>",
  "/profil &lt;texte libre&gt; : décris ta recherche (« baignoire indispensable, pas de moquette, métro à 5 min, étage 3 minimum »)",
  "/profil : voir ton profil · /profil effacer : le retirer",
  "Sous chaque alerte : 👍 👎 📞 appelée 🗓 visite, enregistrés sur le tableau de bord. Rien n'est jamais filtré.",
].join("\n");

/** « /profil@MonBot  texte » -> { command: "profil", args: "texte" } ; null si le texte n'est pas une commande. */
export function parseCommand(text: string): { command: string; args: string } | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { command: m[1]!.toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

const reply =
  (env: Env) =>
  async (html: string): Promise<void> => {
    await sendReply(env, html);
  };

/** Traite un update authentifié ; ne lève jamais (erreur journalisée sans contenu). `freeMessage` : injectable pour les tests. */
export async function handleUpdate(
  env: Env,
  update: TelegramUpdate,
  now: Date = new Date(),
  freeMessage: typeof handleFreeMessage = handleFreeMessage,
): Promise<void> {
  try {
    if (update.callback_query) return await onCallback(env, update.callback_query, now);
    const msg = update.message;
    if (!msg || typeof msg.text !== "string" || !msg.text.trim()) return;
    const cmd = parseCommand(msg.text);
    if (cmd?.command === "profil") return await onProfile(env, cmd.args, now);
    if (cmd?.command === "aide" || cmd?.command === "start") return void (await sendReply(env, HELP));
    // Autre message (ou commande inconnue) : crochet de l'assistant ; sinon l'aide.
    const handled = await freeMessage(
      env,
      { chatId: String(msg.chat.id), text: msg.text, messageId: msg.message_id, date: msg.date },
      reply(env),
    );
    if (!handled) await sendReply(env, HELP);
  } catch (e) {
    console.error("telegram:", errMsg(e));
  }
}

/** Mots qui retirent le profil : « /profil effacer ». */
const CLEAR_WORDS = ["effacer", "supprimer", "reset"];

async function onProfile(env: Env, args: string, now: Date): Promise<void> {
  if (!args) {
    const stored = await loadProfile(env.DB);
    await sendReply(
      env,
      stored
        ? renderProfile(stored)
        : "Aucun profil. Décris ta recherche : <code>/profil baignoire indispensable, pas de moquette, métro à 5 min</code>",
    );
    return;
  }
  if (CLEAR_WORDS.includes(args.toLowerCase())) {
    await sendReply(
      env,
      (await clearProfile(env.DB))
        ? "Profil effacé : les alertes retrouvent la grille par défaut."
        : "Aucun profil à effacer.",
    );
    return;
  }
  if (args.length > PROFILE_TEXT_MAX) {
    await sendReply(env, `Texte trop long (${PROFILE_TEXT_MAX} caractères au plus).`);
    return;
  }
  const profile = await generateProfile(env, args);
  if (!profile) {
    await sendReply(
      env,
      "Je n'ai pas pu en tirer un profil (IA indisponible, budget du jour atteint, ou réponse inexploitable). Reformule ou réessaie plus tard.",
    );
    return;
  }
  await saveProfile(env.DB, args, profile, now);
  const stored = await loadProfile(env.DB);
  await sendReply(env, stored ? `Profil enregistré.\n${renderProfile(stored)}` : "Profil enregistré.");
}

/** Boutons du message cliqué, rangées non vides seulement (forme défensive : vient de Telegram). */
function keyboardOf(cb: TelegramCallback): Keyboard {
  const raw = cb.message?.reply_markup?.inline_keyboard;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(Array.isArray)
    .map((row) =>
      (row as unknown[]).filter(
        (b): b is InlineButton => !!b && typeof b === "object" && typeof (b as InlineButton).text === "string",
      ),
    )
    .filter((row) => row.length);
}

const toast = (env: Env, id: string, text: string) =>
  telegramCall(env, "answerCallbackQuery", { callback_query_id: id, text, cache_time: 0 });

async function onCallback(env: Env, cb: TelegramCallback, now: Date): Promise<void> {
  const decoded = decodeCallback(cb.data);
  if (!decoded) {
    await toast(env, cb.id, "Bouton inconnu");
    return;
  }
  const rows = keyboardOf(cb);
  const listing = await listingByRowid(env.DB, decoded.rowid);
  // Le rowid vient de callback_data : revérifié contre le bouton « Voir l'annonce » du même message.
  const shownUrl = rows.flat().find((b) => typeof b.url === "string")?.url;
  if (!listing || (shownUrl && listing.url !== shownUrl)) {
    await toast(env, cb.id, "Annonce introuvable");
    return;
  }
  const { state, on } = await applyClick(env.DB, listing.source, listing.listing_id, decoded.button, now);
  const label = [decoded.button.emoji, decoded.button.toast].join(" ");
  const keyboard: Keyboard = [...rows.filter((r) => !isFeedbackRow(r))];
  if (!keyboard.length && listing.url) keyboard.push([{ text: "Voir l'annonce", url: listing.url }]);
  keyboard.push(feedbackRow(decoded.rowid, state));
  const chat = cb.message?.chat.id;
  await Promise.all([
    toast(env, cb.id, on ? `${label} ${FEEDBACK_ACTIVE_MARK}` : `${label} retiré`),
    cb.message
      ? telegramCall(env, "editMessageReplyMarkup", {
          chat_id: chat,
          message_id: cb.message.message_id,
          reply_markup: { inline_keyboard: keyboard },
        })
      : null,
  ]);
}

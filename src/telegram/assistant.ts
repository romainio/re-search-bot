import { answerQuestion } from "../assistant/chat";
import type { Env } from "../types";
import { errMsg } from "../guards";

// Crochet de l'assistant : le routeur appelle `handleFreeMessage` pour tout message du chat autorisé qui n'est ni une commande
// connue ni un bouton. `reply(html)` répond dans le chat (HTML échappé avec `esc`) ; rendre false laisse le routeur répondre
// l'aide ; ne jamais lever. Le webhook partage l'invocation (10 ms de CPU) : tout appel modèle passe par src/ai/.

export interface FreeMessage {
  chatId: string;
  text: string;
  messageId: number;
  /** Horodatage Unix (secondes) du message selon Telegram. */
  date: number;
}
export type Reply = (html: string) => Promise<void>;

/** Assistant conversationnel ; éteint ou sans binding AI : false (le routeur répond l'aide), comme pour une commande inconnue. */
export async function handleFreeMessage(env: Env, msg: FreeMessage, reply: Reply): Promise<boolean> {
  if (env.ASSISTANT_ENABLED !== "true" || !env.AI) return false;
  const text = msg.text.trim();
  if (!text || text.startsWith("/")) return false;
  try {
    await reply(await answerQuestion(env, text));
  } catch (e) {
    console.error("assistant:", errMsg(e));
    await reply("Je n'ai pas pu traiter cette question pour l'instant.").catch(() => undefined);
  }
  return true;
}

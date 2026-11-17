import { FEEDBACK_ACTIVE_MARK, FEEDBACK_BUTTONS } from "../config/telegram";
import type { FeedbackButton } from "../config/telegram";

// Boutons de retour sous une alerte. callback_data = « f:<code>:<rowid> », moins de 20 octets (limite 64), rien de sensible.
// Le rowid est revérifié au clic contre l'URL « Voir l'annonce » du message : un retour n'est jamais rattaché à la mauvaise annonce.

export const CALLBACK_MAX_BYTES = 64;
const PATTERN = /^f:([a-z]):(\d{1,12})$/;

export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}
export type Keyboard = InlineButton[][];

/** Retours déjà posés sur une annonce : `type` -> `value` (ex. { avis: "aime", appel: "oui" }). */
export type FeedbackState = Record<string, string>;

export const encodeCallback = (button: FeedbackButton, rowid: number): string => `f:${button.code}:${rowid}`;

/** Bouton et rowid d'un callback_data, ou null (forme inconnue, code inconnu, rowid hors des entiers sûrs). */
export function decodeCallback(data: unknown): { button: FeedbackButton; rowid: number } | null {
  if (typeof data !== "string") return null;
  const m = PATTERN.exec(data);
  if (!m) return null;
  const button = FEEDBACK_BUTTONS.find((b) => b.code === m[1]);
  const rowid = Number(m[2]);
  return button && Number.isSafeInteger(rowid) ? { button, rowid } : null;
}

/** Rangée de boutons d'une annonce ; un bouton dont (type, value) est dans `state` porte la marque ✓. */
export function feedbackRow(rowid: number, state: FeedbackState = {}): InlineButton[] {
  return FEEDBACK_BUTTONS.map((b) => {
    const text = [b.emoji, b.label].filter(Boolean).join(" ");
    return {
      text: state[b.type] === b.value ? `${text} ${FEEDBACK_ACTIVE_MARK}` : text,
      callback_data: encodeCallback(b, rowid),
    };
  });
}

/** Vrai pour la rangée de retours d'un clavier (au moins un callback_data « f:... »). */
export const isFeedbackRow = (row: InlineButton[]): boolean =>
  row.some((b) => decodeCallback(b.callback_data) !== null);

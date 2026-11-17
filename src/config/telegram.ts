// Telegram (src/telegram/, src/notify/) : webhook, profil en langage naturel, boutons.

export const TELEGRAM_MAX_BODY = 32_768;
export const TELEGRAM_API_TIMEOUT_MS = 10_000;
/** Délai d'un message WhatsApp (CallMeBot). */
export const WHATSAPP_TIMEOUT_MS = 10_000;
/** Commandes déclarées à Telegram (setMyCommands) par /telegram/setup. */
export const TELEGRAM_COMMANDS: readonly { command: string; description: string }[] = [
  { command: "profil", description: "Voir, définir (texte libre) ou effacer (« effacer ») mon profil de recherche" },
  { command: "aide", description: "Ce que sait faire le bot" },
];
/** Mises à jour demandées à Telegram (setWebhook allowed_updates). */
export const TELEGRAM_ALLOWED_UPDATES: readonly string[] = ["message", "callback_query"];
/**
 * Boutons de retour sous chaque alerte. `code` : une lettre dans callback_data (« f:<code>:<rowid> », limite 64 octets) ;
 * `type` et `value` : ligne de feedback ; `toast` : fin de la confirmation du clic.
 */
export interface FeedbackButton {
  code: string;
  type: "avis" | "appel" | "visite";
  value: string;
  emoji: string;
  label: string;
  toast: string;
}
export const FEEDBACK_BUTTONS: readonly FeedbackButton[] = [
  { code: "a", type: "avis", value: "aime", emoji: "👍", label: "", toast: "j'aime" },
  { code: "d", type: "avis", value: "deteste", emoji: "👎", label: "", toast: "bof" },
  { code: "c", type: "appel", value: "oui", emoji: "📞", label: "appelée", toast: "appelée" },
  { code: "v", type: "visite", value: "oui", emoji: "🗓", label: "visite", toast: "visite" },
];
export const FEEDBACK_ACTIVE_MARK = "✓";

/** Profil : texte libre accepté au plus (caractères), car il part dans la consigne du modèle. */
export const PROFILE_TEXT_MAX = 600;
export const PROFILE_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const PROFILE_TIMEOUT_MS = 12_000;
export const PROFILE_MAX_TOKENS = 500;
/** Coût pessimiste d'un appel « profil » (~800 jetons de consigne, 500 en sortie). */
export const PROFILE_ESTIMATE_NEURONS = 25;
/** Bornes de validation du profil (valeur hors bornes : réponse du modèle refusée). */
export const PROFILE_TRANSIT_RANGE: readonly [number, number] = [1, 60];
export const PROFILE_FLOOR_RANGE: readonly [number, number] = [0, 30];
export const PROFILE_BUDGET_RANGE: readonly [number, number] = [300, 10_000];
export const PROFILE_SURFACE_RANGE: readonly [number, number] = [9, 250];
/** Mots libres : nombre et longueur maximaux. */
export const PROFILE_KEYWORDS_MAX = 8;
export const PROFILE_KEYWORD_LEN = 40;
/** Longueur maximale de la ligne « profil » de l'alerte. */
export const PROFILE_LINE_MAX = 200;

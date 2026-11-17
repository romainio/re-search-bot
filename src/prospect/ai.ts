import { PHOTO_MODEL } from "../config/ai";
import { PROSPECT_AI_ESTIMATE_NEURONS } from "../config/prospect";
import { runJson } from "../ai/run";
import type { Env } from "../types";
import type { Verdict } from "./types";

/** Modèle de l'étape « publie-t-il des locations ? » (tarif dans AI_MODEL_RATES). */
export const PROSPECT_AI_MODEL = PHOTO_MODEL;
const AI_TIMEOUT_MS = 15_000;
/** Réponse JSON d'un mot : {"verdict":"oui"}. */
const MAX_TOKENS = 20;

/** Interrupteurs : PROSPECT_ENABLED et PROSPECT_AI à "true" ; sans binding AI, l'étape n'existe pas. */
export const prospectOn = (env: Env): boolean => env.PROSPECT_ENABLED === "true";
export const prospectAiOn = (env: Env): boolean => prospectOn(env) && env.PROSPECT_AI === "true" && !!env.AI;

/** Verdict depuis la réponse brute du modèle (« oui », « Non. », « incertain »…) ; null si illisible. */
export function parseVerdict(raw: unknown): Verdict | null {
  const text =
    typeof raw === "string"
      ? raw
      : typeof raw === "object" && raw !== null && typeof (raw as { response?: unknown }).response === "string"
        ? (raw as { response: string }).response
        : "";
  const w = text.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/^oui\b/.test(w)) return "oui";
  if (/^non\b/.test(w)) return "non";
  if (/^incertain\b/.test(w)) return "incertain";
  return null;
}

/**
 * « Ce site publie-t-il des locations ? » d'après le texte de sa page d'accueil, par le socle IA. Jamais d'exception : null si
 * éteint, sans binding, sans budget, sur erreur ou réponse illisible.
 */
export async function classifyRental(env: Env, markdown: string): Promise<Verdict | null> {
  if (!prospectAiOn(env) || !markdown.trim()) return null;
  return runJson<Verdict>(env, {
    feature: "prospect",
    model: PROSPECT_AI_MODEL,
    input: {
      messages: [
        {
          role: "system",
          content: `Tu lis le texte d'une page d'accueil d'agence immobilière. Réponds UNIQUEMENT par un objet JSON {"verdict": "oui" | "non" | "incertain"} : oui si le site publie des annonces de location (appartements à louer), non si l'agence ne fait que de la vente ou de la gestion sans annonces, incertain si le texte ne permet pas de le savoir.`,
        },
        { role: "user", content: markdown },
      ],
      max_tokens: MAX_TOKENS,
      chat_template_kwargs: { enable_thinking: false },
    },
    estimate: PROSPECT_AI_ESTIMATE_NEURONS,
    timeoutMs: AI_TIMEOUT_MS,
    validate: (j) => parseVerdict((j as { verdict?: unknown } | null)?.verdict),
  });
}

import type { Env } from "../types";
import { canSpend, record } from "./budget";
import { isTimeout, withTimeout } from "../timeout";

// Un appel Workers AI unique, borné et budgété, qui rend un objet validé ou null ; jamais d'exception.

/** Texte de la réponse : format OpenAI (choices[0].message.content) ou champ « response » selon le modèle ; null sinon. */
export function answerText(out: unknown): string | null {
  const o = out as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | null;
  const t = o?.choices?.[0]?.message?.content ?? o?.response;
  return typeof t === "string" ? t : null;
}

/**
 * Premier objet JSON de `raw` (texte libre, balises ```json tolérées : de la première « { » à la dernière « } »), ou null si
 * absent ou illisible. Une réponse déjà objet (certains modèles renvoient `response` en objet) est rendue telle quelle.
 */
export function extractJson(raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  const start = raw.indexOf("{"),
    end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface AiCall<T> {
  /** Nom de la fonction (clé de settings().ai.featureCaps) : sert au plafond et au cumul en D1. */
  feature: string;
  model: string;
  /** Corps passé tel quel à env.AI.run (messages, max_tokens, ...). */
  input: unknown;
  /** Neurons estimés (pessimiste) : testés par canSpend avant l'appel et inscrits si le modèle ne renvoie pas `usage`. */
  estimate: number;
  timeoutMs: number;
  /** Validation fournie par l'appelant : reçoit l'objet JSON extrait, renvoie la valeur typée ou null (refus). */
  validate: (json: unknown) => T | null;
  /** Horloge (tests) ; défaut : maintenant. */
  now?: Date;
  /** Appelé avec les neurons inscrits après un appel dont la réponse est reçue (mesure du coût réel d'une lecture). */
  onSpent?: (neurons: number) => void;
}

/** Comme AiCall, mais `parse` reçoit la SORTIE BRUTE du modèle (appels d'outils : `tool_calls`, texte, ...). */
export interface AiRawCall<T> extends Omit<AiCall<T>, "validate"> {
  parse: (out: unknown) => T | null;
}

/**
 * Appel unique : canSpend -> env.AI.run avec délai -> record -> parse ; null sur tout échec. Une réponse reçue est inscrite même
 * refusée (le modèle l'a facturée), un délai dépassé à l'estimation, une erreur du modèle jamais : au plus une écriture par appel.
 */
export async function runAi<T>(env: Env, call: AiRawCall<T>): Promise<T | null> {
  if (!env.AI) return null;
  const now = call.now ?? new Date();
  if (!(await canSpend(env.DB, call.feature, call.estimate, now))) return null;
  let out: unknown;
  try {
    out = await withTimeout(env.AI.run(call.model, call.input), call.timeoutMs);
  } catch (e) {
    if (isTimeout(e)) await record(env.DB, call.feature, call.model, null, call.estimate, now);
    return null;
  }
  const spent = await record(
    env.DB,
    call.feature,
    call.model,
    (out as { usage?: unknown } | null)?.usage,
    call.estimate,
    now,
  );
  call.onSpent?.(spent);
  try {
    return call.parse(out);
  } catch {
    return null;
  }
}

/** Appel unique qui rend un objet JSON validé : runAi dont `parse` extrait le premier objet JSON du texte de la réponse. */
export async function runJson<T>(env: Env, call: AiCall<T>): Promise<T | null> {
  const { validate, ...rest } = call;
  return runAi(env, {
    ...rest,
    parse: (out) => {
      const json = extractJson(answerText(out) ?? (out as { response?: unknown } | null)?.response);
      return json === null ? null : validate(json);
    },
  });
}

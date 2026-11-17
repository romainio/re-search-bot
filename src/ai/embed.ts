import { EMBED_ESTIMATE_PER_TEXT, SEMANTIC_DIMENSIONS, SEMANTIC_MODEL, SEMANTIC_TIMEOUT_MS } from "../config/semantic";
import type { Env } from "../types";
import { canSpend, record } from "./budget";
import { isTimeout, withTimeout } from "../timeout";

// Embeddings budgétés : un appel par lot de textes, mêmes garde-fous que runJson (fonction « embed »).

export const EMBED_FEATURE = "embed";

/** Vecteurs de la réponse (`data`, un par texte, dans l'ordre) ; null si la forme ou une dimension est fausse. */
export function parseEmbeddings(out: unknown, count: number, dims: number = SEMANTIC_DIMENSIONS): number[][] | null {
  const data = (out as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== count) return null;
  for (const v of data) {
    if (!Array.isArray(v) || v.length !== dims || !v.every((x) => typeof x === "number" && Number.isFinite(x)))
      return null;
  }
  return data as number[][];
}

/** Embeddings de `texts` en un appel budgété (EMBED_ESTIMATE_PER_TEXT par texte) ; null sur tout échec. Comptabilité de runAi. */
export async function runEmbed(
  env: Env,
  texts: string[],
  now: Date = new Date(),
  timeoutMs: number = SEMANTIC_TIMEOUT_MS,
): Promise<number[][] | null> {
  if (!env.AI || texts.length === 0) return null;
  const estimate = texts.length * EMBED_ESTIMATE_PER_TEXT;
  if (!(await canSpend(env.DB, EMBED_FEATURE, estimate, now))) return null;
  let out: unknown;
  try {
    out = await withTimeout(env.AI.run(SEMANTIC_MODEL, { text: texts }), timeoutMs);
  } catch (e) {
    if (isTimeout(e)) await record(env.DB, EMBED_FEATURE, SEMANTIC_MODEL, null, estimate, now);
    return null;
  }
  await record(env.DB, EMBED_FEATURE, SEMANTIC_MODEL, (out as { usage?: unknown } | null)?.usage, estimate, now);
  return parseEmbeddings(out, texts.length);
}

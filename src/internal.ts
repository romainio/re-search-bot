import { PART_MAX_BODY } from "./config/scan";
import { authorized, hmacHex } from "./crypto";
import { json } from "./http";
import type { Env } from "./types";

/** En-tête des routes internes : HMAC-SHA256(ADMIN_KEY, corps exact), jamais la clé elle-même (les en-têtes sont journalisés). */
const SIGNATURE_HEADER = "x-internal-key";

/**
 * Appelant des routes internes (/part, /embed), chaque appel étant une invocation séparée avec ses propres 10 ms de CPU et 50
 * sous-requêtes : `env.SELF` s'il est déclaré, sinon `ctx.exports.default` (drapeau enable_ctx_exports), sinon null.
 */
export function internalFetcher(env: Pick<Env, "SELF">, ctx?: { exports?: unknown }): Fetcher | null {
  if (env.SELF) return env.SELF;
  const loop = (ctx?.exports as { default?: Fetcher } | undefined)?.default;
  return loop && typeof loop.fetch === "function" ? loop : null;
}

/** POST signé vers une route interne de ce Worker ; null si aucune voie d'appel n'existe. */
export async function postInternal(
  env: Pick<Env, "SELF" | "ADMIN_KEY">,
  ctx: { exports?: unknown } | undefined,
  path: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<Response | null> {
  const self = internalFetcher(env, ctx);
  if (!self) return null;
  const body = JSON.stringify(payload);
  return self.fetch(`https://re-search${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: await hmacHex(env.ADMIN_KEY, body) },
    body,
    ...(signal ? { signal } : {}),
  });
}

/** Corps d'une requête interne dont la signature est valide (comparée en temps constant), sinon la réponse de refus. */
export async function internalBody(request: Request, env: Pick<Env, "ADMIN_KEY">): Promise<string | Response> {
  const sig = request.headers.get(SIGNATURE_HEADER);
  if (!sig || !env.ADMIN_KEY) return json({ error: "forbidden" }, 403);
  // Longueur annoncée refusée avant toute lecture, puis longueur lue (l'en-tête peut mentir ou manquer).
  if (Number(request.headers.get("content-length") ?? 0) > PART_MAX_BODY)
    return json({ error: "corps trop long" }, 413);
  const raw = await request.text();
  if (raw.length > PART_MAX_BODY) return json({ error: "corps trop long" }, 413);
  if (!authorized(sig, await hmacHex(env.ADMIN_KEY, raw))) return json({ error: "forbidden" }, 403);
  return raw;
}

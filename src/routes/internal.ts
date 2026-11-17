import { settings } from "../derive";
import { json } from "../http";
import { internalBody } from "../internal";
import { loadLiveConfig } from "../live-config";
import { parsePartRequest, runPart } from "../scan";
import { runEmbedStep } from "../search/embed";
import { parseEmbedRequest } from "../search/self";
import type { Env } from "../types";

// Routes appelées par le Worker lui-même (src/internal.ts), chacune dans sa propre invocation : corps signé, jamais de clé dans l'URL.

/** POST /part : un sous-lot de sources lancé par l'orchestrateur du cron. */
export async function partRoute(request: Request, env: Env): Promise<Response> {
  const raw = await internalBody(request, env);
  if (raw instanceof Response) return raw;
  env = await loadLiveConfig(env);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "corps invalide" }, 400);
  }
  const s = settings();
  const req = parsePartRequest(body, s);
  if (!req) return json({ error: "sous-lot invalide" }, 400);
  const r = await runPart(env, req.sources, req.now, s);
  // Centre de données de l'invocation : des refus 403/429 ne touchent que certains lieux d'exécution des crons.
  const colo = (request as { cf?: { colo?: string; country?: string } }).cf;
  const failed = r.sources
    .filter((s) => !s.ok)
    .map((s) => `${s.id} ${"reason" in s ? s.reason : ""}`)
    .join(", ");
  console.log(
    `part ${req.sources.map((s) => s.id).join(",")}: ${r.sources.filter((s) => s.ok).length}/${r.sources.length} ok${failed ? ` (${failed})` : ""} [${colo?.colo ?? "?"} ${colo?.country ?? "?"}]`,
  );
  return json(r);
}

/** POST /embed : un pas d'indexation sémantique lancé par le cron. */
export async function embedRoute(request: Request, env: Env): Promise<Response> {
  const raw = await internalBody(request, env);
  if (raw instanceof Response) return raw;
  env = await loadLiveConfig(env);
  const at = parseEmbedRequest(raw);
  if (!at) return json({ error: "corps invalide" }, 400);
  const r = await runEmbedStep(env, at);
  if (r.result === "pas" || r.result === "erreur")
    console.log(`embed : ${r.result}, ${r.embedded} nouvelles, ${r.refreshed} rafraîchies`);
  return json(r);
}

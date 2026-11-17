import { adminAuthorized } from "../access";
import { buildHealth } from "../admin-health";
import { TOTAL_GROUPS } from "../config/schedule";
import { json, notFound } from "../http";
import { loadLiveConfig } from "../live-config";
import { ensureMigrated } from "../migrate";
import { runProspectStep } from "../prospect/run";
import { runScan, selfRunner } from "../scan";
import { getClusterStats, getSourceStates } from "../store";
import type { Env } from "../types";
import { getConfigRoute, postConfigRoute } from "./config";
import { sourceTestRoute } from "./source-test";

type AdminHandler = (request: Request, env: Env, ctx: ExecutionContext, url: URL) => Promise<Response>;

/** GET /scan?group=N : un passage d'un groupe ; toutes les sources d'un coup dépasseraient le budget d'une invocation. */
const scanRoute: AdminHandler = async (_request, env, ctx, url) => {
  const g = url.searchParams.get("group");
  if (g === null || !/^\d{1,2}$/.test(g) || Number(g) >= TOTAL_GROUPS)
    return json({ error: `group invalide (0-${TOTAL_GROUPS - 1} requis)` }, 400);
  return json(await runScan(env, Number(g), new Date(), selfRunner(env, ctx)));
};

const GET_ROUTES: Readonly<Record<string, AdminHandler>> = {
  "/scan": scanRoute,
  "/test": (_request, env, _ctx, url) => sourceTestRoute(env, url),
  "/status": async (_request, env) => json(await getSourceStates(env.DB)),
  "/stats": async (_request, env) => json(await getClusterStats(env.DB)),
  // Un pas de la prospection ; au repos, lance une campagne.
  "/prospect": async (_request, env) => json(await runProspectStep(env, new Date(), { start: true })),
  // Rapport d'installation en lecture seule (docs/playbook.md).
  "/health": async (_request, env) => json(await buildHealth(env, new Date())),
  "/config": (_request, env) => getConfigRoute(env),
};
const POST_ROUTES: Readonly<Record<string, AdminHandler>> = {
  "/config": (request, env) => postConfigRoute(request, env),
};

/** Routes d'administration : 404 pour une route ou une méthode inconnue (avant tout contrôle d'accès), puis Bearer ADMIN_KEY. */
export async function adminRoute(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const table = request.method === "GET" ? GET_ROUTES : request.method === "POST" ? POST_ROUTES : {};
  const handler = Object.hasOwn(table, url.pathname) ? table[url.pathname] : undefined;
  if (!handler) return notFound();
  if (!adminAuthorized(request, env)) return json({ error: "forbidden" }, 403);
  await ensureMigrated(env.DB);
  return handler(request, await loadLiveConfig(env), ctx, url);
}

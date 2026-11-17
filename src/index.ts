import { onCron } from "./cron";
import { loadLiveConfig } from "./live-config";
import { handleMail } from "./mail/handler";
import type { MailMessage } from "./mail/handler";
import { mcpRoute } from "./mcp/server";
import { ensureMigrated } from "./migrate";
import { adminRoute } from "./routes/admin";
import { dashboardRoute } from "./routes/dashboard";
import { embedRoute, partRoute } from "./routes/internal";
import { telegramRoute } from "./telegram/webhook";
import type { Env } from "./types";

type Handler = (request: Request, env: Env, ctx: ExecutionContext, url: URL) => Promise<Response>;
interface Route {
  method?: "GET" | "POST";
  matches: (path: string) => boolean;
  handle: Handler;
}

/**
 * Routes dans l'ordre d'essai ; la dernière (administration) répond 404 à tout le reste. La configuration vivante (src/live-config.ts)
 * est chargée par chaque route après son contrôle d'accès ; Telegram et MCP la chargent d'abord : leur interrupteur peut être en D1.
 */
const ROUTES: readonly Route[] = [
  {
    matches: (p) => p === "/telegram" || p === "/telegram/setup",
    handle: async (request, env, ctx) => {
      await ensureMigrated(env.DB);
      return (await telegramRoute(request, await loadLiveConfig(env), ctx))!;
    },
  },
  // 404 tant que MCP_ENABLED n'est pas "true" (docs/mcp.md).
  {
    matches: (p) => p === "/mcp" || p.startsWith("/mcp/"),
    handle: async (request, env) => (await mcpRoute(request, await loadLiveConfig(env)))!,
  },
  { method: "GET", matches: (p) => p === "/", handle: (request, env, _ctx, url) => dashboardRoute(request, env, url) },
  { method: "POST", matches: (p) => p === "/part", handle: (request, env) => partRoute(request, env) },
  { method: "POST", matches: (p) => p === "/embed", handle: (request, env) => embedRoute(request, env) },
  { matches: () => true, handle: adminRoute },
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = ROUTES.find((r) => (!r.method || r.method === request.method) && r.matches(url.pathname))!;
    return route.handle(request, env, ctx, url);
  },
  // Alertes par mail : sans effet tant que MAIL_INGEST est éteint.
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleMail(message as MailMessage, await loadLiveConfig(env));
  },
  scheduled: onCron,
};

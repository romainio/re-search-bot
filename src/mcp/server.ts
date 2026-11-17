import { adminAuthorized, bearerOf } from "../access";
import { CONFIG_MAX_BYTES } from "../config/switches";
import { ensureMigrated } from "../migrate";
import type { Env } from "../types";
import { authorized } from "../crypto";
import { mcpToken } from "./token";
import { MCP_TOOLS, toolList } from "./tools";
import { errMsg, isObj } from "../guards";
import { esc } from "../html";
import { json as jsonResponse } from "../http";

/**
 * Serveur MCP : un assistant IA s'y connecte pour paramétrer l'instance. Transport « Streamable HTTP » sans état, écrit à la main
 * (JSON-RPC 2.0, réponses JSON, ni session ni SSE) : aucune dépendance, quelques dizaines de µs de CPU hors de l'outil appelé.
 *
 * Accès : /mcp/<jeton>, jeton aléatoire gardé en D1 et distinct d'ADMIN_KEY : une adresse divulguée se remplace sans toucher à la
 * clé (« Authorization: Bearer <jeton> » est accepté aussi). GET /mcp?k=ADMIN_KEY redirige vers cette adresse. Éteint : 404.
 */

/** Versions du protocole comprises (la plus récente d'abord) : celle du client si elle en fait partie, sinon la plus récente. */
export const MCP_PROTOCOLS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "re-search", title: "RE-SEARCH : alertes de locations", version: "1.0.0" };
const INSTRUCTIONS =
  "Paramétrage d'une instance RE-SEARCH (alertes Telegram de locations nouvelles). Commencer par « etat ». Ordre conseillé : " +
  "definir_recherche (zones, loyer, surface), puis pour chaque agence ou portail : detecter_gabarit, tester_source, ajouter_source ; enfin lier_telegram. " +
  "Ne jamais ajouter un site qui refuse la lecture automatique (403, 429, anti-bot) : aucun contournement.";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  jsonResponse(data, status, { "cache-control": "no-store", ...headers });

/** Adresse du connecteur MCP de cette instance ; null si MCP_ENABLED est éteint ou D1 illisible. */
export async function connectorAddress(env: Pick<Env, "DB" | "MCP_ENABLED">, origin: string): Promise<string | null> {
  if (env.MCP_ENABLED !== "true") return null;
  const token = await mcpToken(env.DB);
  return token ? `${origin}/mcp/${token}` : null;
}

/** Page de l'adresse du connecteur (copie, marche à suivre) ; `welcome` : instance tout juste installée. */
export function addressPage(address: string, welcome = false): Response {
  const a = esc(address);
  const intro = welcome
    ? `<h1>RE-SEARCH est installé</h1><p>Rien n'est encore paramétré : ni la recherche, ni les sites à lire, ni Telegram. Le plus simple est de le faire en parlant avec votre assistant IA, grâce à l'adresse ci-dessous.</p><h2>Adresse du connecteur MCP</h2>`
    : "<h1>Adresse du connecteur MCP</h1>";
  const ask = welcome
    ? "Demandez-lui par exemple : « Paramètre RE-SEARCH pour un 2 pièces à Lyon 3e, moins de 1 000 € ». Il définit la recherche, propose et essaie les sites, puis lie Telegram."
    : "Demandez-lui : « Où en est mon instance RE-SEARCH ? »";
  const more = welcome ? '<p><a href="/?tableau=1">Voir le tableau de bord quand même</a></p>' : "";
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Connecteur MCP</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
code{display:block;word-break:break-all;padding:.8rem;background:#f2f2f2;border-radius:6px;font-size:.95rem}
button{margin:.6rem 0;padding:.5rem 1rem;font:inherit;cursor:pointer}ol{padding-left:1.2rem}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}code{background:#262626}}</style></head><body>
${intro}<code id="a">${a}</code><button onclick="navigator.clipboard.writeText(document.getElementById('a').textContent)">Copier l'adresse</button>
<ol><li>Dans votre assistant (Claude : Paramètres, Connecteurs, « Ajouter un connecteur personnalisé »), collez <strong>cette adresse</strong>.</li>
<li>Laissez l'authentification (OAuth) vide.</li><li>${ask}</li></ol>
<p>Ne partagez pas cette adresse : elle permet de modifier la configuration. Divulguée, demandez à l'assistant de la régénérer (outil « regenerer_adresse »).</p>${more}</body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

/**
 * Écarts des arguments au schéma de l'outil : propriétés inconnues (additionalProperties: false) et propriétés requises absentes. Le
 * reste (types, bornes) est vérifié par l'outil, avec un message propre à chaque champ. null : rien à redire.
 */
export function argsProblem(schema: Record<string, unknown>, args: Record<string, unknown>): string | null {
  const props = isObj(schema.properties) ? Object.keys(schema.properties) : [];
  const errors: string[] = [];
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args)
      .filter((k) => !props.includes(k))
      .map((k) => k.slice(0, 40));
    if (unknown.length)
      errors.push(
        `arguments inconnus : ${unknown.slice(0, 10).join(", ")} (attendus : ${props.join(", ") || "aucun"})`,
      );
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((k): k is string => typeof k === "string")
    : [];
  const missing = required.filter((k) => args[k] === undefined || args[k] === null);
  if (missing.length) errors.push(`arguments requis manquants : ${missing.join(", ")}`);
  return errors.length ? errors.join(" ; ") : null;
}

/** Traite un message JSON-RPC ; null pour une notification (aucune réponse attendue). */
async function handle(msg: unknown, env: Env, origin: string): Promise<unknown | null> {
  if (!isObj(msg) || (msg as Rpc).jsonrpc !== "2.0" || typeof (msg as Rpc).method !== "string") {
    // Une réponse du client (ni méthode ni attente de notre part) est ignorée ; le reste est une requête invalide.
    if (isObj(msg) && msg.method === undefined && ("result" in msg || "error" in msg)) return null;
    return rpcError(isObj(msg) ? msg.id : null, -32600, "requête JSON-RPC invalide");
  }
  const { id, method, params } = msg as { id?: unknown; method: string; params?: unknown };
  const notification = id === undefined;
  const ok = (result: unknown) => (notification ? null : { jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize": {
      const wanted = isObj(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok({
        protocolVersion: MCP_PROTOCOLS.includes(wanted) ? wanted : MCP_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: toolList() });
    case "tools/call": {
      if (notification) return null;
      const name = isObj(params) ? params.name : undefined;
      const tool = MCP_TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `outil inconnu : ${String(name).slice(0, 80)}`);
      const args = isObj(params) && isObj(params.arguments) ? params.arguments : {};
      // Une erreur d'outil est un résultat en erreur, que l'assistant lit pour se reprendre ; jamais une erreur de protocole.
      const fail = (text: string) => ok({ content: [{ type: "text", text }], isError: true });
      const problem = argsProblem(toolList().find((t) => t.name === tool.name)!.inputSchema, args);
      if (problem) return fail(problem);
      try {
        await ensureMigrated(env.DB);
        const data = await tool.run(args, { env, origin, now: new Date() });
        return ok({ content: [{ type: "text", text: JSON.stringify(data) }], isError: false });
      } catch (e) {
        return fail(errMsg(e));
      }
    }
    default:
      // notifications/initialized, notifications/cancelled... : rien à faire, rien à répondre.
      return notification ? null : rpcError(id, -32601, `méthode inconnue : ${method.slice(0, 80)}`);
  }
}

/** Route /mcp : `null` si le chemin n'en est pas une (l'appelant continue), sinon la réponse. `env` porte déjà la configuration vivante. */
export async function mcpRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp" && !url.pathname.startsWith("/mcp/")) return null;
  if (env.MCP_ENABLED !== "true") return new Response("Not found", { status: 404 });
  // Garde contre le rebond DNS (spécification MCP) : une page d'un autre site ouverte dans le navigateur ne pilote pas ce serveur.
  const from = request.headers.get("origin");
  if (from !== null && from !== url.origin) return json({ error: "origine refusée" }, 403);
  await ensureMigrated(env.DB);
  const token = await mcpToken(env.DB);
  const accept = request.headers.get("accept") ?? "";
  const sse = accept.includes("text/event-stream");
  const fromPath = url.pathname.startsWith("/mcp/") ? url.pathname.slice(5) : null;

  // Adresse à donner à l'assistant, réservée à la clé d'administration ; un client MCP qui ouvre un flux SSE n'est pas concerné.
  if (request.method === "GET" && fromPath === null && url.searchParams.has("k") && !sse) {
    if (!token || !adminAuthorized(request, env)) return json({ error: "forbidden" }, 403);
    return new Response(null, {
      status: 302,
      headers: {
        location: `${url.origin}/mcp/${token}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  if (!token || !authorized(fromPath ?? bearerOf(request), token)) return json({ error: "unauthorized" }, 401);
  if (request.method === "GET" && fromPath !== null && !sse && accept.includes("text/html"))
    return addressPage(`${url.origin}/mcp/${token}`);

  // Sans état : ni flux SSE à l'initiative du serveur (GET) ni session à fermer (DELETE).
  if (request.method !== "POST")
    return json({ error: "méthode non permise : POST (JSON-RPC)" }, 405, { allow: "POST" });
  if (Number(request.headers.get("content-length") ?? 0) > CONFIG_MAX_BYTES)
    return json(rpcError(null, -32600, "corps trop long"), 413);
  const raw = await request.text();
  if (raw.length > CONFIG_MAX_BYTES) return json(rpcError(null, -32600, "corps trop long"), 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(rpcError(null, -32700, "JSON invalide"), 400);
  }
  // Lots JSON-RPC retirés du protocole (2025-06-18) : un message par requête, ce qui garde aussi les outils en série.
  if (Array.isArray(body))
    return json(rpcError(null, -32600, "lots JSON-RPC non pris en charge : un message par requête"), 400);
  const r = await handle(body, env, url.origin);
  return r === null ? new Response(null, { status: 202 }) : json(r);
}

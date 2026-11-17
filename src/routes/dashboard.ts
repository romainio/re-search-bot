import { dashboardGate } from "../access";
import { renderDashboard } from "../dashboard/render";
import { settings } from "../derive";
import { parseView } from "../listings-query";
import { loadLiveConfig } from "../live-config";
import { addressPage, connectorAddress } from "../mcp/server";
import { ensureMigrated } from "../migrate";
import { semanticOn } from "../search/embed";
import { normalizeQuery, semanticSearch } from "../search/search";
import { interactiveOn } from "../telegram/webhook";
import type { Env } from "../types";

/** Saisie de recherche lue au plus (caractères) avant normalisation : la validation fine est celle de semanticSearch. */
const QUERY_INPUT_MAX = 200;
/** Cache de la page (secondes) : épargne les lectures D1 du plan gratuit. */
const DASHBOARD_MAX_AGE_S = 60;

/** GET / : tableau de bord, privé par défaut (DASHBOARD_PUBLIC) : ?k=ADMIN_KEY ou cookie posé après une visite avec la clé. */
export async function dashboardRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const gate = await dashboardGate(request, env);
  if (gate.response) return gate.response;
  env = await loadLiveConfig(env);
  await ensureMigrated(env.DB);
  const s = settings();
  // L'adresse du connecteur MCP permet de modifier la configuration : seulement sur un tableau de bord privé.
  const mcpAddress = gate.isPrivate ? await connectorAddress(env, url.origin) : null;
  // Aucune source active (instance tout juste installée) : page de démarrage qui mène à l'assistant ; ?tableau=1 affiche le tableau.
  if (mcpAddress && !s.instance.sources.some((x) => x.active) && !url.searchParams.has("tableau")) {
    return addressPage(mcpAddress, true);
  }
  // Recherche sémantique (?q=), seulement si la fonction est allumée.
  let search = null;
  if (semanticOn(env)) {
    const raw = (url.searchParams.get("q") ?? "").slice(0, QUERY_INPUT_MAX);
    const v = parseView(url.searchParams);
    const result =
      raw.trim() === ""
        ? null
        : await semanticSearch(env, raw, {
            zone: v.zone,
            prix: v.prix,
            surface: v.surface,
            sources: s.sources.all,
            now: new Date(),
          });
    search = { q: normalizeQuery(raw) ?? raw, result };
  }
  const html = await renderDashboard(env.DB, s.sources.all, new Date(), url.searchParams, search, {
    interactive: interactiveOn(env),
    mcpAddress,
  });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": `${gate.isPrivate ? "private" : "public"}, max-age=${DASHBOARD_MAX_AGE_S}`,
    },
  });
}

import { FEATURE_SWITCHES } from "./config/switches";
import { spentToday, utcDay } from "./ai/budget";
import { settings } from "./derive";
import { staleMinutes } from "./health";
import { isConfigured } from "./instance";
import { configOrigin } from "./live-config";
import { chatId } from "./telegram/chat";
import { hasValue } from "./guards";
import type { Env } from "./types";

// Rapport d'installation (GET /health?k=, lecture seule) : ce qu'il faut savoir après un déploiement, en un appel. Il ne contient
// JAMAIS la valeur d'un secret (présence seulement). Chaque lecture D1 est protégée : une table absente donne null, pas une erreur.

/** Secrets et bindings dont la présence est rapportée (jamais la valeur). */
const SECRETS = [
  "ADMIN_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "CALLMEBOT_PHONE",
  "CALLMEBOT_APIKEY",
] as const;
const BINDINGS = ["DB", "SELF", "AI", "VECTORIZE", "BROWSER"] as const;

export interface HealthReport {
  ok: boolean;
  now: string;
  zones: string[];
  criteria: { rentMin: number; rentMax: number; surfaceMin: number; roomsMin: number };
  config: { origin: "fichier" | "d1" };
  /** Présence (jamais la valeur) des secrets. */
  secrets: Record<string, boolean>;
  /** Bindings déclarés dans wrangler.jsonc et reçus par le Worker. */
  bindings: Record<string, boolean>;
  /** Interrupteurs : état, guide, et ce qui manque s'il est allumé. */
  switches: { name: string; on: boolean; doc: string; missing: string[] }[];
  /** Migrations D1 appliquées (table d1_migrations) ; null si la table est illisible. */
  migrations: { count: number; last: string | null; names: string[] } | null;
  ai: {
    day: string;
    spent: number;
    cap: number;
    byFeature: Record<string, { spent: number; cap: number | null }>;
  } | null;
  sources: {
    registry: number;
    readable: number;
    broken: { id: string; error: string | null }[];
    stale: { id: string; minutes: number }[];
    neverRun: number;
  } | null;
  /** Problèmes à traiter (vide : installation saine). */
  problems: string[];
}

async function safe<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

export async function buildHealth(env: Env, now: Date): Promise<HealthReport> {
  const cfg = settings();
  const problems: string[] = [];
  if (!isConfigured(cfg.instance))
    problems.push("recherche non paramétrée : aucune zone (outil MCP definir_recherche, docs/mcp.md)");

  const secrets: Record<string, boolean> = {};
  for (const k of SECRETS) secrets[k] = hasValue(env[k]);
  // TELEGRAM_CHAT_ID et le secret du webhook sont facultatifs (liaison par /start, secret dérivé) ; leur présence reste rapportée.
  secrets.TELEGRAM_CHAT_ID = (await chatId(env).catch(() => null)) !== null;
  for (const k of ["ADMIN_KEY", "TELEGRAM_BOT_TOKEN"]) if (!secrets[k]) problems.push(`secret ${k} absent`);
  if (!secrets.TELEGRAM_CHAT_ID)
    problems.push(
      "aucune conversation Telegram liée (GET /telegram/setup?k=... donne un code, à envoyer au bot : /start <code>)",
    );

  const bindings: Record<string, boolean> = {};
  for (const k of BINDINGS) bindings[k] = hasValue(env[k]);
  // SELF (service binding) est facultatif : à défaut, le Worker s'appelle par ctx.exports (src/internal.ts).
  if (!bindings.DB) problems.push("binding DB absent (wrangler.jsonc)");

  const on = (name: keyof Env): boolean => env[name] === "true";
  const switches = FEATURE_SWITCHES.map((s) => {
    const enabled = on(s.name);
    const missing = !enabled
      ? []
      : [
          ...(s.bindings ?? []).filter((b) => !bindings[b]).map((b) => `binding ${b}`),
          ...(s.secrets ?? []).filter((x) => !secrets[x]).map((x) => `secret ${x}`),
          ...(s.needs ?? []).filter((n) => !on(n)).map((n) => `interrupteur ${n}`),
        ];
    if (missing.length) problems.push(`${s.name} allumé mais il manque : ${missing.join(", ")}`);
    return { name: s.name, on: enabled, doc: s.doc, missing };
  });

  const migrations = await safe(async () => {
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
    const names = results.map((r) => r.name);
    return { count: names.length, last: names.at(-1) ?? null, names };
  });
  if (!migrations || migrations.count === 0)
    problems.push(
      "aucune migration D1 appliquée (le Worker les applique au premier cron ou à la première requête ; voir les journaux)",
    );

  const ai = await safe(async () => {
    const s = await spentToday(env.DB, now);
    const byFeature: Record<string, { spent: number; cap: number | null }> = {};
    for (const [f, n] of Object.entries(s.byFeature))
      byFeature[f] = { spent: Math.round(n), cap: cfg.ai.featureCaps[f] ?? null };
    return { day: utcDay(now), spent: Math.round(s.total), cap: cfg.ai.dailyNeurons, byFeature };
  });

  const sources = await safe(async () => {
    const { results } = await env.DB.prepare("SELECT source, broken, last_run, last_error FROM source_state").all<{
      source: string;
      broken: number;
      last_run: string | null;
      last_error: string | null;
    }>();
    const byId = new Map(results.map((r) => [r.source, r]));
    const readable = cfg.sources.all.filter((s) => cfg.sources.readable.has(s.id));
    const broken = readable
      .filter((s) => byId.get(s.id)?.broken === 1)
      .map((s) => ({ id: s.id, error: byId.get(s.id)?.last_error ?? null }));
    const stale: { id: string; minutes: number }[] = [];
    for (const s of readable) {
      const m = staleMinutes(byId.get(s.id)?.last_run, now, s.every);
      if (m !== null) stale.push({ id: s.id, minutes: m });
    }
    return {
      registry: cfg.sources.all.length,
      readable: readable.length,
      broken,
      stale,
      neverRun: readable.filter((s) => !byId.get(s.id)?.last_run).length,
    };
  });
  if (sources?.broken.length)
    problems.push(`${sources.broken.length} source(s) en panne : ${sources.broken.map((b) => b.id).join(", ")}`);

  return {
    ok: problems.length === 0,
    now: now.toISOString(),
    zones: [...cfg.allowedPostalCodes],
    criteria: {
      rentMin: cfg.criteria.rentMin,
      rentMax: cfg.criteria.rentMax,
      surfaceMin: cfg.criteria.surfaceMin,
      roomsMin: cfg.criteria.roomsMin,
    },
    config: { origin: configOrigin() },
    secrets,
    bindings,
    switches,
    migrations,
    ai,
    sources,
    problems,
  };
}

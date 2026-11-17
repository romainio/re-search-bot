import { AI_FALLBACK_RATE, AI_MODEL_RATES } from "../config/ai";
import { settings } from "../derive";

// Budget Workers AI partagé : toute fonction IA passe par ici. Le cumul du jour UTC vit en D1 (ai_usage, une ligne par jour et
// fonction) : une lecture (canSpend) et une écriture (record) par appel. Sans compteur fiable (erreur D1), aucune dépense.

/** `usage` renvoyé par Workers AI (format OpenAI : prompt_tokens, completion_tokens). Tout champ peut manquer. */
export interface AiUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
}

/** Jour UTC « AAAA-MM-JJ » : les neurons gratuits se remettent à zéro à 00:00 UTC. */
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

const tokens = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Neurons d'un appel d'après `usage` et le tarif du modèle ; null si `usage` est inexploitable (l'appelant retient son
 * estimation). Seul `total_tokens` connu : tout au tarif de sortie, le plus cher.
 */
export function neuronsFromUsage(model: string, usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as AiUsage;
  const rate = AI_MODEL_RATES[model] ?? AI_FALLBACK_RATE;
  const p = tokens(u.prompt_tokens),
    c = tokens(u.completion_tokens);
  if (p !== null || c !== null) return ((p ?? 0) * rate.inPerM + (c ?? 0) * rate.outPerM) / 1_000_000;
  const t = tokens(u.total_tokens);
  return t === null ? null : (t * rate.outPerM) / 1_000_000;
}

export interface AiSpent {
  total: number;
  byFeature: Record<string, number>;
}

/** Neurons déjà dépensés le jour UTC de `now`, au total et par fonction (une lecture D1). */
export async function spentToday(db: D1Database, now: Date = new Date()): Promise<AiSpent> {
  const { results } = await db
    .prepare("SELECT feature, neurons FROM ai_usage WHERE day = ?")
    .bind(utcDay(now))
    .all<{ feature: string; neurons: number }>();
  const byFeature: Record<string, number> = {};
  let total = 0;
  for (const r of results) {
    byFeature[r.feature] = r.neurons;
    total += r.neurons;
  }
  return { total, byFeature };
}

/**
 * Vrai si un appel de `estimate` neurons tient sous le plafond global et sous celui de la fonction. À appeler avant chaque
 * appel ; faux sur toute erreur D1.
 */
export async function canSpend(
  db: D1Database,
  feature: string,
  estimate: number,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const { total, byFeature } = await spentToday(db, now);
    const { dailyNeurons, featureCaps } = settings().ai;
    const cap = featureCaps[feature] ?? dailyNeurons;
    return total + estimate <= dailyNeurons && (byFeature[feature] ?? 0) + estimate <= cap;
  } catch {
    return false;
  }
}

/**
 * Inscrit la dépense d'un appel (une écriture) : les neurons de `usage`, sinon `fallback`, l'estimation de l'appelant (jamais 0).
 * Rend les neurons inscrits, 0 si l'écriture échoue.
 */
export async function record(
  db: D1Database,
  feature: string,
  model: string,
  usage: unknown,
  fallback: number,
  now: Date = new Date(),
): Promise<number> {
  const neurons = neuronsFromUsage(model, usage) ?? fallback;
  try {
    await db
      .prepare(
        "INSERT INTO ai_usage (day, feature, neurons, calls) VALUES (?, ?, ?, 1) ON CONFLICT (day, feature) DO UPDATE SET neurons = neurons + excluded.neurons, calls = calls + 1",
      )
      .bind(utcDay(now), feature, neurons)
      .run();
    return neurons;
  } catch {
    return 0;
  }
}

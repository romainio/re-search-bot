import { PART_MAX_BODY, PART_MAX_SKEW_MS } from "../config/scan";
import { EMBED_STEP_TIMEOUT_MS } from "../config/semantic";
import { errMsg } from "../guards";
import { postInternal } from "../internal";
import type { Env } from "../types";
import { semanticOn } from "./embed";
import type { EmbedReport } from "./embed";

// Le pas d'indexation tourne dans sa propre invocation (POST /embed), comme les sous-lots /part : son CPU et ses sous-requêtes
// ne prennent rien au passage de lecture.

/** Appelle POST /embed par SELF ou ctx.exports (corps signé par HMAC comme /part). Jamais d'exception ; null si éteint ou en échec. */
export async function embedViaSelf(env: Env, now: Date, ctx?: { exports?: unknown }): Promise<EmbedReport | null> {
  if (!semanticOn(env) || !env.ADMIN_KEY) return null;
  try {
    const res = await postInternal(
      env,
      ctx,
      "/embed",
      { now: now.toISOString() },
      AbortSignal.timeout(EMBED_STEP_TIMEOUT_MS),
    );
    if (!res) return null;
    if (res.status !== 200) {
      await res.body?.cancel();
      return null;
    }
    return (await res.json()) as EmbedReport;
  } catch (e) {
    console.error("embed (self):", errMsg(e));
    return null;
  }
}

/** Corps vérifié de POST /embed : { now } proche de l'horloge (rejeu refusé) ; null sinon. */
export function parseEmbedRequest(raw: string, nowMs: number = Date.now()): Date | null {
  if (raw.length > PART_MAX_BODY) return null;
  try {
    const t = Date.parse((JSON.parse(raw) as { now?: unknown }).now as string);
    return Number.isNaN(t) || Math.abs(nowMs - t) > PART_MAX_SKEW_MS ? null : new Date(t);
  } catch {
    return null;
  }
}

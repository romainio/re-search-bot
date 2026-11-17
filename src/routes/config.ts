import { CONFIG_MAX_BYTES } from "../config/switches";
import { errMsg, isObj } from "../guards";
import { json } from "../http";
import { BUNDLED_RAW } from "../instance";
import {
  checkInstance,
  clearInstance,
  configOrigin,
  loadLiveConfig,
  saveInstance,
  saveSwitches,
  storedInstance,
  storedSwitches,
} from "../live-config";
import type { Env } from "../types";

/** GET /config : configuration en vigueur (D1, sinon fichier embarqué), à modifier puis renvoyer par POST. */
export async function getConfigRoute(env: Env): Promise<Response> {
  const stored = await storedInstance(env.DB);
  return json({ origin: configOrigin(), instance: stored ?? BUNDLED_RAW, switches: await storedSwitches(env.DB) });
}

/**
 * POST /config : { instance?: {...} | null, switches?: { NOM: true | false | null } } ; instance null : retour au fichier
 * embarqué. Tout est validé avant la première écriture.
 */
export async function postConfigRoute(request: Request, env: Env): Promise<Response> {
  if (Number(request.headers.get("content-length") ?? 0) > CONFIG_MAX_BYTES)
    return json({ error: "corps trop long" }, 413);
  const raw = await request.text();
  if (raw.length > CONFIG_MAX_BYTES) return json({ error: "corps trop long" }, 413);
  let body: { instance?: unknown; switches?: unknown };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObj(parsed)) throw new Error("objet attendu");
    body = parsed;
  } catch {
    return json({ error: "corps invalide (JSON : { instance?, switches? })" }, 400);
  }
  if (body.instance === undefined && body.switches === undefined)
    return json({ error: "rien à enregistrer (instance ou switches)" }, 400);
  try {
    // L'instance est validée avant toute écriture : une erreur ne laisse rien d'à moitié enregistré.
    const instance = body.instance;
    if (instance !== undefined && instance !== null) checkInstance(instance);
    if (body.switches !== undefined) await saveSwitches(env.DB, body.switches);
    if (instance === null) await clearInstance(env.DB);
    else if (instance !== undefined) await saveInstance(env.DB, instance);
  } catch (e) {
    return json({ error: errMsg(e, "configuration invalide") }, 400);
  }
  await loadLiveConfig(env);
  return json({ ok: true, origin: configOrigin(), switches: await storedSwitches(env.DB) });
}

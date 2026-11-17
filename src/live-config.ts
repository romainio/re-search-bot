import { CONFIG_MAX_BYTES, FEATURE_SWITCHES } from "./config/switches";
import { bundledSettings, derive, useSettings } from "./derive";
import type { Settings } from "./derive";
import { validateInstance } from "./instance";
import { getSetting, setSetting } from "./settings";
import { errMsg } from "./guards";

/**
 * Configuration vivante : l'instance et les interrupteurs peuvent être enregistrés en D1 (table `settings`) et changés sans
 * redéploiement ; sans ligne en D1, le fichier embarqué et les `vars` font foi. Coût par invocation : une lecture D1, validation
 * et dérivation n'étant refaites que si le texte a changé. Jamais bloquant : sur erreur, l'état en vigueur est gardé.
 */

/** Clés de la table `settings`. */
export const INSTANCE_KEY = "instance_config";
export const SWITCHES_KEY = "feature_switches";

const SWITCH_NAMES: ReadonlySet<string> = new Set(FEATURE_SWITCHES.map((s) => s.name));

/** Texte de la configuration D1 en vigueur dans cet isolat ; null : fichier embarqué. */
let loadedRaw: string | null = null;
/** Dernier texte refusé (invalide) : pas revalidé à chaque invocation. */
let rejectedRaw: string | undefined;
let switchesRaw: string | null = null;
let switches: Record<string, "true" | "false"> = {};

/** Origine de la configuration en vigueur : le fichier embarqué ou la base D1. */
export function configOrigin(): "fichier" | "d1" {
  return loadedRaw === null ? "fichier" : "d1";
}

/** Valide une configuration complète comme au chargement (schéma puis répartition en groupes) ; lève sans rien mettre en vigueur. */
export function checkInstance(raw: unknown): Settings {
  return derive(validateInstance(raw, "configuration"));
}

/** Interrupteurs lus d'un objet { NOM: true | false } : seuls les noms de FEATURE_SWITCHES et les booléens sont gardés. */
function parseSwitches(raw: string): Record<string, "true" | "false"> {
  const out: Record<string, "true" | "false"> = {};
  const o: unknown = JSON.parse(raw);
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o))
    if (SWITCH_NAMES.has(k) && typeof v === "boolean") out[k] = v ? "true" : "false";
  return out;
}

/**
 * À appeler au début de chaque invocation : met en vigueur la configuration D1 si elle a changé et renvoie l'env, interrupteurs
 * enregistrés par-dessus les `vars`.
 */
export async function loadLiveConfig<E extends { DB: D1Database }>(env: E): Promise<E> {
  let rows: Map<string, string>;
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN (?, ?)")
      .bind(INSTANCE_KEY, SWITCHES_KEY)
      .all<{ key: string; value: string }>();
    rows = new Map(results.map((r) => [r.key, r.value]));
  } catch {
    // Table absente (avant la première migration) ou D1 indisponible : l'état en vigueur est gardé.
    return Object.keys(switches).length ? { ...env, ...switches } : env;
  }

  const raw = rows.get(INSTANCE_KEY) ?? null;
  if (raw !== loadedRaw && raw !== rejectedRaw) {
    if (raw === null) {
      useSettings(bundledSettings());
      loadedRaw = null;
    } else {
      try {
        useSettings(checkInstance(JSON.parse(raw)));
        loadedRaw = raw;
        rejectedRaw = undefined;
      } catch (e) {
        // Une configuration devenue invalide (code plus strict) laisse l'état en vigueur.
        rejectedRaw = raw;
        console.error("configuration D1 refusée :", errMsg(e));
      }
    }
  }

  const sw = rows.get(SWITCHES_KEY) ?? null;
  if (sw !== switchesRaw) {
    switchesRaw = sw;
    try {
      switches = sw === null ? {} : parseSwitches(sw);
    } catch {
      switches = {};
    }
  }
  return Object.keys(switches).length ? { ...env, ...switches } : env;
}

/** Configuration enregistrée en D1 (objet JSON) et sa version (updated_at), pour une écriture conditionnelle ; null : aucune. */
export async function storedInstanceVersion(db: D1Database): Promise<{ raw: unknown; version: string } | null> {
  let row: { value: string; updated_at: string } | null;
  try {
    row = await db
      .prepare("SELECT value, updated_at FROM settings WHERE key = ?")
      .bind(INSTANCE_KEY)
      .first<{ value: string; updated_at: string }>();
  } catch {
    return null;
  }
  if (!row) return null;
  let raw: unknown = null;
  try {
    raw = JSON.parse(row.value);
  } catch {
    /* illisible : l'appelant repart du fichier embarqué, la version reste celle de la ligne */
  }
  return { raw, version: row.updated_at };
}

export const CONFLICT_MESSAGE =
  "la configuration a changé pendant cet appel (autre modification simultanée) : rien n'est enregistré ; relire l'état puis recommencer";

/**
 * Enregistre une configuration validée. `expected` : version lue avant la modification (null : aucune ligne) ; si la ligne a
 * changé depuis, CONFLICT_MESSAGE est levé. Absent : écriture inconditionnelle.
 */
export async function saveInstance(
  db: D1Database,
  raw: unknown,
  now: Date = new Date(),
  expected?: string | null,
): Promise<void> {
  checkInstance(raw);
  const text = JSON.stringify(raw);
  if (text.length > CONFIG_MAX_BYTES)
    throw new Error(`configuration trop longue (${text.length} caractères, ${CONFIG_MAX_BYTES} au plus)`);
  if (expected === undefined) return setSetting(db, INSTANCE_KEY, text, now);
  // La version doit changer à chaque écriture, même deux fois dans la même milliseconde.
  const at = (now.toISOString() === expected ? new Date(now.getTime() + 1) : now).toISOString();
  const r =
    expected === null
      ? await db
          .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING")
          .bind(INSTANCE_KEY, text, at)
          .run()
      : await db
          .prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND updated_at = ?")
          .bind(text, at, INSTANCE_KEY, expected)
          .run();
  if ((r.meta.changes ?? 0) !== 1) throw new Error(CONFLICT_MESSAGE);
}

/** Retire la configuration D1 : retour au fichier embarqué à la prochaine invocation. */
export async function clearInstance(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(INSTANCE_KEY).run();
}

/** Configuration enregistrée en D1 (objet JSON), ou null. */
export async function storedInstance(db: D1Database): Promise<unknown> {
  const raw = await getSetting(db, INSTANCE_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Interrupteurs enregistrés en D1 ({ NOM: booléen }), sans ceux qui ne le sont pas (ils gardent la valeur des `vars`). */
export async function storedSwitches(db: D1Database): Promise<Record<string, boolean>> {
  const raw = await getSetting(db, SWITCHES_KEY);
  if (raw === null) return {};
  try {
    return Object.fromEntries(Object.entries(parseSwitches(raw)).map(([k, v]) => [k, v === "true"]));
  } catch {
    return {};
  }
}

/**
 * Fusionne des interrupteurs dans ceux enregistrés : { NOM: true | false } pose une valeur, { NOM: null } la retire (retour à la valeur
 * des `vars`). Lève, sans rien écrire, sur un nom inconnu ou une valeur qui n'est ni booléenne ni null.
 */
export async function saveSwitches(
  db: D1Database,
  patch: unknown,
  now: Date = new Date(),
): Promise<Record<string, boolean>> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("switches : objet { NOM: true | false | null } attendu");
  const next = await storedSwitches(db);
  const errors: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!SWITCH_NAMES.has(k)) errors.push(`switches.${k} : interrupteur inconnu (${[...SWITCH_NAMES].join(", ")})`);
    else if (v === null) delete next[k];
    else if (typeof v === "boolean") next[k] = v;
    else errors.push(`switches.${k} : true, false ou null attendu`);
  }
  if (errors.length) throw new Error(`interrupteurs invalides :\n- ${errors.join("\n- ")}`);
  if (Object.keys(next).length === 0) await db.prepare("DELETE FROM settings WHERE key = ?").bind(SWITCHES_KEY).run();
  else await setSetting(db, SWITCHES_KEY, JSON.stringify(next), now);
  return next;
}

import type { FeedbackButton } from "../config/telegram";
import type { FeedbackState } from "./callback";

// Retours de l'utilisateur sur les annonces : affichés, jamais utilisés pour filtrer.

/** Annonce (source, id, url) d'un rowid de `listings`, ou null. */
export async function listingByRowid(
  db: D1Database,
  rowid: number,
): Promise<{ source: string; listing_id: string; url: string | null } | null> {
  return db
    .prepare("SELECT source, listing_id, url FROM listings WHERE rowid = ?")
    .bind(rowid)
    .first<{ source: string; listing_id: string; url: string | null }>();
}

/** Retours posés sur une annonce : `type` -> `value`. */
export async function getFeedback(db: D1Database, source: string, id: string): Promise<FeedbackState> {
  const { results } = await db
    .prepare("SELECT type, value FROM feedback WHERE source = ? AND listing_id = ?")
    .bind(source, id)
    .all<{ type: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.type, r.value]));
}

/**
 * Clic sur un bouton : pose sa valeur pour son type (la dernière gagne) ; un second clic sur la valeur posée la retire. Rend le
 * nouvel état et `on` (valeur posée après le clic). Une lecture, une écriture.
 */
export async function applyClick(
  db: D1Database,
  source: string,
  id: string,
  button: FeedbackButton,
  now: Date,
): Promise<{ state: FeedbackState; on: boolean }> {
  const state = await getFeedback(db, source, id);
  const on = state[button.type] !== button.value;
  if (on) {
    await db
      .prepare(
        "INSERT INTO feedback (source, listing_id, type, value, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (source, listing_id, type) DO UPDATE SET value = excluded.value, at = excluded.at",
      )
      .bind(source, id, button.type, button.value, now.toISOString())
      .run();
    state[button.type] = button.value;
  } else {
    await db
      .prepare("DELETE FROM feedback WHERE source = ? AND listing_id = ? AND type = ?")
      .bind(source, id, button.type)
      .run();
    delete state[button.type];
  }
  return { state, on };
}

/** Valeurs d'un filtre « suivi » du tableau de bord (?suivi=) : paramètre -> (type, value) de la table feedback. */
export const FOLLOW_FILTERS: Readonly<Record<string, { type: string; value: string }>> = {
  aime: { type: "avis", value: "aime" },
  appelee: { type: "appel", value: "oui" },
  visite: { type: "visite", value: "oui" },
};

/** Retours du jour (depuis `since`, ISO) : { aime, deteste, appel, visite } (une lecture D1 groupée). */
export async function feedbackCounts(
  db: D1Database,
  since: string,
): Promise<{ aime: number; deteste: number; appel: number; visite: number }> {
  const { results } = await db
    .prepare("SELECT type, value, COUNT(*) AS n FROM feedback WHERE at >= ? GROUP BY type, value")
    .bind(since)
    .all<{ type: string; value: string; n: number }>();
  const out = { aime: 0, deteste: 0, appel: 0, visite: 0 };
  for (const r of results) {
    if (r.type === "avis" && r.value === "aime") out.aime = r.n;
    else if (r.type === "avis" && r.value === "deteste") out.deteste = r.n;
    else if (r.type === "appel") out.appel = r.n;
    else if (r.type === "visite") out.visite = r.n;
  }
  return out;
}

/** Retours des annonces affichées (tableau de bord) : « source\u0000id » -> état. Borné à `limit` lignes les plus récentes. */
export async function feedbackMarkers(db: D1Database, limit: number): Promise<Map<string, FeedbackState>> {
  const { results } = await db
    .prepare("SELECT source, listing_id, type, value FROM feedback ORDER BY at DESC LIMIT ?")
    .bind(limit)
    .all<{ source: string; listing_id: string; type: string; value: string }>();
  const out = new Map<string, FeedbackState>();
  for (const r of results) {
    const k = `${r.source}\u0000${r.listing_id}`;
    const s = out.get(k) ?? {};
    s[r.type] = r.value;
    out.set(k, s);
  }
  return out;
}

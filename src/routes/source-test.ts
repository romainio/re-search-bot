import { settings } from "../derive";
import { detailCap, enrichOne } from "../enrich";
import { fetchSource } from "../fetch-source";
import { evaluate } from "../filter";
import { json } from "../http";
import { parseSource } from "../scan";
import type { Env } from "../types";
import { readUniversal } from "../universal/read";

/** GET /test?source=<id> : lit une source comme le cron, sans rien écrire, pour vérifier un lecteur en production. */
export async function sourceTestRoute(env: Env, url: URL): Promise<Response> {
  const s = settings();
  const src = s.sources.all.find((x) => x.id === url.searchParams.get("source"));
  if (!src) return json({ error: "source inconnue" }, 404);
  if (src.parser === "universal") {
    // Lecture par le modèle (dépense des neurons) ; page inchangée : aucun appel, sauf force=1.
    const u = await readUniversal(env, src, { persist: false, force: url.searchParams.get("force") === "1" });
    if (u.status === "ok") {
      return json({
        count: u.listings.length,
        unchanged: u.unchanged === true,
        savedNeurons: u.savedNeurons ?? 0,
        neurons: u.neurons ?? 0,
        listings: u.listings,
        evaluations: u.listings.map((l) => evaluate(l, src, s)),
      });
    }
    return json({ error: u.reason, skipped: u.status === "skipped" }, u.status === "skipped" ? 200 : 502);
  }
  if (src.virtual) return json({ error: "source virtuelle (alertes par mail) : rien à lire" }, 400);
  const res = await fetchSource(src);
  if (!res.ok) return json({ error: res.reason }, 502);
  const p = parseSource(src, res.body, res.truncated);
  if (!p.ok) return json({ error: p.reason }, 502);
  const evaluations = p.listings.map((l) => evaluate(l, src, s));
  // Fiches des premières annonces gardées ; une erreur de lecteur donne enriched: false, jamais un 500.
  const kept = p.listings.filter((_, i) => evaluations[i].keep).slice(0, detailCap(src));
  const enriched = await Promise.all(
    kept.map(async (l) => {
      const r = await enrichOne(src, l).catch(() => ({ listing: l, enriched: false, fields: [] as string[] }));
      return {
        id: l.id,
        enriched: r.enriched,
        fields: r.fields,
        listing: r.listing,
        evaluation: evaluate(r.listing, src, s),
      };
    }),
  );
  // Octets lus, arrêt au marqueur de fin (stopped), plafond atteint (truncated) : vérification de la lecture bornée.
  const read = { bytes: res.bytes, stopped: res.stopped, truncated: res.truncated };
  return json({ count: p.listings.length, read, listings: p.listings, evaluations, enriched });
}

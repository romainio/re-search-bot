import type { Listing } from "../types";
import { errMsg } from "../guards";

// Détection de changement : empreinte du texte réduit normalisé. Une page à l'empreinte de la dernière lecture réussie n'est pas
// relue par le modèle (0 neuron). La normalisation ne retire que ce que le modèle n'extrait jamais et qui varie sans que
// l'annonce change ; chaque motif est prudent (trop large, il masquerait un changement). Motifs linéaires : CPU borné.

/** Paramètres d'URL de suivi ou de session : jamais l'identité d'une annonce (le lien est normalisé de même par stableId). */
const URL_NOISE =
  /([?&])(?:utm_[a-z0-9_]*|fbclid|gclid|xtor|mc_[a-z]*|phpsessid|jsessionid|sessionid|sid|token|csrf|csrf_token|nonce|ts|timestamp|cb|cachebust|_)=[^&\s)#"']*/g;
/** Horodatage ISO complet (« 2026-11-09t14:32:05z »), comme ceux des données incrustées ou des attributs de date. */
const ISO_DATETIME = /\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?z?/g;
/** « mis à jour le 09/11/2026 » : seule une date de mise à jour est retirée ; « libre le 15/12 » reste. */
const UPDATED_DATE =
  /(?:mis(?:e)? à jour|mise en ligne|actualis[ée]e?|modifi[ée]e?|publi[ée]e?|ajout[ée]e?)\s*(?:le|:)?\s*\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/g;
/** « il y a 3 heures » : dérive à chaque lecture. */
const RELATIVE_TIME = /il y a \d+ (?:secondes?|minutes?|mins?|heures?|jours?|semaines?|mois|ans?)\b/g;
/** « mis à jour aujourd'hui / hier » : même dérive, quotidienne. */
const UPDATED_RELATIVE =
  /(?:mis(?:e)? à jour|actualis[ée]e?|modifi[ée]e?|publi[ée]e?|ajout[ée]e?)\s*(?:le\s+)?(?:aujourd['’]hui|hier)/g;
/** Heure affichée (« 14h32 », « 14:32 ») : horloge ou heure d'une mise à jour, jamais un champ extrait. */
const CLOCK = /\b\d{1,2}(?:h\s?\d{2}|:\d{2})\b/g;
/** Compteurs d'audience (« 1 234 vues ») ; pluriels seulement (« 1 vue sur le parc » est un titre). */
const COUNTERS = /\b\d{1,3}(?: \d{3})*(?:[.,]\d+)? ?(?:vues|consultations|visiteurs|visualisations)\b/g;

/** Texte normalisé : minuscules, motifs volatils retirés, espaces réduits, blocs d'annonces triés (l'ordre d'un carrousel ne compte pas). */
export function normalizeForFingerprint(text: string): string {
  const t = text
    .toLowerCase()
    .replace(URL_NOISE, "$1")
    .replace(/\?&+/g, "?") // « ?sid=x&a=1 » devient « ?a=1 » ; un « ? » ou « & » resté en fin de lien est retiré
    .replace(/[?&](?=[\s)"'#]|$)/g, "")
    .replace(ISO_DATETIME, "")
    // Les espaces insécables (« 1 350 ») valent des espaces avant les motifs qui en attendent.
    .replace(/[  ]/g, " ")
    .replace(UPDATED_DATE, "")
    .replace(UPDATED_RELATIVE, "")
    .replace(RELATIVE_TIME, "")
    .replace(CLOCK, "")
    .replace(COUNTERS, "");
  const blocks = t
    .split("\n---\n")
    .map((b) =>
      b
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean);
  return blocks.sort().join("\n---\n");
}

/** Empreinte : SHA-256 (crypto.subtle) du texte normalisé, 32 premiers caractères hexadécimaux (128 bits). */
export async function fingerprint(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeForFingerprint(text))),
  );
  let hex = "";
  for (let i = 0; i < 16; i++) hex += digest[i].toString(16).padStart(2, "0");
  return hex;
}

export interface UniversalState {
  fingerprint: string;
  listings: Listing[];
  count: number;
  neurons: number;
  readAt: string;
}

/** Dernière lecture réussie de la source ; null si aucune ou sur erreur (on relit alors par le modèle). */
export async function loadState(db: D1Database, source: string): Promise<UniversalState | null> {
  try {
    const row = await db
      .prepare("SELECT fingerprint, listings, count, neurons, read_at FROM universal_state WHERE source = ?")
      .bind(source)
      .first<{ fingerprint: string; listings: string; count: number; neurons: number; read_at: string }>();
    if (!row) return null;
    const listings = JSON.parse(row.listings) as unknown;
    if (!Array.isArray(listings) || listings.length !== row.count) return null;
    return {
      fingerprint: row.fingerprint,
      listings: listings as Listing[],
      count: row.count,
      neurons: row.neurons,
      readAt: row.read_at,
    };
  } catch {
    return null;
  }
}

/** Mémorise une lecture réussie ; un échec D1 coûte seulement une relecture. */
export async function saveState(
  db: D1Database,
  source: string,
  fp: string,
  listings: Listing[],
  neurons: number,
  now: Date,
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO universal_state (source, fingerprint, listings, count, neurons, read_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(source) DO UPDATE SET fingerprint = excluded.fingerprint, listings = excluded.listings, count = excluded.count, neurons = excluded.neurons, read_at = excluded.read_at",
      )
      .bind(source, fp, JSON.stringify(listings), listings.length, neurons, now.toISOString())
      .run();
  } catch (e) {
    console.error(`universal_state ${source}:`, errMsg(e));
  }
}

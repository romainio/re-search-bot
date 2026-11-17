import { DUP_PRICE_TOLERANCE, DUP_SURFACE_TOLERANCE, GONE_AFTER_HOURS, SEEN_REFRESH_HOURS } from "./config/scan";
import { settings } from "./derive";
import type { Settings } from "./derive";
import { evaluate, postalOf } from "./filter";
import type { GeoHints } from "./geo/hints";
import { findMatchCluster, getKnownRows, getSourceStatus, getTrackedRows, updateByIds } from "./store";
import type { ListingRow } from "./store";
import type { Evaluation, Listing, SourceDef } from "./types";
import { HOUR_MS } from "./time";

export { getPendingAlerts, markAlertSent } from "./store";
export type { PendingAlert } from "./store";

interface Fresh {
  source: string;
  postalCode: string | null;
  surface: number | null;
  rentCC: number | null;
  cluster: string;
}

function matches(a: Fresh, b: Fresh): boolean {
  return (
    a.source !== b.source &&
    a.postalCode !== null &&
    a.postalCode === b.postalCode &&
    a.surface !== null &&
    b.surface !== null &&
    Math.abs(a.surface - b.surface) <= DUP_SURFACE_TOLERANCE + 1e-9 &&
    a.rentCC !== null &&
    b.rentCC !== null &&
    Math.abs(a.rentCC - b.rentCC) < DUP_PRICE_TOLERANCE
  );
}

async function findCluster(db: D1Database, f: Fresh, added: Fresh[]): Promise<string | null> {
  if (f.postalCode === null || f.surface === null || f.rentCC === null) return null;
  const hit = await findMatchCluster(db, {
    postalCode: f.postalCode,
    surface: f.surface,
    rentCC: f.rentCC,
    surfaceTol: DUP_SURFACE_TOLERANCE,
    priceTol: DUP_PRICE_TOLERANCE,
    selfSource: f.source,
  });
  return hit ?? added.find((a) => matches(f, a))?.cluster ?? null;
}

/**
 * Lectures D1 d'une source avant traitement. `tracked` : lignes suivies encore en ligne (disparitions) ; `lastRun` : dernier
 * passage réussi ; `zones` : zones déjà initialisées (null si jamais enregistrées).
 */
export interface KnownState {
  wasInitialized: boolean;
  lastFailed: boolean;
  lastRun: string | null;
  zones: string[] | null;
  known: Map<string, ListingRow>;
  tracked: Map<string, ListingRow>;
}

/**
 * État connu des annonces d'une source, lu une fois par passage. Les lignes suivies d'abord, puis par id les seules autres
 * annonces du passage : aucune ligne n'est lue deux fois.
 */
export async function loadKnown(db: D1Database, src: SourceDef, listings: Listing[]): Promise<KnownState> {
  const status = await getSourceStatus(db, src.id);
  const tracked = await getTrackedRows(db, src.id);
  const known = new Map<string, ListingRow>();
  const rest: string[] = [];
  for (const id of new Set(listings.map((l) => l.id))) {
    const r = tracked.get(id);
    if (r) known.set(id, r);
    else rest.push(id);
  }
  for (const [id, r] of await getKnownRows(db, src.id, rest)) known.set(id, r);
  return {
    wasInitialized: status.initialized,
    lastFailed: status.failing,
    lastRun: status.lastRun,
    zones: status.zones,
    known,
    tracked,
  };
}

/**
 * Présence des annonces suivies après un passage réussi : une annonce revenue perd gone_at ; last_seen n'est réécrit qu'au-delà
 * de SEEN_REFRESH_HOURS. Une absente vue il y a plus de GONE_AFTER_HOURS et avant le passage réussi précédent (moins
 * SEEN_REFRESH_HOURS, le retard possible de last_seen) était déjà absente alors : elle est disparue. Passage vide ou sans
 * passage précédent connu : aucune disparition (une page cassée peut s'analyser sans erreur).
 */
function presenceUpdates(
  db: D1Database,
  src: SourceDef,
  uniq: Listing[],
  state: KnownState,
  now: Date,
): D1PreparedStatement[] {
  const iso = now.toISOString();
  const seenCutoff = new Date(now.getTime() - SEEN_REFRESH_HOURS * HOUR_MS).toISOString();
  const goneByAge = now.getTime() - GONE_AFTER_HOURS * HOUR_MS;
  const prev = state.lastRun ? Date.parse(state.lastRun) : NaN;
  const goneCutoff = Number.isNaN(prev)
    ? null
    : new Date(Math.min(goneByAge, prev - SEEN_REFRESH_HOURS * HOUR_MS)).toISOString();
  const back: string[] = [],
    refresh: string[] = [],
    gone: string[] = [];
  const present = new Set<string>();
  for (const l of uniq) {
    present.add(l.id);
    const row = state.known.get(l.id);
    if (!row || row.alert_status === "filtered") continue;
    if (row.gone_at !== null) back.push(l.id);
    else if (row.last_seen === null || row.last_seen < seenCutoff) refresh.push(l.id);
  }
  if (uniq.length > 0 && goneCutoff !== null) {
    for (const [id, r] of state.tracked)
      if (!present.has(id) && (r.last_seen ?? r.first_seen) < goneCutoff) gone.push(id);
  }
  return [
    ...updateByIds(db, "gone_at = NULL, last_seen = ?", iso, src.id, back),
    ...updateByIds(db, "last_seen = ?", iso, src.id, refresh),
    ...updateByIds(db, "gone_at = ?", iso, src.id, gone),
  ];
}

/**
 * Traite les annonces d'un passage. `listPrices` : prix de la page liste, avant fusion avec la fiche, gardé dans le payload :
 * une annonce connue n'est relue que sur la liste, la baisse de prix se juge donc liste contre liste.
 */
export async function processListings(
  db: D1Database,
  src: SourceDef,
  listings: Listing[],
  now: Date,
  state?: KnownState,
  listPrices?: Map<string, number | null>,
  geo?: Map<string, GeoHints>,
  s: Settings = settings(),
): Promise<{ inserted: number; pending: number }> {
  const listPrice = (l: Listing): number | null => (listPrices?.has(l.id) ? listPrices.get(l.id)! : l.price);
  const iso = now.toISOString();
  const uniq = [...new Map(listings.map((l) => [l.id, l])).values()];
  const st = state ?? (await loadKnown(db, src, uniq));
  const { wasInitialized, known } = st;
  // Zone ajoutée à une source déjà lue : la nouvelle URL révèle tout son stock. Ses annonces (et celles sans code postal, par
  // prudence) sont « silent » à ce seul passage. Zones jamais enregistrées : réputées celles de la configuration.
  const recorded = st.zones;
  const addedZones = recorded === null ? [] : src.zones.filter((z) => !recorded.includes(z));
  const inAddedZone = (l: Listing): boolean => {
    if (addedZones.length === 0) return false;
    const postal = postalOf(l, src, s);
    return postal === null || addedZones.includes(postal);
  };
  const stmts: D1PreparedStatement[] = presenceUpdates(db, src, uniq, st, now);
  const addedThisCall: Fresh[] = [];
  let inserted = 0;
  let pending = 0;

  for (const l of uniq) {
    const row = known.get(l.id);
    // Annonce connue : seule une annonce filtrée peut encore changer d'état (baisse de prix).
    if (row && row.alert_status !== "filtered") continue;

    const ev = evaluate(l, src, s);
    const rent = ev.rentCC ?? l.price;

    if (row) {
      if (!ev.keep) continue;
      let old: { evaluation?: Evaluation; listing?: { price?: unknown }; listPrice?: unknown; geo?: unknown } | null;
      try {
        old = JSON.parse(row.payload ?? "") as typeof old;
      } catch {
        console.error("process: payload illisible ignoré", src.id, l.id);
        continue;
      }
      // Baisse de prix : prix de la liste strictement plus bas que celui de la liste enregistré. Comparer au prix de fiche ferait
      // passer pour une baisse une annonce écartée « prix_haut » sur sa fiche puis relue sur la liste seule.
      const prev =
        typeof old?.listPrice === "number"
          ? old.listPrice
          : typeof old?.listing?.price === "number"
            ? old.listing.price
            : null;
      const cur = listPrice(l);
      if (old?.evaluation?.reason === "prix_haut" && prev !== null && cur !== null && cur < prev) {
        // Les indices de la première lecture sont conservés : l'annonce n'a pas changé de lieu.
        const payload = JSON.stringify({
          listing: l,
          evaluation: ev,
          listPrice: cur,
          ...(old?.geo && typeof old.geo === "object" ? { geo: old.geo } : {}),
        });
        const f: Fresh = {
          source: src.id,
          postalCode: l.postalCode,
          surface: l.surface,
          rentCC: rent,
          cluster: row.cluster,
        };
        const cluster = await findCluster(db, f, addedThisCall);
        if (cluster === null) pending++;
        else f.cluster = cluster;
        addedThisCall.push(f);
        stmts.push(
          db
            .prepare(
              "UPDATE listings SET alert_status = ?, alert_kind = ?, cluster = ?, rent_cc = ?, payload = ?, last_seen = ? WHERE source = ? AND listing_id = ?",
            )
            .bind(
              cluster === null ? "pending" : "duplicate",
              cluster === null ? "price_drop" : null,
              f.cluster,
              rent,
              payload,
              iso,
              src.id,
              l.id,
            ),
        );
      }
      continue;
    }

    const fresh: Fresh = {
      source: src.id,
      postalCode: l.postalCode,
      surface: l.surface,
      rentCC: rent,
      cluster: `${src.id}:${l.id}`,
    };
    let status: string;
    let kind: string | null = null;
    // Annonce écartée : alert_kind garde le motif, compté au tableau de bord.
    if (!ev.keep) {
      status = "filtered";
      kind = ev.reason ?? "inconnu";
    } else if (!wasInitialized || inAddedZone(l)) status = "silent";
    else {
      const cluster = await findCluster(db, fresh, addedThisCall);
      if (cluster !== null) {
        status = "duplicate";
        fresh.cluster = cluster;
      } else {
        status = "pending";
        kind = "new";
        pending++;
      }
    }
    if (ev.keep) addedThisCall.push(fresh);
    inserted++;
    const hints = geo?.get(l.id);
    const payload = JSON.stringify({
      listing: l,
      evaluation: ev,
      listPrice: listPrice(l),
      ...(hints ? { geo: hints } : {}),
    });
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO listings (source, listing_id, url, postal_code, surface, rent_cc, cluster, first_seen, last_seen, alert_status, alert_kind, payload, rooms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          src.id,
          l.id,
          l.url,
          l.postalCode,
          l.surface,
          rent,
          fresh.cluster,
          iso,
          iso,
          status,
          kind,
          payload,
          typeof l.rooms === "number" ? Math.round(l.rooms) : null,
        ),
    );
  }

  // Première lecture ou zones changées : initialized et zones en une écriture. Un passage vide n'enregistre pas de nouvelle zone,
  // sinon le suivant alerterait tout le stock de la zone au lieu de le taire.
  const zones = src.zones.join(",");
  if (!wasInitialized || st.zones === null || (st.zones.join(",") !== zones && uniq.length > 0)) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO source_state (source, initialized, zones) VALUES (?, 1, ?) ON CONFLICT(source) DO UPDATE SET initialized = 1, zones = excluded.zones",
        )
        .bind(src.id, zones),
    );
  }
  if (stmts.length > 0) await db.batch(stmts);
  return { inserted, pending };
}

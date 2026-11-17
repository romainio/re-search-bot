import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { markRun } from "../src/health";
import { getPendingAlerts, markAlertSent, processListings } from "../src/process";
import type { Listing, SourceDef } from "../src/types";

const mkSrc = (id: string, filteredToZones: boolean): SourceDef => ({
  id,
  name: id,
  url: "https://x",
  parser: "orpi",
  group: 1,
  filteredToZones,
  zones: ["75017"],
  phone: null,
  encoding: "utf-8",
  active: true,
});
const wagram = mkSrc("wagram", true);
const bienici = mkSrc("bienici", false);

const l = (source: string, id: string, o: Partial<Listing> = {}): Listing => ({
  source,
  id,
  url: `https://x/${id}`,
  price: null,
  charges: null,
  priceIsCC: null,
  surface: 40,
  rooms: null,
  title: null,
  address: null,
  district: null,
  postalCode: "75017",
  photo: null,
  agency: null,
  phone: null,
  propertyType: null,
  publishedAt: null,
  ...o,
});
const w = (id: string, o: Partial<Listing> = {}) => l("wagram", id, { priceIsCC: true, ...o });

const t = (n: number) => new Date(Date.UTC(2026, 9, 19, 8, n));
const db = () => env.DB;
const ids = async () => (await getPendingAlerts(db(), 10)).map((a) => a.id);

beforeEach(async () => {
  await db().batch([db().prepare("DELETE FROM listings"), db().prepare("DELETE FROM source_state")]);
});

describe("processListings", () => {
  it("premier passage silencieux, puis nouvelle annonce alertée", async () => {
    const r0 = await processListings(db(), wagram, [w("w1", { price: 1300 })], t(0));
    expect(r0).toEqual({ inserted: 1, pending: 0 });
    expect(await getPendingAlerts(db(), 10)).toHaveLength(0);
    const r1 = await processListings(
      db(),
      wagram,
      [w("w1", { price: 1300 }), w("w2", { price: 1400, surface: 35.6 })],
      t(1),
    );
    expect(r1).toEqual({ inserted: 1, pending: 1 });
    expect(await ids()).toEqual(["w2"]);
  });

  it("doublon inter-sources (HC + charges, surface arrondie autrement)", async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(db(), wagram, [w("w2", { price: 1400, surface: 35.6 })], t(1));
    await processListings(db(), bienici, [], t(1));
    await processListings(
      db(),
      bienici,
      [l("bienici", "b9", { price: 1300, charges: 100, priceIsCC: false, surface: 35.0 })],
      t(2),
    );
    expect(await ids()).toEqual(["w2"]);
    const row = await db().prepare("SELECT alert_status, cluster FROM listings WHERE listing_id = 'b9'").first();
    expect(row).toEqual({ alert_status: "duplicate", cluster: "wagram:w2" });
  });

  it("annonce deja vue : aucune nouvelle alerte ni ecriture", async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(db(), wagram, [w("w2", { price: 1400 })], t(1));
    await markAlertSent(db(), "wagram", "w2", t(2));
    const r = await processListings(db(), wagram, [w("w2", { price: 1400 })], t(3));
    expect(r).toEqual({ inserted: 0, pending: 0 });
    expect(await getPendingAlerts(db(), 10)).toHaveLength(0);
    const row = await db().prepare("SELECT alert_status, alerted_at FROM listings WHERE listing_id = 'w2'").first();
    expect(row).toEqual({ alert_status: "sent", alerted_at: t(2).toISOString() });
  });

  it("baisse de prix qui entre dans la fourchette", async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(db(), wagram, [w("w3", { price: 1750 })], t(3));
    expect(await getPendingAlerts(db(), 10)).toHaveLength(0);
    await processListings(db(), wagram, [w("w3", { price: 1590 })], t(4));
    expect(await getPendingAlerts(db(), 10)).toMatchObject([{ id: "w3", kind: "price_drop" }]);
  });

  it("annonce filtree pour une autre raison : jamais re-alertee", async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(db(), wagram, [w("w4", { price: 900 })], t(1));
    await processListings(db(), wagram, [w("w4", { price: 1300 })], t(2));
    expect(await getPendingAlerts(db(), 10)).toHaveLength(0);
  });

  const dropSetup = async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(db(), bienici, [], t(0));
    await processListings(db(), wagram, [w("w1", { price: 1500, surface: 35 })], t(1));
    await processListings(db(), bienici, [l("bienici", "b1", { price: 1700, priceIsCC: true, surface: 35 })], t(2));
  };
  const b1 = () => l("bienici", "b1", { price: 1500, priceIsCC: true, surface: 35 });

  it("baisse de prix : pas d'alerte si l'empreinte a deja ete alertee (envoyee)", async () => {
    await dropSetup();
    await markAlertSent(db(), "wagram", "w1", t(2));
    await processListings(db(), bienici, [b1()], t(3));
    expect(await getPendingAlerts(db(), 10)).toHaveLength(0);
    const row = await db().prepare("SELECT alert_status, cluster FROM listings WHERE listing_id = 'b1'").first();
    expect(row).toEqual({ alert_status: "duplicate", cluster: "wagram:w1" });
  });

  it("baisse de prix : pas de seconde alerte si l'autre copie est encore pending", async () => {
    await dropSetup();
    await processListings(db(), bienici, [b1()], t(3));
    expect(await ids()).toEqual(["w1"]);
  });

  it("baisse de prix sans correspondance : une alerte price_drop", async () => {
    await dropSetup();
    await processListings(db(), wagram, [w("w1", { price: 1500, surface: 35 })], t(3));
    await markAlertSent(db(), "wagram", "w1", t(3));
    await processListings(db(), bienici, [l("bienici", "b1", { price: 1500, priceIsCC: true, surface: 50 })], t(4));
    expect(await getPendingAlerts(db(), 10)).toMatchObject([{ id: "b1", kind: "price_drop" }]);
  });

  it("meme source : pas de rapprochement", async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(
      db(),
      wagram,
      [w("s1", { price: 1100, surface: 40 }), w("s2", { price: 1150, surface: 40.5 })],
      t(1),
    );
    expect(await ids()).toEqual(["s1", "s2"]);
  });

  it("scans concurrents : pas d'erreur, une seule ligne et une alerte", async () => {
    await processListings(db(), wagram, [], t(0));
    await Promise.all([
      processListings(db(), wagram, [w("c1", { price: 1300 })], t(1)),
      processListings(db(), wagram, [w("c1", { price: 1300 })], t(1)),
    ]);
    const n = await db().prepare("SELECT COUNT(*) AS n FROM listings WHERE listing_id = 'c1'").first<{ n: number }>();
    expect(n?.n).toBe(1);
    expect(await ids()).toEqual(["c1"]);
  });

  it("sans code postal : pas de rapprochement inter-sources", async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(db(), bienici, [], t(0));
    await processListings(db(), wagram, [w("n1", { price: 1300, surface: 40, postalCode: null })], t(1));
    await processListings(
      db(),
      bienici,
      [l("bienici", "n2", { price: 1300, priceIsCC: true, surface: 40, postalCode: null })],
      t(2),
    );
    expect((await getPendingAlerts(db(), 10)).map((a) => a.id).sort()).toEqual(["n1", "n2"]);
  });

  it("annonce connue non filtree : le payload stocke n'est ni relu ni reecrit", async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(db(), wagram, [w("k1", { price: 1300 })], t(1));
    // Payload illisible : seule une relecture (JSON.parse) le ferait echouer.
    await db().prepare("UPDATE listings SET payload = 'not json' WHERE listing_id = 'k1'").run();
    const r = await processListings(db(), wagram, [w("k1", { price: 1350 })], t(2));
    expect(r).toEqual({ inserted: 0, pending: 0 });
    const row = await db().prepare("SELECT payload FROM listings WHERE listing_id = 'k1'").first<{ payload: string }>();
    expect(row!.payload).toBe("not json");
  });

  it("payload filtre illisible : ligne ignoree, le reste du passage continue", async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(db(), wagram, [w("k2", { price: 1750 })], t(1));
    await db().prepare("UPDATE listings SET payload = 'not json' WHERE listing_id = 'k2'").run();
    const r = await processListings(
      db(),
      wagram,
      [w("k2", { price: 1500 }), w("k3", { price: 1300, surface: 44 })],
      t(2),
    );
    expect(r).toEqual({ inserted: 1, pending: 1 });
    expect(await ids()).toEqual(["k3"]);
  });

  it("payload pending illisible ou invalide : ignore par getPendingAlerts et sorti de la file", async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(
      db(),
      wagram,
      [w("g1", { price: 1300 }), w("g2", { price: 1350, surface: 50 }), w("g3", { price: 1400, surface: 60 })],
      t(1),
    );
    await db().prepare("UPDATE listings SET payload = 'not json' WHERE listing_id = 'g1'").run();
    await db().prepare("UPDATE listings SET payload = '{}' WHERE listing_id = 'g2'").run();
    expect(await ids()).toEqual(["g3"]);
    const rows = await db()
      .prepare(
        "SELECT listing_id, alert_status, alert_attempts FROM listings WHERE listing_id IN ('g1','g2') ORDER BY listing_id",
      )
      .all();
    expect(rows.results).toEqual([
      { listing_id: "g1", alert_status: "pending", alert_attempts: 5 },
      { listing_id: "g2", alert_status: "pending", alert_attempts: 5 },
    ]);
  });

  it("plus de 49 annonces connues : lecture par paquets", async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      w(`m${i}`, { price: 1300, surface: 35 + i, postalCode: "75017" }),
    );
    await processListings(db(), wagram, many, t(0));
    const r = await processListings(db(), wagram, many, t(1));
    expect(r).toEqual({ inserted: 0, pending: 0 });
  });
});

describe("annonces disparues (last_seen, gone_at)", () => {
  /** 9h00 Paris (07:00Z) + n heures + m minutes. */
  const h = (n: number, m = 0) => new Date(Date.UTC(2026, 9, 19, 7 + n, m));
  /** Base qui compte les lignes modifiées par les lots d'écritures (meta.changes de chaque instruction). */
  const counting = () => {
    let changes = 0;
    const d = new Proxy(env.DB, {
      get(target, k) {
        if (k === "batch")
          return async (s: D1PreparedStatement[]) => {
            const r = await target.batch(s);
            for (const x of r) changes += x.meta.changes ?? 0;
            return r;
          };
        const v = (target as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as D1Database;
    return {
      db: d,
      take: () => {
        const c = changes;
        changes = 0;
        return c;
      },
    };
  };
  const seen = async (id: string, source = "wagram") =>
    db()
      .prepare("SELECT last_seen, gone_at, alert_status FROM listings WHERE source = ? AND listing_id = ?")
      .bind(source, id)
      .first<{ last_seen: string | null; gone_at: string | null; alert_status: string }>();

  it("last_seen posé à l'insertion, puis réécrit seulement s'il a plus de 6 h (écritures comptées : aucune avant)", async () => {
    const c = counting();
    await processListings(c.db, wagram, [], h(0));
    await processListings(c.db, wagram, [w("a1", { price: 1300 })], h(0, 1));
    expect(await seen("a1")).toMatchObject({ last_seen: h(0, 1).toISOString(), gone_at: null });
    c.take();
    for (const at of [h(0, 6), h(1), h(5), h(6, 1)]) {
      // 6 h pile : pas plus vieux que 6 h
      await processListings(c.db, wagram, [w("a1", { price: 1300 })], at);
      expect(c.take(), at.toISOString()).toBe(0);
    }
    await processListings(c.db, wagram, [w("a1", { price: 1300 })], h(6, 2));
    expect(c.take()).toBe(1);
    expect((await seen("a1"))!.last_seen).toBe(h(6, 2).toISOString());
    await processListings(c.db, wagram, [w("a1", { price: 1300 })], h(7));
    expect(c.take()).toBe(0);
  });

  /** Passage réussi d'une source, comme dans runPart : traitement puis last_run = maintenant. */
  const pass = async (src: SourceDef, ls: Listing[], at: Date) => {
    await processListings(db(), src, ls, at);
    await markRun(db(), src.id, at);
  };

  it("gone_at : annonce suivie absente, vue il y a plus de 12 h et déjà absente au passage réussi précédent ; pas avant ; jamais filtrée ni autre source", async () => {
    await pass(wagram, [], h(0));
    await pass(bienici, [], h(0));
    await pass(
      wagram,
      [w("g1", { price: 1300 }), w("g2", { price: 1400, surface: 50 }), w("f1", { price: 5000 })],
      h(0, 1),
    );
    await pass(bienici, [l("bienici", "b1", { price: 1200, priceIsCC: true, surface: 70 })], h(0, 1));
    expect((await seen("f1"))!.alert_status).toBe("filtered");
    for (const at of [h(0, 6), h(6, 2), h(11), h(12, 1)]) {
      // 12 h pile : pas plus vieux que 12 h
      await pass(wagram, [w("g1", { price: 1300 })], at);
      expect((await seen("g2"))!.gone_at, at.toISOString()).toBeNull();
    }
    await pass(wagram, [w("g1", { price: 1300 })], h(12, 2));
    expect(await seen("g2")).toMatchObject({ gone_at: h(12, 2).toISOString(), alert_status: "pending" }); // l'alerte n'est pas touchée
    expect((await seen("g1"))!.gone_at).toBeNull();
    expect((await seen("f1"))!.gone_at).toBeNull(); // filtrée : jamais suivie
    expect((await seen("b1", "bienici"))!.gone_at).toBeNull(); // autre source
    expect(await ids()).toEqual(["b1", "g1", "g2"]); // aucune alerte ajoutée ni retirée
  });

  it("garantie : last_seen = T ; x absente dès T+5 min, y présente jusqu'à T+5h05 (sans réécriture) : aucune disparue avant T+12 h, les deux après ; une présence réécrit last_seen au plus 6 h après, donc jamais disparue après moins de 6 h d'absence", async () => {
    await pass(wagram, [], h(0));
    await pass(
      wagram,
      [w("x", { price: 1300 }), w("y", { price: 1400, surface: 50 }), w("k", { price: 1250, surface: 60 })],
      h(0),
    ); // T = h(0)
    const keep = w("k", { price: 1250, surface: 60 }),
      y = w("y", { price: 1400, surface: 50 });
    for (let m = 5; m <= 12 * 60; m += 30) {
      // passages toutes les 30 min, de T+5 min à T+11h35
      await pass(wagram, m <= 5 * 60 + 30 ? [keep, y] : [keep], h(0, m));
      expect([(await seen("x"))!.gone_at, (await seen("y"))!.gone_at], `T+${m} min`).toEqual([null, null]);
    }
    expect((await seen("y"))!.last_seen).toBe(h(0).toISOString()); // présente jusqu'à T+5h05 sans réécriture (moins de 6 h)
    await pass(wagram, [keep], h(12)); // 12 h pile
    expect((await seen("x"))!.gone_at).toBeNull();
    await pass(wagram, [keep], h(12, 5));
    expect((await seen("x"))!.gone_at).toBe(h(12, 5).toISOString());
    expect((await seen("y"))!.gone_at).toBe(h(12, 5).toISOString()); // absente depuis T+5h35 : plus de 6 h d'absence
  });

  it("passage du matin : vue la veille (il y a 19 h) et présente au dernier passage de la veille (il y a 18 h), manquée au seul premier passage du matin : pas disparue ; absente aussi au passage suivant : disparue", async () => {
    const d1 = (hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 18, hh, mm)); // veille, heure UTC
    await pass(wagram, [], d1(7));
    await pass(
      wagram,
      [w("m1", { price: 1300 }), w("m2", { price: 1400, surface: 50 }), w("k", { price: 1250, surface: 60 })],
      d1(12),
    ); // vue il y a 19 h
    await pass(
      wagram,
      [w("m1", { price: 1300 }), w("m2", { price: 1400, surface: 50 }), w("k", { price: 1250, surface: 60 })],
      d1(13),
    ); // dernier passage, présentes (pas de réécriture)
    expect((await seen("m1"))!.last_seen).toBe(d1(12).toISOString());
    const k = w("k", { price: 1250, surface: 60 });
    await pass(wagram, [k], h(0)); // 9h00 : m1, m2 manquées ; vues il y a 19 h mais présentes au passage précédent (18 h)
    expect([(await seen("m1"))!.gone_at, (await seen("m2"))!.gone_at]).toEqual([null, null]);
    await pass(wagram, [k, w("m1", { price: 1300 })], h(0, 5)); // m1 revient ; m2 absente une seconde fois
    expect(await seen("m1")).toEqual({ last_seen: h(0, 5).toISOString(), gone_at: null, alert_status: "pending" });
    expect((await seen("m2"))!.gone_at).toBe(h(0, 5).toISOString());
  });

  it("sans passage réussi précédent connu (last_run nul) : aucune disparition", async () => {
    await processListings(db(), wagram, [], h(0));
    await processListings(db(), wagram, [w("n1", { price: 1300 }), w("k", { price: 1250, surface: 60 })], h(0, 1));
    await processListings(db(), wagram, [w("k", { price: 1250, surface: 60 })], h(20));
    expect((await seen("n1"))!.gone_at).toBeNull();
  });

  it("résultat vide (page vide ou cassée) : aucune annonce marquée disparue", async () => {
    await pass(wagram, [], h(0));
    await pass(wagram, [w("e1", { price: 1300 })], h(0, 1));
    await pass(wagram, [], h(13));
    await pass(wagram, [], h(14));
    expect((await seen("e1"))!.gone_at).toBeNull();
  });

  it("silent, sent et duplicate sont suivis ; une annonce disparue qui réapparaît : gone_at remis à NULL, last_seen = maintenant, aucune alerte", async () => {
    await pass(wagram, [w("s1", { price: 1300, surface: 60 })], h(0)); // premier passage : silent
    await pass(bienici, [], h(0));
    await pass(wagram, [w("s1", { price: 1300, surface: 60 }), w("p1", { price: 1400, surface: 45 })], h(0, 1));
    await markAlertSent(db(), "wagram", "p1", h(0, 2));
    await pass(bienici, [l("bienici", "d1", { price: 1400, priceIsCC: true, surface: 45 })], h(0, 3));
    expect((await seen("d1", "bienici"))!.alert_status).toBe("duplicate");
    const x = w("x", { price: 1300, surface: 80 }),
      y = l("bienici", "y", { price: 1300, priceIsCC: true, surface: 90 });
    await pass(wagram, [x], h(7));
    await pass(bienici, [y], h(7));
    await pass(wagram, [x], h(13));
    await pass(bienici, [y], h(13));
    for (const [id, src] of [
      ["s1", "wagram"],
      ["p1", "wagram"],
      ["d1", "bienici"],
    ])
      expect((await seen(id, src))!.gone_at, id).toBe(h(13).toISOString());
    await markAlertSent(db(), "wagram", "x", h(7, 1));
    await markAlertSent(db(), "bienici", "y", h(7, 1));

    await pass(wagram, [x, w("p1", { price: 1400, surface: 45 })], h(14));
    expect(await seen("p1")).toEqual({ last_seen: h(14).toISOString(), gone_at: null, alert_status: "sent" });
    expect((await seen("s1"))!.gone_at).toBe(h(13).toISOString()); // toujours absente
    expect(await getPendingAlerts(db(), 10)).toHaveLength(0);
  });

  it("lignes suivies : plan par l'index listings_gone (EXPLAIN QUERY PLAN de la base D1 de test), jamais toutes les lignes de la source par la clé primaire", async () => {
    const { TRACKED_ROWS_SQL } = await import("../src/store");
    const { results } = await db()
      .prepare(`EXPLAIN QUERY PLAN ${TRACKED_ROWS_SQL}`)
      .bind("wagram", 500)
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail).join("\n");
    expect(plan).toContain("USING INDEX listings_gone");
    expect(plan).not.toContain("sqlite_autoindex_listings_1");
  });

  it("lignes suivies lues dans un ordre déterministe (listing_id), sous la borne TRACKED_LIMIT", async () => {
    await processListings(db(), wagram, [], h(0));
    await processListings(
      db(),
      wagram,
      ["z", "a", "m"].map((id, i) => w(id, { price: 1300 + i * 10, surface: 40 + i })),
      h(0, 1),
    );
    const { getTrackedRows } = await import("../src/store");
    expect([...(await getTrackedRows(db(), "wagram")).keys()]).toEqual(["a", "m", "z"]);
  });

  it("baisse de prix d'une annonce filtrée : last_seen posé avec le nouveau statut (suivie dès lors)", async () => {
    await processListings(db(), wagram, [], h(0));
    await processListings(db(), wagram, [w("pd", { price: 1750 })], h(0, 1));
    await processListings(db(), wagram, [w("pd", { price: 1590 })], h(9));
    expect(await seen("pd")).toEqual({ last_seen: h(9).toISOString(), gone_at: null, alert_status: "pending" });
  });

  it("lignes suivies lues une fois : une annonce présente déjà dans la lecture des lignes suivies n'est pas relue par id", async () => {
    await processListings(db(), wagram, [], h(0));
    await processListings(db(), wagram, [w("r1", { price: 1300 }), w("r2", { price: 5000 })], h(0, 1));
    const byId: unknown[][] = [];
    const spyDb = new Proxy(env.DB, {
      get(target, k) {
        if (k === "prepare")
          return (sql: string) => {
            const st = target.prepare(sql);
            if (!/^SELECT/.test(sql.trim()) || !/listing_id IN/.test(sql)) return st;
            return new Proxy(st, {
              get(s, m) {
                const v = (s as unknown as Record<string | symbol, unknown>)[m];
                return m === "bind"
                  ? (...a: unknown[]) => {
                      byId.push(a);
                      return s.bind(...a);
                    }
                  : typeof v === "function"
                    ? (v as (...x: unknown[]) => unknown).bind(s)
                    : v;
              },
            });
          };
        const v = (target as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as D1Database;
    const { loadKnown } = await import("../src/process");
    const st = await loadKnown(spyDb, wagram, [w("r1"), w("r2"), w("r3")]);
    expect([...st.known.keys()].sort()).toEqual(["r1", "r2"]);
    expect(byId.flat()).not.toContain("r1"); // suivie (pending) : déjà lue
    expect(byId.flat()).toEqual(expect.arrayContaining(["r2", "r3"])); // filtrée et nouvelle : lues par id
  });
});

describe("zone ajoutée à une source déjà lue (Bien'ici bi-zone) : premier passage silencieux pour cette zone", () => {
  const before = mkSrc("bienici", true); // zones ["75017"]
  const after: SourceDef = { ...before, zones: ["75017", "92300"] };
  const b = (id: string, o: Partial<Listing> = {}) => l("bienici", id, { price: 1300, priceIsCC: true, ...o });
  const status = async (id: string) =>
    (
      await db()
        .prepare("SELECT alert_status FROM listings WHERE source = 'bienici' AND listing_id = ?")
        .bind(id)
        .first<{ alert_status: string }>()
    )?.alert_status;
  const stateRow = () =>
    db()
      .prepare("SELECT initialized, zones FROM source_state WHERE source = 'bienici'")
      .first<{ initialized: number; zones: string | null }>();

  it("source initialisée avant la colonne zones (NULL) : réputée couvrir les zones de sa configuration, rien de silencieux ; zones enregistrées", async () => {
    await db().prepare("INSERT INTO source_state (source, initialized) VALUES ('bienici', 1)").run();
    await processListings(db(), after, [b("p1"), b("v1", { postalCode: "92300", surface: 41 })], t(0));
    expect([await status("p1"), await status("v1")]).toEqual(["pending", "pending"]);
    expect(await stateRow()).toEqual({ initialized: 1, zones: "75017,92300" });
  });

  it("zone ajoutée à une source dont les zones sont enregistrées : annonces nouvelles de la zone ajoutée silent, celles des autres alertées ; zones enregistrées ; au passage suivant la zone ajoutée est alertée", async () => {
    await db().prepare("INSERT INTO source_state (source, initialized) VALUES ('bienici', 1)").run();
    await processListings(db(), before, [b("p1")], t(0));
    expect(await status("p1")).toBe("pending");
    expect(await stateRow()).toEqual({ initialized: 1, zones: "75017" }); // zones jamais enregistrées : celles de la configuration

    const r = await processListings(
      db(),
      after,
      [
        b("p1"),
        b("p2", { surface: 50 }), // nouvelle du 17e : alertée
        b("v1", { postalCode: "92300", surface: 41 }), // stock de Levallois révélé par la nouvelle URL
        b("v2", { postalCode: null, title: "Appartement Levallois-Perret 2 pièces", surface: 45 }),
        b("v3", { postalCode: null, surface: 60 }), // zone inconnue : silencieuse par prudence au seul premier passage
        b("v4", { postalCode: "92300", price: 2500 }), // filtrée, comme toujours
      ],
      t(1),
    );
    expect(r).toEqual({ inserted: 5, pending: 1 });
    expect(await ids()).toEqual(["p1", "p2"]);
    expect([await status("v1"), await status("v2"), await status("v3"), await status("v4")]).toEqual([
      "silent",
      "silent",
      "silent",
      "filtered",
    ]);
    expect(await stateRow()).toEqual({ initialized: 1, zones: "75017,92300" });

    const r2 = await processListings(
      db(),
      after,
      [b("v1", { postalCode: "92300" }), b("v5", { postalCode: "92300", surface: 70 }), b("p3", { surface: 80 })],
      t(2),
    );
    expect(r2).toEqual({ inserted: 2, pending: 2 });
    expect(await ids()).toEqual(["p1", "p2", "p3", "v5"]);
  });

  it("source nouvelle : premier passage silencieux comme avant, zones enregistrées avec initialized ; passage suivant alerté sans réécrire l'état", async () => {
    const lev: SourceDef = { ...mkSrc("bienici", true), zones: ["92300"] };
    await processListings(db(), lev, [b("x1", { postalCode: "92300" }), b("x2", { postalCode: "75017" })], t(0));
    expect([await status("x1"), await status("x2")]).toEqual(["silent", "silent"]);
    expect(await stateRow()).toEqual({ initialized: 1, zones: "92300" });
    await processListings(
      db(),
      lev,
      [b("x3", { postalCode: "92300", surface: 55 }), b("x4", { postalCode: "75017", surface: 65 })],
      t(1),
    );
    expect(await ids()).toEqual(["x3", "x4"]);
  });

  it("M1 : passage vide après l'ajout de la zone (page vide ou partielle) : zones non enregistrées, le silence est gardé pour le premier passage non vide", async () => {
    await db().prepare("INSERT INTO source_state (source, initialized, zones) VALUES ('bienici', 1, '75017')").run();
    expect(await processListings(db(), after, [], t(0))).toEqual({ inserted: 0, pending: 0 });
    expect(await stateRow()).toEqual({ initialized: 1, zones: "75017" });
    await processListings(db(), after, [b("v1", { postalCode: "92300", surface: 41 }), b("p2", { surface: 50 })], t(1));
    expect([await status("v1"), await status("p2")]).toEqual(["silent", "pending"]);
    expect(await ids()).toEqual(["p2"]);
    expect(await stateRow()).toEqual({ initialized: 1, zones: "75017,92300" });
  });

  it("zones inchangées : aucune écriture dans source_state (budget D1) ; zone retirée : zones mises à jour, rien de silencieux", async () => {
    await processListings(db(), after, [], t(0));
    expect(await stateRow()).toEqual({ initialized: 1, zones: "75017,92300" });
    await db().prepare("UPDATE source_state SET last_count = 7 WHERE source = 'bienici'").run();
    const stmts: string[] = [];
    const spyDb = new Proxy(env.DB, {
      get(target, k) {
        if (k === "prepare")
          return (sql: string) => {
            stmts.push(sql);
            return target.prepare(sql);
          };
        const v = (target as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as D1Database;
    await processListings(spyDb, after, [b("q1", { postalCode: "92300", surface: 40 })], t(1));
    expect(stmts.filter((s) => /source_state/.test(s) && !/^\s*SELECT/.test(s))).toEqual([]);
    expect(await ids()).toEqual(["q1"]);
    await processListings(db(), before, [b("q2", { postalCode: "92300", surface: 42 })], t(2));
    expect(await stateRow()).toEqual({ initialized: 1, zones: "75017" });
    expect(await ids()).toEqual(["q1", "q2"]);
  });
});

describe("motif d'écart des annonces filtrées (alert_kind)", () => {
  const row = async (id: string) =>
    db()
      .prepare("SELECT alert_status, alert_kind FROM listings WHERE source = 'wagram' AND listing_id = ?")
      .bind(id)
      .first<{ alert_status: string; alert_kind: string | null }>();

  it("chaque motif est conservé ; une annonce gardée n'en porte pas ; alerte new inchangée", async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(
      db(),
      wagram,
      [
        w("fh", { price: 1700 }),
        w("fb", { price: 900 }),
        w("fs", { price: 1300, surface: 20 }),
        w("ft", { price: 1300, propertyType: "Parking" }),
        w("fl", { price: 1300, postalCode: "75018" }),
        w("ok", { price: 1300 }),
      ],
      t(1),
    );
    expect(await row("fh")).toEqual({ alert_status: "filtered", alert_kind: "prix_haut" });
    expect(await row("fb")).toEqual({ alert_status: "filtered", alert_kind: "prix_bas" });
    expect(await row("fs")).toEqual({ alert_status: "filtered", alert_kind: "surface" });
    expect(await row("ft")).toEqual({ alert_status: "filtered", alert_kind: "type" });
    expect(await row("fl")).toEqual({ alert_status: "filtered", alert_kind: "localisation" });
    expect(await row("ok")).toEqual({ alert_status: "pending", alert_kind: "new" });
  });

  it("seul prix_haut déclenche une baisse de prix ; la ligne devient une alerte price_drop (motif remplacé)", async () => {
    await processListings(db(), wagram, [], t(0));
    await processListings(
      db(),
      wagram,
      [w("h", { price: 1700 }), w("b", { price: 900 }), w("s", { price: 1300, surface: 20 })],
      t(1),
    );
    await processListings(
      db(),
      wagram,
      [w("h", { price: 1500 }), w("b", { price: 1300 }), w("s", { price: 1300, surface: 50 })],
      t(2),
    );
    expect(await row("h")).toEqual({ alert_status: "pending", alert_kind: "price_drop" });
    expect(await row("b")).toEqual({ alert_status: "filtered", alert_kind: "prix_bas" });
    expect(await row("s")).toEqual({ alert_status: "filtered", alert_kind: "surface" });
  });
});

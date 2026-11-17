import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKET_MIN_SAMPLE } from "../src/config/market";
import { renderDashboard } from "../src/dashboard/render";
import { settings } from "../src/derive";
import {
  dailySeries,
  loadMarket,
  marketHint,
  marketLine,
  refreshMarketStats,
  roomsBucket,
  trendLine,
  trendOf,
} from "../src/market";
import { formatTelegram } from "../src/notify/format";
import { sendPendingAlerts } from "../src/notify/send";
import { getPendingAlerts, processListings } from "../src/process";
import { buildDailySummary } from "../src/summary";
import type { Env, Evaluation, Listing, SourceDef } from "../src/types";

const cfg = settings();

const NOW = new Date("2026-11-09T12:00:00.000Z");
const H = 3_600_000,
  D = 24 * H;
const ago = (ms: number, from = NOW): string => new Date(from.getTime() - ms).toISOString();
const db = () => env.DB;
const E = (o: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  WHATSAPP_ENABLED: "false",
  ...o,
});
const src: SourceDef = {
  id: "wagram",
  name: "Wagram",
  url: "https://x",
  parser: "orpi",
  group: 1,
  filteredToZones: true,
  zones: ["75017"],
  phone: null,
  encoding: "utf-8",
  active: true,
};
const P17 = cfg.zones[0];

interface Seed {
  id: string;
  status?: string;
  zone?: string;
  rooms?: number | null;
  age?: number;
  life?: number | null;
  rent?: number;
  surface?: number;
  cluster?: string;
}
let n = 0;
/** Insère une ligne : `age` = ancienneté de first_seen (ms), `life` = durée avant gone_at (ms ; null = encore en ligne). */
function row(o: Seed): D1PreparedStatement {
  const first = ago(o.age ?? 20 * D);
  const gone = o.life == null ? null : new Date(Date.parse(first) + o.life).toISOString();
  return db()
    .prepare(
      `INSERT INTO listings (source, listing_id, url, postal_code, surface, rent_cc, cluster, first_seen, last_seen, gone_at, alert_status, payload, rooms)
     VALUES ('wagram', ?, 'https://x', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    )
    .bind(
      o.id,
      o.zone ?? "75017",
      o.surface ?? 40,
      o.rent ?? 1200,
      o.cluster ?? `wagram:${o.id}`,
      first,
      first,
      gone,
      o.status ?? "sent",
      o.rooms === undefined ? 2 : o.rooms,
    );
}
const seed = (rows: Seed[]) => db().batch(rows.map(row));
/** `count` annonces d'un groupe, durées de vie `life(i)` (i de 1 à count). */
const group = (prefix: string, count: number, o: (i: number) => Partial<Seed>): Seed[] =>
  Array.from({ length: count }, (_, k) => ({ id: `${prefix}${k + 1}${n++}`, ...o(k + 1) }));
const cell = async (zone: string, bucket: string) => (await loadMarket(db()))!.cells.get(`${zone}|${bucket}`);

beforeEach(async () => {
  await db().batch(
    ["listings", "source_state", "market_stats", "market_daily", "market_meta"].map((t) =>
      db().prepare(`DELETE FROM ${t}`),
    ),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("médianes (SQL)", () => {
  it("durée de vie médiane par tranche et par zone ; prix au m² médian", async () => {
    await seed([
      // 2 pièces, 9 annonces disparues en 1 à 9 jours -> médiane 5 j ; loyers 1 000 à 2 600 € sur 40 m² -> 25 à 65 €/m², médiane 45
      ...group("a", 9, (i) => ({ rooms: 2, life: i * D, rent: 800 + i * 200 })),
      // 3 pièces : durées de 6 h en 6 h (9 annonces) -> médiane 30 h
      ...group("b", 9, (i) => ({ rooms: 3, life: i * 6 * H, rent: 1500, surface: 50 })),
    ]);
    expect(await refreshMarketStats(db(), NOW)).toBe("recalculé");
    const c2 = (await cell("75017", "2"))!;
    expect(c2.lifeN).toBe(9);
    expect(c2.lifeMedianH).toBeCloseTo(5 * 24, 3);
    expect(c2.m2Median).toBeCloseTo(45, 5);
    expect((await cell("75017", "3"))!.lifeMedianH).toBeCloseTo(30, 3);
    expect((await cell("75017", "3"))!.m2Median).toBeCloseTo(30, 5);
    // zone entière : 18 annonces, médiane = moyenne des 9e et 10e durées triées
    const all = (await cell("75017", "all"))!;
    expect(all.lifeN).toBe(18);
    const hours = [
      ...Array.from({ length: 9 }, (_, k) => (k + 1) * 24),
      ...Array.from({ length: 9 }, (_, k) => (k + 1) * 6),
    ].sort((a, b) => a - b);
    expect(all.lifeMedianH).toBeCloseTo((hours[8] + hours[9]) / 2, 3);
  });

  it("médiane paire : moyenne des deux valeurs centrales", async () => {
    await seed(group("e", 10, (i) => ({ rooms: 2, life: i * D, rent: 1200 })));
    await refreshMarketStats(db(), NOW);
    expect((await cell("75017", "2"))!.lifeMedianH).toBeCloseTo(5.5 * 24, 3);
  });

  it("zones séparées (Levallois à part)", async () => {
    await seed([
      ...group("p", 9, (i) => ({ zone: "75017", life: i * D, rent: 1000 })),
      ...group("q", 9, (i) => ({ zone: "92300", life: Math.min(2 * i * D, 9 * D), rent: 1400 })),
    ]);
    await refreshMarketStats(db(), NOW);
    expect((await cell("75017", "all"))!.m2Median).toBeCloseTo(25, 5);
    expect((await cell("92300", "all"))!.m2Median).toBeCloseTo(35, 5);
  });
});

describe("censure, doublons, filtrées", () => {
  it("annonces encore en ligne : jamais comptées comme durées courtes (médiane inconnue si la moitié n'a pas disparu)", async () => {
    await seed([
      ...group("g", 4, (i) => ({ life: i * D })), // 1 à 4 jours
      ...group("o", 5, () => ({ life: null })), // encore en ligne (détectées il y a 20 j)
    ]);
    await refreshMarketStats(db(), NOW);
    const c = (await cell("75017", "2"))!;
    expect(c.lifeN).toBe(9);
    expect(c.lifeMedianH).toBeNull(); // médiane au-delà de l'horizon : jamais 3 j
    // 5 disparues sur 9 : le rang central est une durée connue
    await db()
      .prepare("UPDATE listings SET gone_at = ? WHERE listing_id LIKE 'o1%'")
      .bind(ago(10 * D))
      .run();
    await db()
      .prepare("UPDATE market_meta SET computed_at = ?")
      .bind(ago(2 * H))
      .run();
    await refreshMarketStats(db(), NOW);
    expect((await cell("75017", "2"))!.lifeMedianH).not.toBeNull();
  });

  it("disparue après l'horizon, ou détectée trop récemment : hors de la durée courte / de la cohorte", async () => {
    await seed([
      ...group("l", 8, (i) => ({ life: i * D })),
      { id: "late", life: 12 * D, age: 25 * D }, // disparue après 12 j > horizon : censurée
      { id: "recent", life: 1 * D, age: 5 * D }, // détectée il y a 5 j : hors cohorte (horizon 10 j)
    ]);
    await refreshMarketStats(db(), NOW);
    const c = (await cell("75017", "2"))!;
    expect(c.lifeN).toBe(9); // 8 + « late » ; « recent » exclue
    // durées triées : 1..8 j puis censurée ; rang central = 5e = 5 j
    expect(c.lifeMedianH).toBeCloseTo(5 * 24, 3);
  });

  it("doublons (cluster) comptés une fois ; annonce encore en ligne sur une autre source : le cluster reste en ligne", async () => {
    const rows = group("c", 9, (i) => ({ life: i * D }));
    await seed(rows);
    // un doublon par annonce : même cluster, statut duplicate
    await seed(
      rows.map((r) => ({ id: `${r.id}d`, status: "duplicate", cluster: `wagram:${r.id}`, age: r.age, life: r.life })),
    );
    await refreshMarketStats(db(), NOW);
    expect((await cell("75017", "2"))!.lifeN).toBe(9);
    expect((await cell("75017", "2"))!.m2N).toBe(9);
    // la première annonce (1 j) reste en ligne sur le doublon : cluster censuré, la médiane ne bouge pas (rang 5)
    await db().prepare("UPDATE listings SET gone_at = NULL WHERE listing_id = ?").bind(`${rows[0].id}d`).run();
    await db()
      .prepare("UPDATE market_meta SET computed_at = ?")
      .bind(ago(2 * H))
      .run();
    await refreshMarketStats(db(), NOW);
    // durées : 2..9 j puis censurée (la 1re) : 9 valeurs, rang 5 = 6 j
    expect((await cell("75017", "2"))!.lifeMedianH).toBeCloseTo(6 * 24, 3);
  });

  it("annonces filtrées et « silent » ignorées", async () => {
    await seed([
      ...group("k", 9, (i) => ({ life: i * D })),
      ...group("f", 20, (i) => ({ status: "filtered", life: 1 * H * i, rent: 100 })),
      ...group("s", 20, () => ({ status: "silent", life: 1 * H, rent: 100 })),
    ]);
    await refreshMarketStats(db(), NOW);
    const c = (await cell("75017", "2"))!;
    expect(c.lifeN).toBe(9);
    expect(c.lifeMedianH).toBeCloseTo(5 * 24, 3);
    expect(c.m2N).toBe(29); // le prix compte aussi les « silent » (stock d'une zone ajoutée), jamais les filtrées
  });

  it("surface aberrante ou loyer nul : hors du prix au m²", async () => {
    await seed([
      ...group("z", 9, () => ({ life: D })),
      { id: "tiny", surface: 1, rent: 1200 },
      { id: "zero", rent: 0 },
    ]);
    await refreshMarketStats(db(), NOW);
    expect((await cell("75017", "2"))!.m2N).toBe(9);
  });
});

describe("effectif minimum", () => {
  it("sous le minimum : ni indice ni ligne de tableau", async () => {
    await seed(group("m", MARKET_MIN_SAMPLE - 1, (i) => ({ life: i * D })));
    await refreshMarketStats(db(), NOW);
    const m = (await loadMarket(db()))!;
    expect((await cell("75017", "2"))!.lifeN).toBe(MARKET_MIN_SAMPLE - 1);
    const ev: Evaluation = { keep: true, rentCC: 900, flags: [] };
    const lst = { rooms: 2, surface: 40, price: 900 } as Listing;
    expect(marketHint(m, lst, ev, P17)).toBeNull();
    const html = await renderDashboard(db(), [src], NOW);
    expect(html).toContain("Marché (30 jours)");
    expect(html).not.toContain('id="marche"');
    expect(html).toContain("Pas encore assez");
  });

  it("au minimum : affiché", async () => {
    await seed(group("m", MARKET_MIN_SAMPLE, (i) => ({ life: i * D })));
    await refreshMarketStats(db(), NOW);
    expect(await renderDashboard(db(), [src], NOW)).toContain('id="marche"');
  });
});

describe("fraîcheur des agrégats", () => {
  it("pas de recalcul avant 1 h, recalcul à 1 h", async () => {
    await seed(group("t", 9, (i) => ({ life: i * D })));
    expect(await refreshMarketStats(db(), NOW)).toBe("recalculé");
    await seed(group("u", 9, (i) => ({ rooms: 3, life: i * D })));
    expect(await refreshMarketStats(db(), new Date(NOW.getTime() + 59 * 60_000))).toBe("à jour");
    expect(await cell("75017", "3")).toBeUndefined();
    expect(await refreshMarketStats(db(), new Date(NOW.getTime() + 60 * 60_000))).toBe("recalculé");
    expect((await cell("75017", "3"))!.lifeN).toBe(9);
  });

  it("avant le premier calcul : loadMarket vaut null et le tableau de bord l'indique", async () => {
    expect(await loadMarket(db())).toBeNull();
    expect(await renderDashboard(db(), [src], NOW)).toContain("en cours de calcul");
  });
});

describe("indices par annonce", () => {
  const ev = (rent: number): Evaluation => ({ keep: true, rentCC: rent, flags: [] });
  const lst = (rooms: number | null, surface = 40): Listing => ({ rooms, surface }) as Listing;
  beforeEach(async () => {
    await seed([
      ...group("a", 9, (i) => ({ rooms: 2, life: i * D, rent: 1200 })), // 30 €/m², médiane 5 j
      ...group("b", 9, (i) => ({ rooms: 3, life: i * 6 * H, rent: 1500, surface: 50 })), // 30 €/m², médiane 30 h
      ...group("c", 3, (i) => ({ rooms: 1, life: i * D, rent: 800, surface: 20 })), // trop peu : repli sur la zone
    ]);
    await refreshMarketStats(db(), NOW);
  });

  it("écart au prix médian de la zone et de la tranche", async () => {
    const m = await loadMarket(db());
    expect(marketHint(m, lst(2), ev(1104), P17)!.gap).toBe("−8 % vs médiane Paris 17 · 2 p.");
    expect(marketHint(m, lst(2), ev(1320), P17)!.gap).toBe("+10 % vs médiane Paris 17 · 2 p.");
    expect(marketHint(m, lst(2), ev(1200), P17)!.gap).toBe("≈ médiane Paris 17 · 2 p.");
  });

  it("tranche sans effectif ou pièces inconnues : repli sur la zone entière ; zone ou surface inconnue : pas d'écart", async () => {
    const m = await loadMarket(db());
    expect(marketHint(m, lst(1, 20), ev(500), P17)!.gap).toMatch(/^−\d+ % vs médiane Paris 17$/);
    expect(marketHint(m, lst(null), ev(1104), P17)!.gap).toBe("−8 % vs médiane Paris 17");
    expect(marketHint(m, lst(2, 0), ev(1104), P17)?.gap ?? null).toBeNull();
    expect(marketHint(m, lst(2), ev(1104), null)).toBeNull();
    expect(marketHint(null, lst(2), ev(1104), P17)).toBeNull();
  });

  it("signal « part vite » quand la durée médiane de la catégorie est courte ; absent sinon", async () => {
    const m = await loadMarket(db());
    expect(marketHint(m, lst(3, 50), ev(1500), P17)!.fast).toBe("part vite (médiane 30 h)");
    expect(marketHint(m, lst(2), ev(1200), P17)!.fast).toBeNull(); // 5 j
  });

  it("ligne Telegram", async () => {
    const m = await loadMarket(db());
    expect(marketLine(marketHint(m, lst(3, 50), ev(1350), P17))).toBe(
      "📊 −10 % vs médiane Paris 17 · 3 p. · ⏱ part vite (médiane 30 h)",
    );
    expect(marketLine(null)).toBeNull();
  });

  it("roomsBucket", () => {
    expect([roomsBucket(0), roomsBucket(null), roomsBucket(1), roomsBucket(2), roomsBucket(4), roomsBucket(7)]).toEqual(
      [null, null, "1", "2", "4", "4"],
    );
  });
});

describe("légende Telegram et interrupteur", () => {
  const long = (): Listing => ({
    source: "wagram",
    id: "q1",
    url: "https://x/q1",
    price: 1300,
    charges: 100,
    priceIsCC: false,
    surface: 40,
    rooms: 3,
    title: "T".repeat(3000),
    address: `rue ${"x".repeat(3000)}`,
    district: null,
    postalCode: "75017",
    photo: null,
    agency: "A".repeat(300),
    phone: null,
    propertyType: null,
    publishedAt: null,
    description: "d".repeat(900),
  });
  const alertOf = async (listing: Listing) => {
    await processListings(db(), src, [], new Date(NOW.getTime() - D));
    await processListings(db(), src, [listing], NOW);
    return (await getPendingAlerts(db(), 5))[0];
  };

  it("légende <= 1024 avec la ligne de marché, qui reste présente", async () => {
    const a = await alertOf(long());
    const line = "📊 −8 % vs médiane Paris 17 · 3 p. · ⏱ part vite (médiane 30 h)";
    const { caption } = formatTelegram(a, src, null, line);
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption).toContain(line);
    expect(formatTelegram(a, src).caption).not.toContain("📊");
  });

  it('MARKET_HINTS : ligne seulement si "true"', async () => {
    await seed(group("a", 9, (i) => ({ rooms: 2, life: i * D, rent: 1200 })));
    await refreshMarketStats(db(), NOW);
    await alertOf({
      ...long(),
      title: "Joli",
      address: "rue Legendre",
      description: undefined,
      rooms: 2,
      price: 1104,
      priceIsCC: true,
      charges: null,
    });
    const bodies = async (on: boolean) => {
      await db()
        .prepare("UPDATE listings SET alert_status = 'pending', alerted_at = NULL WHERE listing_id = 'q1'")
        .run();
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await sendPendingAlerts(E({ MARKET_HINTS: on ? "true" : "false" }), [src], NOW);
      return spy.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    };
    const off = await bodies(false);
    expect(off[0].text).not.toContain("📊");
    vi.restoreAllMocks();
    const on = await bodies(true);
    expect(on[0].text).toContain("📊 −8 % vs médiane Paris 17 · 2 p.");
  });
});

describe("tendance et bilan du soir", () => {
  it("tendance : 7 derniers jours complets contre les 7 précédents ; zéros comptés ; jour en cours exclu", async () => {
    const rows: Seed[] = [];
    // hier (1) à 7 jours : 2 par jour = 14 ; 8 à 14 jours : 1 par jour = 7 ; aujourd'hui : 5 (exclu)
    for (let d = 1; d <= 7; d++) for (let k = 0; k < 2; k++) rows.push({ id: `nA${d}_${k}`, age: d * D, life: null });
    for (let d = 8; d <= 14; d++) rows.push({ id: `nB${d}`, age: d * D, life: null });
    for (let k = 0; k < 5; k++) rows.push({ id: `today${k}`, age: 0, life: null });
    await seed(rows);
    await refreshMarketStats(db(), NOW);
    const m = (await loadMarket(db()))!;
    const series = dailySeries(m, NOW);
    expect(series).toHaveLength(30);
    expect(series[series.length - 1].day).toBe("2026-11-08");
    expect(series.slice(0, 15).every((d) => d.n === 0)).toBe(true);
    const t = trendOf(series)!;
    expect(t.recent).toBeCloseTo(2, 5);
    expect(t.before).toBeCloseTo(1, 5);
    expect(t.arrow).toBe("↗");
    expect(trendLine(m, NOW)).toBe("📈 Nouvelles annonces : 2,0/jour sur 7 j ↗ (1,0 les 7 précédents)");
  });

  it("tendance absente sous l'effectif minimum", async () => {
    await seed([
      { id: "x1", age: 2 * D, life: null },
      { id: "x2", age: 9 * D, life: null },
    ]);
    await refreshMarketStats(db(), NOW);
    expect(trendLine(await loadMarket(db()), NOW)).toBeNull();
  });

  it("bilan : ligne de tendance seulement avec l'option", async () => {
    const rows: Seed[] = [];
    for (let d = 1; d <= 14; d++) rows.push({ id: `t${d}`, age: d * D, life: null });
    await seed(rows);
    await refreshMarketStats(db(), NOW);
    expect(await buildDailySummary(db(), [src], NOW)).not.toContain("📈");
    expect(await buildDailySummary(db(), [src], NOW, true)).toContain("📈 Nouvelles annonces : 1,0/jour");
  });
});

describe("tableau de bord", () => {
  it("section Marché : tableau, barres, méthode ; écart et signal sur la carte d'une annonce", async () => {
    await seed([
      ...group("a", 9, (i) => ({ rooms: 2, life: i * D, rent: 1200 })),
      ...group("b", 9, (i) => ({ rooms: 3, life: i * 6 * H, rent: 1500, surface: 50 })),
    ]);
    await refreshMarketStats(db(), NOW);
    await processListings(db(), src, [], new Date(NOW.getTime() - D));
    const listing: Listing = {
      source: "wagram",
      id: "card1",
      url: "https://x/card1",
      price: 1350,
      charges: null,
      priceIsCC: true,
      surface: 45,
      rooms: 3,
      title: null,
      address: "rue Legendre",
      district: null,
      postalCode: "75017",
      photo: null,
      agency: null,
      phone: null,
      propertyType: null,
      publishedAt: null,
    };
    await processListings(db(), src, [listing], NOW); // 30 €/m² : écart nul... 1350 / 45 = 30
    await processListings(db(), src, [{ ...listing, id: "card2", price: 1215 }], NOW); // 27 €/m² : −10 %
    const html = await renderDashboard(db(), [src], NOW);
    expect(html).toContain("<h2>Marché (30 jours)</h2>");
    expect(html).toContain('id="marche"');
    expect(html).toContain("5,0 j"); // 2 pièces
    expect(html).toContain("30,0 €");
    expect(html).toContain('class="bars"');
    expect(html).toContain("Calculé le");
    expect(html).toContain("−10 % vs médiane Paris 17 · 3 p.");
    expect(html).toContain("part vite (médiane 30 h)");
    expect(html).toContain("Tendance des nouvelles annonces");
  });
});

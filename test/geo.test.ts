import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "../src/config/fetch";
import { GEO_MAX_PER_PART, GEO_MIN_SCORE } from "../src/config/geo";
import { RENT_QUARTERS, RENT_ROWS } from "../src/data/rent-cap";
import { STATIONS } from "../src/data/stations";
import { settings } from "../src/derive";
import { DETAIL_PARSERS } from "../src/detail/index";
import { readDpe } from "../src/geo/dpe";
import { geocode, hasStreet } from "../src/geo/geocode";
import { distanceMeters, pointInPolygon, walkMinutes } from "../src/geo/geometry";
import { buildHints, geoHintsFor } from "../src/geo/hints";
import { judgeClaim, readClaim } from "../src/geo/proximity";
import { geoLine, geoParts } from "../src/geo/render";
import { eraOfYear, quarterAt, readEra, readFurnished, rentHint } from "../src/geo/rent";
import { citedStation, nearestStation } from "../src/geo/stations";
import { formatTelegram } from "../src/notify/format";
import { getPendingAlerts, processListings } from "../src/process";
import type { KnownState } from "../src/process";
import { renderDashboard } from "../src/dashboard/render";
import { runPart } from "../src/scan";
import type { Env, Listing, SourceDef } from "../src/types";

const cfg = settings();

const src: SourceDef = {
  id: "wagram",
  name: "Wagram Immobilier",
  url: "https://x",
  parser: "orpi",
  group: 1,
  filteredToZones: true,
  zones: ["75017"],
  phone: null,
  encoding: "utf-8",
  active: true,
};
const srcLev: SourceDef = { ...src, id: "lev", name: "Levallois Immo", zones: ["92300"] };
const l = (id: string, o: Partial<Listing> = {}): Listing => ({
  source: "wagram",
  id,
  url: `https://x/${id}`,
  price: 1300,
  charges: 100,
  priceIsCC: false,
  surface: 40,
  rooms: 2,
  title: "Joli 2 pièces",
  address: "rue Legendre",
  district: null,
  postalCode: "75017",
  photo: null,
  agency: "Wagram",
  phone: null,
  propertyType: null,
  publishedAt: null,
  ...o,
});
const E = (o: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  ADMIN_KEY: "k",
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  WHATSAPP_ENABLED: "false",
  ...o,
});
const state = (o: Partial<KnownState> = {}): KnownState => ({
  wasInitialized: true,
  lastFailed: false,
  lastRun: null,
  zones: ["75017"],
  known: new Map(),
  tracked: new Map(),
  ...o,
});
const BROCHANT = { lat: 48.89059, lon: 2.32017 };
const GEO = "https://data.geopf.fr/geocodage/search";

const feature = (lon: number, lat: number, o: { score?: number; postcode?: string; type?: string } = {}) => ({
  features: [
    {
      geometry: { coordinates: [lon, lat] },
      properties: { score: o.score ?? 0.95, postcode: o.postcode ?? "75017", type: o.type ?? "housenumber" },
    },
  ],
});
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

afterEach(() => vi.restoreAllMocks());

describe("distance, marche et station la plus proche", () => {
  it("haversine : 1 degré de latitude ≈ 111 km ; marche = distance × 1,3 à 80 m/min, au moins 1 min", () => {
    expect(distanceMeters(48, 2, 49, 2)).toBeGreaterThan(111_000);
    expect(distanceMeters(48, 2, 49, 2)).toBeLessThan(111_400);
    expect(distanceMeters(48.89, 2.3, 48.89, 2.3)).toBe(0);
    expect(walkMinutes(0)).toBe(1);
    expect(walkMinutes(300)).toBe(5); // 300 × 1,3 / 80 = 4,9
    expect(walkMinutes(615)).toBe(10);
  });

  it("à 100 m de Brochant : Brochant (ligne 13), 2 minutes", () => {
    const n = nearestStation(BROCHANT.lat + 0.0009, BROCHANT.lon)!;
    expect(n.station.name).toBe("Brochant");
    expect(n.station.lines).toEqual(["13"]);
    expect(Math.round(n.meters)).toBeGreaterThan(90);
    expect(walkMinutes(n.meters)).toBe(2);
  });

  it("Levallois : Anatole France et Pont de Levallois ; loin de tout (Loire) : aucune station", () => {
    expect(nearestStation(48.8925, 2.285)!.station.name).toBe("Anatole France");
    expect(nearestStation(48.8975, 2.28)!.station.name).toBe("Pont de Levallois");
    expect(nearestStation(47.4, 0.7)).toBeNull();
  });

  it("données embarquées : coordonnées plausibles (Paris), lignes renseignées", () => {
    expect(STATIONS.length).toBeGreaterThan(30);
    for (const s of STATIONS) {
      expect(s.lat).toBeGreaterThan(48.86);
      expect(s.lat).toBeLessThan(48.92);
      expect(s.lon).toBeGreaterThan(2.25);
      expect(s.lon).toBeLessThan(2.35);
      expect(s.lines.length).toBeGreaterThan(0);
    }
  });

  it("station citée : précédée d'un mot de transport, durée annoncée lue ; un nom de rue seul ne compte pas", () => {
    expect(citedStation("Proche métro Brochant (ligne 13)")?.station.name).toBe("Brochant");
    expect(citedStation("à 2 min de Brochant")).toMatchObject({ minutes: 2 });
    expect(citedStation("RER C Péreire, pereire levallois")?.station.name).toBe("Péreire");
    expect(citedStation("Rue de Rome, bel immeuble")).toBeNull();
    expect(citedStation("rue Brochant calme")).toBeNull();
    expect(citedStation("")).toBeNull();
  });
});

describe("point dans un polygone et quartiers du 17e", () => {
  const square: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  it("carré : dedans, dehors, concave", () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(11, 5, square)).toBe(false);
    expect(pointInPolygon(5, -1, square)).toBe(false);
    const u: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [7, 10],
      [7, 3],
      [3, 3],
      [3, 10],
      [0, 10],
    ];
    expect(pointInPolygon(5, 8, u)).toBe(false);
    expect(pointInPolygon(1, 8, u)).toBe(true);
  });

  it("repères connus : square des Batignolles, parc Monceau, place des Ternes, Brochant (Épinettes) ; Levallois et l'Étoile hors quartiers", () => {
    expect(quarterAt(48.8847, 2.3213)?.name).toBe("Batignolles");
    expect(quarterAt(48.8812, 2.3085)?.name).toBe("Plaine de Monceau");
    expect(quarterAt(48.8785, 2.2981)?.name).toBe("Ternes");
    expect(quarterAt(48.893, 2.32)?.name).toBe("Épinettes");
    expect(quarterAt(48.8975, 2.28)).toBeNull();
    expect(quarterAt(48.8738, 2.295 - 0.01)).toBeNull();
  });

  it("4 quartiers, polygones simplifiés (moins de 20 sommets), 128 lignes de loyers", () => {
    expect(RENT_QUARTERS).toHaveLength(4);
    for (const q of RENT_QUARTERS) expect(q.polygon.length).toBeLessThan(20);
    expect(RENT_ROWS).toHaveLength(128);
  });
});

describe("DPE", () => {
  it.each([
    ["DPE G", "G"],
    ["DPE : F", "F"],
    ["dpe: e", null],
    ["Classe énergie : G", "G"],
    ["classe énergétique E (kWh)", "E"],
    ["étiquette énergie (F)", "F"],
    ["Diagnostic de performance énergétique : D", "D"],
    ["DPE en cours", null],
    ["DPE vierge", null],
    ["GES : G", null],
    ["Beau 2P. DPE C, GES D, proche métro", "C"],
    ["", null],
  ] as const)("%s -> %s", (text, want) => {
    expect(readDpe(text)).toBe(want);
  });
});

describe("encadrement des loyers de Paris", () => {
  const base = {
    postalCode: "75017",
    listing: { price: 1300, priceIsCC: false as const, charges: 100, surface: 40, rooms: 2 },
    text: "",
    quarterId: 67,
    quarterName: "Batignolles",
  };

  it("époque, meublé, quartier connus : plafond exact de la table (Batignolles, 2 pièces, avant 1946, non meublé : 32,5 €/m²)", () => {
    const r = rentHint({
      ...base,
      text: "immeuble haussmannien, non meublé",
      listing: { ...base.listing, price: 1400 },
    })!;
    expect(r).toMatchObject({
      perM2: 35,
      capMin: 32.5,
      capMax: 32.5,
      status: "above",
      basis: "hc",
      quarter: "Batignolles",
      year: 2025,
    });
  });

  it("époque inconnue : fourchette des époques ; entre les bornes -> « maybe », au-dessus de tout -> « above », dessous -> « ok »", () => {
    const rows = RENT_ROWS.filter((r) => r.quarter === 67 && r.rooms === 2 && !r.furnished).map((r) => r.max);
    const lo = Math.min(...rows),
      hi = Math.max(...rows);
    expect([lo, hi]).toEqual([28.9, 32.5]);
    const at = (perM2: number) =>
      rentHint({ ...base, text: "non meublé", listing: { ...base.listing, price: perM2 * 40 } })!;
    expect(at(30)).toMatchObject({ capMin: lo, capMax: hi, status: "maybe" });
    expect(at(34).status).toBe("above");
    expect(at(25).status).toBe("ok");
  });

  it("meublé non précisé : non meublé (32,5) ; « meublé » : plafond meublé (37,1) ; quartier inconnu : fourchette des quatre quartiers", () => {
    const vide = rentHint({ ...base, text: "construit en 1930" })!;
    expect([vide.capMin, vide.capMax]).toEqual([32.5, 32.5]);
    const meuble = rentHint({ ...base, text: "meublé, construit en 1930" })!;
    expect([meuble.capMin, meuble.capMax]).toEqual([37.1, 37.1]);
    const q = rentHint({ ...base, quarterId: null, quarterName: null, text: "construit en 1930" })!;
    expect(q.quarter).toBeNull();
    expect(q.capMax).toBeGreaterThanOrEqual(q.capMin);
    expect(q.capMin).toBeLessThanOrEqual(32.5);
    expect(q.capMax).toBeGreaterThanOrEqual(32.5);
  });

  it("charges comprises sans charges connues : plafond relevé de 15 % ; CC et charges connues : loyer hors charges", () => {
    const cc = rentHint({
      ...base,
      text: "non meublé construit en 1930",
      listing: { price: 1400, priceIsCC: null, charges: null, surface: 40, rooms: 2 },
    })!;
    expect(cc.basis).toBe("cc");
    expect(cc.status).toBe("ok"); // 35 €/m² < 32,5 × 1,15 = 37,4
    const hc = rentHint({
      ...base,
      text: "non meublé construit en 1930",
      listing: { price: 1500, priceIsCC: true, charges: 100, surface: 40, rooms: 2 },
    })!;
    expect(hc).toMatchObject({ basis: "hc", perM2: 35 });
  });

  it("Levallois (92300), pièces ou surface inconnues, prix inconnu : aucun indice ; 4 pièces et plus : ligne « 4 »", () => {
    expect(rentHint({ ...base, postalCode: "92300" })).toBeNull();
    expect(rentHint({ ...base, listing: { ...base.listing, rooms: null } })).toBeNull();
    expect(rentHint({ ...base, listing: { ...base.listing, surface: null } })).toBeNull();
    expect(rentHint({ ...base, listing: { ...base.listing, price: null } })).toBeNull();
    expect(rentHint({ ...base, listing: { ...base.listing, rooms: 6 } })).not.toBeNull();
  });

  it("époque et meublé lus dans le texte", () => {
    expect(eraOfYear(1945)).toBe(0);
    expect(eraOfYear(1946)).toBe(1);
    expect(eraOfYear(1971)).toBe(2);
    expect(eraOfYear(1991)).toBe(3);
    expect(readEra("Immeuble de 1965")).toBe(1);
    expect(readEra("pierre de taille")).toBe(0);
    expect(readEra("programme neuf")).toBe(3);
    expect(readEra("beau 2 pièces")).toBeNull();
    expect(readFurnished("Location non meublée")).toBe(false);
    expect(readFurnished("appartement meublé")).toBe(true);
    expect(readFurnished("2 pièces")).toBeNull();
  });
});

describe("promesse de proximité", () => {
  const near = (lat: number, lon: number) => nearestStation(lat, lon)!;
  // 800 m au sud de Brochant : la marche vaut 13 minutes.
  const farPoint = { lat: 48.892, lon: 2.304 }; // 785 m de Porte de Clichy, la plus proche : 13 minutes
  const stationCoords = (name: string) => STATIONS.find((s) => s.name === name)!;

  it("lecture : station nommée avec durée, formule générique, durée générique, rien", () => {
    const c1 = readClaim("à 2 min de Brochant", citedStation("à 2 min de Brochant"));
    expect(c1).toMatchObject({ minutes: 2 });
    expect(c1?.station?.name).toBe("Brochant");
    expect(readClaim("Proche métro et commerces", null)).toEqual({ station: null, minutes: null });
    expect(readClaim("à 3 min du métro", null)).toEqual({ station: null, minutes: 3 });
    expect(readClaim("à proximité immédiate des transports", null)).toEqual({ station: null, minutes: null });
    expect(readClaim("Beau 2 pièces lumineux", null)).toBeNull();
  });

  it("promesse « proche métro » confirmée près d'une station, non confirmée à 13 minutes", () => {
    const claim = readClaim("proche métro", null)!;
    expect(
      judgeClaim(claim, BROCHANT.lat + 0.0009, BROCHANT.lon, near(BROCHANT.lat + 0.0009, BROCHANT.lon)),
    ).toBeNull();
    const v = judgeClaim(claim, farPoint.lat, farPoint.lon, near(farPoint.lat, farPoint.lon))!;
    expect(v.kind).toBe("far");
    expect(v.actual).toBeGreaterThan(8);
  });

  it("durée annoncée : « à 2 min de Brochant » depuis 5 min = tolérée (+4), depuis 11 min = non confirmée", () => {
    const claim = { station: stationCoords("Brochant"), minutes: 2 };
    const p5 = { lat: BROCHANT.lat - 0.0025, lon: BROCHANT.lon }; // ≈ 280 m -> 5 min
    expect(judgeClaim(claim, p5.lat, p5.lon, near(p5.lat, p5.lon))).toBeNull();
    const p11 = { lat: BROCHANT.lat - 0.0055, lon: BROCHANT.lon }; // ≈ 610 m -> 10 min
    const v = judgeClaim(claim, p11.lat, p11.lon, near(p11.lat, p11.lon));
    expect(v).toMatchObject({ kind: "far", cited: "Brochant", claimed: 2 });
  });

  it("station citée qui n'est pas la plus proche (à moins de 8 min mais 4 min de plus) : « other »", () => {
    const rome = stationCoords("Rome");
    // Point entre Brochant et la station Guy-Môquet : cite Brochant alors que Guy-Môquet est bien plus proche.
    const guy = stationCoords("Guy-Môquet");
    const p = { lat: guy.lat + 0.0003, lon: guy.lon };
    const n = near(p.lat, p.lon);
    expect(n.station.name).toBe("Guy-Môquet");
    const v = judgeClaim({ station: stationCoords("Brochant"), minutes: null }, p.lat, p.lon, n);
    expect(v?.kind === "other" || v?.kind === "far").toBe(true);
    expect(v?.nearest).toBe("Guy-Môquet");
    expect(rome.name).toBe("Rome");
  });
});

describe("indices d'une annonce (buildHints)", () => {
  it("point géocodé : station + quartier + loyer ; DPE G lu ; ligne courte", () => {
    const h = buildHints(
      l("a", { title: "2P proche métro Brochant, DPE G, non meublé, construit en 1930", price: 1450 }),
      src,
      { ...BROCHANT, precision: "housenumber" },
    )!;
    expect(h.station).toMatchObject({ name: "Brochant", from: "geocode" });
    expect(h.rent).toMatchObject({ status: "above", quarter: "Épinettes" });
    expect(h.dpe).toBe("G");
    expect(h.claim).toBeNull();
    const line = geoLine(h)!;
    expect(line).toContain("🚇 Brochant (13) à ~1 min");
    expect(line).toContain("DPE G, interdit à la location depuis 2025");
    expect(line).toContain("loyer au-dessus du plafond");
    expect(line.length).toBeLessThanOrEqual(220);
  });

  it("repli sans géocodage : station citée par l'annonce (distance inconnue), pas de verdict ; sans rien : null", () => {
    const h = buildHints(l("b", { title: "à 2 min de Brochant" }), src, null)!;
    expect(h.station).toEqual({ name: "Brochant", lines: ["13"], meters: null, minutes: null, from: "text" });
    expect(h.claim).toBeNull();
    expect(geoLine(h)).toBe("🚇 Brochant (13), citée par l'annonce");
    expect(buildHints(l("c", { title: "Joli 2 pièces", price: null }), src, null)).toBeNull();
  });

  it("Levallois : station mais jamais d'encadrement ; DPE F : mention simple, non avertissante", () => {
    const h = buildHints(
      l("d", { postalCode: "92300", title: "DPE F", address: "rue Anatole France", price: 2500 }),
      srcLev,
      { lat: 48.8925, lon: 2.285, precision: "street" },
    )!;
    expect(h.rent).toBeNull();
    expect(geoParts(h).map((p) => [p.text, p.warn])).toEqual([
      ["🚇 Anatole France (3) à ~1 min", false],
      ["DPE F", false],
    ]);
  });

  it("promesse non confirmée affichée en avertissement", () => {
    const farPoint = { lat: 48.892, lon: 2.304, precision: "street" };
    const h = buildHints(l("e", { title: "proche métro" }), src, farPoint)!;
    expect(h.claim?.kind).toBe("far");
    expect(geoLine(h)).toMatch(/⚠️ proximité annoncée non confirmée \(\w.* à ~\d+ min\)/);
  });
});

describe("géocodage simulé", () => {
  const ok = (r: Response) => vi.fn(async () => r) as unknown as typeof fetch;

  it("succès : point, requête vers la Géoplateforme avec le code postal et un délai", async () => {
    const f = vi.fn(async () => json(feature(2.32, 48.888))) as unknown as typeof fetch;
    expect(await geocode("12 rue Legendre", "75017", 3000, f)).toEqual({
      lon: 2.32,
      lat: 48.888,
      precision: "housenumber",
    });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url.startsWith(`${GEO}?`)).toBe(true);
    expect(url).toContain("postcode=75017");
    expect(url).toContain("q=12+rue+Legendre");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
  });

  it("échecs : HTTP 500, 429, réseau, JSON invalide, aucun résultat, score faible, code postal hors zones ou différent : null, jamais d'exception", async () => {
    expect(await geocode("x", null, 3000, ok(json({}, 500)))).toBeNull();
    expect(await geocode("x", null, 3000, ok(json({}, 429)))).toBeNull();
    expect(
      await geocode(
        "x",
        null,
        3000,
        vi.fn(async () => {
          throw new TypeError("réseau");
        }) as unknown as typeof fetch,
      ),
    ).toBeNull();
    expect(await geocode("x", null, 3000, ok(new Response("pas du json")))).toBeNull();
    expect(await geocode("x", null, 3000, ok(json({ features: [] })))).toBeNull();
    expect(await geocode("x", "75017", 3000, ok(json(feature(2.3, 48.88, { score: GEO_MIN_SCORE - 0.1 }))))).toBeNull();
    expect(await geocode("x", null, 3000, ok(json(feature(2.3, 48.88, { postcode: "69001" }))))).toBeNull();
    expect(await geocode("x", "75017", 3000, ok(json(feature(2.3, 48.88, { postcode: "92300" }))))).toBeNull();
    expect(
      await geocode(
        "x",
        null,
        3000,
        ok(
          json({ features: [{ geometry: { coordinates: ["a", "b"] }, properties: { score: 1, postcode: "75017" } }] }),
        ),
      ),
    ).toBeNull();
  });

  it("délai : un serveur qui ne répond pas est abandonné à l'échéance (null)", async () => {
    const hang = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new Error("abandon")));
        }),
    ) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(await geocode("x", null, 40, hang)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("adresse à voie : « rue Legendre », « 12 av. de Wagram », « Allée du parc » oui ; « Paris 17e », « Batignolles », null non", () => {
    for (const a of ["rue Legendre", "12 av. de Wagram", "Allée du parc", "Cité des Fleurs", "bd Pereire"])
      expect(hasStreet(a), a).toBe(true);
    for (const a of ["Paris 17e", "Batignolles", null, ""]) expect(hasStreet(a), String(a)).toBe(false);
  });
});

describe("géocodage dans un passage (geoHintsFor)", () => {
  const spyGeo = (coords: [number, number] = [2.3202, 48.8907]) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(feature(coords[0], coords[1])));

  it("éteint (GEO_HINTS absent ou « false ») : aucun indice, aucune requête", async () => {
    const spy = spyGeo();
    expect((await geoHintsFor(E(), src, [l("1")], state())).size).toBe(0);
    expect((await geoHintsFor(E({ GEO_HINTS: "false" }), src, [l("1")], state())).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("allumé : nouvelles annonces gardées seulement, au plus GEO_MAX_PER_PART géocodages, les autres gardent leurs indices sans réseau", async () => {
    const spy = spyGeo();
    const many = Array.from({ length: GEO_MAX_PER_PART + 2 }, (_, i) => l(`n${i}`, { title: "DPE G" }));
    const known = l("old", { title: "DPE G" });
    const dropped = l("cher", { title: "DPE G", price: 3000 });
    const st = state({
      known: new Map([
        [
          "old",
          {
            source: "wagram",
            listing_id: "old",
            cluster: "c",
            alert_status: "sent",
            first_seen: "",
            last_seen: null,
            gone_at: null,
          },
        ],
      ]),
    });
    const out = await geoHintsFor(E({ GEO_HINTS: "true" }), src, [...many, known, dropped], st);
    expect(spy).toHaveBeenCalledTimes(GEO_MAX_PER_PART);
    expect([...out.keys()].sort()).toEqual(many.map((m) => m.id).sort()); // ni « old » (connue) ni « cher » (écartée)
    expect(out.get("n0")!.geocoded).toBe(true);
    expect(out.get(`n${GEO_MAX_PER_PART}`)!.geocoded).toBe(false);
    expect(out.get(`n${GEO_MAX_PER_PART}`)!.dpe).toBe("G");
  });

  it("premier passage d'une source (silent) ou passage précédent en échec : aucun géocodage, indices sans réseau conservés", async () => {
    const spy = spyGeo();
    const a = await geoHintsFor(
      E({ GEO_HINTS: "true" }),
      src,
      [l("1", { title: "DPE G" })],
      state({ wasInitialized: false }),
    );
    const b = await geoHintsFor(
      E({ GEO_HINTS: "true" }),
      src,
      [l("1", { title: "DPE G" })],
      state({ lastFailed: true }),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(a.get("1")!.dpe).toBe("G");
    expect(b.get("1")!.dpe).toBe("G");
  });

  it("temps restant insuffisant (< 1 s) ou adresse sans voie : pas de géocodage", async () => {
    const spy = spyGeo();
    await geoHintsFor(E({ GEO_HINTS: "true" }), src, [l("1")], state(), 500);
    await geoHintsFor(E({ GEO_HINTS: "true" }), src, [l("2", { address: "Paris 17e" })], state());
    expect(spy).not.toHaveBeenCalled();
  });

  it("géocodage en échec (500, réseau) : l'annonce garde ses indices sans point, aucune exception", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("réseau");
    });
    const out = await geoHintsFor(E({ GEO_HINTS: "true" }), src, [l("1", { title: "DPE F" })], state());
    expect(out.get("1")).toMatchObject({ geocoded: false, dpe: "F" });
  });
});

describe("rendu : alerte Telegram et tableau de bord", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM listings"), env.DB.prepare("DELETE FROM source_state")]);
  });
  const t0 = new Date(Date.UTC(2026, 9, 19, 8, 0));
  const t1 = new Date(Date.UTC(2026, 9, 19, 12, 5));
  const seed = async (listings: Listing[], geo?: Map<string, NonNullable<ReturnType<typeof buildHints>>>) => {
    await processListings(env.DB, src, [], t0);
    await processListings(env.DB, src, listings, t1, undefined, undefined, geo);
    return getPendingAlerts(env.DB, 10);
  };

  it("la ligne d'indices est dans la légende, avant la description, et la légende tient en 1024 caractères même très chargée", async () => {
    const lst = l("g1", {
      title: "T".repeat(3000),
      address: `rue Legendre ${"x".repeat(3000)}`,
      description: "D".repeat(500),
    });
    const h = buildHints(l("g1", { title: "DPE G proche métro, non meublé construit en 1930", price: 1500 }), src, {
      ...BROCHANT,
      precision: "street",
    })!;
    const [a] = await seed([lst], new Map([["g1", h]]));
    expect(a.geo).toEqual(h);
    const { caption } = formatTelegram(a, src);
    expect(caption).toContain("🚇 Brochant (13) à ~1 min");
    expect(caption.length).toBeLessThanOrEqual(1024);
    const lines = caption.split("\n");
    expect(lines.findIndex((x) => x.startsWith("🚇"))).toBeLessThan(lines.length - 1); // la description (dernière) vient après
  });

  it("annonce sans indice (interrupteur éteint) : légende identique à celle d'avant, payload sans clé geo", async () => {
    const [a] = await seed([l("g2")]);
    expect(a.geo).toBeUndefined();
    expect(formatTelegram(a, src).caption).not.toContain("🚇");
    const row = await env.DB.prepare("SELECT payload FROM listings WHERE listing_id = 'g2'").first<{
      payload: string;
    }>();
    expect(Object.keys(JSON.parse(row!.payload)).sort()).toEqual(["evaluation", "listPrice", "listing"]);
  });

  it("badges sur la carte du tableau de bord (avertissement en alerte), absents sans indice ; échappement", async () => {
    const h = buildHints(l("g3", { title: "DPE G <b>", price: 1500 }), src, { ...BROCHANT, precision: "street" })!;
    await seed([l("g3"), l("g4")], new Map([["g3", h]]));
    const html = await renderDashboard(env.DB, [src], new Date(Date.UTC(2026, 9, 19, 13, 0)));
    expect(html).toContain('<span class="badge">🚇 Brochant (13) à ~1 min</span>');
    expect(html).toContain('<span class="badge warn">⚠️ DPE G, interdit à la location depuis 2025</span>');
    expect(html.match(/class="hints"/g)).toHaveLength(1);
  });
});

describe("passage /part (runPart) avec l'interrupteur", () => {
  const ORPI = cfg.sources.dedicated.find((s) => s.id === "orpi_17")!;
  const NOW = new Date(Date.UTC(2026, 9, 19, 10, 0));
  const enc = (o: object) => JSON.stringify(o).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const list = (ids: number[]) =>
    `<html><div data-result="${enc({
      items: ids.map((id) => ({
        id,
        slug: `appartement-t2-paris-17-75017-x${id}`,
        price: 1500,
        surface: 41,
        nbRooms: 2,
        type: "appartement",
        images: [],
        agency: { name: "Orpi" },
      })),
      similars: [],
    })}"></div></html>`;

  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare("DELETE FROM listings"), env.DB.prepare("DELETE FROM source_state")]);
    await env.DB.prepare("INSERT INTO source_state (source, initialized) VALUES ('orpi_17', 1)").run();
  });

  const run = async (geoHints: string | undefined, ids: number[]) => {
    const orig = DETAIL_PARSERS.orpi!;
    DETAIL_PARSERS.orpi = {
      read: () => ({ address: "12 rue Legendre", description: "Proche métro Brochant, DPE G" }),
      maxPerPass: 5,
    };
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u === ORPI.url) return new Response(list(ids));
      if (u.startsWith(GEO)) return json(feature(BROCHANT.lon, BROCHANT.lat + 0.0005));
      if (u.startsWith("https://www.orpi.com/annonce-location-")) return new Response("<html>fiche</html>");
      return new Response("introuvable", { status: 404 });
    });
    try {
      await runPart(E({ ...(geoHints === undefined ? {} : { GEO_HINTS: geoHints }) }), [ORPI], NOW);
    } finally {
      DETAIL_PARSERS.orpi = orig;
    }
    return spy;
  };
  const payloadOf = async (id: string) =>
    JSON.parse(
      (await env.DB.prepare("SELECT payload FROM listings WHERE source = 'orpi_17' AND listing_id = ?")
        .bind(id)
        .first<{ payload: string }>())!.payload,
    ) as Record<string, unknown>;

  it("éteint : aucune requête de géocodage, payload sans geo (comportement identique à avant)", async () => {
    const spy = await run("false", [901]);
    expect(spy.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(GEO))).toEqual([]);
    expect(Object.keys(await payloadOf("901")).sort()).toEqual(["evaluation", "listPrice", "listing"]);
    vi.restoreAllMocks();
    await env.DB.prepare("DELETE FROM listings").run();
    await run(undefined, [902]);
    expect(await payloadOf("902")).not.toHaveProperty("geo");
  });

  it("allumé : un géocodage par annonce nouvelle gardée (plafond GEO_MAX_PER_PART), indices dans le payload, évaluation inchangée", async () => {
    const ids = [911, 912, 913, 914, 915];
    const spy = await run("true", ids);
    expect(spy.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(GEO))).toHaveLength(GEO_MAX_PER_PART);
    const p = (await payloadOf("911")) as {
      evaluation: { keep: boolean };
      geo: { station: { name: string }; dpe: string; geocoded: boolean };
    };
    expect(p.evaluation.keep).toBe(true);
    expect(p.geo).toMatchObject({ station: { name: "Brochant" }, dpe: "G", geocoded: true });
    // Cinq annonces avec fiche (lecteur simulé) : trois géocodées, les deux autres gardent leurs indices de texte et de loyer.
    const geocoded = await Promise.all(
      ids.map(async (id) => (await payloadOf(String(id))).geo as { geocoded: boolean; dpe: string }),
    );
    expect(geocoded.filter((g) => g.geocoded)).toHaveLength(GEO_MAX_PER_PART);
    expect(geocoded.every((g) => g.dpe === "G")).toBe(true);
  });
});

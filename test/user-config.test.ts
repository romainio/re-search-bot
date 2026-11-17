import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { settings } from "../src/derive";
import { evaluate } from "../src/filter";
import { buildHints } from "../src/geo/hints";
import { applyUserSources } from "../src/sources";
import worker from "../src/index";
import type { HealthReport } from "../src/admin-health";
import type { Env, Listing, SourceDef } from "../src/types";

// La configuration d'une instance (instance.config.json, ici l'exemple de référence chargé par l'alias de vitest.config.ts) donne les
// réglages (src/derive.ts) : ses valeurs sont EXACTEMENT celles de l'instance d'origine (Paris 17 et Levallois). Ces tests figent ces
// valeurs : les changer volontairement impose de les changer ici.

describe("valeurs de l'exemple de référence = instance d'origine", () => {
  const cfg = settings();
  it("critères de filtre", () => {
    expect(cfg.criteria).toEqual({
      rentMin: 1000,
      rentMax: 1600,
      surfaceMin: 35,
      roomsMin: 2,
      excludeGroundFloor: true,
    });
  });
  it("zones, communes voisines, quartier", () => {
    expect(cfg.zones.map((z) => [z.postalCode, z.label])).toEqual([
      ["75017", "Paris 17"],
      ["92300", "Levallois"],
    ]);
    expect(cfg.zones[0].town).toBeUndefined();
    expect(cfg.zones[1].town?.test("Levallois-Perret")).toBe(true);
    expect(cfg.allowedPostalCodes).toEqual(["75017", "92300"]);
    expect(cfg.outOfZoneTowns.map((t) => t.postalCode)).toEqual([
      "92250",
      "92270",
      "92200",
      "92110",
      "92400",
      "92700",
      "92800",
      "92100",
      "92600",
      "93400",
      "92150",
      "92130",
      "92000",
    ]);
    expect(cfg.neighborhood.zone).toBe("75017");
    expect(cfg.neighborhood.keywords).toHaveLength(17);
    expect(cfg.neighborhood.keywords.slice(0, 3)).toEqual(["Batignolles", "Cardinet", "Brochant"]);
    expect(cfg.neighborhood.normalizedKeywords.slice(0, 3)).toEqual(["batignolles", "cardinet", "brochant"]);
    expect(cfg.prospect.bbox).toEqual({
      "75017": [48.8765, 2.268, 48.896, 2.333],
      "92300": [48.884, 2.268, 48.91, 2.3],
    });
  });
  it("plafonds IA et fenêtre horaire", () => {
    expect(cfg.ai.dailyNeurons).toBe(8_000);
    expect(cfg.ai.featureCaps).toEqual({
      photo: 4_000,
      prospect: 500,
      embed: 1_000,
      profile: 400,
      universal: 4_000,
      mail: 1_000,
      assistant: 1_500,
    });
    expect(cfg.window).toEqual({ startHour: 9, endHour: 20, summaryHour: 20, summaryMinute: 5 });
  });
  it("critères photo par défaut", () => {
    expect(cfg.photoCriteria.map((c) => c.id)).toEqual([
      "parquet",
      "carrelage",
      "moquette",
      "stratifie",
      "cuisine_equipee",
      "cuisine_recente",
      "baignoire",
      "douche",
      "luminosite",
      "exterieur",
    ]);
    expect(cfg.photoCriteria.filter((c) => c.showNo).map((c) => c.id)).toEqual([
      "cuisine_equipee",
      "baignoire",
      "luminosite",
    ]);
    expect(cfg.photoCriteria.find((c) => c.id === "cuisine_recente")?.parent).toBe("cuisine_equipee");
  });
  it("données Île-de-France", () => {
    expect(cfg.geo.rentCapPostalCodes).toEqual(["75017"]);
    expect(cfg.geo.stationPostalCodes).toEqual(["75017", "92300"]);
  });
  it("sources : toutes celles du registre restent dans leur état d'origine", () => {
    const { dedicated, all } = cfg.sources;
    expect(applyUserSources([...dedicated], "auto", cfg.zones)).toEqual(dedicated);
    // Seules les sources inactives du registre (century21...) le sont : aucune source n'est désactivée par la configuration.
    expect(dedicated.filter((s) => s.active).length).toBeGreaterThan(40);
    expect(all.map((s) => s.id)).toContain("bienici");
  });
});

describe("sélection des sources (applyUserSources)", () => {
  const mk = (id: string, zones: string[], active = true): SourceDef => ({
    id,
    name: id,
    url: "https://x",
    parser: "lbi",
    group: 0,
    zones,
    filteredToZones: false,
    phone: null,
    encoding: "utf-8",
    active,
  });
  const list = [mk("a", ["75017"]), mk("b", ["92300"]), mk("c", ["69003"]), mk("d", ["75017"], false)];
  const active = (l: SourceDef[]) => l.filter((s) => s.active).map((s) => s.id);

  it("auto : celles dont les zones recoupent les zones choisies", () => {
    expect(active(applyUserSources(list, "auto", [{ postalCode: "75017" }]))).toEqual(["a"]);
    expect(active(applyUserSources(list, "auto", [{ postalCode: "75017" }, { postalCode: "69003" }]))).toEqual([
      "a",
      "c",
    ]);
  });
  it("liste : seulement celles nommées ; une source inactive au registre le reste ; rien n'est supprimé", () => {
    const out = applyUserSources(list, ["b", "d"], [{ postalCode: "75017" }]);
    expect(active(out)).toEqual(["b"]);
    expect(out).toHaveLength(4);
  });
});

describe("filtre : rez-de-chaussée selon la configuration", () => {
  const src = { id: "x", zones: ["75017"], filteredToZones: true } as unknown as SourceDef;
  const l = {
    source: "x",
    id: "1",
    url: "u",
    price: 1300,
    charges: null,
    priceIsCC: true,
    surface: 40,
    rooms: 2,
    floor: 0,
    title: "Appartement",
    address: null,
    district: null,
    postalCode: "75017",
    photo: null,
    agency: null,
    phone: null,
    propertyType: null,
    publishedAt: null,
  } as Listing;
  it("par défaut le rez-de-chaussée est écarté", () => {
    expect(evaluate(l, src)).toMatchObject({ keep: false, reason: "rdc" });
  });
});

describe("indices géographiques hors Île-de-France", () => {
  const src = { id: "x", zones: ["69003"], filteredToZones: true } as unknown as SourceDef;
  const l = {
    source: "x",
    id: "1",
    url: "u",
    price: 1300,
    charges: null,
    priceIsCC: true,
    surface: 40,
    rooms: 2,
    title: "Appartement à 2 min du métro Brochant",
    description: "Classe énergie G",
    address: "12 rue de la République",
    district: null,
    postalCode: "69003",
    photo: null,
    agency: null,
    phone: null,
    propertyType: null,
    publishedAt: null,
  } as Listing;
  it("zone sans données de stations : ni station citée ni station la plus proche, même avec un point au cœur du 17e", () => {
    const h = buildHints(l, src, { lat: 48.8906, lon: 2.3202, precision: "housenumber" });
    expect(h?.station ?? null).toBeNull();
    expect(h?.claim ?? null).toBeNull();
    expect(h?.rent ?? null).toBeNull();
  });
  it("zone du 17e : la station citée est reconnue (inchangé)", () => {
    const h = buildHints({ ...l, postalCode: "75017" }, { ...src, zones: ["75017"] } as SourceDef, null);
    expect(h?.station?.name).toBe("Brochant");
  });
});

describe("GET /health", () => {
  const E = { ...env, ADMIN_KEY: "secret-key", TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "1" } as unknown as Env;
  const call = (path: string, e: Env = E) =>
    worker.fetch(new Request(`https://re-search.test${path}`), e, createExecutionContext());

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM ai_usage").run();
    await env.DB.prepare("DELETE FROM source_state").run();
  });

  it("refuse sans clé (403) et avec une mauvaise clé", async () => {
    expect((await call("/health")).status).toBe(403);
    expect((await call("/health?k=faux")).status).toBe(403);
  });

  it("rapport : interrupteurs éteints, secrets par présence, migrations, budget IA, sources", async () => {
    const res = await call("/health?k=secret-key");
    expect(res.status).toBe(200);
    const h = (await res.json()) as HealthReport;
    expect(h.zones).toEqual(["75017", "92300"]);
    expect(h.criteria).toEqual({ rentMin: 1000, rentMax: 1600, surfaceMin: 35, roomsMin: 2 });
    expect(h.secrets).toMatchObject({
      ADMIN_KEY: true,
      TELEGRAM_BOT_TOKEN: true,
      TELEGRAM_CHAT_ID: true,
      TELEGRAM_WEBHOOK_SECRET: false,
    });
    expect(h.bindings).toMatchObject({ DB: true, SELF: true });
    expect(h.switches.map((s) => s.name)).toContain("SEMANTIC_SEARCH");
    expect(h.switches.every((s) => s.on === false)).toBe(true);
    expect(h.migrations?.count).toBeGreaterThan(5);
    expect(h.migrations?.names).toContain("0001_init.sql");
    expect(h.ai).toEqual({ day: new Date().toISOString().slice(0, 10), spent: 0, cap: 8000, byFeature: {} });
    expect(h.sources?.readable).toBeGreaterThan(40);
    expect(h.sources?.broken).toEqual([]);
    expect(h.problems).toEqual([]);
    expect(h.ok).toBe(true);
  });

  it("ne contient jamais la valeur d'un secret", async () => {
    const text = await (await call("/health?k=secret-key")).text();
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain('"tok"');
  });

  it("signale un secret absent, un interrupteur allumé sans son exigence, une source en panne et la consommation IA", async () => {
    await env.DB.prepare("INSERT INTO ai_usage (day, feature, neurons) VALUES (?, 'photo', 123.4)")
      .bind(new Date().toISOString().slice(0, 10))
      .run();
    await env.DB.prepare(
      "INSERT INTO source_state (source, consecutive_failures, broken, last_error) VALUES ('bienici', 3, 1, 'HTTP 403')",
    ).run();
    const e = {
      ...E,
      AI: undefined,
      VECTORIZE: undefined,
      TELEGRAM_BOT_TOKEN: "",
      SEMANTIC_SEARCH: "true",
      TELEGRAM_INTERACTIVE: "true",
      ASSISTANT_ENABLED: "true",
    } as unknown as Env;
    const h = (await (await call("/health?k=secret-key", e)).json()) as HealthReport;
    expect(h.ok).toBe(false);
    expect(h.problems.join("\n")).toContain("secret TELEGRAM_BOT_TOKEN absent");
    expect(h.problems.join("\n")).toContain("SEMANTIC_SEARCH allumé mais il manque");
    expect(h.problems.join(" | ")).not.toContain("TELEGRAM_WEBHOOK_SECRET"); // facultatif : dérivé d ADMIN_KEY
    expect(h.problems.join("\n")).toContain("1 source(s) en panne : bienici");
    expect(h.sources?.broken).toEqual([{ id: "bienici", error: "HTTP 403" }]);
    expect(h.ai?.spent).toBe(123);
    expect(h.ai?.byFeature.photo).toEqual({ spent: 123, cap: 4000 });
    expect(h.switches.find((s) => s.name === "ASSISTANT_ENABLED")?.missing).toEqual(["binding AI"]);
  });

  it("est en lecture seule : aucune écriture en base", async () => {
    await call("/health?k=secret-key");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM source_state").first<{ n: number }>())?.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_usage").first<{ n: number }>())?.n).toBe(0);
  });
});

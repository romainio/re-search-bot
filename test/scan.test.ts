/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../src/derive";
import worker from "../src/index";
import { fetchSource } from "../src/fetch-source";
import {
  groupParts,
  parsePartRequest,
  parseSource,
  PART_FAILED,
  PASS_TOO_LATE,
  runPart,
  runScan,
  selfRunner,
  splitParts,
} from "../src/scan";
import { PARSERS } from "../src/parsers/index";
import { LBI_EMPTY } from "../src/parsers/lbi";
import type { PartResult, PartRunner, ScanReport } from "../src/scan";
import { SOURCE_MAX_BYTES, SOURCE_TIMEOUT_MS } from "../src/config/fetch";
import { PART_MAX_SKEW_MS, PART_SIZE, PART_TIMEOUT_MS, PASS_DEADLINE_MS } from "../src/config/scan";
import { GROUP_COUNT, GROUP_MAX_SOURCES, TOTAL_GROUPS } from "../src/config/schedule";
import { groupFor } from "../src/schedule";
import { decodeWindows1252 } from "../src/util";
import type { Env, Listing } from "../src/types";
import { FIXTURE_BY_ID, fx, EXTRA_17_IDS, SECOND_LANE_IDS } from "./source-fixtures";
import bieniciRaw from "./fixtures/bienici.json?raw";
import orpiRaw from "./fixtures/orpi.html?raw";
import fonciaRaw from "./fixtures/foncia.html?raw";
import cmbRaw from "./fixtures/cmb.html?raw";
import lbiAgbRaw from "./fixtures/lbi_agb.html?raw";
import fnaimRaw from "./fixtures/fnaim.html?raw";
import nestennRaw from "./fixtures/nestenn.html?raw";
import feauRaw from "./fixtures/danielfeau.html?raw";
import domiereRaw from "./fixtures/domiere.html?raw";
import laforetRaw from "./fixtures/laforet.html?raw";

const cfg = settings();

const E: Env = {
  ...(env as unknown as Env),
  ADMIN_KEY: "secret-key",
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  WHATSAPP_ENABLED: "false",
};
const t = (h: number, m: number) => new Date(Date.UTC(2026, 9, 19, h, m));
const BROKEN = "foncia_17";
const ACTIVE = cfg.sources.dedicated.filter((s) => s.active);
/** Groupe du cron de 10h Paris (08:00 UTC) : minute UTC modulo GROUP_COUNT (0). */
const G10H = groupFor(new Date("2026-10-19T08:00:00Z"));
/** Groupes lus par le passage de 08:00 UTC : un par voie (G10H et G10H + 5), lus en parallèle ; sous-lots triés (ordre entrelacé). */
const PASS_GROUPS = [G10H, G10H + GROUP_COUNT];
const passParts = () => PASS_GROUPS.flatMap((g) => groupParts(g));
const byIds = (a: string[], b: string[]) => a.join().localeCompare(b.join());
const inPass = (x: { group: number }) => PASS_GROUPS.includes(x.group);
const GROUPS = Array.from({ length: TOTAL_GROUPS }, (_, g) => g);
/** Sources gardées au registre mais désactivées (active: false). */
const INACTIVE_IDS = ["century21_levallois", "century21_17"];

function bienici(extra: boolean): string {
  const j = JSON.parse(bieniciRaw);
  if (extra) {
    const ad = structuredClone(j.realEstateAds[0]);
    ad.id = "new-ad-1";
    ad.price = 1300;
    ad.postalCode = "75017";
    ad.propertyType = "flat";
    delete ad.rentWithoutCharges;
    delete ad.charges;
    j.realEstateAds.unshift(ad);
  }
  return JSON.stringify(j);
}

function mockFetch(opts: { extra?: boolean; failing?: string; tgStatus?: number } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u.startsWith("https://api.telegram.org/"))
      return new Response(JSON.stringify({ ok: opts.tgStatus === undefined }), { status: opts.tgStatus ?? 200 });
    const src = cfg.sources.dedicated.find((s) => s.url === u);
    if (!src) return new Response("?", { status: 404 });
    if (src.id === opts.failing) return new Response("no", { status: 403 });
    const bodies: Record<string, string> = {
      apimo: feauRaw,
      bienici: bienici(!!opts.extra),
      orpi: orpiRaw,
      foncia: fonciaRaw,
      lbi: cmbRaw,
      lbi2: lbiAgbRaw,
      fnaim: fnaimRaw,
      nestenn: nestennRaw,
      netty: domiereRaw,
      laforet: laforetRaw,
      century21: fx("century21_levallois.html"),
      oralia: fx("oralia.html"),
      osl: fx("elger.html"),
      billie: fx("fredelion_p2.html"),
      office5: fx("imax_levallois.html"),
      at1605: fx("levimmo.html"),
      caimmo: fx("ca_immo_levallois.html"),
      wpapimo: fx("pni.html"),
      era: fx("era_17.json"),
    };
    return new Response(bodies[src.parser]);
  });
}
const tgCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) => String(c[0]).startsWith("https://api.telegram.org/"));
const tgTexts = (spy: { mock: { calls: unknown[][] } }) =>
  tgCalls(spy).map((c) => JSON.parse((c[1] as RequestInit).body as string).text as string);
/** SELF en boucle locale sur la route /part de ce Worker, avec cet env (le SELF du pool appellerait le Worker avec l'env du pool). */
const loopSelf = (e: Env): Fetcher =>
  ({
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      worker.fetch(new Request(input, init), e, createExecutionContext()),
  }) as unknown as Fetcher;
/** Runner qui enregistre les sous-lots demandés et le nombre maximal de sous-lots en cours en même temps. */
function recording(base: PartRunner) {
  const calls: string[][] = [];
  let running = 0,
    maxRunning = 0;
  const run: PartRunner = async (ids, now) => {
    calls.push(ids);
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      return await base(ids, now);
    } finally {
      running--;
    }
  };
  return { run, calls, maxRunning: () => maxRunning };
}
/** HMAC-SHA256 hexadecimal (implementation de test, independante de src/). */
async function hmacHex(key: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body))), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
const failures = async (id: string) =>
  (
    await env.DB.prepare("SELECT consecutive_failures FROM source_state WHERE source = ?")
      .bind(id)
      .first<{ consecutive_failures: number }>()
  )?.consecutive_failures ?? 0;
async function seedPending(n: number) {
  const stmts = Array.from({ length: n }, (_, i) => {
    const listing: Listing = {
      source: "bienici",
      id: `q${i}`,
      url: `https://x/q${i}`,
      price: 1300,
      charges: null,
      priceIsCC: true,
      surface: 30 + i,
      rooms: 2,
      title: "T",
      address: null,
      district: null,
      postalCode: "75017",
      photo: "https://img.test/p.jpg",
      agency: null,
      phone: null,
      propertyType: null,
      publishedAt: null,
    };
    return env.DB.prepare(
      "INSERT INTO listings (source, listing_id, cluster, first_seen, alert_status, alert_kind, payload) VALUES ('bienici', ?, ?, ?, 'pending', 'new', ?)",
    ).bind(
      `q${i}`,
      `bienici:q${i}`,
      t(9, i).toISOString(),
      JSON.stringify({ listing, evaluation: { keep: true, rentCC: 1300, flags: [] } }),
    );
  });
  await env.DB.batch(stmts);
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM listings"), env.DB.prepare("DELETE FROM source_state")]);
  // Horloge simulée (Date seulement) près des passages t(10, x) : /part refuse un instant trop éloigné de l'horloge.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t(10, 2));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("registry", () => {
  it("ids uniques, groupes 0-9, au plus GROUP_MAX_SOURCES (10) sources par groupe (une source par invocation /part), 24 sources de base, les agences supplémentaires du 17e et la seconde voie", () => {
    expect(new Set(cfg.sources.dedicated.map((s) => s.id)).size).toBe(cfg.sources.dedicated.length);
    expect(cfg.sources.dedicated.every((s) => GROUPS.includes(s.group))).toBe(true);
    for (const g of GROUPS) expect(ACTIVE.filter((x) => x.group === g).length).toBeLessThanOrEqual(GROUP_MAX_SOURCES);
    expect(cfg.sources.dedicated).toHaveLength(24 + EXTRA_17_IDS.length + SECOND_LANE_IDS.length);
    // Toutes actives sauf celles désactivées au registre (Century 21 : 429 depuis les IP de Cloudflare).
    expect(cfg.sources.dedicated.filter((s) => !s.active).map((s) => s.id)).toEqual(INACTIVE_IDS);
    expect(ACTIVE).toHaveLength(24 + EXTRA_17_IDS.length + SECOND_LANE_IDS.length - INACTIVE_IDS.length);
    expect(new Set(cfg.sources.dedicated.map((s) => s.url)).size).toBe(cfg.sources.dedicated.length); // une requête par URL
    expect(cfg.sources.dedicated.find((s) => s.id === "etude_wagram")!.encoding).toBe("utf-8");
    expect(cfg.sources.dedicated.find((s) => s.id === "cmb_p2")!.group).toBe(4);
  });

  it("zones déclarées pour chaque source (codes des zones de l'instance) ; les 17 sources du 17e (et les agences supplémentaires) restent sur 75017 ; Bien'ici bi-zone", () => {
    for (const s of cfg.sources.dedicated) {
      expect(s.zones.length, s.id).toBeGreaterThan(0);
      expect(
        s.zones.every((z) => cfg.allowedPostalCodes.includes(z)),
        s.id,
      ).toBe(true);
    }
    const LEV_IDS = [
      "orpi_levallois",
      "foncia_levallois",
      "laforet_levallois",
      "nestenn_courbevoie",
      "fnaim_levallois",
      "century21_levallois",
      "ca_immo_levallois",
      "era_levallois",
      "imax_levallois",
      "mister_property",
      "levimmo",
    ];
    expect(
      cfg.sources.dedicated
        .filter((s) => s.zones.join() === "92300")
        .map((s) => s.id)
        .sort(),
    ).toEqual([...LEV_IDS].sort());
    // Agences des deux zones (liste non filtrée) : une annonce « Paris » sans arrondissement y est titrée « Paris 17 ou Levallois », pas « Levallois ».
    expect(cfg.sources.dedicated.filter((s) => s.zones.join() === "75017,92300").map((s) => s.id)).toEqual([
      "bienici",
      "fredelion",
      "fredelion_p2",
      "consultants",
      "agence_pereire",
      "pni",
    ]);
    expect(cfg.sources.dedicated.filter((s) => s.zones.join() === "75017")).toHaveLength(
      17 + EXTRA_17_IDS.length + ["ca_immo_17", "era_17", "imax_paris", "safar"].length,
    );
    // Bien'ici : une seule requête pour les deux zones (-9519 = Paris 17e, -86985 = Levallois-Perret), 900-1 700 €, size 100.
    const f = JSON.parse(
      new URL(cfg.sources.dedicated.find((s) => s.id === "bienici")!.url).searchParams.get("filters")!,
    );
    expect(f).toMatchObject({
      size: 100,
      from: 0,
      filterType: "rent",
      propertyType: ["flat"],
      minPrice: 900,
      maxPrice: 1700,
      sortBy: "publicationDate",
      onTheMarket: [true],
    });
    expect(f.zoneIdsByTypes).toEqual({ zoneIds: ["-9519", "-86985"] });
    const page = JSON.parse(FIXTURE_BY_ID.bienici);
    expect(page.total).toBe(32); // 16 + 16 : size 100 laisse une marge x3
    expect(page.realEstateAds.length).toBe(page.total);
  });

  it("sources de Levallois enregistrées (URL des fixtures, parseur, filtre, groupe, marqueur)", () => {
    const by = (id: string) => cfg.sources.dedicated.find((s) => s.id === id)!;
    const LEV = { zones: ["92300"], active: true, encoding: "utf-8" };
    expect(by("orpi_levallois")).toMatchObject({
      ...LEV,
      parser: "orpi",
      filteredToZones: true,
      group: 1,
      url: "https://www.orpi.com/recherche/rent?realEstateTypes%5B0%5D=appartement&locations%5B0%5D%5Bvalue%5D=levallois-perret&locations%5B0%5D%5Blabel%5D=Levallois-Perret&sort=date-down&layoutType=mixte",
    });
    expect(by("foncia_levallois")).toMatchObject({
      ...LEV,
      parser: "foncia",
      filteredToZones: true,
      group: 3,
      url: "https://fr.foncia.com/location/levallois-perret-92300/appartement",
    });
    expect(by("laforet_levallois")).toMatchObject({
      ...LEV,
      parser: "laforet",
      filteredToZones: true,
      group: 0,
      url: "https://www.laforet.com/ville/location-appartement-levallois-perret-92300",
      stopMarker: 'id="nearest--area--',
    });
    expect(by("nestenn_courbevoie")).toMatchObject({
      ...LEV,
      parser: "nestenn",
      filteredToZones: false,
      group: 1,
      name: "Nestenn Courbevoie",
      phone: "01 49 97 33 33",
      url: "https://immobilier-courbevoie.nestenn.com/louer",
    });
    expect(by("fnaim_levallois")).toMatchObject({ ...LEV, parser: "fnaim", filteredToZones: true, group: 3 });
    expect(by("century21_levallois")).toMatchObject({
      ...LEV,
      active: false,
      parser: "century21",
      filteredToZones: true,
      group: 2,
      url: "https://www.century21.fr/annonces/location-appartement/v-levallois+perret/",
    });
    // La liste FNAIM : même requête que fnaim_17, localité Levallois-Perret (id 38051, INSEE 92044).
    const loc = JSON.parse(new URL(by("fnaim_levallois").url).searchParams.get("localites")!);
    expect(loc).toEqual([
      {
        id: "38051",
        label: "LEVALLOIS PERRET (92300)",
        type: "3",
        code: "92300",
        insee: "92044",
        value: "LEVALLOIS PERRET (92300)",
      },
    ]);
    expect(new URL(by("fnaim_levallois").url).searchParams.get("PRIX_MAX")).toBe("1700");
  });

  it("Nestenn enregistré avec son parseur, son encodage et son téléphone", () => {
    const by = (id: string) => cfg.sources.dedicated.find((s) => s.id === id)!;
    expect(by("nestenn_17")).toMatchObject({
      parser: "nestenn",
      encoding: "utf-8",
      filteredToZones: false,
      active: true,
      phone: "01 47 70 96 17",
    });
  });

  it("LBI : Sector Immobilier, Cabinet Azoulay, Equinimo enregistres avec leur parseur et leur telephone", () => {
    const by = (id: string) => cfg.sources.dedicated.find((s) => s.id === id)!;
    expect(by("sector")).toMatchObject({
      parser: "lbi2",
      encoding: "utf-8",
      filteredToZones: false,
      active: true,
      phone: "01 42 29 29 00",
      url: "https://www.sectorimmobilier.fr/a-louer/1",
    });
    expect(by("azoulay")).toMatchObject({
      parser: "lbi2",
      encoding: "utf-8",
      filteredToZones: false,
      active: true,
      phone: "01 55 42 77 71",
      url: "https://www.azoulay.net/location/1",
    });
    expect(by("equinimo")).toMatchObject({
      parser: "lbi",
      encoding: "utf-8",
      filteredToZones: false,
      active: true,
      phone: "01 84 20 40 37",
      url: "https://www.equinimo.fr/location/1",
    });
  });

  it("Apimo : Daniel Feau filtre sur le 17e, parseur apimo", () => {
    const by = (id: string) => cfg.sources.dedicated.find((s) => s.id === id)!;
    expect(by("feau_17")).toMatchObject({
      parser: "apimo",
      encoding: "utf-8",
      filteredToZones: true,
      active: true,
      url: "https://danielfeau.com/fr/listing/france/location/paris/paris-17eme",
    });
  });

  it("Domiere (Netty, base64 _TEMPLATE_DATA) active, groupe 3", () => {
    expect(cfg.sources.dedicated.find((s) => s.id === "domiere")).toMatchObject({
      parser: "netty",
      encoding: "utf-8",
      filteredToZones: false,
      active: true,
      group: 3,
      phone: "+33 1 45 74 08 08",
      url: "https://www.domiere.com/location",
    });
  });

  it("Laforêt Paris 17 (4 agences, URL de ville filtrée sur le 17e) active, groupe 0", () => {
    expect(cfg.sources.dedicated.find((s) => s.id === "laforet_17")).toMatchObject({
      parser: "laforet",
      encoding: "utf-8",
      filteredToZones: true,
      active: true,
      group: 0,
      phone: null,
      url: "https://www.laforet.com/ville/location-appartement-paris-75017",
    });
  });

  it("agences supplémentaires du 17e enregistrées (URL des fixtures, parseur, zones, filtre, groupe, marqueur)", () => {
    const by = (id: string) => cfg.sources.dedicated.find((s) => s.id === id)!;
    const P17 = { zones: ["75017"], active: true, encoding: "utf-8", filteredToZones: false };
    expect(by("elger")).toMatchObject({
      ...P17,
      parser: "osl",
      group: 1,
      phone: "+33 1 81 70 17 16",
      name: "Elger Immobilier",
      url: "https://www.elger-immobilier.com/fr/location-maison-appartement-paris/&new_research=1",
    });
    expect(by("oralia")).toMatchObject({
      ...P17,
      filteredToZones: true,
      parser: "oralia",
      group: 1,
      phone: null,
      name: "Oralia",
      url: "https://oralia.fr/location/nos-biens-a-louer/ile-de-france/paris-75/paris-75017",
    });
    expect(by("century21_17")).toMatchObject({
      ...P17,
      active: false,
      filteredToZones: true,
      parser: "century21",
      group: 4,
      phone: null,
      name: "Century 21 Paris 17",
      url: "https://www.century21.fr/annonces/location-appartement/cpv-75017_paris/",
    });
    expect(by("sainte_aubane")).toMatchObject({
      ...P17,
      parser: "lbi2",
      group: 2,
      phone: null,
      name: "Sainte Aubane Immobilière",
      url: "https://www.sainteaubane.com/locations/1",
    });
    expect(by("immediat")).toMatchObject({
      ...P17,
      parser: "lbi2",
      group: 3,
      phone: null,
      name: "Agence Immédiat",
      url: "https://www.agence-immediat.fr/location/1",
    });
    expect(by("aream")).toMatchObject({
      ...P17,
      parser: "apimo",
      group: 0,
      phone: "+33 1 58 36 36 58",
      name: "Aream",
      url: "https://aream.fr/fr/locations",
    });
    expect(by("connexion")).toMatchObject({
      ...P17,
      parser: "apimo",
      group: 4,
      phone: "+33 1 40 54 29 80",
      name: "Connexion Immobilier",
      url: "https://connexion.immo/fr/locations-paris",
    });
    expect(by("impact")).toMatchObject({
      ...P17,
      parser: "apimo",
      group: 1,
      phone: "01 75 61 42 00",
      name: "Impact Immo",
      url: "https://impact-immo.com/fr/locations",
    });
  });

  it("voie 0 : 32 sources au registre réparties en 5 groupes d'au plus 10 (cadence de 5 min conservée), Century 21 désactivée, pages lourdes au plus 3 par groupe", () => {
    const lane0 = cfg.sources.dedicated.filter((x) => x.group < GROUP_COUNT);
    expect(lane0).toHaveLength(32);
    expect(ACTIVE).toHaveLength(cfg.sources.dedicated.length - INACTIVE_IDS.length);
    expect(EXTRA_17_IDS).toHaveLength(8);
    expect(GROUPS.slice(0, GROUP_COUNT).map((g) => cfg.sources.dedicated.filter((x) => x.group === g).length)).toEqual([
      7, 7, 5, 6, 7,
    ]);
    for (const g of GROUPS) expect(ACTIVE.filter((x) => x.group === g).length).toBeLessThanOrEqual(GROUP_MAX_SOURCES);
    // Groupes des 8 agences de EXTRA_17_IDS : 0 (aream), 1 (impact, oralia, elger : le groupe d'Orpi), 2 (sainte_aubane),
    // 3 (immediat), 4 (connexion, century21_17).
    const g = (id: string) => cfg.sources.dedicated.find((x) => x.id === id)!.group;
    expect(EXTRA_17_IDS.map((id) => [id, g(id)]).sort()).toEqual([
      ["aream", 0],
      ["century21_17", 4],
      ["connexion", 4],
      ["elger", 1],
      ["immediat", 3],
      ["impact", 1],
      ["oralia", 1],
      ["sainte_aubane", 2],
    ]);
  });

  it("seconde voie : 14 sources (groupes 5 à 9, au plus trois par groupe), lecteurs et marqueurs déclarés, une page lourde au plus par groupe", () => {
    const by = (id: string) => cfg.sources.dedicated.find((s) => s.id === id)!;
    expect(SECOND_LANE_IDS).toHaveLength(14);
    expect(GROUPS.slice(GROUP_COUNT).map((g) => cfg.sources.dedicated.filter((x) => x.group === g).length)).toEqual([
      3, 3, 2, 3, 3,
    ]);
    expect(
      cfg.sources.dedicated
        .filter((x) => x.group >= GROUP_COUNT)
        .map((x) => x.id)
        .sort(),
    ).toEqual([...SECOND_LANE_IDS].sort());
    expect(by("imax_levallois")).toMatchObject({
      parser: "office5",
      encoding: "windows-1252",
      filteredToZones: true,
      zones: ["92300"],
      phone: "01 56 04 00 00",
    });
    for (const id of ["ca_immo_17", "ca_immo_levallois", "era_17", "era_levallois", "consultants"])
      expect(by(id).filteredToZones, id).toBe(true);
    // Chaque source de la seconde voie se lit sur sa page enregistrée (era_levallois : réponse vide réelle -> aucune annonce, sans erreur).
    for (const id of SECOND_LANE_IDS) {
      const out = PARSERS[by(id).parser](FIXTURE_BY_ID[id], by(id));
      if (id === "era_levallois") expect(out).toEqual([]);
      else expect(out.length, id).toBeGreaterThan(0);
    }
  });

  it("les deux Orpi dans un même groupe avec des sources LEGERES seulement ; autres groupes <= 10 sources dont au plus 3 LOURDES (page de fixture > 400 Ko) ; au plus 1 LOURDE par sous-lot", () => {
    // parse < 1 ms et page < 300 Ko
    const LIGHT = ["spr", "sector", "nestenn_17", "nestenn_courbevoie", "impact", "oralia", "elger"];
    const HEAVY = cfg.sources.dedicated.filter((s) => FIXTURE_BY_ID[s.id].length > 400_000).map((s) => s.id);
    expect(HEAVY.sort()).toEqual([
      "cmb",
      "cmb_p2",
      "domiere",
      "laforet_17",
      "laforet_levallois",
      "orpi_17",
      "orpi_levallois",
      "safar",
    ]);
    for (const id of LIGHT) expect(FIXTURE_BY_ID[id].length).toBeLessThan(300_000);
    const groups = GROUPS.map((g) => ACTIVE.filter((s) => s.group === g).map((s) => s.id));
    const orpi = groups.find((g) => g.includes("orpi_17"))!;
    expect(orpi).toContain("orpi_levallois");
    const others = orpi.filter((id) => !id.startsWith("orpi_"));
    expect(others.length).toBeLessThanOrEqual(GROUP_MAX_SOURCES - 2);
    expect(others.every((id) => LIGHT.includes(id))).toBe(true);
    for (const g of groups) {
      if (g === orpi) continue;
      expect(g.length <= GROUP_MAX_SOURCES).toBe(true);
      expect(g.filter((id) => HEAVY.includes(id)).length).toBeLessThanOrEqual(3);
    }
    // Chaque sous-lot est une invocation (10 ms de CPU) : jamais deux pages lourdes dans le meme.
    for (const g of GROUPS)
      for (const p of groupParts(g))
        expect(p.filter((id) => HEAVY.includes(id)).length, p.join("+")).toBeLessThanOrEqual(1);
  });
});

describe("runScan", () => {
  it("aucune alerte au premier passage, une seule au second avec une annonce de plus", async () => {
    const spy = mockFetch();
    // Groupe 0 (celui de Bien'ici) : un passage « all » de plus de 45 sources n'a plus de budget de sous-requêtes pour une alerte.
    const r1 = await runScan(E, 0, t(10, 0));
    expect(tgCalls(spy)).toHaveLength(0);
    expect(r1.alertsSent).toBe(0);
    expect(r1.sources).toHaveLength(ACTIVE.filter((x) => x.group === 0).length);
    spy.mockRestore();

    const spy2 = mockFetch({ extra: true });
    const r2 = await runScan(E, 0, t(10, 5));
    expect(tgCalls(spy2)).toHaveLength(1);
    expect(r2.alertsSent).toBe(1);
  });

  it("une source en 403 trois fois : panne suivie en base, aucun message Telegram, les autres continuent", async () => {
    const spy = mockFetch({ failing: BROKEN });
    let report: ScanReport | undefined;
    for (let i = 0; i < 3; i++) report = await runScan(E, GROUPS, t(10, i));
    expect(tgCalls(spy)).toHaveLength(0);
    const st = await env.DB.prepare("SELECT broken FROM source_state WHERE source = ?")
      .bind(BROKEN)
      .first<{ broken: number }>();
    expect(st?.broken).toBe(1);
    expect(report!.sources.find((s) => s.id === BROKEN)).toMatchObject({ ok: false, reason: "HTTP 403" });
    expect(report!.sources.filter((s) => s.ok).length).toBe(ACTIVE.length - 1);
  });

  it("anti-bot detecte, et un parseur qui leve devient parse_error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.includes("bienici")) return new Response("<html>Just a moment...</html>");
      if (u.includes("orpi")) return new Response("pas du json ni du html attendu");
      return new Response("<html></html>");
    });
    const r = await runScan(E, GROUPS, t(10, 0));
    expect(r.sources.find((s) => s.id === "bienici")).toMatchObject({ ok: false, reason: "anti-bot" });
    expect(r.sources.find((s) => s.id === "orpi_17")).toMatchObject({ ok: false, reason: "parse_error" });
  });

  it("budget (orchestrateur) : sous-lots + messages + alertes + 2 de marge, jamais plus de 48 sous-requetes (pire cas : le groupe actif le plus rempli, toutes ses sources en panne ; et la borne theorique d'un groupe de GROUP_MAX_SOURCES = 10 sources)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.includes("/sendPhoto")) return new Response("bad", { status: 400 });
      if (u.startsWith("https://api.telegram.org/")) return new Response("{}", { status: 200 });
      return new Response("no", { status: 403 });
    });
    const size = (g: number) => ACTIVE.filter((x) => x.group === g).length; // sources actives : les desactivees ne coutent aucune sous-requete
    const G = GROUPS.reduce((best, g) => (size(g) > size(best) ? g : best), 0); // groupe actif le plus charge (pire cas reel) ; le passage manuel « all » n'a pas cette garantie
    await runScan(E, G, t(10, 0));
    await runScan(E, G, t(10, 1));
    await seedPending(24);
    spy.mockClear();
    const r = await runScan(E, G, t(10, 2)); // n sous-lots (PART_SIZE = 1), pannes sans message
    const n = size(G);
    expect(n).toBeLessThanOrEqual(GROUP_MAX_SOURCES);
    const parts = groupParts(G).length;
    expect(parts).toBe(n);
    // Les lectures des sources se font dans les invocations /part (1 sous-requete chacune) ; l'orchestrateur paie 1 appel par sous-lot.
    expect(parts + tgCalls(spy).length).toBeLessThanOrEqual(48);
    // un appel par sous-lot, 2 reservees : (50-10-2)/2 = 19 avec 10 sources, plafonne par ALERT_BUDGET (15)
    expect(r.alertsSent).toBe(Math.min(15, Math.floor((50 - parts - 2) / 2)));
    // Borne theorique : meme avec GROUP_MAX_SOURCES sources actives (des sources desactivees peuvent etre reactivees), le budget tient.
    const theoretical = GROUP_MAX_SOURCES + 2 * Math.min(15, Math.floor((50 - GROUP_MAX_SOURCES - 2) / 2));
    expect(theoretical + 2).toBeLessThanOrEqual(48);
    expect(parts).toBeLessThanOrEqual(GROUP_MAX_SOURCES);
  });

  it("budget (orchestrateur, deux voies) : les deux groupes d'un passage, toutes leurs sources en panne, jamais plus de 48 sous-requetes", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.includes("/sendPhoto")) return new Response("bad", { status: 400 });
      if (u.startsWith("https://api.telegram.org/")) return new Response("{}", { status: 200 });
      return new Response("no", { status: 403 });
    });
    const size = (g: number) => ACTIVE.filter((x) => x.group === g || x.group === g + GROUP_COUNT).length;
    const G = GROUPS.slice(0, GROUP_COUNT).reduce((best, g) => (size(g) > size(best) ? g : best), 0); // paire la plus chargee
    const pair = [G, G + GROUP_COUNT];
    await runScan(E, pair, t(10, 0));
    await runScan(E, pair, t(10, 1));
    await seedPending(24);
    spy.mockClear();
    const r = await runScan(E, pair, t(10, 2)); // n sous-lots, pannes sans message
    const n = size(G);
    expect(n).toBeLessThanOrEqual(2 * GROUP_MAX_SOURCES);
    expect(r.sources).toHaveLength(n);
    expect(n + tgCalls(spy).length).toBeLessThanOrEqual(48);
    expect(r.alertsSent).toBe(Math.min(15, Math.floor((50 - n - 2) / 2)));
  });

  it("passage complet : last_run ecrit pour chaque source traitee", async () => {
    mockFetch({ failing: "foncia_17" });
    await runScan(E, 0, t(10, 0));
    const run = async (s: string) =>
      (
        await env.DB.prepare("SELECT last_run FROM source_state WHERE source = ?")
          .bind(s)
          .first<{ last_run: string | null }>()
      )?.last_run ?? null;
    expect(await run("bienici")).toBe(t(10, 0).toISOString());
    expect(await run("sector")).toBe(t(10, 0).toISOString());
    expect(await run("foncia_17")).toBeNull(); // 403 : pas de passage complet
  });

  it("traitement qui leve : passage compte en echec « erreur interne », sans last_run", async () => {
    mockFetch();
    const db = new Proxy(env.DB, {
      get(target, k) {
        if (k === "batch")
          return async () => {
            throw new Error("d1 down");
          };
        const v = (target as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const dbEnv: Env = { ...E, DB: db as D1Database };
    dbEnv.SELF = loopSelf(dbEnv); // /part doit voir la base qui leve
    const r = await runScan(dbEnv, 0, t(10, 0));
    expect(r.sources.find((s) => s.id === "bienici")).toMatchObject({ ok: false, reason: "erreur interne" });
    const st = await env.DB.prepare(
      "SELECT consecutive_failures, last_error, last_ok, last_run FROM source_state WHERE source = 'bienici'",
    ).first();
    expect(st).toEqual({ consecutive_failures: 1, last_error: "erreur interne", last_ok: null, last_run: null });
  });

  it("source sans passage depuis 20 min : panne suivie en base, rétablie au passage suivant, aucun message Telegram", async () => {
    const broken = async () =>
      (await env.DB.prepare("SELECT broken FROM source_state WHERE source = 'orpi_17'").first<{ broken: number }>())
        ?.broken;
    await env.DB.prepare("INSERT INTO source_state (source, initialized, last_run) VALUES ('orpi_17', 1, ?)")
      .bind(t(9, 30).toISOString())
      .run();
    const spy = mockFetch();
    await runScan(E, 0, t(10, 0)); // groupe 0 : Orpi (groupe 1) n'a pas tourne depuis 30 min
    expect(await broken()).toBe(1);
    await runScan(E, 1, t(10, 3)); // Orpi repasse : retablie
    expect(await broken()).toBe(0);
    expect(tgCalls(spy)).toHaveLength(0);
  });

  it("ne lit que le groupe demande", async () => {
    const spy = mockFetch();
    const r = await runScan(E, 0, t(10, 0));
    expect(r.sources.map((s) => s.id).sort()).toEqual(
      ACTIVE.filter((s) => s.group === 0)
        .map((s) => s.id)
        .sort(),
    );
    expect(spy).toHaveBeenCalledTimes(ACTIVE.filter((s) => s.group === 0).length);
  });
});

describe("routes", () => {
  const call = (path: string, e: Env = E) =>
    worker.fetch(new Request(`https://x.test${path}`), e, createExecutionContext());

  it("/status refuse sans cle ou avec mauvaise cle, accepte avec la cle", async () => {
    expect((await call("/status")).status).toBe(403);
    expect((await call("/status?k=nope")).status).toBe(403);
    const ok = await call("/status?k=secret-key");
    expect(ok.status).toBe(200);
    expect(Array.isArray(await ok.json())).toBe(true);
  });

  it("ADMIN_KEY vide refuse tout, meme avec k vide", async () => {
    expect((await call("/status?k=", { ...E, ADMIN_KEY: "" })).status).toBe(403);
    expect((await call("/status", { ...E, ADMIN_KEY: "" })).status).toBe(403);
  });

  it("/inconnu renvoie 404 (la racine sert le tableau de bord)", async () => {
    expect((await call("/inconnu")).status).toBe(404);
  });

  it("/test : source inconnue 404, source connue renvoie count/listings/evaluations sans ecrire", async () => {
    mockFetch();
    expect((await call("/test?source=zzz&k=secret-key")).status).toBe(404);
    const res = await call("/test?source=bienici&k=secret-key");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; listings: unknown[]; evaluations: unknown[] };
    expect(body.count).toBe(18);
    expect(body.listings).toHaveLength(18);
    expect(body.evaluations).toHaveLength(18);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM listings").first<{ n: number }>())!.n).toBe(0);
  });

  it("/scan?group=0 execute le scan, group invalide 400", async () => {
    mockFetch();
    const res = await call("/scan?group=0&k=secret-key");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sources: unknown[] }).sources).toHaveLength(
      ACTIVE.filter((s) => s.group === 0).length,
    );
    expect((await call("/scan?group=10&k=secret-key")).status).toBe(400); // groupes 0 à 9 (deux voies)
    expect((await call("/scan?group=9&k=secret-key")).status).toBe(200);
    expect((await call("/scan?k=secret-key")).status).toBe(400);
    expect((await call("/scan?group=all&k=secret-key")).status).toBe(400);
    expect((await call("/scan?group=2&k=secret-key")).status).toBe(200);
  });

  it("/stats : cluster avec alerte envoyee, sources et plus rapide", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO listings (source,listing_id,cluster,first_seen,alert_status,payload) VALUES ('a','1','a:1','2026-10-19T10:05:00Z','sent','{}')",
      ),
      env.DB.prepare(
        "INSERT INTO listings (source,listing_id,cluster,first_seen,alert_status,payload) VALUES ('b','9','a:1','2026-10-19T10:00:00Z','duplicate','{}')",
      ),
      env.DB.prepare(
        "INSERT INTO listings (source,listing_id,cluster,first_seen,alert_status,payload) VALUES ('c','2','c:2','2026-10-19T10:00:00Z','silent','{}')",
      ),
    ]);
    const body = (await (await call("/stats?k=secret-key")).json()) as {
      cluster: string;
      fastest: string;
      sources: unknown[];
    }[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ cluster: "a:1", fastest: "b" });
    expect(body[0].sources).toHaveLength(2);
  });
});

describe("scheduled", () => {
  it("hors fenetre (7h Paris) : aucun fetch", async () => {
    const spy = mockFetch();
    const ctx = createExecutionContext();
    vi.setSystemTime(Date.parse("2026-10-19T05:00:05Z")); // la fenetre active se juge sur l'horloge reelle
    await worker.scheduled(createScheduledController({ scheduledTime: Date.parse("2026-10-19T05:00:00Z") }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fenetre active jugee sur l'horloge reelle, pas sur scheduledTime : cron prevu a 19h59 de Paris, parti a 20h00 : aucun scan", async () => {
    const spy = mockFetch();
    const ctx = createExecutionContext();
    vi.setSystemTime(Date.parse("2026-10-19T18:00:03Z")); // 20h00 Paris : hors fenetre, avant le creneau du resume (20h05)
    await worker.scheduled(createScheduledController({ scheduledTime: Date.parse("2026-10-19T17:59:00Z") }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect(spy).not.toHaveBeenCalled();
  });

  it("dans la fenetre (10h Paris) : scanne le groupe", async () => {
    const spy = mockFetch();
    const ctx = createExecutionContext();
    vi.setSystemTime(Date.parse("2026-10-19T08:00:05Z")); // le cron part quelques secondes apres l'heure prevue
    await worker.scheduled(createScheduledController({ scheduledTime: Date.parse("2026-10-19T08:00:00Z") }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect(spy).toHaveBeenCalledTimes(ACTIVE.filter((s) => s.group === G10H || s.group === G10H + GROUP_COUNT).length); // 08:00 UTC -> groupes G10H et G10H + 5
  });

  it("deux voies, un seul cron : le passage de 08:00 lit les groupes 0 et 5 en parallele ; une alerte en attente part une seule fois", async () => {
    await seedPending(1);
    const spy = mockFetch();
    vi.setSystemTime(Date.parse("2026-10-19T08:00:05Z"));
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.parse("2026-10-19T08:00:00Z") }), E, ctx);
    await waitOnExecutionContext(ctx);
    const read = spy.mock.calls.map((c) => String(c[0])).filter((u) => !u.startsWith("https://api.telegram.org/"));
    const both = ACTIVE.filter((s) => s.group === G10H || s.group === G10H + GROUP_COUNT).map((s) => s.url);
    expect(ACTIVE.some((s) => s.group === G10H + GROUP_COUNT)).toBe(true);
    expect(read.sort()).toEqual(both.sort());
    expect(tgCalls(spy).filter((c) => String(c[0]).endsWith("/sendPhoto"))).toHaveLength(1);
  });

  /** SELF du pool qui enregistre, pour chaque POST /part, les ids, l'instant signe (now) et le statut de la reponse. */
  function recordingSelf() {
    const seen: { ids: string[]; now: string; status: number }[] = [];
    const self = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const { ids, now } = (await req.clone().json()) as { ids: string[]; now: string };
        const res = await E.SELF!.fetch(req);
        seen.push({ ids, now, status: res.status });
        return res;
      },
    } as unknown as Fetcher;
    return { seen, self };
  }
  const lastRun = async (id: string) =>
    (await env.DB.prepare("SELECT last_run FROM source_state WHERE source = ?").bind(id).first<{ last_run: string }>())
      ?.last_run;

  it("cron parti 7 min en retard : groupe choisi sur scheduledTime, mais sous-lots signes avec l'horloge reelle (aucun HTTP 400), last_run = horloge reelle, aucune source en echec", async () => {
    mockFetch();
    const { seen, self } = recordingSelf();
    const real = Date.parse("2026-10-19T08:07:05Z"); // scheduledTime 08:00:00Z : 7 min de retard
    vi.setSystemTime(real);
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.parse("2026-10-19T08:00:00Z") }),
      { ...E, SELF: self },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(seen.map((s) => s.ids).sort(byIds)).toEqual(passParts().sort(byIds)); // groupe de la cadence (scheduledTime), pas de la minute reelle (07 -> groupe 2)
    expect(seen.map((s) => s.status)).toEqual(seen.map(() => 200));
    for (const s of seen) expect(Math.abs(Date.parse(s.now) - Date.now())).toBeLessThan(1000);
    for (const s of ACTIVE.filter(inPass)) {
      expect(await lastRun(s.id), s.id).toBe(new Date(real).toISOString());
      expect(await failures(s.id), s.id).toBe(0);
    }
  });

  it("passage en retard : aucun sous-lot coupe d'emblee (ni « délai dépassé » ni echec), delai de sous-lot = PART_TIMEOUT_MS (25 s) depuis le lancement reel", async () => {
    mockFetch();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.parse("2026-10-19T08:07:05Z") });
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { seen, self } = recordingSelf();
    let delays: number[];
    try {
      const ctx = createExecutionContext();
      await worker.scheduled(
        createScheduledController({ scheduledTime: Date.parse("2026-10-19T08:00:00Z") }),
        { ...E, SELF: self },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      delays = timers.mock.calls.map((c) => c[1]).filter((d): d is number => typeof d === "number"); // avant mockRestore (qui vide les appels)
    } finally {
      timers.mockRestore();
    }
    const partTimeouts = delays.filter((d) => d > 20_000 && d <= 25_000); // (le minuteur de 30 s vu ici n'est pas celui du Worker)
    expect(partTimeouts).toHaveLength(passParts().length); // un minuteur par sous-lot
    for (const d of partTimeouts) {
      expect(d).toBeGreaterThan(24_000);
      expect(d).toBeLessThanOrEqual(PART_TIMEOUT_MS);
    }
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0); // jamais un delai negatif (echeance calculee sur scheduledTime)
    expect(seen).toHaveLength(passParts().length);
    expect(seen.map((s) => s.status)).toEqual(seen.map(() => 200));
    for (const s of ACTIVE.filter(inPass)) {
      expect(await failures(s.id), s.id).toBe(0);
      expect(await lastRun(s.id), s.id).toBeTruthy();
    }
  });

  it("runScan avec un instant (now) de 7 min en arriere : le 1er sous-lot garde ses 25 s pleines et l'echeance de 40 s court depuis le debut reel du passage", async () => {
    mockFetch();
    const base = selfRunner(E);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.parse("2026-10-19T08:07:05Z") });
    const late = new Date("2026-10-19T08:00:00Z");
    const [first] = groupParts(G10H);
    let settled = false,
      hung!: () => void;
    const reached = new Promise<void>((res) => {
      hung = res;
    });
    const p = runScan(E, G10H, late, (ids, now) => {
      if (ids[0] !== first[0]) return base(ids, now);
      hung();
      // Le 1er sous-lot repond au bout de 24,9 s : dans son delai (25 s) malgre le retard de 7 min de `now`.
      return new Promise<PartResult>((resolve) =>
        setTimeout(
          () => resolve({ sources: ids.map((id) => ({ id, ok: true, count: 0, ms: 0 })), events: [] }),
          24_900,
        ),
      );
    });
    void p.then(() => {
      settled = true;
    });
    await reached;
    await vi.advanceTimersByTimeAsync(24_899);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.sources[0]).toEqual({ id: first[0], ok: true, count: 0, ms: 0 });
    // 24,9 s < 40 s : les sous-lots suivants demarrent (echeance depuis le debut reel du passage, pas depuis `now`).
    expect(r.sources.filter((s) => s.reason === PASS_TOO_LATE || s.reason === PART_FAILED)).toEqual([]);
    expect(r.sources).toHaveLength(groupParts(G10H).length);
  });
});

describe("parsePartRequest : ecart d'horloge (rejeu d'une requete signee)", () => {
  const ids = [ACTIVE[0].id];
  const req = (offsetMs: number) => parsePartRequest({ ids, now: new Date(Date.now() + offsetMs).toISOString() });

  it("PART_MAX_SKEW_MS = 10 min : un cron en retard de plusieurs minutes (jusqu'a 10) reste accepte, des deux cotes de l'horloge", () => {
    expect(PART_MAX_SKEW_MS).toBe(10 * 60_000);
    for (const offset of [
      0,
      -6 * 60_000,
      -9 * 60_000,
      -9 * 60_000 - 59_000,
      -PART_MAX_SKEW_MS,
      9 * 60_000,
      PART_MAX_SKEW_MS,
    ]) {
      expect(req(offset), String(offset)).toMatchObject({ sources: [{ id: ids[0] }] });
    }
  });

  it("au-dela de 10 min (dans les deux sens) : refuse (null), tout comme un instant illisible ou absent", () => {
    for (const offset of [-PART_MAX_SKEW_MS - 1000, -11 * 60_000, PART_MAX_SKEW_MS + 1000, 11 * 60_000, -3_600_000]) {
      expect(req(offset), String(offset)).toBeNull();
    }
    expect(parsePartRequest({ ids, now: "pas une date" })).toBeNull();
    expect(parsePartRequest({ ids })).toBeNull();
  });
});

describe("fetchSource anti-bot", () => {
  const src = cfg.sources.dedicated.find((s) => s.id === "fnaim_17")!;
  it("un script datadome dans une page saine n'est pas de l'anti-bot", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('<html><script src="https://js.datadome.co/tags.js"></script><body>annonces</body></html>'),
    );
    expect(await fetchSource(src)).toMatchObject({ ok: true });
  });
  it("M4 : lecture d'une source abandonnee au bout de 10 s (AbortSignal.timeout(SOURCE_TIMEOUT_MS) ; listes lues en 0,1 a 0,3 s en prod), echeance du passage inchangee (40 s)", async () => {
    expect(SOURCE_TIMEOUT_MS).toBe(10_000);
    expect(PASS_DEADLINE_MS).toBe(40_000);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>annonces</html>"));
    await fetchSource(src);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
  it("captcha-delivery est de l'anti-bot", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('<iframe src="https://geo.captcha-delivery.com/x"></iframe>'),
    );
    expect(await fetchSource(src)).toEqual({ ok: false, reason: "anti-bot" });
  });
});

describe("fetchSource : lecture bornee (marqueur de fin, plafond de 2 Mo)", () => {
  const fnaim = cfg.sources.dedicated.find((s) => s.id === "fnaim_17")!; // source sans marqueur de fin
  const cmb = cfg.sources.dedicated.find((s) => s.id === "cmb")!;
  const enc = new TextEncoder();
  /** Page servie en flux de morceaux de 64 Ko (comme le reseau) ; pulled = octets reellement servis. */
  function serve(page: string) {
    const bytes = enc.encode(page),
      stats = { pulled: 0 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      let i = 0;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(c) {
              if (i >= bytes.length) {
                c.close();
                return;
              }
              const part = bytes.slice(i, i + 64 * 1024);
              i += part.length;
              stats.pulled += part.length;
              c.enqueue(part);
            },
          },
          { highWaterMark: 0 },
        ),
      );
    });
    return stats;
  }

  it("marqueur de la source : corps coupe juste apres lui, le reste de la page n'est pas lu", async () => {
    const page = `<html>${"a".repeat(300_000)}<footer>${"b".repeat(600_000)}`;
    const stats = serve(page);
    const res = await fetchSource({ ...fnaim, stopMarker: "<footer>" });
    expect(res).toMatchObject({
      ok: true,
      body: page.slice(0, page.indexOf("<footer>") + 8),
      stopped: true,
      truncated: false,
    });
    expect(res.ok && res.bytes).toBeLessThan(400_000);
    expect(stats.pulled).toBeLessThan(400_000);
  });

  it("sans marqueur : page entiere ; plafond SOURCE_MAX_BYTES (2 Mo) ou maxBytes de la source atteint : truncated", async () => {
    expect(SOURCE_MAX_BYTES).toBe(2_000_000);
    const small = `<html>${"c".repeat(300_000)}</html>`;
    serve(small);
    expect(await fetchSource(fnaim)).toEqual({
      ok: true,
      body: small,
      bytes: small.length,
      stopped: false,
      truncated: false,
    });
    serve("d".repeat(2_100_000));
    const big = await fetchSource(fnaim);
    expect(big).toMatchObject({ ok: true, bytes: 2_000_000, stopped: false, truncated: true });
    expect(big.ok && big.body.length).toBe(2_000_000);
    serve(small);
    expect(await fetchSource({ ...fnaim, maxBytes: 100_000 })).toMatchObject({
      ok: true,
      bytes: 100_000,
      truncated: true,
    });
    serve(small); // marqueur absent de la page : lecture complete normale
    expect(await fetchSource({ ...fnaim, stopMarker: "<footer>" })).toMatchObject({
      ok: true,
      body: small,
      stopped: false,
      truncated: false,
    });
  });

  it("parseSource : page de pagination (extraPage) sans carte -> [] (site avec moins d'annonces) ; page 1 sans carte -> parse_error ; tronquée -> échec", () => {
    const blank = "<main><div>Estimer votre bien</div></main>";
    expect(parseSource({ ...cmb, extraPage: true }, blank)).toEqual({ ok: true, listings: [] });
    expect(parseSource(cmb, blank)).toEqual({ ok: false, reason: "parse_error" });
    expect(parseSource({ ...cmb, extraPage: true }, blank, true)).toEqual({ ok: false, reason: "page tronquée" });
  });

  it("parseSource : page tronquee sans carte -> echec « page tronquee », jamais [] ; avec cartes -> les cartes", () => {
    const emptyLbi = `<main><div class="properties-list-v1"><p>Désolé, aucun bien n'est disponible pour le moment.</p></div></main>`;
    expect(parseSource(cmb, emptyLbi)).toEqual({ ok: true, listings: [] }); // etat vide reel, page complete
    expect(parseSource(cmb, emptyLbi, true)).toEqual({ ok: false, reason: "page tronquée" });
    expect(parseSource(fnaim, `<html>${"x".repeat(1000)}`, true)).toEqual({ ok: false, reason: "page tronquée" }); // parseur qui leve
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const full = parseSource(cmb, cmbRaw, true);
    expect(full.ok && full.listings.length).toBe(20);
    // Plafond atteint avec des cartes : gardées, mais signalées (cartes au-delà du plafond perdues), sans URL ni contenu de page.
    expect(full).toMatchObject({ ok: true, truncated: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^cmb: page tronquée au plafond, 20 annonces lues/);
    expect(parseSource(cmb, cmbRaw)).not.toHaveProperty("truncated"); // page complète : pas de signalement
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("runPart : plafond atteint avec des cartes -> source OK avec truncated: true dans le rapport ; page complete : pas de truncated", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const capped = { ...cmb, stopMarker: undefined, maxBytes: 400_000 }; // cmb : dernier article a ~371 Ko, page de 489 Ko
    serve(cmbRaw);
    const r = await runPart(E, [capped], t(10, 0));
    expect(r.sources).toEqual([expect.objectContaining({ id: "cmb", ok: true, count: 20, truncated: true })]);
    expect(warn).toHaveBeenCalled();
    serve(cmbRaw);
    const again = await runPart(E, [cmb], t(10, 1));
    expect(again.sources).toEqual([expect.objectContaining({ id: "cmb", ok: true, count: 20 })]);
    expect(again.sources[0]).not.toHaveProperty("truncated");
  });

  it("runPart : page de plus de 2 Mo sans carte -> source en echec « page tronquee »", async () => {
    serve(`<html>${"y".repeat(2_100_000)}`);
    const r = await runPart(E, [fnaim], t(10, 0));
    expect(r.sources).toEqual([expect.objectContaining({ id: "fnaim_17", ok: false, reason: "page tronquée" })]);
    expect(await failures("fnaim_17")).toBe(1);
  });

  it("/test indique la lecture (octets, arret au marqueur, troncature)", async () => {
    mockFetch();
    const res = await worker.fetch(
      new Request("https://x.test/test?source=bienici&k=secret-key"),
      E,
      createExecutionContext(),
    );
    const body = (await res.json()) as { read: unknown };
    expect(body.read).toEqual({ bytes: enc.encode(bieniciRaw).length, stopped: false, truncated: false });
  });
});

// Lecture bornée des pages lourdes : chaque marqueur de fin est prouvé sur la fixture de sa source.
describe("marqueurs de fin des pages lourdes (lecture bornee, prouves sur les fixtures)", () => {
  const enc = new TextEncoder();
  /** Sources à marqueur de fin : marqueur attendu et fixture (page peuplée). */
  const MARKED: Record<string, { marker: string; page: string }> = {
    laforet_17: { marker: 'id="nearest--area--', page: "laforet.html" }, // section « Appartements à proximité » (40 cartes d'autres villes)
    cmb: { marker: "</main>", page: "cmb.html" }, // fin du contenu principal (après la pagination), puis pied de page et scripts
    cmb_p2: { marker: "</main>", page: "cmb.html" },
    // Même gabarit et même repère que le 17e ; 213 Ko lus sur 1 249 Ko.
    laforet_levallois: { marker: 'id="nearest--area--', page: "laforet_levallois.html" },
    // Frédélion page 1 (388 Ko) : bloc d'appel à projet après la dernière carte ; Safar (405 Ko, ISO-8859-1) : barre de
    // navigation après la dernière carte (~162 Ko lus).
    fredelion: { marker: "container-cta-purchase-project", page: "fredelion.html" },
    safar: { marker: '<div class="barre-navigation-bottom">', page: "safar.html" },
  };

  const CHUNK = 64 * 1024;
  type Server = (bytes: Uint8Array, stats: { pulled: number }) => ReadableStream<Uint8Array>;
  /** Flux par défaut : premier morceau coupé au milieu du premier caractère multi-octets après 1 Ko, puis morceaux de 64 Ko. */
  const splitDefault: Server = (bytes, stats) => {
    let cut = 1024;
    while (cut < bytes.length && bytes[cut] < 0xc0) cut++; // premier octet de tête d'un caractère multi-octets
    expect(cut, "la page contient un caractère multi-octets").toBeLessThan(bytes.length);
    let i = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(c) {
          if (i >= bytes.length) {
            c.close();
            return;
          }
          const part = bytes.slice(i, i === 0 ? cut + 1 : i + CHUNK); // octet de tête dans ce morceau, suite dans le suivant
          i += part.length;
          stats.pulled += part.length;
          c.enqueue(part);
        },
      },
      { highWaterMark: 0 },
    );
  };
  /** Flux d'octets (lecture BYOB readAtLeast, comme le corps d'un fetch dans workerd), morceaux de 64 Ko. */
  const byteStream: Server = (bytes, stats) => {
    let i = 0;
    return new ReadableStream(
      {
        type: "bytes",
        pull(c) {
          if (i >= bytes.length) {
            c.close();
            return;
          }
          const part = bytes.slice(i, i + CHUNK);
          i += part.length;
          stats.pulled += part.length;
          c.enqueue(part);
        },
      },
      { highWaterMark: 0 },
    );
  };
  function serve(page: string, server: Server) {
    const bytes = enc.encode(page),
      stats = { pulled: 0, size: bytes.length };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(server(bytes, stats)));
    return stats;
  }
  const src = (id: string) => cfg.sources.dedicated.find((s) => s.id === id)!;
  const cutAt = (page: string, marker: string) => page.slice(0, page.indexOf(marker) + marker.length);

  describe("registre : marqueurs de fin", () => {
    it("seules les pages lourdes au marqueur prouvé en ont un ; aucun plafond propre (2 Mo par défaut)", () => {
      const marked = Object.fromEntries(
        cfg.sources.dedicated.filter((s) => s.stopMarker).map((s) => [s.id, s.stopMarker]),
      );
      expect(marked).toEqual(Object.fromEntries(Object.entries(MARKED).map(([id, m]) => [id, m.marker])));
      // Sans marqueur, et pourquoi : bienici (JSON), orpi_17 (attribut data-result jusqu'à 2 Ko de la fin), domiere (bloc base64
      // jusqu'à 1,5 Ko de la fin).
      // orpi_levallois : data-result finit à 2,5 Ko de la fin de la page (405 Ko), comme orpi_17.
      for (const id of ["bienici", "orpi_17", "orpi_levallois", "domiere"])
        expect(src(id).stopMarker, id).toBeUndefined();
      expect(cfg.sources.dedicated.filter((s) => s.maxBytes !== undefined)).toEqual([]);
    });
  });

  describe.each([
    ["flux par défaut, caractère multi-octets coupé entre deux morceaux", splitDefault],
    ["flux d'octets (BYOB)", byteStream],
  ])("pages à marqueur, %s", (_label, server) => {
    // Pages UTF-8 seulement (coupure au milieu d'un caractère multi-octets) ; safar (ISO-8859-1) a son test plus bas.
    for (const [id, { marker, page: file }] of Object.entries(MARKED).filter(([id]) => src(id).encoding === "utf-8")) {
      it(`${id} : lecture arrêtée au marqueur (octets lus < page), mêmes annonces qu'avec la page entière`, async () => {
        const page = fx(file);
        const stats = serve(page, server);
        const res = await fetchSource(src(id));
        if (!res.ok) throw new Error(res.reason);
        expect(res).toMatchObject({ stopped: true, truncated: false });
        expect(res.body).toBe(cutAt(page, marker)); // décodage identique, multi-octets compris
        expect(res.bytes).toBeLessThan(stats.size);
        expect(stats.pulled).toBe(res.bytes);
        const full = PARSERS[src(id).parser](page, src(id));
        expect(full.length).toBeGreaterThan(0);
        expect(parseSource(src(id), res.body, res.truncated)).toEqual({ ok: true, listings: full });
      });
    }
  });

  describe("pages à marqueur : sécurité", () => {
    for (const [id, { marker, page: file }] of Object.entries(MARKED).filter(([id]) => src(id).encoding === "utf-8")) {
      it(`${id} : marqueur unique, après la dernière carte (le texte coupé juste avant lui donne les mêmes annonces)`, () => {
        const page = fx(file);
        expect(page.split(marker)).toHaveLength(2);
        const before = page.slice(0, page.indexOf(marker));
        expect(PARSERS[src(id).parser](before, src(id))).toEqual(PARSERS[src(id).parser](page, src(id)));
      });

      it(`${id} : marqueur absent (gabarit changé) -> page entière lue ; plafond atteint avant les cartes -> « page tronquée »`, async () => {
        const page = fx(file);
        const changed = page.replace(marker, "<!-- gabarit modifié -->");
        serve(changed, byteStream);
        const res = await fetchSource(src(id));
        if (!res.ok) throw new Error(res.reason);
        expect(res).toMatchObject({ body: changed, stopped: false, truncated: false });
        expect(parseSource(src(id), res.body, res.truncated)).toEqual({
          ok: true,
          listings: PARSERS[src(id).parser](changed, src(id)),
        });
        serve(changed, byteStream);
        const capped = await fetchSource({ ...src(id), maxBytes: 20_000 });
        if (!capped.ok) throw new Error(capped.reason);
        expect(capped).toMatchObject({ stopped: false, truncated: true, bytes: 20_000 });
        expect(parseSource(src(id), capped.body, capped.truncated)).toEqual({ ok: false, reason: "page tronquée" });
      });
    }

    it("safar (ISO-8859-1) : vrais octets cp1252, lecture arrêtée au marqueur, mêmes annonces qu'avec la page entière décodée", async () => {
      const { marker, page: file } = MARKED.safar;
      const raw = fx(file);
      const bytes = Uint8Array.from(raw, (c) => (c === "€" ? 0x80 : c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f));
      const stats = { pulled: 0, size: bytes.length };
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(byteStream(bytes, stats)));
      const res = await fetchSource(src("safar"));
      if (!res.ok) throw new Error(res.reason);
      expect(res).toMatchObject({ stopped: true, truncated: false });
      expect(res.bytes).toBeLessThan(stats.size / 2);
      expect(res.body.endsWith(marker)).toBe(true);
      const full = PARSERS.office5(decodeWindows1252(bytes), src("safar"));
      expect(full.length).toBe(25);
      expect(parseSource(src("safar"), res.body, res.truncated)).toEqual({ ok: true, listings: full });
    });

    it("cmb, état vide LBI (aucune page vide réelle enregistrée) : la phrase, à la place de la liste, est avant </main> -> []", async () => {
      const page = fx("cmb.html");
      const first = page.indexOf('<article class="item');
      const pager = page.indexOf('<div class="properties-list-v1__pagination');
      expect(first).toBeGreaterThan(0);
      expect(pager).toBeGreaterThan(first);
      const empty = `${page.slice(0, first)}<p>Désolé, aucun bien n'est disponible pour le moment.</p>${page.slice(pager)}`;
      expect(empty.search(LBI_EMPTY)).toBeLessThan(empty.indexOf("</main>"));
      serve(empty, byteStream);
      const res = await fetchSource(src("cmb"));
      if (!res.ok) throw new Error(res.reason);
      expect(res.stopped).toBe(true);
      expect(parseSource(src("cmb"), res.body, res.truncated)).toEqual({ ok: true, listings: [] });
    });

    it("laforet_17 : le marqueur est le repère de fin du parseur (section « à proximité ») ; 3 annonces du 17e, aucune voisine", async () => {
      serve(fx("laforet.html"), byteStream);
      const res = await fetchSource(src("laforet_17"));
      if (!res.ok) throw new Error(res.reason);
      const p = parseSource(src("laforet_17"), res.body, res.truncated);
      expect(p.ok && p.listings.map((l) => l.postalCode)).toEqual(["75017", "75017", "75017"]);
    });

    it("laforet_levallois : lecture arrêtée à la section « à proximité » ; 4 annonces de Levallois (92300), aucune voisine", async () => {
      const stats = serve(fx("laforet_levallois.html"), byteStream);
      const res = await fetchSource(src("laforet_levallois"));
      if (!res.ok) throw new Error(res.reason);
      expect(res.stopped).toBe(true);
      expect(stats.pulled).toBeLessThan(stats.size / 4);
      const p = parseSource(src("laforet_levallois"), res.body, res.truncated);
      expect(p.ok && p.listings.map((l) => l.postalCode)).toEqual(["92300", "92300", "92300", "92300"]);
    });
  });
});

describe("sous-lots", () => {
  it("PART_SIZE = 1 (CPU prod 13 ms P50 a 2 sources) : une source par sous-lot ; taille 2 : 6 -> 2+2+2, 5 -> 2+2+1", () => {
    expect(PART_SIZE).toBe(1);
    expect(splitParts(["a", "b", "c"])).toEqual([["a"], ["b"], ["c"]]);
    expect(splitParts(["a"])).toEqual([["a"]]);
    expect(splitParts([])).toEqual([]);
    expect(splitParts(["a", "b", "c", "d", "e", "f"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
    expect(splitParts(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("sous-lots d'un groupe : sources actives du groupe, ordre du registre, stables, aucune source deux fois", () => {
    // Sources hors EXTRA_17_IDS (celles-ci suivent dans l'ordre du registre, test dédié plus haut).
    const baseParts = (g: number) => groupParts(g).filter(([id]) => !EXTRA_17_IDS.includes(id));
    expect(baseParts(0)).toEqual([
      ["bienici"],
      ["foncia_17"],
      ["fnaim_17"],
      ["sector"],
      ["laforet_17"],
      ["laforet_levallois"],
    ]);
    expect(baseParts(1)).toEqual([["orpi_17"], ["spr"], ["orpi_levallois"], ["nestenn_courbevoie"]]);
    expect(baseParts(2)).toEqual([["etude_wagram"], ["armaille"], ["nestenn_17"]]);
    expect(baseParts(3)).toEqual([
      ["agence_batignolles"],
      ["feau_17"],
      ["domiere"],
      ["foncia_levallois"],
      ["fnaim_levallois"],
    ]);
    expect(baseParts(4)).toEqual([["cmb"], ["odi"], ["cmb_p2"], ["azoulay"], ["equinimo"]]);
    expect(groupParts(0)).toEqual(groupParts(0));
    for (const g of GROUPS) {
      const parts = groupParts(g);
      const ids = parts.flat();
      expect(ids).toEqual(ACTIVE.filter((s) => s.group === g).map((s) => s.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(parts.every((p) => p.length >= 1 && p.length <= PART_SIZE)).toBe(true);
    }
    // Chaque source active est dans un et un seul groupe.
    expect(GROUPS.flatMap((g) => groupParts(g).flat()).sort()).toEqual(ACTIVE.map((s) => s.id).sort());
  });
});

describe("route /part", () => {
  // En-tete par defaut : HMAC-SHA256(cle, corps) ; key = valeur brute de l'en-tete, null = pas d'en-tete ; signWith/signBody pour signer autre chose.
  const part = async (
    body: unknown,
    o: {
      key?: string | null;
      signWith?: string;
      signBody?: string;
      query?: string;
      method?: string;
      raw?: string;
      e?: Env;
    } = {},
  ) => {
    const method = o.method ?? "POST";
    const text = method === "GET" ? undefined : (o.raw ?? JSON.stringify(body));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (o.key !== null)
      headers["x-internal-key"] = o.key ?? (await hmacHex(o.signWith ?? "secret-key", o.signBody ?? text ?? ""));
    return worker.fetch(
      new Request(`https://x.test/part${o.query ?? ""}`, { method, headers, body: text }),
      o.e ?? E,
      createExecutionContext(),
    );
  };
  const now = t(10, 0).toISOString();

  it("403 sans en-tete, 403 avec ?k= seul, 403 avec une mauvaise cle ou ADMIN_KEY vide ; rien n'est lu", async () => {
    const spy = mockFetch();
    const body = { ids: ["sector"], now };
    expect((await part(body, { key: null })).status).toBe(403);
    expect((await part(body, { key: null, query: "?k=secret-key" })).status).toBe(403);
    expect((await part(body, { key: "nope" })).status).toBe(403);
    expect((await part(body, { signWith: "nope" })).status).toBe(403);
    expect((await part(body, { key: "", e: { ...E, ADMIN_KEY: "" } })).status).toBe(403);
    expect((await part(body, { e: { ...E, ADMIN_KEY: "" } })).status).toBe(403); // signee avec "secret-key", Worker sans cle
    expect(spy).not.toHaveBeenCalled();
  });

  it("l'en-tete porte HMAC-SHA256(ADMIN_KEY, corps), jamais la cle : la cle brute est refusee, une signature d'un autre corps aussi", async () => {
    const spy = mockFetch();
    const body = { ids: ["sector"], now };
    expect((await part(body, { key: "secret-key" })).status).toBe(403);
    expect((await part(body, { signBody: JSON.stringify({ ids: ["fnaim_17"], now }) })).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    expect((await part(body)).status).toBe(200);
  });

  it("200 avec le bon en-tete : lit sa source une fois, renvoie { sources, events }, last_run = now transmis", async () => {
    const spy = mockFetch();
    const res = await part({ ids: ["sector"], now });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: { id: string; ok: boolean }[]; events: unknown[] };
    expect(body.sources.map((s) => [s.id, s.ok])).toEqual([["sector", true]]);
    expect(body.events).toEqual([]);
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([
      cfg.sources.dedicated.find((s) => s.id === "sector")!.url,
    ]);
    const st = await env.DB.prepare("SELECT last_run FROM source_state WHERE source = 'sector'").first<{
      last_run: string;
    }>();
    expect(st!.last_run).toBe(now);
  });

  it("n'envoie aucun message Telegram (ni alerte ni panne) et renvoie les evenements de sante", async () => {
    await env.DB.prepare(
      "INSERT INTO listings (source, listing_id, cluster, first_seen, alert_status, alert_kind, payload) VALUES ('bienici', 'p1', 'bienici:p1', ?, 'pending', 'new', ?)",
    )
      .bind(
        t(9, 0).toISOString(),
        JSON.stringify({
          listing: {
            source: "bienici",
            id: "p1",
            url: "https://x/p1",
            price: 1300,
            charges: null,
            priceIsCC: true,
            surface: 40,
            rooms: 2,
            title: "T",
            address: null,
            district: null,
            postalCode: "75017",
            photo: null,
            agency: null,
            phone: null,
            propertyType: null,
            publishedAt: null,
          },
          evaluation: { keep: true, rentCC: 1300, flags: [] },
        }),
      )
      .run();
    const spy = mockFetch({ failing: "sector" });
    let body: { sources: { id: string; ok: boolean; reason?: string }[]; events: unknown[] } | undefined;
    for (let i = 0; i < 3; i++)
      body = (await (await part({ ids: ["sector"], now: t(10, i).toISOString() })).json()) as typeof body;
    expect(tgCalls(spy)).toHaveLength(0);
    expect(body!.sources.find((s) => s.id === "sector")).toMatchObject({ ok: false, reason: "HTTP 403" });
    expect(body!.events).toEqual([{ type: "broken", sourceId: "sector", reason: "HTTP 403" }]);
    const row = await env.DB.prepare("SELECT alert_status FROM listings WHERE listing_id = 'p1'").first<{
      alert_status: string;
    }>();
    expect(row!.alert_status).toBe("pending");
  });

  it("413 si content-length > 4096, sans lire le corps ; 413 aussi apres lecture d'un corps trop long sans longueur annoncee", async () => {
    const spy = mockFetch();
    let pulled = false;
    const big = new TextEncoder().encode(JSON.stringify({ ids: ["sector"], now, pad: "x".repeat(5000) }));
    const sig = await hmacHex("secret-key", new TextDecoder().decode(big));
    const send = (headers: Record<string, string>) => {
      const body = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            pulled = true;
            c.enqueue(big);
            c.close();
          },
        },
        { highWaterMark: 0 },
      );
      return worker.fetch(
        new Request("https://x.test/part", { method: "POST", headers, body }),
        E,
        createExecutionContext(),
      );
    };
    const r1 = await send({
      "content-type": "application/json",
      "content-length": String(big.length),
      "x-internal-key": sig,
    });
    expect(r1.status).toBe(413);
    expect(pulled).toBe(false);
    const r2 = await send({ "content-type": "application/json", "x-internal-key": sig });
    expect(r2.status).toBe(413);
    expect(pulled).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("instant transmis a plus de 10 min de l'horloge (horloge simulee) : 400, contre le rejeu d'une requete signee ; 10 min pile et 6 min (cron en retard) acceptees", async () => {
    mockFetch();
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    expect((await part({ ids: ["sector"], now: at(-10 * 60_000 - 1000) })).status).toBe(400);
    expect((await part({ ids: ["sector"], now: at(10 * 60_000 + 1000) })).status).toBe(400);
    expect((await part({ ids: ["sector"], now: at(-10 * 60_000) })).status).toBe(200);
    expect((await part({ ids: ["sector"], now: at(10 * 60_000) })).status).toBe(200);
    expect((await part({ ids: ["sector"], now: at(-6 * 60_000) })).status).toBe(200);
  });

  it("400 : corps illisible, source inconnue, plus de PART_SIZE sources, doublon, liste vide, instant invalide ; GET /part 404", async () => {
    const spy = mockFetch();
    expect((await part(null, { raw: "pas du json" })).status).toBe(400);
    expect((await part({ ids: ["zzz"], now })).status).toBe(400);
    expect((await part({ ids: ["fnaim_17", "sector"], now })).status).toBe(400); // PART_SIZE = 1
    expect((await part({ ids: ["fnaim_17", "sector", "bienici"], now })).status).toBe(400);
    expect((await part({ ids: ["sector", "sector"], now })).status).toBe(400);
    expect((await part({ ids: [], now })).status).toBe(400);
    expect((await part({ ids: ["sector"] })).status).toBe(400);
    expect((await part({ ids: ["sector"], now: "hier" })).status).toBe(400);
    expect((await part({ ids: "sector", now })).status).toBe(400);
    expect((await part(null, { method: "GET" })).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("orchestrateur (fan-out en sous-lots)", () => {
  const G0 = () => ACTIVE.filter((s) => s.group === 0);

  it("tous les sous-lots OK : un appel par sous-lot d'une source (ordre du registre, l'un apres l'autre), chaque source lue une fois, rapport complet, alertes comme avant", async () => {
    const spy = mockFetch();
    const rec = recording(selfRunner(E));
    const r1 = await runScan(E, 0, t(10, 0), rec.run);
    expect(rec.calls).toEqual(groupParts(0));
    expect(rec.maxRunning()).toBe(1);
    expect(r1.sources.map((s) => s.id)).toEqual(G0().map((s) => s.id));
    expect(r1.sources.every((s) => s.ok)).toBe(true);
    expect(spy.mock.calls.map((c) => String(c[0])).sort()).toEqual(
      G0()
        .map((s) => s.url)
        .sort(),
    );
    expect(r1.alertsSent).toBe(0);
    spy.mockRestore();

    const spy2 = mockFetch({ extra: true });
    const r2 = await runScan(E, 0, t(10, 5), rec.run);
    expect(tgCalls(spy2)).toHaveLength(1);
    expect(r2.alertsSent).toBe(1);
  });

  it("un sous-lot en echec : sa source « sous-lot en échec » et consecutive_failures incremente en D1, les autres OK ; 3 echecs -> source en panne, sans message", async () => {
    expect(PART_FAILED).toBe("sous-lot en échec");
    const spy = mockFetch();
    const base = selfRunner(E);
    const runner: PartRunner = (ids, now) =>
      ids.includes("sector") ? Promise.reject(new Error("boom")) : base(ids, now);
    let r = await runScan(E, 0, t(10, 0), runner);
    expect(await failures("sector")).toBe(1);
    expect(await failures("fnaim_17")).toBe(0);
    expect(await failures("bienici")).toBe(0);
    expect(tgCalls(spy)).toHaveLength(0);
    for (let i = 1; i < 3; i++) r = await runScan(E, 0, t(10, i), runner);
    expect(r.sources.filter((s) => !s.ok)).toEqual([{ id: "sector", ok: false, reason: PART_FAILED, ms: 0 }]);
    expect(r.sources.filter((s) => s.ok).map((s) => s.id)).toEqual(
      G0()
        .map((s) => s.id)
        .filter((id) => id !== "sector"),
    );
    expect(await failures("sector")).toBe(3);
    expect(tgTexts(spy)).toHaveLength(0);
    expect(await failures("sector")).toBe(3);
    expect(spy.mock.calls.some((c) => String(c[0]) === cfg.sources.dedicated.find((s) => s.id === "sector")!.url)).toBe(
      false,
    );
  });

  it("appel du sous-lot par SELF : reponse non 200, JSON invalide, forme invalide ou exception -> sous-lot en echec, les autres continuent", async () => {
    for (const mode of ["500", "json", "shape", "throw"] as const) {
      await env.DB.batch([env.DB.prepare("DELETE FROM listings"), env.DB.prepare("DELETE FROM source_state")]);
      const spy = mockFetch();
      const sabotaged = {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = new Request(input, init);
          const { ids } = (await req.clone().json()) as { ids: string[] };
          if (!ids.includes("sector")) return E.SELF!.fetch(req);
          if (mode === "500") return new Response("boom", { status: 500 });
          if (mode === "json") return new Response("pas du json", { status: 200 });
          if (mode === "shape") return Response.json({ sources: "x" });
          throw new Error("binding");
        },
      } as unknown as Fetcher;
      const r = await runScan({ ...E, SELF: sabotaged }, 0, t(10, 0)); // runner par defaut : selfRunner(env)
      expect(
        r.sources.filter((s) => !s.ok).map((s) => [s.id, s.reason]),
        mode,
      ).toEqual([["sector", PART_FAILED]]);
      expect(
        r.sources.filter((s) => s.ok),
        mode,
      ).toHaveLength(G0().length - 1);
      expect(await failures("sector"), mode).toBe(1);
      spy.mockRestore();
    }
  });

  it("sous-lot sans reponse au bout de PART_TIMEOUT_MS (25 s, horloge simulee) : sous-lot en echec, les precedents gardent leur resultat", async () => {
    expect(PART_TIMEOUT_MS).toBe(25_000); // lecture des sources 10 s + fiches + traitement : 25 s suffisent
    mockFetch();
    const base = selfRunner(E);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: t(10, 2) });
    const LAST = G0().at(-1)!.id; // dernier sous-lot du groupe 0, dans l'ordre du registre
    let settled = false,
      hung!: () => void;
    const reached = new Promise<void>((res) => {
      hung = res;
    });
    const p = runScan(E, 0, t(10, 0), (ids, now) => {
      if (!ids.includes(LAST)) return base(ids, now);
      hung(); // dernier sous-lot lance : son minuteur de 25 s est arme dans la foulee
      return new Promise<PartResult>(() => {});
    });
    void p.then(() => {
      settled = true;
    });
    await reached;
    await vi.advanceTimersByTimeAsync(24_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.sources.filter((s) => !s.ok).map((s) => [s.id, s.reason])).toEqual([[LAST, PART_FAILED]]);
    expect(r.sources.filter((s) => s.ok)).toHaveLength(G0().length - 1);
    expect(await failures(LAST)).toBe(1);
  });

  it("echeance du passage (PASS_DEADLINE_MS = 40 s, horloge simulee) : aucun sous-lot ne demarre apres, le reste en « délai dépassé » et compte en echec", async () => {
    expect(PASS_DEADLINE_MS).toBe(40_000);
    const spy = mockFetch();
    const base = selfRunner(E);
    const calls: string[][] = [];
    const runner: PartRunner = async (ids, now) => {
      calls.push(ids);
      const r = await base(ids, now);
      vi.advanceTimersByTime(calls.length === 1 ? PASS_DEADLINE_MS - 1 : 1); // 1er sous-lot fini a 39,999 s (le 2e demarre), 2e a 40 s
      return r;
    };
    const r = await runScan(E, 0, t(10, 0), runner);
    expect(calls).toEqual(groupParts(0).slice(0, 2));
    expect(r.sources.slice(0, 2).map((s) => [s.id, s.ok])).toEqual([
      ["bienici", true],
      ["foncia_17", true],
    ]);
    const late = G0()
      .slice(2)
      .map((s) => s.id); // tout le groupe 0 sauf les deux premiers sous-lots
    expect(r.sources.slice(2)).toEqual(late.map((id) => ({ id, ok: false, reason: "délai dépassé", ms: 0 })));
    for (const id of late) expect(await failures(id)).toBe(1);
    for (const id of late)
      expect(spy.mock.calls.some((c) => String(c[0]) === cfg.sources.dedicated.find((s) => s.id === id)!.url)).toBe(
        false,
      );
  });

  it("sous-lot tue apres avoir termine sa source : elle garde son passage (last_run = now) ; tue avant : la source compte un echec", async () => {
    mockFetch();
    const base = selfRunner(E);
    const fnaim = cfg.sources.dedicated.find((s) => s.id === "fnaim_17")!;
    const runner: PartRunner = async (ids, now) => {
      if (ids.includes("fnaim_17")) {
        await runPart(E, [fnaim], now);
        throw new Error("invocation tuee apres markRun");
      }
      if (ids.includes("sector")) throw new Error("invocation tuee avant markRun");
      return base(ids, now);
    };
    const r = await runScan(E, 0, t(10, 0), runner);
    expect(r.sources.find((s) => s.id === "fnaim_17")).toEqual({ id: "fnaim_17", ok: true, ms: 0 });
    expect(r.sources.find((s) => s.id === "sector")).toEqual({ id: "sector", ok: false, reason: PART_FAILED, ms: 0 });
    expect(await failures("fnaim_17")).toBe(0);
    expect(await failures("sector")).toBe(1);
  });

  it("annonces disparues dans le sous-lot : passage reussi -> annonce suivie vue il y a plus de 12 h et absente du passage precedent marquee (gone_at), sans alerte ; passage en echec (403) -> rien", async () => {
    const nestenn = cfg.sources.dedicated.find((s) => s.id === "nestenn_17")!;
    // Vue la veille (14 h avant), passage reussi precedent a 9h55Z (deja sans elle).
    const seed = () =>
      env.DB.batch([
        env.DB.prepare("DELETE FROM listings"),
        env.DB.prepare("DELETE FROM source_state"),
        env.DB.prepare("INSERT INTO source_state (source, initialized, last_run) VALUES ('nestenn_17', 1, ?)").bind(
          t(9, 55).toISOString(),
        ),
        env.DB.prepare(
          "INSERT INTO listings (source, listing_id, cluster, first_seen, alert_status, payload) VALUES ('nestenn_17', 'old1', 'nestenn_17:old1', ?, 'sent', '{}')",
        ).bind(t(-4, 0).toISOString()),
      ]);
    const gone = async () =>
      (await env.DB.prepare("SELECT gone_at FROM listings WHERE listing_id = 'old1'").first<{
        gone_at: string | null;
      }>())!.gone_at;
    await seed();
    mockFetch({ failing: "nestenn_17" });
    await runPart(E, [nestenn], t(10, 0));
    expect(await gone()).toBeNull();
    vi.restoreAllMocks();
    await seed();
    const spy = mockFetch();
    const r = await runPart(E, [nestenn], t(10, 0));
    expect(r.sources).toMatchObject([{ id: "nestenn_17", ok: true }]);
    expect(await gone()).toBe(t(10, 0).toISOString());
    expect(tgCalls(spy)).toHaveLength(0);
  });

  it("runPart lit et analyse toutes ses sources avant la premiere operation D1 (une invocation tuee pendant l'analyse n'a rien ecrit)", async () => {
    mockFetch();
    const order: string[] = [];
    for (const k of ["fnaim", "nestenn"] as const) {
      const orig = PARSERS[k];
      vi.spyOn(PARSERS, k).mockImplementation((body, src) => {
        order.push(`parse:${src.id}`);
        return orig(body, src);
      });
    }
    const db = new Proxy(env.DB, {
      get(target, k) {
        const v = (target as unknown as Record<string | symbol, unknown>)[k];
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          if (k === "prepare" || k === "batch") order.push("d1");
          return (v as (...x: unknown[]) => unknown).apply(target, a);
        };
      },
    });
    const r = await runPart(
      { ...E, DB: db as D1Database },
      ["fnaim_17", "nestenn_17"].map((id) => cfg.sources.dedicated.find((s) => s.id === id)!),
      t(10, 0),
    );
    expect(r.sources.map((s) => s.ok)).toEqual([true, true]);
    expect(order.filter((x) => x.startsWith("parse:"))).toEqual(["parse:fnaim_17", "parse:nestenn_17"]);
    expect(order.indexOf("d1")).toBeGreaterThan(order.indexOf("parse:nestenn_17"));
  });

  it("budget d'alertes = 50 - nbSousLots - 2 (WhatsApp actif : 3 sous-requetes par alerte au pire), jamais plus de 48", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.includes("/sendPhoto")) return new Response("bad", { status: 400 });
      return new Response("{}", { status: 200 }); // sendMessage et CallMeBot
    });
    await seedPending(24);
    const runner = vi.fn<PartRunner>(async (ids) => ({
      sources: ids.map((id) => ({ id, ok: false, reason: "HTTP 403", ms: 0 })),
      events: ids.map((id) => ({ type: "broken" as const, sourceId: id, reason: "HTTP 403" })),
    }));
    const W: Env = { ...E, WHATSAPP_ENABLED: "true", CALLMEBOT_PHONE: "+33600000000", CALLMEBOT_APIKEY: "cle-wa" };
    const r = await runScan(W, 0, t(10, 0), runner);
    const parts = groupParts(0).length;
    expect(runner).toHaveBeenCalledTimes(parts);
    expect(tgTexts(spy).filter((m) => m?.includes("en panne"))).toHaveLength(0); // les pannes ne donnent plus de message
    // (50 - n sous-lots - 2) / 3 alertes a 3 sous-requetes (PART_SIZE = 1 : un sous-lot par source).
    expect(r.alertsSent).toBe(Math.floor((50 - parts - 2) / 3));
    expect(r.alertsSent).toBeGreaterThan(0);
    expect(parts + spy.mock.calls.length).toBeLessThanOrEqual(48);
  });

  it("meme appartement nouveau sur trois sources de trois sous-lots differents au meme passage : une seule alerte (dedup inchangee)", async () => {
    mockFetch();
    await runScan(E, 0, t(10, 0)); // premier passage : tout est silencieux
    // Meme bien (75017, 37-38 m2) vu par Bien'ici (sous-lot 1), FNAIM (sous-lot 2) et Sector (sous-lot 3, page lbi2 de mockFetch) :
    // les trois redeviennent nouvelles au meme passage (cas du premier passage de 9h apres une nuit sans lecture).
    const SAME = [
      ["bienici", "ag941161-553470770"],
      ["fnaim_17", "53199034"],
      ["sector", "7444"],
    ];
    for (const [src, id] of SAME)
      await env.DB.prepare("DELETE FROM listings WHERE source = ? AND listing_id = ?").bind(src, id).run();
    vi.restoreAllMocks();
    const spy = mockFetch();
    const r = await runScan(E, 0, t(10, 5));
    expect(r.alertsSent).toBe(1);
    expect(tgCalls(spy)).toHaveLength(1);
    const rows = await env.DB.prepare(
      "SELECT source, alert_status, cluster FROM listings WHERE (source = ? AND listing_id = ?) OR (source = ? AND listing_id = ?) OR (source = ? AND listing_id = ?) ORDER BY source",
    )
      .bind(...SAME.flat())
      .all<{ source: string; alert_status: string; cluster: string }>();
    const cluster = "bienici:ag941161-553470770";
    expect(rows.results).toEqual([
      { source: "bienici", alert_status: "sent", cluster },
      { source: "fnaim_17", alert_status: "duplicate", cluster },
      { source: "sector", alert_status: "duplicate", cluster },
    ]);
  });
});

describe("bout en bout : service binding SELF du pool vitest (route /part du Worker, env du pool)", () => {
  it("scheduled a 10h Paris : un POST /part par sous-lot, en-tete interne signe (pas la cle), chaque source du groupe lue exactement une fois", async () => {
    const spy = mockFetch();
    const seen: { method: string; path: string; ids: string[]; signed: boolean; rawKey: boolean; query: string }[] = [];
    const counting = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const u = new URL(req.url);
        const text = await req.clone().text();
        const { ids } = JSON.parse(text) as { ids: string[] };
        const h = req.headers.get("x-internal-key");
        seen.push({
          method: req.method,
          path: u.pathname,
          ids,
          signed: h === (await hmacHex(E.ADMIN_KEY, text)),
          rawKey: h === E.ADMIN_KEY,
          query: u.search,
        });
        return E.SELF!.fetch(req);
      },
    } as unknown as Fetcher;
    const ctx = createExecutionContext();
    vi.setSystemTime(Date.parse("2026-10-19T08:00:05Z"));
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.parse("2026-10-19T08:00:00Z") }),
      { ...E, SELF: counting },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect([...seen].sort((a, b) => byIds(a.ids, b.ids))).toEqual(
      passParts()
        .sort(byIds)
        .map((ids) => ({ method: "POST", path: "/part", ids, signed: true, rawKey: false, query: "" })),
    );
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(passParts().length);
    for (const s of ACTIVE.filter(inPass)) {
      expect(urls.filter((u) => u === s.url)).toHaveLength(1);
      const st = await env.DB.prepare("SELECT last_run FROM source_state WHERE source = ?")
        .bind(s.id)
        .first<{ last_run: string }>();
      // last_run = horloge reelle du passage (08:00:05Z), pas scheduledTime (08:00:00Z) : un cron en retard ne decale pas ses ecritures.
      expect(st!.last_run).toBe("2026-10-19T08:00:05.000Z");
    }
  });

  it("cle interne differente de celle du Worker appele : /part repond 403, tout le groupe en « sous-lot en échec », aucune source lue", async () => {
    const spy = mockFetch();
    const r = await runScan({ ...E, ADMIN_KEY: "autre-cle" }, 0, t(10, 0));
    expect(r.sources.map((s) => [s.id, s.ok, s.reason])).toEqual(
      ACTIVE.filter((s) => s.group === 0).map((s) => [s.id, false, PART_FAILED]),
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("requête bi-zone de Bien'ici (bout en bout runPart, registre et fixture)", () => {
  const bien = cfg.sources.dedicated.find((s) => s.id === "bienici")!;
  const page = JSON.parse(fx("bienici_2z.json"));
  const HELD = "ag941161-553470770"; // 17e, 38 m², 1 374 € CC : nouvelle au premier passage bi-zone
  const serveBienici = (ads: unknown[]) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u !== bien.url) return new Response("?", { status: 404 });
      return new Response(JSON.stringify({ ...page, realEstateAds: ads, total: ads.length }));
    });
  const statusOf = async (id: string) =>
    (
      await env.DB.prepare("SELECT alert_status FROM listings WHERE source = 'bienici' AND listing_id = ?")
        .bind(id)
        .first<{ alert_status: string }>()
    )?.alert_status;
  const pendingIds = async () =>
    (
      await env.DB.prepare("SELECT listing_id FROM listings WHERE alert_status = 'pending' ORDER BY listing_id").all<{
        listing_id: string;
      }>()
    ).results.map((r) => r.listing_id);

  it("zone ajoutée (Bien'ici initialisée sur le 17e, puis 17e et Levallois) : stock de Levallois silent (5 gardées), nouvelle du 17e alertée ; ensuite une nouvelle de Levallois est alertée", async () => {
    const ads17 = page.realEstateAds.filter((a: { postalCode: string }) => a.postalCode === "75017");
    // Avant l'ajout de Levallois : la requête du 17e seul a déjà vu 15 des 16 annonces du 17e.
    let spy = serveBienici(ads17.filter((a: { id: string }) => a.id !== HELD));
    expect((await runPart(E, [{ ...bien, zones: ["75017"] }], t(9, 30))).sources[0].ok).toBe(true);
    expect(await env.DB.prepare("SELECT zones FROM source_state WHERE source = 'bienici'").first()).toEqual({
      zones: "75017",
    });
    spy.mockRestore();

    spy = serveBienici(page.realEstateAds);
    const r = await runPart(E, [bien], t(10, 0));
    expect(r.sources[0]).toMatchObject({ id: "bienici", ok: true, count: 32 });
    expect(await pendingIds()).toEqual([HELD]);
    const lev = page.realEstateAds
      .filter((a: { postalCode: string }) => a.postalCode === "92300")
      .map((a: { id: string }) => a.id);
    const silentLev = (await Promise.all(lev.map(statusOf))).filter((s) => s === "silent");
    expect(silentLev).toHaveLength(5);
    expect(await env.DB.prepare("SELECT zones FROM source_state WHERE source = 'bienici'").first()).toEqual({
      zones: "75017,92300",
    });
    spy.mockRestore();

    const fresh = {
      ...page.realEstateAds.find((a: { id: string }) => a.id === "dauchez-26740"),
      id: "lev-new-1",
      surfaceArea: 62,
      price: 1450,
    };
    spy = serveBienici([fresh, ...page.realEstateAds]);
    await runPart(E, [bien], t(10, 10));
    expect(await pendingIds()).toEqual([HELD, "lev-new-1"].sort());
    spy.mockRestore();
  });
});

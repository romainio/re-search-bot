import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderDashboard } from "../src/dashboard/render";
import { settings } from "../src/derive";
import worker from "../src/index";
import { USER_AGENT } from "../src/config/fetch";
import { PROSPECT_PAGES_PER_STEP, PROSPECT_STEP_BUDGET } from "../src/config/prospect";
import { classifyRental, parseVerdict } from "../src/prospect/ai";
import { overpassQuery, parseEntreprises, parseOverpass } from "../src/prospect/apis";
import { inRegistry, keyTokens, sameAgency, sameSite } from "../src/prospect/match";
import { runProspectStep } from "../src/prospect/run";
import { detectTemplate } from "../src/prospect/template";
import type { Env } from "../src/types";
import entreprisesLev from "./fixtures/prospect_entreprises_levallois.json";
import entreprises17 from "./fixtures/prospect_entreprises_paris17.json";
import overpass from "./fixtures/prospect_overpass.json";
import lbiAgb from "./fixtures/lbi_agb.html?raw";
import lbiImmediat from "./fixtures/immediat.html?raw";
import connexion from "./fixtures/connexion.html?raw";
import consultants from "./fixtures/consultants.html?raw";
import domiere from "./fixtures/domiere.html?raw";
import elger from "./fixtures/elger.html?raw";
import levimmo from "./fixtures/levimmo.html?raw";
import nestenn from "./fixtures/nestenn.html?raw";
import century21 from "./fixtures/century21_17.html?raw";
import foncia from "./fixtures/foncia.html?raw";
import laforet from "./fixtures/laforet.html?raw";
import imax from "./fixtures/imax_paris.html?raw";
import fredelion from "./fixtures/fredelion.html?raw";
import oralia from "./fixtures/oralia.html?raw";

const cfg = settings();

const ON: Env = {
  ...(env as unknown as Env),
  ADMIN_KEY: "k",
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  PROSPECT_ENABLED: "true",
  PROSPECT_AI: "false",
};
const OFF: Env = { ...ON, PROSPECT_ENABLED: "false" };
const db = () => env.DB;
const t0 = Date.UTC(2026, 10, 9, 19, 30);
/** Instant du pas n : deux minutes d'écart (le bail d'un pas dure une minute). */
const at = (n: number) => new Date(t0 + n * 120_000);

beforeEach(async () => {
  await db().batch([db().prepare("DELETE FROM agency_candidates"), db().prepare("DELETE FROM prospect_state")]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
/** Horloge réelle du Worker fixée (scheduled juge la fenêtre active sur new Date()) : 19/10/2026 19h30 UTC = 21h30 à Paris, hors fenêtre et hors résumé. */
const night = () => vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.UTC(2026, 9, 19, 19, 30)) });

describe("lecture des deux API", () => {
  it("Recherche d'entreprises : établissements ouverts de la zone seulement, noms lisibles", () => {
    const lev = parseEntreprises(entreprisesLev, ["92300"]);
    expect(lev.totalPages).toBe(19);
    const names = lev.candidates.map((c) => c.names[0]);
    expect(names).toContain("Consultants Immobilier (Cimmoneuf)");
    expect(names).toContain("Imax");
    // Établissements fermés (état « F ») écartés : Foncia Transaction France (92300 fermé) n'y est pas.
    expect(names.some((n) => n.startsWith("Foncia"))).toBe(false);
    for (const c of lev.candidates) {
      expect(c.postalCode).toBe("92300");
      expect(c.id).toMatch(/^\d{14}$/);
      expect(c.origin).toBe("entreprises");
    }
    expect(parseEntreprises(entreprises17, ["75017"]).candidates.length).toBeGreaterThan(5);
    expect(parseEntreprises(entreprises17, ["92300"]).candidates).toHaveLength(0);
    expect(() => parseEntreprises({ nope: 1 })).toThrow();
  });

  it("Overpass : nom obligatoire, site ramené à la racine, code postal des étiquettes ou de l'emprise", () => {
    const c = parseOverpass(overpass);
    expect(c).toHaveLength(5); // l'élément sans nom est ignoré
    const clap = c.find((x) => x.names[0] === "Clap'Immo")!;
    expect(clap).toMatchObject({
      id: "osm:node/9122381389",
      website: "http://www.clap-immo.fr/",
      phone: "+33 1 73 43 07 70",
      origin: "osm",
    });
    expect(c.find((x) => x.names[0] === "Brauman & K")).toMatchObject({
      postalCode: "75017",
      address: "5 Rue Des Acacias, 75017 Paris",
    });
    expect(c.find((x) => x.names[0] === "Korn")?.postalCode).toBe("75017");
    expect(() => parseOverpass("<html>502</html>")).toThrow();
    expect(overpassQuery("75017")).toContain('["shop"="estate_agent"]');
    expect(overpassQuery("99999")).toBeNull();
  });
});

describe("rapprochement avec le registre", () => {
  const cand = (names: string[], website: string | null = null) => ({ names, website });
  it("nom normalisé : une agence déjà lue n'est pas candidate", () => {
    expect(inRegistry(cand(["Foncia Transaction France"]), cfg.sources.dedicated)?.id).toBe("foncia_17");
    expect(inRegistry(cand(["CONSULTANTS IMMOBILIER (CIMMONEUF)"]), cfg.sources.dedicated)?.id).toBe("consultants");
    expect(inRegistry(cand(["Société Elger Immobilier (SAS)"]), cfg.sources.dedicated)?.id).toBe("elger");
    expect(inRegistry(cand(["Agence Du Marché"]), cfg.sources.dedicated)).toBeNull();
    expect(inRegistry(cand(["Aleph Transactions"]), cfg.sources.dedicated)).toBeNull();
  });
  it("mots vides : formes juridiques, métier, ordinaux et lieux de l'instance ; aucun autre lieu en dur", () => {
    // Zones de l'exemple (« Paris 17 », « Levallois », quartier « Batignolles ») retirées parce qu'elles sont dans l'instance.
    expect(keyTokens("Agence Orpi Paris 17e Batignolles SARL")).toEqual(["orpi"]);
    expect(keyTokens("Cabinet Martin 75017 Levallois 3eme 1er")).toEqual(["martin"]);
    // Une ville hors de l'instance reste un mot d'identification.
    expect(keyTokens("Orpi Lyon Croix-Rousse")).toEqual(["orpi", "lyon", "croix", "rousse"]);
    expect(keyTokens("Immobilière de Neuilly-sur-Seine")).toEqual(["neuilly", "seine"]);
  });
  it("domaine du site, hors plateformes partagées", () => {
    expect(inRegistry(cand(["Autre nom"], "https://www.spr-immobilier.fr/contact"), cfg.sources.dedicated)?.id).toBe(
      "spr",
    );
    expect(sameSite("http://www.clap-immo.fr", "https://clap-immo.fr/louer")).toBe(true);
    // Sous-domaine d'une plateforme : seul l'hôte exact compte.
    expect(sameSite("https://autre.la-boite-immo.com/", "https://ag-batignolles.la-boite-immo.com/location/1")).toBe(
      false,
    );
    expect(sameSite(null, "https://x.fr")).toBe(false);
  });
  it("entreprises et OSM désignant la même agence se recoupent", () => {
    expect(
      sameAgency(
        { names: ["Clap'Immo"], website: null },
        { names: ["CLAP IMMO (CLAPIMMO)", "Clap Immo"], website: "http://clap-immo.fr" },
      ),
    ).toBe(true);
    expect(sameAgency({ names: ["Korn"], website: null }, { names: ["Brauman"], website: null })).toBe(false);
  });
});

describe("signatures de gabarit", () => {
  it.each([
    ["lbi", lbiAgb, "lbi"],
    ["lbi2", lbiImmediat, "lbi2"],
    ["apimo", connexion, "apimo"],
    ["wpapimo", consultants, "wpapimo"],
    ["netty", domiere, "netty"],
    ["osl", elger, "osl"],
    ["at1605", levimmo, "at1605"],
    ["nestenn", nestenn, "nestenn"],
    ["century21", century21, "century21"],
    ["foncia", foncia, "foncia"],
    ["laforet", laforet, "laforet"],
    ["office5", imax, "office5"],
  ])("%s", (_n, html, expected) => {
    const m = detectTemplate(html);
    expect(m.template).toBe(expected);
    expect(m.parser).toBe(expected);
  });
  it("fredelion : billie ; page sans signature : inconnu, sans lecteur", () => {
    expect(detectTemplate(fredelion).parser).toBe("billie");
    expect(detectTemplate(oralia)).toEqual({ template: "inconnu", parser: null });
    expect(detectTemplate("")).toEqual({ template: "inconnu", parser: null });
  });
});

describe("étape IA", () => {
  const ai = (answer: string) => ({ run: vi.fn(async () => ({ response: `{"verdict":"${answer}"}` })) });
  it("verdict lu dans la réponse du modèle", () => {
    expect(parseVerdict({ response: "Oui." })).toBe("oui");
    expect(parseVerdict("non, aucune")).toBe("non");
    expect(parseVerdict({ response: "Incertain" })).toBe("incertain");
    expect(parseVerdict({ response: "peut-être" })).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });
  it("interrupteur éteint (ou PROSPECT_AI éteint, ou pas de binding) : aucun appel, null", async () => {
    const a = ai("oui");
    expect(await classifyRental({ ...OFF, PROSPECT_AI: "true", AI: a }, "texte")).toBeNull();
    expect(await classifyRental({ ...ON, PROSPECT_AI: "false", AI: a }, "texte")).toBeNull();
    expect(await classifyRental({ ...ON, PROSPECT_AI: "true", AI: undefined }, "texte")).toBeNull();
    expect(a.run).not.toHaveBeenCalled();
  });
  it("allumé : un appel, verdict ; erreur du modèle : null", async () => {
    const a = ai("oui");
    expect(await classifyRental({ ...ON, PROSPECT_AI: "true", AI: a }, "location appartement")).toBe("oui");
    expect(a.run).toHaveBeenCalledTimes(1);
    const bad = {
      run: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    expect(await classifyRental({ ...ON, PROSPECT_AI: "true", AI: bad }, "x")).toBeNull();
  });
});

/** Réseau simulé : Recherche d'entreprises (total_pages réduit : 17e = 4 pages, Levallois = 1), Overpass, sites, Telegram. */
function mockNet(opts: { overpassFails?: number; pages17?: number } = {}) {
  let overpassFails = opts.overpassFails ?? 0;
  const calls: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith("https://recherche-entreprises.api.gouv.fr/search")) {
      const q = new URL(url).searchParams;
      const is17 = q.get("code_postal") === "75017";
      expect(q.get("activite_principale")).toBe("68.31Z");
      expect(q.get("etat_administratif")).toBe("A");
      expect((init?.headers as Record<string, string> | undefined)?.["User-Agent"]).toBe(USER_AGENT);
      const page = Number(q.get("page"));
      const base = is17 ? entreprises17 : entreprisesLev;
      return new Response(JSON.stringify({ ...base, page, total_pages: is17 ? (opts.pages17 ?? 4) : 1 }));
    }
    if (url.startsWith("https://overpass-api.de/")) {
      if (overpassFails-- > 0) return new Response("# 502 Gateway Timeout", { status: 502 });
      return new Response(JSON.stringify(overpass));
    }
    if (url.startsWith("https://api.telegram.org/")) return new Response(JSON.stringify({ ok: true }));
    if (url.startsWith("http://www.clap-immo.fr")) return new Response(lbiAgb);
    return new Response("not found", { status: 404 });
  });
  const external = () => calls.filter((u) => !u.startsWith("https://api.telegram.org/"));
  const telegram = () =>
    spy.mock.calls
      .filter((c) => String(c[0]).startsWith("https://api.telegram.org/"))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
  return { calls, external, telegram };
}

describe("campagne par pas", () => {
  it("interrupteur éteint : aucun effet (ni réseau, ni D1)", async () => {
    const net = mockNet();
    const r = await runProspectStep(OFF, at(0), { start: true });
    expect(r).toEqual({ enabled: false, result: "éteint", subrequests: 0 });
    expect(net.calls).toHaveLength(0);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM prospect_state").first<{ n: number }>())?.n).toBe(0);
    // Le cron hors fenêtre (19h30 UTC l'été = 21h30 de Paris, hors créneau du résumé) ne fait rien non plus.
    night();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 9, 19, 19, 30) }), OFF, ctx);
    await waitOnExecutionContext(ctx);
    expect(net.calls).toHaveLength(0);
  });

  it("une campagne complète : pas bornés, reprise du curseur, registre écarté, doublons OSM fusionnés, un seul message", async () => {
    const net = mockNet();
    const reports = [];
    for (let i = 0; i < 20; i++) {
      const before = net.external().length;
      const r = await runProspectStep(ON, at(i));
      if (r.result === "repos") break;
      reports.push(r);
      // Budget : au plus PROSPECT_STEP_BUDGET sous-requêtes, et le rapport dit vrai (hors Telegram).
      expect(r.subrequests).toBeLessThanOrEqual(PROSPECT_STEP_BUDGET);
      expect(net.external().length - before).toBeLessThanOrEqual(r.subrequests);
    }
    // 17e : 4 pages, Levallois : 1 page = 5 pages en 2 pas de 3 pages au plus, puis 2 pas Overpass, puis les sites, puis la fin.
    expect(reports.map((r) => r.phase).slice(0, 4)).toEqual(["entreprises", "entreprises", "osm", "osm"]);
    expect(reports[0].subrequests).toBe(PROSPECT_PAGES_PER_STEP);
    expect(reports.at(-1)?.phase).toBe("fin");
    const rows = (
      await db().prepare("SELECT id, name, website, template, parser, status, origin FROM agency_candidates").all<{
        id: string;
        name: string;
        website: string | null;
        template: string | null;
        parser: string | null;
        status: string;
        origin: string;
      }>()
    ).results;
    // Déjà au registre : jamais candidates.
    expect(rows.some((r) => /consultants|imax/i.test(r.name))).toBe(false);
    // Doublon de plus d'une page (la même fixture revient à chaque page) : un seul SIRET une seule fois.
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    expect(rows.every((r) => r.status === "nouveau")).toBe(true);
    const clap = rows.find((r) => r.name === "Clap'Immo")!;
    expect(clap).toMatchObject({ origin: "osm", template: "lbi", parser: "lbi", website: "http://www.clap-immo.fr/" });
    // Sans site : marqué, pas de lecture.
    expect(rows.find((r) => r.origin === "entreprises")?.template).toBe("aucun_site");
    // Un seul message Telegram, avec le candidat qui a un site.
    const msgs = net.telegram();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toContain("Clap&#39;Immo".replace("&#39;", "'"));
    expect(msgs[0].text).toContain("gabarit lbi");
    // Au repos : plus aucun appel, plus de message avant le mois suivant.
    const n = net.calls.length;
    expect((await runProspectStep(ON, at(40))).result).toBe("repos");
    expect(net.calls).toHaveLength(n);
    // Campagne mensuelle : relancée seulement 28 jours après le début.
    expect((await runProspectStep(ON, new Date(t0 + 27 * 86_400_000))).result).toBe("repos");
    expect((await runProspectStep(ON, new Date(t0 + 29 * 86_400_000))).result).toBe("pas");
  });

  it("échec d'Overpass (502) : le curseur reste, le pas suivant reprend au même endroit", async () => {
    mockNet({ overpassFails: 1, pages17: 1 });
    await runProspectStep(ON, at(0), { start: true }); // 17e (1 page) + Levallois (1 page)
    const before = await db()
      .prepare("SELECT phase, cursor FROM prospect_state")
      .first<{ phase: string; cursor: string }>();
    expect(before?.phase).toBe("osm");
    const bad = await runProspectStep(ON, at(1));
    expect(bad).toMatchObject({ phase: "osm", failed: true, subrequests: 1 });
    expect(await db().prepare("SELECT phase, cursor, failures FROM prospect_state").first()).toMatchObject({
      phase: "osm",
      cursor: before!.cursor,
      failures: 1,
    });
    const good = await runProspectStep(ON, at(2));
    expect(good.failed).toBeFalsy();
  });

  it("un pas déjà pris à bail n'est pas relancé", async () => {
    const net = mockNet();
    await runProspectStep(ON, at(0), { start: true });
    // Un autre pas tient le bail (posé à la main : un pas qui finit le libère).
    await db()
      .prepare("UPDATE prospect_state SET lease_until = ?")
      .bind(new Date(at(0).getTime() + 60_000).toISOString())
      .run();
    const n = net.calls.length;
    const r = await runProspectStep(ON, new Date(at(0).getTime() + 1000));
    expect(r.result).toBe("occupé");
    expect(net.calls).toHaveLength(n);
  });

  it("le cron hors fenêtre active lance un pas quand l'interrupteur est allumé", async () => {
    const net = mockNet();
    night();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 9, 19, 19, 30) }), ON, ctx);
    await waitOnExecutionContext(ctx);
    expect(net.external().length).toBe(PROSPECT_PAGES_PER_STEP);
    // Dans la fenêtre active (12h UTC = 14h de Paris) : le scan seul, jamais de prospection.
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 19, 12, 0)));
    const n = net.calls.length;
    const ctx2 = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 9, 19, 12, 0) }), ON, ctx2);
    await waitOnExecutionContext(ctx2);
    expect(net.calls.filter((u) => u.includes("recherche-entreprises"))).toHaveLength(PROSPECT_PAGES_PER_STEP);
    expect(n).toBe(PROSPECT_PAGES_PER_STEP);
  });

  it("route /prospect : clé obligatoire, rapport JSON, éteint sans effet", async () => {
    const net = mockNet();
    const call = (e: Env, k: string) =>
      worker.fetch(new Request(`https://x/prospect?k=${k}`), e, createExecutionContext());
    expect((await call(ON, "mauvaise")).status).toBe(403);
    const off = await call(OFF, "k");
    expect(await off.json()).toMatchObject({ enabled: false, result: "éteint" });
    expect(net.calls).toHaveLength(0);
    const on = await call(ON, "k");
    expect(await on.json()).toMatchObject({ enabled: true, result: "pas", phase: "entreprises" });
  });
});

describe("tableau de bord", () => {
  it("section « Agences candidates » : absente si vide, nouvelles en tête avec gabarit, lien et téléphone", async () => {
    const empty = await renderDashboard(db(), cfg.sources.dedicated, new Date(), new URLSearchParams());
    expect(empty).not.toContain("Agences candidates");
    const ins = (
      id: string,
      name: string,
      website: string | null,
      template: string | null,
      parser: string | null,
      status: string,
      seen: string,
    ) =>
      db()
        .prepare(
          "INSERT INTO agency_candidates (id, name, website, phone, template, parser, status, origin, first_seen, last_seen) VALUES (?1, ?2, ?3, '01 02 03 04 05', ?4, ?5, ?6, 'osm', ?7, ?7)",
        )
        .bind(id, name, website, template, parser, status, seen);
    await db().batch([
      ins("a", "Ancienne <b>Agence</b>", null, "aucun_site", null, "ignore", "2026-10-01T00:00:00Z"),
      ins("b", "Agence Lbi", "https://lbi.example/", "lbi", "lbi", "nouveau", "2026-11-01T00:00:00Z"),
      ins("c", "Agence Inconnue", "javascript:alert(1)", "inconnu", null, "nouveau", "2026-11-02T00:00:00Z"),
    ]);
    const html = await renderDashboard(db(), cfg.sources.dedicated, new Date(), new URLSearchParams());
    expect(html).toContain("Agences candidates");
    expect(html.indexOf("Agence Lbi")).toBeLessThan(html.indexOf("Agence Inconnue"));
    expect(html).toContain("lbi (lecteur existant)");
    expect(html).toContain('href="https://lbi.example/"');
    expect(html).toContain("01 02 03 04 05");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Ancienne"); // statut « ignoré » masqué
  });
});

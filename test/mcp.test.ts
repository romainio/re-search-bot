import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_SAMPLE_SIZE } from "../src/config/mcp";
import { settings } from "../src/derive";
import worker from "../src/index";
import {
  configOrigin,
  INSTANCE_KEY,
  loadLiveConfig,
  saveInstance,
  storedSwitches,
  SWITCHES_KEY,
} from "../src/live-config";
import { argsProblem, MCP_PROTOCOLS } from "../src/mcp/server";
import { MCP_TOKEN_KEY, mcpToken } from "../src/mcp/token";
import { townRegex } from "../src/mcp/args";
import { MCP_TOOLS } from "../src/mcp/tools";
import { publicUrl } from "../src/public-url";
import { LINK_CODE_KEY } from "../src/telegram/chat";
import type { Env } from "../src/types";
import fonciaRaw from "./fixtures/foncia.html?raw";
import shippedRaw from "../instance.config.json?raw";

// Serveur MCP (src/mcp/) : protocole (JSON-RPC sans état), accès (jeton aléatoire dans l'adresse), outils de paramétrage.

const E = (o: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  ADMIN_KEY: "k",
  TELEGRAM_BOT_TOKEN: "tok",
  MCP_ENABLED: "true",
  ...o,
});
const FONCIA = "https://fr.foncia.com/location/paris-75017/appartement";

const send = async (path: string, init: RequestInit, e: Env = E()): Promise<Response> => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://w.test${path}`, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};
/** Jeton en vigueur (créé au premier besoin). */
const tok = async (): Promise<string> => (await mcpToken(env.DB))!;
const post = async (body: unknown, e: Env = E(), path?: string): Promise<Response> =>
  send(
    path ?? `/mcp/${await tok()}`,
    { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) },
    e,
  );
const rpc = async (
  method: string,
  params?: unknown,
  e: Env = E(),
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> =>
  (await post({ jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) }, e)).json();
/** Appel d'un outil : { data } (résultat JSON) ou { error } (résultat en erreur, texte). */
const tool = async (
  name: string,
  args: Record<string, unknown> = {},
  e: Env = E(),
): Promise<{ data?: Record<string, unknown>; error?: string }> => {
  const r = await rpc("tools/call", { name, arguments: args }, e);
  const text = (r.result!.content as { text: string }[])[0]!.text;
  return r.result!.isError ? { error: text } : { data: JSON.parse(text) as Record<string, unknown> };
};
/** Réseau simulé : Telegram répond ok, l'adresse Foncia sert sa page enregistrée, `refused` répond 403, le reste 404. */
const mockNet = (refused = "https://refus.exemple.fr/locations") =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u.startsWith("https://api.telegram.org/")) return new Response(JSON.stringify({ ok: true }));
    if (u === FONCIA) return new Response(fonciaRaw);
    if (u === refused) return new Response("no", { status: 403 });
    return new Response("?", { status: 404 });
  });

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare("DELETE FROM settings WHERE key IN (?, ?, ?, ?)")
    .bind(INSTANCE_KEY, SWITCHES_KEY, LINK_CODE_KEY, MCP_TOKEN_KEY)
    .run();
  await loadLiveConfig(E());
});

describe("MCP : accès", () => {
  it("éteint : 404 sur /mcp et /mcp/<jeton>", async () => {
    const off = E({ MCP_ENABLED: "false" });
    expect((await send("/mcp?k=k", {}, off)).status).toBe(404);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, off)).status).toBe(404);
  });

  it("GET /mcp?k=ADMIN_KEY redirige vers /mcp/<jeton> (jeton aléatoire, sans lien avec la clé) ; mauvaise clé : 403", async () => {
    const token = await tok();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await tok()).toBe(token); // gardé en D1
    const res = await send("/mcp?k=k", { headers: { accept: "text/html,*/*" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://w.test/mcp/${token}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await send("/mcp?k=faux", {})).status).toBe(403);
  });

  it("GET /mcp/<jeton> depuis un navigateur : page avec cette même adresse ; client MCP qui ouvre un flux : 405 (sans état)", async () => {
    const token = await tok();
    const page = await send(`/mcp/${token}`, { headers: { accept: "text/html,*/*" } });
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await page.text()).toContain(`https://w.test/mcp/${token}`);
    expect((await send(`/mcp/${token}`, { headers: { accept: "text/event-stream" } })).status).toBe(405);
    expect((await send("/mcp/0000", { headers: { accept: "text/html" } })).status).toBe(401);
  });

  it("sans jeton ou avec un mauvais jeton : 401 ; la clé d'administration n'ouvre pas le protocole ; Bearer <jeton> accepté sur /mcp", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(ping, E(), "/mcp")).status).toBe(401);
    expect((await post(ping, E(), "/mcp/")).status).toBe(401);
    expect((await post(ping, E(), "/mcp/0000")).status).toBe(401);
    expect((await post(ping, E(), "/mcp/k")).status).toBe(401);
    // ?k=ADMIN_KEY ne sert qu'à la redirection : jamais d'adresse de connecteur qui contienne la clé.
    expect((await post(ping, E(), "/mcp?k=k")).status).toBe(401);
    const bearer = (b: string) =>
      send("/mcp", { method: "POST", body: JSON.stringify(ping), headers: { authorization: `Bearer ${b}` } });
    expect((await bearer("k")).status).toBe(401);
    expect((await bearer(await tok())).status).toBe(200);
  });

  it("en-tête Origin d'un autre site : 403 (rebond DNS) ; même origine ou sans Origin : accepté", async () => {
    const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const path = `/mcp/${await tok()}`;
    expect(
      (await send(path, { method: "POST", body: ping, headers: { origin: "https://attaquant.example" } })).status,
    ).toBe(403);
    expect((await send(path, { method: "POST", body: ping, headers: { origin: "https://w.test" } })).status).toBe(200);
    expect((await send(path, { method: "POST", body: ping })).status).toBe(200);
  });

  it("sans état : GET et DELETE avec le jeton rendent 405", async () => {
    const path = `/mcp/${await tok()}`;
    expect((await send(path, {})).status).toBe(405);
    expect((await send(path, { method: "DELETE" })).status).toBe(405);
  });

  it("regenerer_adresse : nouvelle adresse rendue, l'ancienne refusée aussitôt", async () => {
    const old = await tok();
    const { data } = await tool("regenerer_adresse");
    const fresh = await tok();
    expect(fresh).not.toBe(old);
    expect(data!.adresse).toBe(`https://w.test/mcp/${fresh}`);
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(ping, E(), `/mcp/${old}`)).status).toBe(401);
    expect((await post(ping, E(), `/mcp/${fresh}`)).status).toBe(200);
  });
});

describe("MCP : protocole", () => {
  it("initialize : version du client si elle est connue, sinon la plus récente ; capacités et consignes", async () => {
    const r = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "1" },
    });
    expect(r.result).toMatchObject({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "re-search" },
    });
    expect(String(r.result!.instructions)).toContain("etat");
    expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result!.protocolVersion).toBe(MCP_PROTOCOLS[0]);
  });

  it("notification : 202 sans corps ; ping : résultat vide ; méthode inconnue : -32601 ; JSON invalide : -32700", async () => {
    const n = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(n.status).toBe(202);
    expect(await n.text()).toBe("");
    expect((await rpc("ping")).result).toEqual({});
    expect((await rpc("resources/list")).error?.code).toBe(-32601);
    const bad = await post("{");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
    expect(((await (await post({ id: 1, method: "ping" })).json()) as { error: { code: number } }).error.code).toBe(
      -32600,
    );
  });

  it("lot JSON-RPC (retiré du protocole 2025-06-18) : -32600, rien n'est exécuté", async () => {
    for (const batch of [[{ jsonrpc: "2.0", id: "a", method: "ping" }], []]) {
      const res = await post(batch);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32600);
    }
  });

  it("tools/call : arguments inconnus (additionalProperties: false) ou requis absents : résultat en erreur qui les nomme", async () => {
    expect((await tool("etat", { verbeux: true })).error).toMatch(/arguments inconnus : verbeux/);
    expect((await tool("retirer_source", {})).error).toMatch(/arguments requis manquants : id/);
    expect((await tool("ajouter_source", { id: "x", nom: "X", adresse: FONCIA, lectuer: "foncia" })).error).toMatch(
      /arguments inconnus : lectuer[\s\S]*requis manquants : lecteur/,
    );
    expect(argsProblem({ type: "object", properties: { a: {} } }, { a: 1, b: 2 })).toBeNull(); // sans additionalProperties: false, toléré
  });

  it("tools/list : tous les outils, chacun avec un schéma d'objet ; outil inconnu : -32602", async () => {
    const tools = (await rpc("tools/list")).result!.tools as {
      name: string;
      description: string;
      inputSchema: { type: string };
    }[];
    expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "etat",
        "definir_recherche",
        "tester_source",
        "ajouter_source",
        "retirer_source",
        "lier_telegram",
        "chercher_annonces",
      ]),
    );
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
    }
    expect((await rpc("tools/call", { name: "supprimer_tout" })).error?.code).toBe(-32602);
  });
});

describe("MCP : outils de paramétrage", () => {
  it("etat : recherche en vigueur, fonctions, prochaines étapes", async () => {
    const { data } = await tool("etat");
    expect(data!.parametree).toBe(true);
    expect(data!.configuration).toMatch(/fichier embarqué/);
    expect((data!.recherche as { loyer_max: number }).loyer_max).toBe(settings().instance.criteria.rentMax);
    expect((data!.fonctions as { nom: string; allumee: boolean }[]).find((f) => f.nom === "MCP_ENABLED")?.allumee).toBe(
      true,
    );
    expect((data!.prochaines_etapes as string[]).join(" ")).not.toMatch(/definir_recherche/);
  });

  it("definir_recherche : seuls les champs donnés changent ; enregistré en D1 et en vigueur aussitôt", async () => {
    const before = settings().instance;
    const { data } = await tool("definir_recherche", { loyer_max: 1234, exclure_rez_de_chaussee: false });
    expect(data!.ok).toBe(true);
    expect(configOrigin()).toBe("d1");
    expect(settings().criteria.rentMax).toBe(1234);
    expect(settings().criteria.surfaceMin).toBe(before.criteria.surfaceMin);
    expect(settings().instance.zones.map((z) => z.postalCode)).toEqual(before.zones.map((z) => z.postalCode));
    expect(settings().instance.sources.length).toBe(before.sources.length);
  });

  it("definir_recherche avec d'autres zones : les sources hors zone sont retirées et nommées ; une instance sans source est valide", async () => {
    const { data } = await tool("definir_recherche", {
      zones: [{ code_postal: "69003", libelle: "Lyon 3e", commune: "Lyon" }],
      communes_exclues: [{ code_postal: "69100", commune: "Villeurbanne" }],
      loyer_min: 500,
      loyer_max: 900,
      surface_min: 25,
      pieces_min: 1,
      quartiers: ["Montchat"],
      heure_debut: 8,
      heure_fin: 21,
    });
    expect(data!.sources_actives).toBe(0);
    expect((data!.sources_retirees as string[]).length).toBeGreaterThan(10);
    const i = settings().instance;
    expect(i.zones.map((z) => z.postalCode)).toEqual(["69003"]);
    expect(i.zones[0]!.town?.test("appartement à LYON")).toBe(true);
    expect(i.outOfZoneTowns[0]!.town.test("Villeurbanne Gratte-Ciel")).toBe(true);
    expect(i.sources).toEqual([]);
    expect(i.window).toMatchObject({ startHour: 8, endHour: 21 });
    expect(i.neighborhoodKeywords).toEqual(["Montchat"]);
  });

  it("definir_recherche : une zone gardée sans « commune » conserve sa commune ; « commune » redonnée la remplace", async () => {
    await tool("definir_recherche", { zones: [{ code_postal: "69003", libelle: "Lyon 3e", commune: "Lyon" }] });
    await tool("definir_recherche", {
      zones: [
        { code_postal: "69003", libelle: "Lyon 3" },
        { code_postal: "69100", libelle: "Villeurbanne" },
      ],
    });
    let [lyon, vil] = settings().instance.zones;
    expect(lyon!.label).toBe("Lyon 3");
    expect(lyon!.town?.test("appartement à LYON")).toBe(true);
    expect(vil!.town).toBeUndefined();
    await tool("definir_recherche", { zones: [{ code_postal: "69003", libelle: "Lyon 3", commune: "Saint-Étienne" }] });
    [lyon] = settings().instance.zones;
    expect(lyon!.town?.test("à Lyon")).toBe(false);
    expect(lyon!.town?.test("à Saint-Etienne")).toBe(true);
  });

  it("definir_recherche invalide : résultat en erreur lisible, rien n'est enregistré", async () => {
    const r = await tool("definir_recherche", { loyer_min: 2000, loyer_max: 900 });
    expect(r.error).toMatch(/rentMin/);
    expect((await tool("definir_recherche", { loyer_max: "cher" })).error).toMatch(/loyer_max : nombre attendu/);
    expect(configOrigin()).toBe("fichier");
  });

  it("tester_source : lit la page, applique le lecteur et le filtre, n'enregistre rien", async () => {
    const spy = mockNet();
    const { data } = await tool("tester_source", { adresse: FONCIA, lecteur: "foncia", filtree_sur_les_zones: true });
    expect(data!.ok).toBe(true);
    expect(data!.annonces_lues as number).toBeGreaterThan(0);
    const ex = data!.exemples as { gardee: boolean; lien: string }[];
    expect(ex.length).toBe(MCP_SAMPLE_SIZE);
    // Gardées d'abord, chacune avec le lien de l'annonce.
    expect(ex.map((x) => x.gardee)).toEqual([...ex.map((x) => x.gardee)].sort((a, b) => Number(b) - Number(a)));
    expect(ex.every((x) => x.lien.startsWith("https://"))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(configOrigin()).toBe("fichier");
    // Source déjà enregistrée, par son identifiant.
    expect((await tool("tester_source", { id: "foncia_17" })).data!.ok).toBe(true);
    expect((await tool("tester_source", { id: "inconnue" })).error).toMatch(/source inconnue/);
  });

  it("tester_source : site qui refuse (403) ou page non reconnue : ok false avec un conseil, jamais d'exception", async () => {
    mockNet();
    const refused = (await tool("tester_source", { adresse: "https://refus.exemple.fr/locations", lecteur: "foncia" }))
      .data!;
    expect(refused).toMatchObject({ ok: false, erreur: "HTTP 403" });
    expect(String(refused.conseil)).toMatch(/aucun contournement/);
    // La page Foncia lue par un autre lecteur : gabarit non reconnu.
    const wrong = (await tool("tester_source", { adresse: FONCIA, lecteur: "era" })).data!;
    expect(wrong.ok).toBe(false);
    expect((await tool("tester_source", { adresse: FONCIA, lecteur: "inconnu" })).error).toMatch(/lecteur inconnu/);
    expect((await tool("tester_source", { adresse: FONCIA, lecteur: "foncia", zones: ["13001"] })).error).toMatch(
      /zones inconnues/,
    );
  });

  it("ajouter_source : refusée sans lecture réussie (rien n'est écrit) ; ajoutée après une lecture réussie ; puis retirée", async () => {
    mockNet();
    const refused = await tool("ajouter_source", {
      id: "refus",
      nom: "Refus",
      adresse: "https://refus.exemple.fr/locations",
      lecteur: "foncia",
    });
    expect(refused.error).toMatch(/source non ajoutée[\s\S]*HTTP 403/);
    expect(configOrigin()).toBe("fichier");

    const n = settings().instance.sources.length;
    expect(
      (await tool("ajouter_source", { id: "foncia_17", nom: "Doublon", adresse: FONCIA, lecteur: "foncia" })).error,
    ).toMatch(/déjà pris/);
    const added = await tool("ajouter_source", {
      id: "foncia_bis",
      nom: "Foncia bis",
      adresse: FONCIA,
      lecteur: "foncia",
      zones: ["75017"],
      filtree_sur_les_zones: true,
      cadence_minutes: 10,
    });
    expect(added.data).toMatchObject({ ok: true, ajoutee: "foncia_bis" });
    const src = settings().instance.sources.find((s) => s.id === "foncia_bis");
    expect(src).toMatchObject({
      name: "Foncia bis",
      parser: "foncia",
      zones: ["75017"],
      filteredToZones: true,
      every: 10,
      active: true,
    });
    expect(settings().instance.sources.length).toBe(n + 1);
    expect(((await tool("lister_sources")).data!.sources as { id: string }[]).some((s) => s.id === "foncia_bis")).toBe(
      true,
    );

    expect((await tool("retirer_source", { id: "foncia_bis" })).data).toMatchObject({
      ok: true,
      retiree: "foncia_bis",
    });
    expect(settings().instance.sources.length).toBe(n);
    expect((await tool("retirer_source", { id: "foncia_bis" })).error).toMatch(/source inconnue/);
  });

  it("modification simultanée pendant ajouter_source : rien n'est écrasé, erreur qui demande de recommencer ; rejoué, l'ajout passe", async () => {
    // Avec une ligne en D1 (mise à jour conditionnelle) puis sans (insertion conditionnelle).
    for (const stored of [true, false]) {
      if (stored) await tool("definir_recherche", { loyer_max: 1500 });
      let interleave = true;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const u = String(input instanceof Request ? input.url : input);
        // Une autre modification arrive pendant que la source est lue (entre la lecture et l'écriture de la configuration).
        if (u === FONCIA && interleave) {
          interleave = false;
          await tool("definir_recherche", { loyer_max: 1400 });
        }
        return u === FONCIA ? new Response(fonciaRaw) : new Response("?", { status: 404 });
      });
      const args = { id: "foncia_bis", nom: "Foncia bis", adresse: FONCIA, lecteur: "foncia" };
      expect((await tool("ajouter_source", args)).error).toMatch(/a changé pendant cet appel[\s\S]*recommencer/);
      expect(settings().criteria.rentMax).toBe(1400);
      expect(settings().instance.sources.some((s) => s.id === "foncia_bis")).toBe(false);
      expect((await tool("ajouter_source", args)).data).toMatchObject({ ok: true, ajoutee: "foncia_bis" });
      expect(settings().criteria.rentMax).toBe(1400);
      vi.restoreAllMocks();
      await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(INSTANCE_KEY).run();
      await loadLiveConfig(E());
    }
  });

  it("completer_localisation : commune des zones à code unique, voisines dans le rayon (départements voisins compris), petites et lointaines écartées", async () => {
    await tool("definir_recherche", {
      zones: [
        { code_postal: "69003", libelle: "Lyon 3e" },
        { code_postal: "69100", libelle: "Villeurbanne" },
      ],
      communes_exclues: [{ code_postal: "69300", commune: "Caluire-et-Cuire" }],
    });
    const c = (
      nom: string,
      code: string,
      codesPostaux: string[],
      lon: number,
      lat: number,
      population: number,
      codeDepartement = "69",
    ) => ({ nom, code, codesPostaux, centre: { type: "Point", coordinates: [lon, lat] }, population, codeDepartement });
    const LYON = c(
      "Lyon",
      "69123",
      ["69001", "69002", "69003", "69004", "69005", "69006", "69007", "69008", "69009"],
      4.8351,
      45.758,
      520_000,
    );
    const VILLEURBANNE = c("Villeurbanne", "69266", ["69100"], 4.88, 45.77, 150_000);
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input instanceof Request ? input.url : input);
      urls.push(u);
      const body = u.includes("codePostal=69003")
        ? [LYON]
        : u.includes("codePostal=69100")
          ? [VILLEURBANNE]
          : u.includes("lat=")
            ? [
                {
                  nom: "Sonde",
                  code: "00000",
                  codeDepartement: u.includes("lon=4.9") || u.includes("lon=5") ? "01" : "69",
                },
              ]
            : u.includes("/departements/69/")
              ? [
                  LYON,
                  VILLEURBANNE,
                  c("Bron", "69029", ["69500"], 4.91, 45.73, 40_000),
                  c("Hameau", "69999", ["69990"], 4.86, 45.76, 500),
                  c("Villefranche-sur-Saône", "69264", ["69400"], 4.72, 45.99, 37_000),
                ]
              : u.includes("/departements/01/")
                ? [c("Miribel", "01249", ["01700"], 4.95, 45.82, 10_000, "01")]
                : [];
      return new Response(JSON.stringify(body));
    });
    const { data } = await tool("completer_localisation");
    expect(urls.every((u) => u.startsWith("https://geo.api.gouv.fr/"))).toBe(true);
    expect(urls.length).toBeLessThan(50);
    expect(data!.zones_nommees).toEqual(["69100 Villeurbanne"]); // Lyon couvre 9 codes : pas de nom pour 69003
    expect((data!.communes_exclues as string[]).map((s) => s.split(" (")[0])).toEqual(["Bron", "Miribel"]);
    expect(data!.gardees_a_la_main).toBe(1);
    const i = settings().instance;
    expect(i.outOfZoneTowns.map((t) => t.postalCode)).toEqual(["69300", "69500", "01700"]);
    expect(i.zones.find((z) => z.postalCode === "69100")!.town!.test("T2 à VILLEURBANNE")).toBe(true);
    expect(i.zones.find((z) => z.postalCode === "69003")!.town).toBeUndefined();
  });

  it("completer_localisation : API indisponible ou rayon hors bornes : résultat en erreur, rien n'est changé", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("panne", { status: 503 }));
    expect((await tool("completer_localisation")).error).toMatch(/HTTP 503/);
    expect((await tool("completer_localisation", { rayon_km: 100 })).error).toMatch(/rayon_km/);
    expect(configOrigin()).toBe("fichier");
  });

  it("proposer_sources : propositions pour les zones (exemple Paris 17 et Levallois), sources déjà enregistrées signalées, rien d'écrit", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.includes("geo.api.gouv.fr") && u.includes("92300"))
        return new Response(
          JSON.stringify([{ nom: "Levallois-Perret", code: "92044", codesPostaux: ["92300"], population: 66_000 }]),
        );
      if (u.includes("suggest.json"))
        return new Response(JSON.stringify([{ postalCodes: [u.slice(-5)], zoneIds: [`-${u.slice(-5)}`] }]));
      return new Response("[]");
    });
    const { data } = await tool("proposer_sources");
    const props = data!.propositions as { id: string; adresse: string; deja_enregistree?: boolean }[];
    expect(props.find((p) => p.id === "foncia_paris_17e")).toMatchObject({ adresse: FONCIA, deja_enregistree: true });
    expect(props.find((p) => p.id === "foncia_levallois_perret")?.deja_enregistree).toBe(true); // même adresse que foncia_levallois
    expect(props.find((p) => p.id === "century21_75017")?.deja_enregistree).toBe(true);
    expect(props.some((p) => !p.deja_enregistree)).toBe(true);
    expect(configOrigin()).toBe("fichier");
  });

  it("detecter_gabarit : lecteur reconnu, gabarit inconnu, site qui refuse", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.includes("connu")) return new Response('<html><meta name="generator" content="bObcat"></html>');
      if (u.includes("refus")) return new Response("no", { status: 429 });
      return new Response("<html><body>Agence</body></html>");
    });
    expect((await tool("detecter_gabarit", { adresse: "https://connu.exemple.fr/" })).data).toMatchObject({
      ok: true,
      gabarit: "lbi",
      lecteur: "lbi",
    });
    expect((await tool("detecter_gabarit", { adresse: "https://autre.exemple.fr/" })).data).toMatchObject({
      ok: true,
      gabarit: "inconnu",
      lecteur: null,
    });
    expect((await tool("detecter_gabarit", { adresse: "https://refus.exemple.fr/" })).data).toMatchObject({
      ok: false,
      erreur: "HTTP 429",
    });
  });

  it("adresses : seuls les noms de domaine publics en http(s) sont lus", async () => {
    const spy = mockNet();
    for (const bad of [
      "http://127.0.0.1/",
      "http://localhost/",
      "https://192.168.1.10/a",
      "ftp://exemple.fr/",
      "https://[::1]/",
      "https://intranet/",
      "https://u:p@exemple.fr/",
      "pas une adresse",
    ]) {
      expect(() => publicUrl(bad), bad).toThrow();
      expect((await tool("detecter_gabarit", { adresse: bad })).error, bad).toBeTruthy();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(publicUrl("https://www.exemple.fr/location?p=1")).toBe("https://www.exemple.fr/location?p=1");
  });

  it("townRegex : accents, traits d'union et apostrophes tolérés", () => {
    const re = (n: string) => new RegExp(townRegex(n), "i");
    expect(re("Saint-Étienne").test("T2 à Saint Etienne centre")).toBe(true);
    expect(re("Saint-Étienne").test("SAINT-ÉTIENNE")).toBe(true);
    expect(re("L'Haÿ-les-Roses").test("l’hay les roses")).toBe(true);
    expect(re("Lyon").test("Lyonnais")).toBe(false);
    expect(() => townRegex("  ")).toThrow();
  });

  it("regler_fonctions : enregistre les interrupteurs, signale ce qui manque ; nom inconnu refusé", async () => {
    const { data } = await tool("regler_fonctions", { fonctions: { GEO_HINTS: true, SEMANTIC_SEARCH: true } });
    expect(data!.enregistrees).toEqual({ GEO_HINTS: true, SEMANTIC_SEARCH: true });
    expect((data!.manques as { nom: string }[]).map((m) => m.nom)).toContain("SEMANTIC_SEARCH"); // binding VECTORIZE absent
    expect((await tool("regler_fonctions", { fonctions: { ADMIN_KEY: true } })).error).toMatch(/interrupteur inconnu/);
    expect(await storedSwitches(env.DB)).toEqual({ GEO_HINTS: true, SEMANTIC_SEARCH: true });
  });

  it("lier_telegram : refusé tant que TELEGRAM_INTERACTIVE est éteinte ; sinon webhook installé et code de liaison rendu", async () => {
    const spy = mockNet();
    expect((await tool("lier_telegram")).error).toMatch(/TELEGRAM_INTERACTIVE/);
    expect(spy).not.toHaveBeenCalled();
    const { data } = await tool("lier_telegram", {}, E({ TELEGRAM_INTERACTIVE: "true" }));
    expect(data!.ok).toBe(true);
    expect(String(data!.code)).toMatch(/^[A-Z2-9]{8}$/);
    expect(String(data!.a_faire)).toContain(`/start ${String(data!.code)}`);
    const hook = spy.mock.calls.find((c) => String(c[0]).includes("setWebhook"));
    expect(JSON.parse((hook![1] as RequestInit).body as string).url).toBe("https://w.test/telegram");
    // Le jeton du bot ne figure dans aucune réponse.
    expect(JSON.stringify(data)).not.toContain("tok");
  });

  it("chercher_annonces : lecture seule, arguments validés par le schéma de l'assistant", async () => {
    expect((await tool("chercher_annonces", { loyer_max: 1500, limite: 3 })).data).toMatchObject({
      nombre: 0,
      annonces: [],
    });
    expect((await tool("chercher_annonces", { zone: "99999" })).error).toMatch(/zone/);
  });
});

describe("MCP : accueil", () => {
  const home = async (path: string, e: Env): Promise<Response> => send(path, { headers: { cookie: "" } }, e);
  const PRIVATE = (o: Partial<Env> = {}) => E({ DASHBOARD_PUBLIC: "false", ...o });

  it("aucune source active : page de démarrage avec l'adresse du connecteur ; ?tableau=1 : le tableau de bord", async () => {
    await tool("definir_recherche", { zones: [{ code_postal: "69003", libelle: "Lyon 3e" }] }); // les sources de l'exemple sont retirées
    const first = await home("/?k=k", PRIVATE()); // la clé pose le cookie et redirige
    expect(first.status).toBe(302);
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    const page = await send("/", { headers: { cookie } }, PRIVATE());
    const html = await page.text();
    expect(html).toContain("RE-SEARCH est installé");
    expect(html).toContain(`https://w.test/mcp/${await tok()}`);
    expect(await (await send("/?tableau=1", { headers: { cookie } }, PRIVATE())).text()).toContain(
      "Dernières annonces",
    );
  });

  it("tableau de bord privé : encart avec l'adresse ; public ou MCP éteint : jamais d'adresse", async () => {
    const cookie = (await home("/?k=k", PRIVATE())).headers.get("set-cookie")!.split(";")[0]!;
    const token = (await tok())!;
    const priv = await (await send("/", { headers: { cookie } }, PRIVATE())).text();
    expect(priv).toContain("Paramétrer avec un assistant IA");
    expect(priv).toContain(token);
    expect(await (await send("/", {}, E({ DASHBOARD_PUBLIC: "true" }))).text()).not.toContain(token);
    expect(await (await send("/", { headers: { cookie } }, PRIVATE({ MCP_ENABLED: "false" }))).text()).not.toContain(
      "Paramétrer avec un assistant",
    );
  });
});

describe("instance non paramétrée (fichier livré)", () => {
  /** Met en vigueur le fichier livré, comme sur une instance tout juste déployée. */
  const fresh = async (): Promise<void> => {
    await saveInstance(env.DB, JSON.parse(shippedRaw));
    await loadLiveConfig(E());
  };

  it("etat : non paramétrée, première étape definir_recherche ; /health le signale", async () => {
    await fresh();
    const { data } = await tool("etat");
    expect(data!.parametree).toBe(false);
    expect((data!.prochaines_etapes as string[])[0]).toMatch(/definir_recherche/);
    expect((data!.problemes as string[]).join(" ")).toMatch(/recherche non paramétrée/);
    expect((data!.recherche as { zones: unknown[] }).zones).toEqual([]);
  });

  it("definir_recherche : sans loyer_max, erreur qui le nomme ; avec, l'instance est paramétrée", async () => {
    await fresh();
    const zones = [{ code_postal: "69003", libelle: "Lyon 3e", commune: "Lyon" }];
    expect((await tool("definir_recherche", { heure_debut: 8 })).data?.ok).toBe(true);
    expect((await tool("definir_recherche", { zones })).error).toMatch(/criteria/);
    expect((await tool("definir_recherche", { zones, loyer_max: 900 })).data?.ok).toBe(true);
    const { data } = await tool("etat");
    expect(data!.parametree).toBe(true);
    expect((data!.prochaines_etapes as string[]).join(" ")).toMatch(/proposer_sources/);
  });

  it("tableau de bord : page de démarrage en privé, rappel « Recherche à paramétrer » en public", async () => {
    await fresh();
    const first = await send("/?k=k", { headers: { cookie: "" } }, E({ DASHBOARD_PUBLIC: "false" }));
    const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
    expect(await (await send("/", { headers: { cookie } }, E({ DASHBOARD_PUBLIC: "false" }))).text()).toContain(
      "RE-SEARCH est installé",
    );
    expect(await (await send("/", {}, E({ DASHBOARD_PUBLIC: "true" }))).text()).toContain("Recherche à paramétrer");
  });

  it("cron : rien n'est lu ni envoyé, même dans la fenêtre active", async () => {
    await fresh();
    const spy = vi.spyOn(globalThis, "fetch");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-19T08:00:05Z"));
    try {
      const ctx = createExecutionContext();
      await worker.scheduled(
        createScheduledController({ scheduledTime: Date.parse("2026-10-19T08:00:00Z") }),
        E(),
        ctx,
      );
      await waitOnExecutionContext(ctx);
    } finally {
      vi.useRealTimers();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOTAL_GROUPS } from "../src/config/schedule";
import {
  UNIVERSAL_BROWSER_MAX,
  UNIVERSAL_ESTIMATE_NEURONS,
  UNIVERSAL_MAX_ACTIVE,
  UNIVERSAL_MAX_CHARS,
  UNIVERSAL_MIN_EVERY,
} from "../src/config/universal";
import { settings } from "../src/derive";
import { evaluate } from "../src/filter";
import { staleMinutes } from "../src/health";
import { isDue } from "../src/schedule";
import { getPendingAlerts } from "../src/process";
import { groupParts, parsePartRequest, runPart } from "../src/scan";
import { readableIds } from "../src/sources";
import type { Env, SourceDef } from "../src/types";
import { reduceMarkdown } from "../src/universal/reduce";
import { readUniversal } from "../src/universal/read";
import { appearsIn, normalizeUrl, stableId, validateExtraction } from "../src/universal/schema";
import type { ExtractContext } from "../src/universal/schema";
import david from "./fixtures/davidimmo.html?raw";
import { fakeAi, fakeMarkdown, withAi } from "./universal-helpers";
import type { FakeAi } from "./universal-helpers";

const cfg = settings();

const E = (o: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  ADMIN_KEY: "k",
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  WHATSAPP_ENABLED: "false",
  UNIVERSAL_READER: "true",
  ...o,
});
const SRC: SourceDef = { ...cfg.sources.universal[0], active: true };
const at = (h: number, m: number) => new Date(Date.UTC(2026, 10, 9, h, m));

// Réponse du modèle simulé pour la fixture David Immo : trois annonces, avec la page telle qu'elle est écrite (prix « CC », liens relatifs).
const ANSWER = {
  listings: [
    {
      url: "/location-appartement-3-pieces-levallois-perret-92300-17461.html",
      title: "Appartement 3 pièces à Levallois-Perret",
      price: 2550,
      price_kind: "CC",
      charges: null,
      surface: 55,
      rooms: 3,
      floor: null,
      address: null,
      postal_code: "92300",
      district: null,
      photo: null,
      property_type: "Appartement",
    },
    {
      url: "/location-appartement-2-pieces-paris-75018-17257.html",
      title: "Appartement 2 pièces Paris 18",
      price: 1521,
      price_kind: "CC",
      charges: null,
      surface: 39,
      rooms: 2,
      floor: null,
      address: null,
      postal_code: "75018",
      district: "Custine-Clignancourt",
      photo: null,
      property_type: "Appartement",
    },
    {
      url: "/location-appartement-1-piece-paris-75018-15287.html",
      title: "Appartement 1 pièce Paris 18 Guy Môquet",
      price: 1349,
      price_kind: "CC",
      charges: null,
      surface: 30.66,
      rooms: 1,
      floor: null,
      address: null,
      postal_code: "75018",
      district: null,
      photo: null,
      property_type: "Appartement",
    },
  ],
  empty: false,
};

const mockPage = (html: string) => vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(html));

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM listings"),
    env.DB.prepare("DELETE FROM source_state"),
    env.DB.prepare("DELETE FROM ai_usage"),
    env.DB.prepare("DELETE FROM universal_state"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("réduction du Markdown", () => {
  it("ne garde que les blocs d'annonces (prix en € près d'une surface ou de pièces) : la page David Immo passe de ~11 000 à ~2 400 caractères", () => {
    const md = fakeMarkdown(david);
    const r = reduceMarkdown(md);
    expect(md.length).toBeGreaterThan(10_000);
    expect(r.length).toBeLessThan(UNIVERSAL_MAX_CHARS);
    expect(r.length).toBeLessThan(md.length / 3);
    expect(r).toContain("2 550 € CC");
    expect(r).toContain(
      "[Levallois-perret - 92300 - LEVALLOIS-PERRET Appartement 3 pièces](/location-appartement-3-pieces-levallois-perret-92300-17461.html)",
    );
    expect(r).not.toContain("Lancer la recherche"); // formulaire
    expect(r).not.toContain("attestation de domicile"); // texte de présentation
  });

  it("rien qui ressemble à une annonce : texte vide ; un prix sans surface ni pièces n'est pas une annonce", () => {
    expect(reduceMarkdown("# Accueil\n\nBienvenue\n\nAbonnement à 9 € par mois")).toBe("");
    expect(reduceMarkdown("")).toBe("");
  });

  it("plafond de caractères : fenêtres entières, la dernière qui dépasse est abandonnée ; jamais plus que le plafond", () => {
    const card = (i: number) => `Appartement ${i}\n2 pièces 40 m²\n1 ${100 + i} € CC\n[Voir](/a/${i})\n\n\n\n\n\n\n\n`;
    const md = Array.from({ length: 200 }, (_, i) => card(i)).join("\n");
    const r = reduceMarkdown(md, 500);
    expect(r.length).toBeLessThanOrEqual(500);
    expect(r).toContain("Appartement 0");
    expect(r).not.toContain("Appartement 199");
  });
});

describe("validation stricte du JSON du modèle", () => {
  const TEXT = "[Studio lumineux](/a/1)\n1 350 € CC\n32 m²\n[Autre](/a/2)\n980 € HC\n24,5 m²\ncharges 60 €";
  const ctx = (o: Partial<ExtractContext> = {}): ExtractContext => ({
    source: "x",
    agency: "Agence X",
    phone: null,
    baseUrl: "https://agence.fr/location",
    text: TEXT,
    max: 15,
    keepQuery: true,
    ...o,
  });
  const item = (o: Record<string, unknown> = {}) => ({
    url: "/a/1",
    title: "Studio lumineux",
    price: 1350,
    price_kind: "CC",
    charges: null,
    surface: 32,
    rooms: 1,
    floor: null,
    address: null,
    postal_code: null,
    district: null,
    photo: null,
    property_type: null,
    ...o,
  });
  const run = (items: unknown[], c = ctx()) => validateExtraction({ listings: items, empty: false }, c)!;

  it("annonce valide : format Listing, id = URL normalisée, agence de la source, prix CC retenu parce que le texte le dit", () => {
    const [l] = run([item()]).listings;
    expect(l).toMatchObject({
      source: "x",
      id: "https://agence.fr/a/1",
      url: "https://agence.fr/a/1",
      price: 1350,
      priceIsCC: true,
      charges: null,
      surface: 32,
      rooms: 1,
      agency: "Agence X",
      postalCode: null,
      publishedAt: null,
    });
  });

  it("champ inventé : l'annonce est refusée (et comptée) ; champ inconnu au niveau de la réponse : réponse refusée", () => {
    const r = run([item({ energy_class: "A" }), item({ url: "/a/2", price: 980, price_kind: "HC", surface: 24.5 })]);
    expect(r.listings).toHaveLength(1);
    expect(r.rejected).toBe(1);
    expect(validateExtraction({ listings: [], extra: 1 }, ctx())).toBeNull();
    expect(validateExtraction({ listings: "non" }, ctx())).toBeNull();
    expect(validateExtraction([], ctx())).toBeNull();
    expect(validateExtraction({ listings: [], empty: "oui" }, ctx())).toBeNull();
  });

  it("prix incohérents refusés : hors fourchette, texte à la place d'un nombre, absent du texte (inventé), charges supérieures au loyer", () => {
    expect(run([item({ price: 90 })]).listings).toHaveLength(0);
    expect(run([item({ price: 250_000 })]).listings).toHaveLength(0);
    expect(run([item({ price: "1350 €" })]).listings).toHaveLength(0);
    expect(run([item({ price: 1400 })]).listings).toHaveLength(0); // 1 400 n'est pas écrit dans le texte
    expect(run([item({ surface: 55 })]).listings).toHaveLength(0); // 55 m² non plus
    expect(run([item({ charges: 1500 })]).listings).toHaveLength(0);
    expect(run([item({ rooms: 2.5 })]).listings).toHaveLength(0);
    expect(run([item({ price_kind: "TTC" })]).listings).toHaveLength(0);
  });

  it("CC / HC : seulement si le texte le dit ; charges seulement si écrites ; sans prix, aucune nature", () => {
    const hc = run([item({ url: "/a/2", price: 980, price_kind: "HC", charges: 60, surface: 24.5 })]).listings[0];
    expect(hc).toMatchObject({ price: 980, priceIsCC: false, charges: 60 });
    const noWord = run([item({ price_kind: "CC" })], ctx({ text: "[Studio lumineux](/a/1)\n1 350 €\n32 m²" }))
      .listings[0];
    expect(noWord.priceIsCC).toBeNull();
    const invented = run([item({ url: "/a/2", price: 980, price_kind: "HC", charges: 75, surface: 24.5 })]).listings[0];
    expect(invented.charges).toBeNull(); // 75 n'est pas écrit
    const none = run([item({ price: null, price_kind: "CC" })]).listings[0];
    expect(none).toMatchObject({ price: null, priceIsCC: null });
  });

  it("lien non écrit dans le texte ignoré : identifiant par hachage titre + prix + surface, stable d'un appel à l'autre ; sans lien ni titre, annonce refusée", () => {
    const a = run([item({ url: "/inventee" })]).listings[0];
    const b = run([item({ url: "https://evil.example/x" })]).listings[0];
    expect(a.id).toMatch(/^h:[0-9a-f]{8}$/);
    expect(b.id).toBe(a.id);
    expect(a.url).toBe("https://agence.fr/location");
    expect(run([item({ url: null, title: null })]).listings).toHaveLength(0);
    expect(run([item({ url: null, title: "Autre titre" })]).listings[0].id).not.toBe(a.id);
  });

  it("doublons fusionnés, plafond respecté", () => {
    expect(run([item(), item()]).listings).toHaveLength(1);
    const many = Array.from({ length: 6 }, (_, i) => item({ url: null, title: `T${i}` }));
    expect(validateExtraction({ listings: many }, ctx({ max: 3 }))!.listings).toHaveLength(3);
  });

  it("normalizeUrl / stableId : relatif résolu, ancre et suivi retirés, paramètres triés, « / » final retiré ; appearsIn lit « 1 350 » comme 1350", () => {
    expect(normalizeUrl("/a/1/?utm_source=x&b=2&a=1#haut", "https://Agence.fr/x")).toBe(
      "https://agence.fr/a/1/?a=1&b=2".replace("/?", "?"),
    );
    expect(normalizeUrl("/a/1?cid=9", "https://agence.fr/", false)).toBe("https://agence.fr/a/1");
    expect(normalizeUrl("javascript:alert(1)", "https://agence.fr/")).toBeNull();
    expect(stableId("https://x/y", "t", 1, 1)).toBe("https://x/y");
    expect(stableId(null, null, 1, 1)).toBeNull();
    expect(appearsIn("loyer 1350 euros 42,06 m²", 1350)).toBe(true);
    expect(appearsIn("loyer 11350 euros", 1350)).toBe(false);
    expect(appearsIn("loyer 42,06 m²", 42.06)).toBe(true);
  });
});

describe("lecture universelle (David Immo, modèle simulé)", () => {
  it("page -> toMarkdown -> réduction -> modèle -> annonces au format Listing ; neurons inscrits d'après usage ; la conversion HTML ne coûte rien", async () => {
    const ai = fakeAi(ANSWER);
    mockPage(david);
    const r = await readUniversal(withAi(E(), ai), SRC);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.listings.map((l) => l.id)).toEqual([
      "https://www.davidimmo.com/location-appartement-3-pieces-levallois-perret-92300-17461.html",
      "https://www.davidimmo.com/location-appartement-2-pieces-paris-75018-17257.html",
      "https://www.davidimmo.com/location-appartement-1-piece-paris-75018-15287.html",
    ]);
    expect(r.listings[0]).toMatchObject({
      source: "david_immo",
      price: 2550,
      priceIsCC: true,
      surface: 55,
      rooms: 3,
      postalCode: "92300",
      agency: "David Immo",
      phone: "01 47 63 08 08",
    });
    expect(r.listings[2].surface).toBe(30.66);
    // Un seul téléchargement, une seule conversion, un seul appel modèle ; le texte envoyé est réduit (consigne comprise < 8 000 caractères).
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(ai.toMarkdown).toHaveBeenCalledTimes(1);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify((ai.run.mock.calls[0] as unknown[])[1]);
    expect(sent.length).toBeLessThan(8_000);
    // 2 400 jetons en entrée + 700 en sortie au tarif de Gemma 4 : ~41 neurons, sous l'estimation de 65.
    const row = await env.DB.prepare("SELECT feature, neurons, calls FROM ai_usage").first<{
      feature: string;
      neurons: number;
      calls: number;
    }>();
    expect(row!.feature).toBe("universal");
    expect(row!.calls).toBe(1);
    expect(row!.neurons).toBeCloseTo((2400 * 9091 + 700 * 27273) / 1e6, 1);
    expect(row!.neurons).toBeLessThan(UNIVERSAL_ESTIMATE_NEURONS);
  });

  it("le filtre habituel s'applique aux annonces lues (indices, pas de contournement) : seule l'annonce du 18e est écartée en « localisation »", async () => {
    mockPage(david);
    const r = await readUniversal(withAi(E(), fakeAi(ANSWER)), SRC);
    if (r.status !== "ok") throw new Error("lecture en échec");
    expect(r.listings.map((l) => evaluate(l, SRC).reason)).toEqual(["prix_haut", "localisation", "localisation"]);
  });

  it("zéro annonce valide : échec de la source (sauf état vide explicite)", async () => {
    mockPage(david);
    const bad = fakeAi({ listings: [{ title: "inventée", price: 1000, surface: 40, bogus: 1 }], empty: false });
    expect(await readUniversal(withAi(E(), bad), SRC)).toEqual({ status: "fail", reason: "aucune annonce valide" });
    const prose = {
      run: vi.fn(async () => ({ response: "Voici les annonces : aucune." })),
      toMarkdown: fakeAi({}).toMarkdown,
    };
    expect(await readUniversal(withAi(E(), prose as unknown as FakeAi), SRC)).toEqual({
      status: "fail",
      reason: "réponse du modèle refusée",
    });
    // « empty: true » sans que la page le dise : toujours un échec.
    expect(await readUniversal(withAi(E(), fakeAi({ listings: [], empty: true })), SRC)).toMatchObject({
      status: "fail",
    });
  });

  it("état vide explicite (« Aucun bien ne correspond ») : zéro annonce sans erreur, sans appel modèle quand rien ne ressemble à une annonce", async () => {
    mockPage("<html><body><h1>Nos locations</h1><p>Aucun bien ne correspond à votre recherche.</p></body></html>");
    const ai = fakeAi({ listings: [], empty: true });
    expect(await readUniversal(withAi(E(), ai), SRC)).toEqual({ status: "ok", listings: [] });
    expect(ai.run).not.toHaveBeenCalled();
    // Page sans annonce et sans message d'état vide : gabarit changé, donc échec.
    mockPage("<html><body><h1>Maintenance</h1></body></html>");
    expect(await readUniversal(withAi(E(), ai), SRC)).toEqual({
      status: "fail",
      reason: "aucune annonce dans la page",
    });
  });

  it("interrupteur éteint, IA absente : lecture non tentée (skipped), aucune requête ; erreur de page : échec", async () => {
    const spy = mockPage(david);
    expect(await readUniversal(withAi(E({ UNIVERSAL_READER: "false" }), fakeAi(ANSWER)), SRC)).toMatchObject({
      status: "skipped",
    });
    expect(await readUniversal(withAi(E(), undefined), SRC)).toMatchObject({
      status: "skipped",
      reason: "IA indisponible",
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockImplementation(async () => new Response("", { status: 503 }));
    expect(await readUniversal(withAi(E(), fakeAi(ANSWER)), SRC)).toEqual({ status: "fail", reason: "HTTP 503" });
    const noConv = fakeAi(ANSWER);
    spy.mockImplementation(async () => new Response(david));
    expect(await readUniversal(withAi(E(), { run: noConv.run } as unknown as FakeAi), SRC)).toEqual({
      status: "fail",
      reason: "conversion Markdown indisponible",
    });
  });

  it("budget épuisé : lecture non tentée (skipped), sans requête ni appel modèle ; le plafond de la fonction `universal` est celui de cfg.ai.featureCaps", async () => {
    const spy = mockPage(david);
    const ai = fakeAi(ANSWER);
    await env.DB.prepare("INSERT INTO ai_usage (day, feature, neurons, calls) VALUES (date('now'), 'universal', ?, 40)")
      .bind(cfg.ai.featureCaps.universal - 10)
      .run();
    expect(await readUniversal(withAi(E(), ai), SRC)).toEqual({ status: "skipped", reason: "budget IA épuisé" });
    expect(spy).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
  });
});

describe("cadence et plafonds des sources universelles", () => {
  it("cadence imposée : toute source universelle du registre lit au plus toutes les 15 min ; une source plus rapide échoue proprement", async () => {
    for (const s of cfg.sources.all.filter((x) => x.parser === "universal"))
      expect(s.every ?? 0, s.id).toBeGreaterThanOrEqual(UNIVERSAL_MIN_EVERY);
    mockPage(david);
    expect(await readUniversal(withAi(E(), fakeAi(ANSWER)), { ...SRC, every: 10 })).toMatchObject({ status: "fail" });
    expect(await readUniversal(withAi(E(), fakeAi(ANSWER)), { ...SRC, every: undefined })).toMatchObject({
      status: "fail",
    });
    expect(UNIVERSAL_MIN_EVERY).toBe(15);
    // every: 15 est accepté (la page est lue) ; un passage par tranche de 15 minutes (schedule.isDue) : 4 sur 12 par heure.
    expect(await readUniversal(withAi(E(), fakeAi(ANSWER)), { ...SRC, every: 15 })).toMatchObject({ status: "ok" });
    const slots = Array.from({ length: 12 }, (_, i) => isDue({ every: 15 }, at(10, i * 5))).filter(Boolean);
    expect(slots).toHaveLength(4);
    expect(Array.from({ length: 12 }, (_, i) => isDue(SRC, at(10, i * 5))).filter(Boolean)).toHaveLength(2); // la source d'exemple (every: 30) : 2 par heure
  });

  it("plafond de sources universelles actives : UNIVERSAL_MAX_ACTIVE (15) au plus lues, les suivantes du registre ignorées ; au plus UNIVERSAL_BROWSER_MAX avec le rendu navigateur", () => {
    expect(UNIVERSAL_MAX_ACTIVE).toBe(15);
    const u = (id: string, o: Partial<SourceDef> = {}): SourceDef => ({ ...SRC, id, ...o });
    const many = Array.from({ length: 17 }, (_, i) => u(`s${i}`));
    expect([...readableIds(many)]).toEqual(many.slice(0, 15).map((x) => x.id));
    const browsers = [
      u("a", { render: "browser" }),
      u("b", { render: "browser" }),
      u("c", { render: "browser" }),
      u("d"),
    ];
    expect([...readableIds(browsers)]).toEqual(["a", "b", "d"]);
    expect(cfg.ai.featureCaps.universal).toBeGreaterThanOrEqual(4_000);
    expect(UNIVERSAL_BROWSER_MAX).toBe(2);
    expect(readableIds([u("x", { active: false }), u("y", { virtual: true })]).size).toBe(0);
  });

  it("registre : l'exemple (David Immo) est inactif, hors des groupes tant qu'il l'est, et jamais lu par le cron ; sources virtuelles hors des groupes et de /part", () => {
    expect(SRC.id).toBe("david_immo");
    expect(cfg.sources.universal[0].active).toBe(false);
    expect(cfg.sources.universal.some((s) => s.id === "david_immo")).toBe(true);
    expect(cfg.sources.dedicated.some((s) => s.parser === "universal")).toBe(false);
    expect(Array.from({ length: TOTAL_GROUPS }, (_, g) => groupParts(g)).flat(2)).not.toContain("david_immo");
    expect(parsePartRequest({ ids: ["david_immo"], now: new Date().toISOString() })).toBeNull();
    expect(new Set(cfg.sources.all.map((s) => s.id)).size).toBe(cfg.sources.all.length);
    expect(cfg.sources.cron.length).toBe(cfg.sources.dedicated.length + cfg.sources.universal.length);
  });
});

describe('rendu navigateur (render: "browser")', () => {
  const BR: SourceDef = { ...SRC, render: "browser" };
  const browser = (md: string | null) => ({
    quickAction: vi.fn(async () =>
      md === null ? new Response("", { status: 500 }) : Response.json({ success: true, result: md }),
    ),
  });

  it("binding BROWSER absent ou interrupteur éteint : échec propre « rendu navigateur indisponible », aucune requête", async () => {
    const spy = mockPage(david);
    expect(await readUniversal(withAi(E({ BROWSER_RENDER: "true" }), fakeAi(ANSWER)), BR)).toEqual({
      status: "fail",
      reason: "rendu navigateur indisponible",
    });
    expect(await readUniversal(withAi(E({ BROWSER: browser("x") }), fakeAi(ANSWER)), BR)).toEqual({
      status: "fail",
      reason: "rendu navigateur indisponible",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("binding présent et interrupteur allumé : UN rendu (quick action markdown), pas de téléchargement ni de conversion ; échec du rendu : échec de la source", async () => {
    const spy = mockPage(david);
    const ai = fakeAi(ANSWER);
    const b = browser(fakeMarkdown(david));
    const r = await readUniversal(withAi(E({ BROWSER_RENDER: "true", BROWSER: b }), ai), BR);
    expect(r.status).toBe("ok");
    expect(b.quickAction).toHaveBeenCalledTimes(1);
    expect((b.quickAction.mock.calls[0] as unknown[])[0]).toBe("markdown");
    expect(spy).not.toHaveBeenCalled();
    expect(ai.toMarkdown).not.toHaveBeenCalled();
    expect(
      await readUniversal(withAi(E({ BROWSER_RENDER: "true", BROWSER: browser(null) }), fakeAi(ANSWER)), BR),
    ).toEqual({ status: "fail", reason: "rendu navigateur en échec" });
  });
});

describe("dans le passage (runPart)", () => {
  const dbRow = (id: string) =>
    env.DB.prepare("SELECT consecutive_failures, broken, last_run, last_error FROM source_state WHERE source = ?")
      .bind(id)
      .first<{ consecutive_failures: number; broken: number; last_run: string | null; last_error: string | null }>();

  it("premier passage silencieux, puis une annonce nouvelle devient une alerte", async () => {
    mockPage(david);
    const e = withAi(E(), fakeAi(ANSWER));
    const r1 = await runPart(e, [SRC], at(10, 0));
    expect(r1.sources[0]).toMatchObject({ id: "david_immo", ok: true, count: 3 });
    expect(await getPendingAlerts(env.DB, 10)).toHaveLength(0);
    // Au passage suivant, une annonce de plus dans la cible (Levallois, 41 m², 1 349 € CC) : la page l'écrit, le modèle simulé la rend.
    const NEW = "/location-appartement-2-pieces-levallois-perret-92300-99999.html";
    mockPage(david.replaceAll("/location-appartement-1-piece-paris-75018-15287.html", NEW).replaceAll("30.66", "41"));
    const ai2 = fakeAi({
      listings: [
        ANSWER.listings[0],
        ANSWER.listings[1],
        { ...ANSWER.listings[2], url: NEW, surface: 41, rooms: 2, postal_code: "92300" },
      ],
      empty: false,
    });
    const r2 = await runPart(withAi(E(), ai2), [SRC], at(10, 30));
    expect(r2.sources[0]).toMatchObject({ ok: true, count: 3 });
    const pending = await getPendingAlerts(env.DB, 10);
    expect(pending.map((p) => p.listing.id)).toEqual([
      "https://www.davidimmo.com/location-appartement-2-pieces-levallois-perret-92300-99999.html",
    ]);
  });

  it("budget épuisé : la source n'échoue pas (pas de panne après 3 passages, pas de retard) et ne lit rien ; elle reprend le lendemain", async () => {
    const spy = mockPage(david);
    const ai = fakeAi(ANSWER);
    await env.DB.prepare("INSERT INTO ai_usage (day, feature, neurons, calls) VALUES (date('now'), 'universal', ?, 50)")
      .bind(cfg.ai.featureCaps.universal)
      .run();
    for (let i = 0; i < 5; i++) {
      const r = await runPart(withAi(E(), ai), [SRC], at(10, i * 30));
      expect(r.sources[0]).toMatchObject({ ok: true, skipped: "budget IA épuisé" });
      expect(r.events).toEqual([]);
    }
    expect(spy).not.toHaveBeenCalled();
    const row = await dbRow("david_immo");
    expect(row).toMatchObject({ consecutive_failures: 0, broken: 0 });
    expect(row!.last_run).toBe(at(10, 120).toISOString()); // passage fait : jamais « en retard »
    expect(staleMinutes(row!.last_run, at(10, 140), SRC.every)).toBeNull();
    // Budget revenu : lecture normale.
    await env.DB.prepare("DELETE FROM ai_usage").run();
    mockPage(david);
    expect((await runPart(withAi(E(), ai), [SRC], at(11, 0))).sources[0]).toMatchObject({ ok: true, count: 3 });
  });

  it("échecs de lecture (modèle qui répond n'importe quoi) : compte comme les autres sources, en panne au troisième passage", async () => {
    mockPage(david);
    const ai = fakeAi({ listings: [], empty: false });
    const events = [];
    for (let i = 0; i < 3; i++) events.push(...(await runPart(withAi(E(), ai), [SRC], at(10, i * 30))).events);
    expect(events).toEqual([{ type: "broken", sourceId: "david_immo", reason: "aucune annonce valide" }]);
    expect(await dbRow("david_immo")).toMatchObject({ consecutive_failures: 3, broken: 1 });
  });

  it("lecteur éteint : rien n'est lu ni écrit en échec", async () => {
    const spy = mockPage(david);
    const r = await runPart(withAi(E({ UNIVERSAL_READER: "false" }), fakeAi(ANSWER)), [SRC], at(10, 0));
    expect(r.sources[0]).toMatchObject({ ok: true, skipped: "lecteur universel éteint" });
    expect(spy).not.toHaveBeenCalled();
    expect((await dbRow("david_immo"))!.consecutive_failures).toBe(0);
  });
});

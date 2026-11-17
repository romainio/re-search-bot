import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerQuestion,
  fallback,
  filtersText,
  formatReply,
  historyMessages,
  loadHistory,
  parseTurn,
  runLoop,
  systemPrompt,
} from "../src/assistant/chat";
import { TOOL_NAMES, runTool, toolSchemas, validateArgs } from "../src/assistant/tools";
import type { Card } from "../src/assistant/tools";
import {
  ASSISTANT_ESTIMATE_CALL,
  ASSISTANT_HISTORY_TURNS,
  ASSISTANT_LIST_MAX,
  ASSISTANT_MAX_PER_HOUR,
  ASSISTANT_MAX_TOOL_TURNS,
  ASSISTANT_MODEL,
  ASSISTANT_PAUSED,
} from "../src/config/assistant";
import { SEMANTIC_DIMENSIONS, SEMANTIC_MODEL } from "../src/config/semantic";
import { neuronsFromUsage } from "../src/ai/budget";
import { settings } from "../src/derive";
import { handleFreeMessage } from "../src/telegram/assistant";
import { handleUpdate } from "../src/telegram/router";
import type { Env, VectorizeLike } from "../src/types";

const cfg = settings();

const db = () => env.DB;
const NOW = new Date("2026-11-09T10:00:00Z");
const iso = (daysAgo: number): string => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

interface Seed {
  id: string;
  rid?: number;
  postal?: string | null;
  rent?: number | null;
  surface?: number | null;
  rooms?: number | null;
  seen?: number;
  gone?: boolean;
  title?: string;
  url?: string;
  grid?: Record<string, string>;
  status?: string;
  cluster?: string;
  summary?: string;
}
async function seed(s: Seed): Promise<void> {
  const payload = {
    listing: {
      source: "wagram",
      id: s.id,
      url: s.url ?? `https://x/${s.id}`,
      title: s.title ?? `Appartement ${s.id}`,
      description: "Texte de l'annonce",
      floor: 3,
    },
    evaluation: { keep: true, rentCC: s.rent ?? null, flags: [] },
    ...(s.grid
      ? {
          photo: {
            grid: Object.fromEntries(Object.entries(s.grid).map(([k, v]) => [k, { answer: v, photo: null }])),
            summary: s.summary ?? null,
            images: 3,
          },
        }
      : {}),
  };
  await db()
    .prepare(
      `INSERT INTO listings (source, listing_id, url, postal_code, surface, rent_cc, cluster, first_seen, last_seen, gone_at, alert_status, payload, rooms)
     VALUES ('wagram', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      s.id,
      s.url ?? `https://x/${s.id}`,
      s.postal === undefined ? "75017" : s.postal,
      s.surface === undefined ? 40 : s.surface,
      s.rent === undefined ? 1300 : s.rent,
      s.cluster ?? `wagram:${s.id}`,
      iso(s.seen ?? 1),
      iso(s.seen ?? 1),
      s.gone ? iso(0.5) : null,
      s.status ?? "sent",
      JSON.stringify(payload),
      s.rooms === undefined ? 2 : s.rooms,
    )
    .run();
}
const ridOf = async (id: string): Promise<number> =>
  (await db().prepare("SELECT rowid AS r FROM listings WHERE listing_id = ?").bind(id).first<{ r: number }>())!.r;

beforeEach(async () => {
  await db().batch(
    [
      "listings",
      "ai_usage",
      "assistant_history",
      "feedback",
      "search_profile",
      "search_cache",
      "search_rate",
      "market_stats",
      "market_daily",
      "market_meta",
    ].map((t) => db().prepare(`DELETE FROM ${t}`)),
  );
});

/* ---- IA simulée : rejoue des sorties de modèle enregistrées, dans l'ordre ---- */
type Out = unknown | (() => unknown);
interface Script {
  run: ReturnType<typeof vi.fn>;
  inputs: { model: string; input: { messages: { role: string; content: string }[]; tools?: unknown[] } }[];
}
function scripted(outs: Out[]): Script {
  const inputs: Script["inputs"] = [];
  let i = 0;
  const run = vi.fn(async (model: string, input: unknown) => {
    inputs.push({ model, input: structuredClone(input) as Script["inputs"][number]["input"] }); // copie : la boucle réutilise le tableau de messages
    const o = outs[Math.min(i++, outs.length - 1)];
    const v = typeof o === "function" ? (o as () => unknown)() : o;
    return v;
  });
  return { run, inputs };
}
const call = (name: string, args: unknown, usage?: unknown) => ({
  tool_calls: [{ name, arguments: args }],
  ...(usage ? { usage } : {}),
});
const text = (t: string, usage?: unknown) => ({ choices: [{ message: { content: t } }], ...(usage ? { usage } : {}) });
const E = (s: Script, o: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  ADMIN_KEY: "k",
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  ASSISTANT_ENABLED: "true",
  AI: { run: s.run as unknown as (m: string, i: unknown) => Promise<unknown> },
  ...o,
});
const calls = (s: Script) => s.run.mock.calls.length;

describe("validation des arguments (jamais de SQL du modèle)", () => {
  it("accepte des arguments valides, nombres en texte compris, ignore les clés inconnues", () => {
    const v = validateArgs("chercher_annonces", {
      zone: "75017",
      loyer_max: "1450",
      surface_min: 30,
      photo_oui: ["baignoire"],
      inconnue: "x",
      __proto__: { a: 1 },
    });
    expect(v).toEqual({
      ok: true,
      args: { zone: "75017", loyer_max: 1450, surface_min: 30, photo_oui: ["baignoire"] },
    });
    expect(validateArgs("chercher_annonces", '{"zone":"92300","limite":3}')).toEqual({
      ok: true,
      args: { zone: "92300", limite: 3 },
    });
    expect(validateArgs("profil", undefined)).toEqual({ ok: true, args: {} });
  });
  it("refuse hors bornes, hors liste, types faux, JSON invalide, injection SQL", () => {
    const bad = (a: unknown) => expect(validateArgs("chercher_annonces", a).ok).toBe(false);
    bad({ loyer_max: 5 });
    bad({ loyer_max: 1e9 });
    bad({ loyer_max: -3 });
    bad({ loyer_max: "beaucoup" });
    bad({ pieces_min: 2.5 });
    bad({ limite: 500 });
    bad({ zone: "75017'; DROP TABLE listings; --" });
    bad({ zone: "75008" });
    bad({ tri: "rent_cc; DELETE FROM feedback" });
    bad({ photo_oui: ["baignoire') OR 1=1 --"] });
    bad({ photo_oui: "baignoire" });
    bad({ photo_oui: ["parquet", "carrelage", "moquette", "douche", "baignoire"] });
    bad("{pas du json");
    bad([1, 2]);
    bad({ statut: "tout" });
    expect(validateArgs("recherche_semantique", {}).ok).toBe(false);
    expect(validateArgs("recherche_semantique", { requete: "x".repeat(101) }).ok).toBe(false);
    expect(validateArgs("annonce", { id: "1; DROP" }).ok).toBe(false);
    expect(validateArgs("annonce", { id: 12 })).toEqual({ ok: true, args: { id: 12 } });
  });
  it("les schémas envoyés au modèle couvrent les cinq outils", () => {
    expect([...TOOL_NAMES].sort()).toEqual([
      "annonce",
      "chercher_annonces",
      "marche",
      "profil",
      "recherche_semantique",
    ]);
    const s = toolSchemas() as { function: { name: string; parameters: { required: string[] } } }[];
    expect(s.map((x) => x.function.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(s.find((x) => x.function.name === "annonce")!.function.parameters.required).toEqual(["id"]);
    expect(Object.keys(cfg.assistantTools.chercher_annonces.fields)).toContain("photo_oui");
  });
});

describe("outil chercher_annonces", () => {
  beforeEach(async () => {
    await seed({
      id: "a",
      rent: 1300,
      surface: 40,
      rooms: 2,
      seen: 1,
      grid: { baignoire: "oui", parquet: "non" },
      summary: "Deux pièces lumineux.",
    });
    await seed({ id: "b", rent: 1500, surface: 55, rooms: 3, seen: 10, grid: { baignoire: "non" } });
    await seed({ id: "c", rent: 1200, surface: 33, rooms: 2, seen: 2, postal: "92300", grid: { baignoire: "oui" } });
    await seed({ id: "d", rent: 1100, surface: 30, rooms: 1, seen: 3, gone: true });
    await seed({ id: "e", rent: null, surface: null, rooms: null, seen: 4 });
    await seed({ id: "f", status: "filtered" });
  });
  const ids = async (a: Record<string, unknown>): Promise<string[]> => {
    const v = validateArgs("chercher_annonces", a);
    if (!v.ok) throw new Error(v.error);
    const r = await runTool(E(scripted([])), "chercher_annonces", v.args, NOW);
    return (r.data as { annonces: { titre: string }[] }).annonces.map((x) => x.titre.replace("Appartement ", ""));
  };
  it("par défaut : en ligne, statut suivi seulement (pas « filtered »), plus récentes d'abord", async () => {
    expect(await ids({})).toEqual(["a", "c", "e", "b"]);
  });
  it("zone, loyer max, surface min (valeurs inconnues gardées comme au tableau de bord)", async () => {
    expect(await ids({ zone: "92300" })).toEqual(["c"]);
    expect((await ids({ loyer_max: 1250 })).sort()).toEqual(["c", "e"]);
    expect((await ids({ surface_min: 35 })).sort()).toEqual(["a", "b", "e"]);
  });
  it("pièces, période, statut, tri, limite", async () => {
    expect((await ids({ pieces_min: 3 })).sort()).toEqual(["b", "e"]);
    expect((await ids({ pieces_max: 1, statut: "toutes" })).sort()).toEqual(["d", "e"]);
    expect(await ids({ depuis_jours: 5 })).toEqual(["a", "c", "e"]);
    expect(await ids({ statut: "disparue" })).toEqual(["d"]);
    expect(await ids({ statut: "toutes" })).toHaveLength(5);
    expect(await ids({ tri: "prix" })).toEqual(["c", "a", "b", "e"]);
    expect(await ids({ limite: 2 })).toHaveLength(2);
  });
  it("critères photo « oui » lus dans payload.photo.grid", async () => {
    expect(await ids({ photo_oui: ["baignoire"] })).toEqual(["a", "c"]);
    expect(await ids({ photo_oui: ["baignoire"], zone: "75017", loyer_max: 1450 })).toEqual(["a"]);
    expect(await ids({ photo_oui: ["parquet"] })).toEqual([]);
  });
  it("suivi : annonces marquées « visite », « aime », « deteste »", async () => {
    const mark = (id: string, type: string, value: string) =>
      db()
        .prepare("INSERT INTO feedback (source, listing_id, type, value, at) VALUES ('wagram', ?, ?, ?, ?)")
        .bind(id, type, value, iso(0))
        .run();
    await mark("b", "visite", "oui");
    await mark("a", "avis", "aime");
    await mark("c", "avis", "deteste");
    expect(await ids({ suivi: "visite" })).toEqual(["b"]);
    expect(await ids({ suivi: "aime" })).toEqual(["a"]);
    expect(await ids({ suivi: "deteste" })).toEqual(["c"]);
  });
  it("résultat petit : champs utiles, sans URL ni payload ; cartes avec lien de la base", async () => {
    const v = validateArgs("chercher_annonces", { photo_oui: ["baignoire"], zone: "75017" });
    const r = await runTool(E(scripted([])), "chercher_annonces", (v as unknown as { args: never }).args, NOW);
    expect(r.data).toEqual({
      nombre: 1,
      annonces: [
        {
          id: await ridOf("a"),
          titre: "Appartement a",
          loyer: 1300,
          surface: 40,
          pieces: 2,
          zone: "Paris 17",
          depuis: iso(1).slice(0, 10),
          en_ligne: true,
          photos_oui: ["baignoire"],
        },
      ],
    });
    expect(JSON.stringify(r.data)).not.toContain("https://");
    expect(r.cards![0]!.url).toBe("https://x/a");
  });
});

describe("outils recherche_semantique, marche, profil, annonce", () => {
  it("recherche_semantique : éteinte -> erreur claire pour le modèle ; allumée -> annonces de la base, rate limit du tableau de bord non consommée", async () => {
    await seed({ id: "a", title: "Près de Brochant" });
    await seed({ id: "b", title: "Autre" });
    const off = await runTool(E(scripted([])), "recherche_semantique", { requete: "près de Brochant" }, NOW);
    expect(JSON.stringify(off.data)).toContain("non activée");
    const vec = new Array<number>(SEMANTIC_DIMENSIONS).fill(0.01);
    const index: VectorizeLike = {
      async upsert() {
        return {};
      },
      async deleteByIds() {
        return {};
      },
      async query() {
        return {
          matches: [
            { id: "1", score: 0.9, metadata: { source: "wagram", lid: "b" } },
            { id: "2", score: 0.8, metadata: { source: "wagram", lid: "a" } },
            { id: "3", score: 0.1, metadata: { source: "wagram", lid: "z" } },
          ],
        };
      },
    };
    const ai = scripted([
      { shape: [1, SEMANTIC_DIMENSIONS], data: [vec], usage: { prompt_tokens: 10, total_tokens: 10 } },
    ]);
    const e = E(ai, { SEMANTIC_SEARCH: "true", VECTORIZE: index });
    const on = await runTool(e, "recherche_semantique", { requete: "près de Brochant", limite: 5 }, NOW);
    expect(ai.inputs[0]!.model).toBe(SEMANTIC_MODEL);
    expect((on.data as { annonces: { titre: string }[] }).annonces.map((x) => x.titre)).toEqual([
      "Autre",
      "Près de Brochant",
    ]);
    expect(on.cards!.map((c) => c.url)).toEqual(["https://x/b", "https://x/a"]);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM search_rate").first<{ n: number }>())!.n).toBe(0);
  });
  it("marche : médianes fiables seulement, durée de vie en clair", async () => {
    await db().batch([
      db().prepare("INSERT INTO market_meta (id, computed_at) VALUES (1, ?)").bind(iso(0)),
      db().prepare(
        "INSERT INTO market_stats (zone, bucket, life_n, life_median_h, m2_n, m2_median) VALUES ('92300', '2', 20, 50, 15, 31.04)",
      ),
      db().prepare(
        "INSERT INTO market_stats (zone, bucket, life_n, life_median_h, m2_n, m2_median) VALUES ('92300', '3', 2, 10, 2, 28)",
      ),
      db().prepare(
        "INSERT INTO market_stats (zone, bucket, life_n, life_median_h, m2_n, m2_median) VALUES ('75017', '2', 20, NULL, 20, 35)",
      ),
    ]);
    const r = await runTool(E(scripted([])), "marche", { zone: "92300" }, NOW);
    expect(r.cards).toBeNull();
    expect((r.data as { cellules: unknown[] }).cellules).toEqual([
      {
        zone: "Levallois",
        pieces: "2",
        duree_vie_mediane: "2,1 j",
        annonces_duree: 20,
        loyer_m2_median: 31,
        annonces_prix: 15,
      },
    ]);
    const all = await runTool(E(scripted([])), "marche", { pieces: 2 }, NOW);
    expect(
      (all.data as { cellules: { duree_vie_mediane: string }[] }).cellules.map((c) => c.duree_vie_mediane),
    ).toEqual(["plus de 10 jours", "2,1 j"]);
  });
  it("marche sans calcul : erreur claire ; profil absent puis présent", async () => {
    expect(JSON.stringify((await runTool(E(scripted([])), "marche", {}, NOW)).data)).toContain("pas encore calculés");
    expect((await runTool(E(scripted([])), "profil", {}, NOW)).data).toMatchObject({ profil: null });
    const profile = {
      criteria: { baignoire: "indispensable" },
      transitMaxMin: 5,
      floorMin: 3,
      budgetMax: 1500,
      surfaceMin: 35,
      keywords: ["calme"],
    };
    await db()
      .prepare("INSERT INTO search_profile (id, updated_at, source_text, profile) VALUES (1, ?, 'x', ?)")
      .bind(iso(0), JSON.stringify(profile))
      .run();
    expect((await runTool(E(scripted([])), "profil", {}, NOW)).data).toMatchObject({
      station_max_min: 5,
      etage_min: 3,
      budget_max: 1500,
      mots: ["calme"],
    });
  });
  it("annonce : détail par identifiant court, retours de l'utilisateur, introuvable", async () => {
    await seed({ id: "a", grid: { baignoire: "oui" }, summary: "Joli deux pièces." });
    const rid = await ridOf("a");
    await db()
      .prepare("INSERT INTO feedback (source, listing_id, type, value, at) VALUES ('wagram', 'a', 'visite', 'oui', ?)")
      .bind(iso(0))
      .run();
    const r = await runTool(E(scripted([])), "annonce", { id: rid }, NOW);
    expect(r.data).toMatchObject({
      id: rid,
      description: "Joli deux pièces.",
      grille_photo: ["baignoire : oui"],
      retours_utilisateur: { visite: "oui" },
      etage: 3,
    });
    expect(r.cards).toHaveLength(1);
    expect(JSON.stringify((await runTool(E(scripted([])), "annonce", { id: 999_999 }, NOW)).data)).toContain(
      "introuvable",
    );
  });
  it("aucune écriture D1 par les outils", async () => {
    await seed({ id: "a" });
    const count = async () =>
      JSON.stringify(
        await db()
          .batch(
            ["listings", "feedback", "search_profile", "search_cache", "search_rate", "market_stats"].map((t) =>
              db().prepare(`SELECT COUNT(*) AS n FROM ${t}`),
            ),
          )
          .then((r) => r.map((x) => x.results)),
      );
    const before = await count();
    for (const [t, a] of [
      ["chercher_annonces", {}],
      ["marche", {}],
      ["profil", {}],
      ["annonce", { id: await ridOf("a") }],
    ] as const)
      await runTool(E(scripted([])), t, a, NOW);
    expect(await count()).toBe(before);
  });
});

describe("lecture des sorties du modèle", () => {
  it("accepte les deux formes d'appels (Workers AI et OpenAI) et le texte", () => {
    expect(parseTurn({ tool_calls: [{ name: "profil", arguments: {} }] })).toEqual({
      calls: [{ name: "profil", args: {} }],
      text: null,
    });
    expect(
      parseTurn({
        choices: [
          {
            message: { content: null, tool_calls: [{ id: "1", function: { name: "annonce", arguments: '{"id":3}' } }] },
          },
        ],
      })!.calls[0],
    ).toEqual({ name: "annonce", args: '{"id":3}' });
    expect(parseTurn({ response: "Bonjour" })).toEqual({ calls: [], text: "Bonjour" });
    expect(parseTurn(null)).toBeNull();
    expect(parseTurn({ tool_calls: "nimportequoi" })!.calls).toEqual([]);
  });
});

describe("boucle d'outils", () => {
  beforeEach(async () => {
    await seed({ id: "a", rent: 1300, grid: { baignoire: "oui" } });
    await seed({ id: "b", rent: 1700, grid: { baignoire: "oui" } });
  });
  it("un tour d'outil puis la réponse : liste tirée de la base, résultat rendu au modèle, historique écrit", async () => {
    const s = scripted([
      call(
        "chercher_annonces",
        { loyer_max: 1450, photo_oui: ["baignoire"], depuis_jours: 7 },
        { prompt_tokens: 1000, completion_tokens: 50 },
      ),
      text("Une annonce avec baignoire sous 1 450 €.", { prompt_tokens: 1200, completion_tokens: 40 }),
    ]);
    const html = await answerQuestion(E(s), "les annonces de la semaine avec baignoire sous 1 450 €", NOW);
    expect(calls(s)).toBe(2);
    expect(s.inputs[0]!.model).toBe(ASSISTANT_MODEL);
    expect(s.inputs[0]!.input.tools).toHaveLength(5);
    expect(s.inputs[1]!.input.messages.at(-1)!.content).toContain('"titre":"Appartement a"');
    expect(html).toContain("Une annonce avec baignoire sous 1 450 €.");
    expect(html).toContain('<a href="https://x/a">Appartement a</a> — 1 300 € · 40 m² · 2 p. · Paris 17');
    expect(html).not.toContain("Appartement b");
    const row = await db()
      .prepare("SELECT question, answer, context FROM assistant_history")
      .first<{ question: string; answer: string; context: string }>();
    expect(row!.answer).toBe("Une annonce avec baignoire sous 1 450 €.");
    expect(row!.context).toContain("chercher_annonces");
    // neurons inscrits d'après usage (pas l'estimation)
    const used = await db()
      .prepare("SELECT neurons, calls FROM ai_usage WHERE feature = 'assistant'")
      .first<{ neurons: number; calls: number }>();
    expect(used!.calls).toBe(2);
    expect(used!.neurons).toBeCloseTo(
      neuronsFromUsage(ASSISTANT_MODEL, { prompt_tokens: 1000, completion_tokens: 50 })! +
        neuronsFromUsage(ASSISTANT_MODEL, { prompt_tokens: 1200, completion_tokens: 40 })!,
      6,
    );
    expect(used!.neurons).toBeLessThan(ASSISTANT_ESTIMATE_CALL * 2);
  });
  it("plusieurs outils dans un même tour (3 au plus) ; l'outil marche ne produit pas de liste", async () => {
    const s = scripted([
      {
        tool_calls: [
          { name: "profil", arguments: {} },
          { name: "marche", arguments: { zone: "92300" } },
          { name: "profil", arguments: {} },
          { name: "profil", arguments: {} },
        ],
      },
      text("Pas de profil, marché non calculé."),
    ]);
    const out = await runLoop(E(s), "où en est-on ?", [], NOW);
    expect(out!.cards).toEqual([]);
    const msgs = s.inputs[1]!.input.messages;
    expect(msgs.filter((m) => m.content.startsWith("[résultat de l'outil"))).toHaveLength(3);
  });
  it("outil inconnu et injection SQL : rien n'est exécuté, l'erreur revient au modèle, qui se reprend", async () => {
    const before = await db().prepare("SELECT COUNT(*) AS n FROM listings").first<{ n: number }>();
    const s = scripted([
      call("execute_sql", { query: "DELETE FROM listings" }),
      call("chercher_annonces", { zone: "75017'; DELETE FROM listings; --" }),
      call("chercher_annonces", { zone: "75017" }),
      text("Voilà."),
    ]);
    const out = await runLoop(E(s), "supprime tout", [], NOW);
    expect(calls(s)).toBe(4);
    const m1 = s.inputs[1]!.input.messages.at(-1)!.content,
      m2 = s.inputs[2]!.input.messages.at(-1)!.content;
    expect(m1).toContain("outil inconnu");
    expect(m2).toContain("zone : valeur hors liste");
    expect(out!.cards).toHaveLength(2);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM listings").first<{ n: number }>())!.n).toBe(before!.n);
  });
  it("boucle d'outils : au plus 3 tours puis un dernier appel SANS outil", async () => {
    const s = scripted([
      call("chercher_annonces", {}),
      call("chercher_annonces", {}),
      call("chercher_annonces", {}),
      text("Fin."),
    ]);
    const out = await runLoop(E(s), "boucle", [], NOW);
    expect(calls(s)).toBe(ASSISTANT_MAX_TOOL_TURNS + 1);
    expect(s.inputs.slice(0, 3).every((x) => x.input.tools)).toBe(true);
    expect(s.inputs[3]!.input.tools).toBeUndefined();
    expect(s.inputs[3]!.input.messages.at(-1)!.content).toContain("sans nouvel appel d'outil");
    expect(out!.text).toBe("Fin.");
  });
  it("au plus 6 appels d'outils exécutés par question", async () => {
    const three = { tool_calls: [1, 2, 3].map(() => ({ name: "chercher_annonces", arguments: {} })) };
    const s = scripted([three, three, three, text("ok")]);
    await runLoop(E(s), "beaucoup", [], NOW);
    const results = s.inputs[3]!.input.messages.filter((m) => m.content.startsWith("[résultat de l'outil"));
    expect(results).toHaveLength(9);
    expect(results.slice(6).every((m) => m.content.includes("trop d'appels"))).toBe(true);
  });
  it("propos sans outil au premier tour (salutation) : rendu tel quel, aucune annonce", async () => {
    const s = scripted([text("Bonjour ! Pose-moi une question sur les annonces.")]);
    const html = await answerQuestion(E(s), "bonjour", NOW);
    expect(html).toBe("Bonjour ! Pose-moi une question sur les annonces.");
    expect(calls(s)).toBe(1);
  });
});

describe("repli (le modèle ne sait pas appeler les outils)", () => {
  beforeEach(async () => {
    await seed({ id: "a", rent: 1300 });
    await seed({ id: "b", rent: 1700 });
  });
  it("arguments toujours invalides : UN appel runJson de filtres puis formatage sans second appel modèle", async () => {
    const s = scripted([
      call("chercher_annonces", "{pas du json"),
      call("chercher_annonces", { loyer_max: -1 }),
      call("nimporte", {}),
      text('{"zone":"75017","loyer_max":1450}'),
    ]);
    const html = await answerQuestion(E(s), "sous 1 450 € dans le 17", NOW);
    expect(calls(s)).toBe(4); // 3 tours invalides + 1 appel de repli
    expect(s.inputs[3]!.input.tools).toBeUndefined();
    expect(html).toContain("Filtres : Paris 17 · ≤ 1 450 €");
    expect(html).toContain("Appartement a");
    expect(html).not.toContain("Appartement b");
  });
  it("le modèle lève une erreur au premier appel : repli aussi (si le second passe)", async () => {
    const s = scripted([text('{"loyer_max": 1400}')]);
    s.run.mockImplementationOnce(async () => {
      throw new Error("3040 capacité");
    });
    const out = await runLoop(E(s), "pas cher", [], NOW);
    expect(out!.context[0]!.tool).toBe("chercher_annonces");
    expect(out!.cards.map((c) => c.id)).toHaveLength(1);
  });
  it("filtres du repli hors schéma ou texte quelconque : null, message « pas pu répondre »", async () => {
    const s = scripted([{ response: "je ne sais pas" }]);
    expect(await fallback(E(s), "?", [], NOW)).toBeNull();
    const s2 = scripted([call("x", {}), call("x", {}), call("x", {}), text('{"loyer_max": 3}')]);
    expect(await answerQuestion(E(s2), "bizarre", NOW)).toContain("Je n'ai pas pu répondre");
  });
});

describe("budget, débit, historique", () => {
  it("budget du jour épuisé : « assistant en pause jusqu'à demain », aucun appel modèle ni historique", async () => {
    await db()
      .prepare("INSERT INTO ai_usage (day, feature, neurons, calls) VALUES ('2026-11-09', 'assistant', ?, 40)")
      .bind(cfg.ai.featureCaps.assistant! - 10)
      .run();
    const s = scripted([text("x")]);
    const html = await answerQuestion(E(s), "une question", NOW);
    expect(html).toContain("en pause jusqu'à demain");
    expect(html).toBe(ASSISTANT_PAUSED.replace(/&/g, "&amp;"));
    expect(calls(s)).toBe(0);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM assistant_history").first<{ n: number }>())!.n).toBe(0);
  });
  it("budget global épuisé aussi (autre fonction)", async () => {
    await db()
      .prepare(
        "INSERT INTO ai_usage (day, feature, neurons, calls) VALUES ('2026-11-09', 'photo', 7_900, 100)".replace(
          "7_900",
          "7900",
        ),
      )
      .run();
    const s = scripted([text("x")]);
    expect(await answerQuestion(E(s), "q", NOW)).toContain("en pause");
    expect(calls(s)).toBe(0);
  });
  it("limite de débit : ASSISTANT_MAX_PER_HOUR questions par heure", async () => {
    const stmts = Array.from({ length: ASSISTANT_MAX_PER_HOUR }, (_, i) =>
      db()
        .prepare("INSERT INTO assistant_history (at, question, answer) VALUES (?, 'q', 'r')")
        .bind(new Date(NOW.getTime() - i * 60_000).toISOString()),
    );
    await db().batch(stmts);
    const s = scripted([text("x")]);
    expect(await answerQuestion(E(s), "encore une", NOW)).toContain("Trop de questions");
    expect(calls(s)).toBe(0);
    // une heure plus tard, la limite est levée
    const later = new Date(NOW.getTime() + 3_700_000);
    expect(await answerQuestion(E(s), "encore une", later)).toBe("x");
  });
  it("historique : 3 derniers échanges rejoués (questions de suivi), filtres de l'échange précédent inclus", async () => {
    await seed({ id: "a" });
    const s = scripted([call("chercher_annonces", { zone: "75017", loyer_max: 1450 }), text("Une annonce.")]);
    await answerQuestion(E(s), "annonces à Paris 17 sous 1 450 €", NOW);
    for (let i = 0; i < 4; i++) {
      await db()
        .prepare("INSERT INTO assistant_history (at, question, answer, context) VALUES (?, ?, 'réponse', NULL)")
        .bind(new Date(NOW.getTime() + (i + 1) * 60_000).toISOString(), `question ${i}`)
        .run();
    }
    const h = await loadHistory(db(), new Date(NOW.getTime() + 600_000));
    expect(h.map((x) => x.question)).toEqual(["question 1", "question 2", "question 3"]);
    expect(h).toHaveLength(ASSISTANT_HISTORY_TURNS);
    // suivi : l'échange précédent (avec ses filtres) est dans les messages du modèle
    const s2 = scripted([text("Voilà.")]);
    await db().prepare("DELETE FROM assistant_history").run();
    await db()
      .prepare(
        "INSERT INTO assistant_history (at, question, answer, context) VALUES (?, 'annonces à Paris 17', 'Une annonce.', ?)",
      )
      .bind(iso(0), 'chercher_annonces {"zone":"75017"}')
      .run();
    await answerQuestion(E(s2), "et à Levallois ?", NOW);
    const msgs = s2.inputs[0]!.input.messages;
    expect(msgs[1]).toEqual({ role: "user", content: "annonces à Paris 17" });
    expect(msgs[2]!.content).toContain("Une annonce.");
    expect(msgs[2]!.content).toContain('"zone":"75017"');
    expect(msgs.at(-1)).toEqual({ role: "user", content: "et à Levallois ?" });
    expect(historyMessages([{ question: "q", answer: "r", context: null }])).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "r" },
    ]);
  });
  it("purge : ce qui a plus de 24 h disparaît à la question suivante et n'est jamais rejoué", async () => {
    await db().batch([
      db().prepare("INSERT INTO assistant_history (at, question, answer) VALUES (?, 'ancienne', 'r')").bind(iso(1.5)),
      db().prepare("INSERT INTO assistant_history (at, question, answer) VALUES (?, 'récente', 'r')").bind(iso(0.5)),
    ]);
    expect((await loadHistory(db(), NOW)).map((x) => x.question)).toEqual(["récente"]);
    await answerQuestion(E(scripted([text("ok")])), "nouvelle", NOW);
    const qs = (
      await db().prepare("SELECT question FROM assistant_history ORDER BY id").all<{ question: string }>()
    ).results.map((r) => r.question);
    expect(qs).toEqual(["récente", "nouvelle"]);
  });
  it("aucune écriture hors historique et ai_usage", async () => {
    await seed({ id: "a" });
    const snap = async () =>
      JSON.stringify(
        await db()
          .batch(
            [
              "listings",
              "feedback",
              "search_profile",
              "search_cache",
              "search_rate",
              "market_stats",
              "source_state",
            ].map((t) => db().prepare(`SELECT * FROM ${t}`)),
          )
          .then((r) => r.map((x) => x.results)),
      );
    const before = await snap();
    await answerQuestion(
      E(scripted([call("chercher_annonces", {}), call("marche", {}), call("profil", {}), text("ok")])),
      "tout",
      NOW,
    );
    expect(await snap()).toBe(before);
  });
  it("question trop longue refusée sans appel", async () => {
    const s = scripted([text("x")]);
    expect(await answerQuestion(E(s), "a".repeat(500), NOW)).toContain("trop longue");
    expect(calls(s)).toBe(0);
  });
});

describe("formatage Telegram (HTML échappé, 4 096 caractères)", () => {
  const card = (i: number, o: Partial<Card> = {}): Card => ({
    id: i,
    url: `https://x/${i}`,
    title: `Titre ${i}`,
    rent: 1000 + i,
    surface: 40,
    rooms: 2,
    zone: "Paris 17",
    since: "2026-11-01",
    online: true,
    ...o,
  });
  it("échappe le texte du modèle et les titres, refuse les URL d'un autre schéma, neutralise les guillemets", () => {
    const html = formatReply("<b>Attention</b> & <script>alert(1)</script>", [
      card(1, { title: '<img src=x onerror=alert(1)> "q"' }),
      card(2, { url: "javascript:alert(1)" }),
      card(3, { url: 'https://x/a"onmouseover="y' }),
    ]);
    expect(html).toContain("&lt;b&gt;Attention&lt;/b&gt; &amp; &lt;script&gt;");
    expect(html).not.toMatch(/<(?!\/?a[ >])[a-z]/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('"onmouseover');
    expect(html).toContain("Titre 2 —");
  });
  it("cinq annonces au plus et longueur ≤ 4 096 même avec un texte énorme", () => {
    const html = formatReply(
      "é".repeat(10_000),
      Array.from({ length: 12 }, (_, i) => card(i + 1)),
    );
    expect(html.length).toBeLessThanOrEqual(4096);
    expect((html.match(/<a href/g) ?? []).length).toBe(ASSISTANT_LIST_MAX);
    const tiny = formatReply(
      "ok",
      Array.from({ length: 5 }, (_, i) => card(i + 1, { title: "T".repeat(5000) })),
    );
    expect(tiny.length).toBeLessThanOrEqual(4096);
    expect((tiny.match(/<a /g) ?? []).length).toBe((tiny.match(/<\/a>/g) ?? []).length);
  });
  it("annonce disparue signalée ; liste vide avec texte", () => {
    expect(formatReply("x", [card(1, { online: false })])).toContain("disparue");
    expect(formatReply("Rien trouvé.", [])).toBe("Rien trouvé.");
    expect(filtersText({ zone: "92300", loyer_max: 1450, photo_oui: ["baignoire"] })).toBe(
      "Levallois · ≤ 1 450 € · photos : baignoire",
    );
  });
  it("consigne : date du jour, données non fiables", () => {
    const p = systemPrompt(NOW);
    expect(p).toContain("9 novembre 2026");
    expect(p).toContain("DONNÉES");
  });
});

describe("interrupteur et crochet Telegram", () => {
  const msg = (t: string) => ({ chatId: "42", text: t, messageId: 1, date: 1 });
  it("éteint (ou sans IA) : false, aucun appel -> le routeur répond l'aide", async () => {
    const s = scripted([text("x")]);
    const reply = vi.fn(async (_h: string) => undefined);
    expect(await handleFreeMessage(E(s, { ASSISTANT_ENABLED: "false" }), msg("bonjour"), reply)).toBe(false);
    expect(await handleFreeMessage(E(s, { ASSISTANT_ENABLED: undefined }), msg("bonjour"), reply)).toBe(false);
    expect(await handleFreeMessage({ ...E(s), AI: undefined }, msg("bonjour"), reply)).toBe(false);
    expect(await handleFreeMessage(E(s), msg("/inconnue"), reply)).toBe(false);
    expect(calls(s)).toBe(0);
    expect(reply).not.toHaveBeenCalled();
  });
  it("allumé : répond, true ; erreur interne : message d'excuse, jamais d'exception", async () => {
    const reply = vi.fn(async (_h: string) => undefined);
    expect(await handleFreeMessage(E(scripted([text("Salut")])), msg("salut"), reply)).toBe(true);
    expect(reply).toHaveBeenCalledWith("Salut");
    const broken = {
      ...E(scripted([text("x")])),
      DB: {
        prepare() {
          throw new Error("D1 en panne");
        },
        batch() {
          throw new Error("D1 en panne");
        },
      } as unknown as D1Database,
    };
    const r2 = vi.fn(async (_h: string) => undefined);
    expect(await handleFreeMessage(broken, msg("salut"), r2)).toBe(true);
    expect(r2.mock.calls[0]![0]).toContain("pas pu traiter");
  });
  it("routeur : éteint -> l'aide, allumé -> l'assistant (message envoyé à Telegram)", async () => {
    const sent: string[] = [];
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      sent.push(JSON.parse(String((init as RequestInit).body)).text);
      return new Response("{}");
    });
    const update = {
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 42 },
        text: "combien de temps restent les 2 pièces à Levallois ?",
      },
    };
    await handleUpdate(E(scripted([text("x")]), { ASSISTANT_ENABLED: "false" }), update);
    expect(sent[0]).toContain("<b>RE-SEARCH</b>");
    await handleUpdate(E(scripted([text("Réponse de l'assistant")])), update);
    expect(sent[1]).toBe("Réponse de l'assistant");
    f.mockRestore();
  });
});

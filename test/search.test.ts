import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEmbeddings, runEmbed } from "../src/ai/embed";
import {
  EMBED_BATCH,
  SEMANTIC_DIMENSIONS,
  SEMANTIC_MAX_PER_HOUR,
  SEMANTIC_MAX_VECTORS,
  SEMANTIC_MODEL,
  SEMANTIC_TOPK,
} from "../src/config/semantic";
import { renderDashboard } from "../src/dashboard/render";
import { settings } from "../src/derive";
import worker from "../src/index";
import {
  MARK_BACK_SQL,
  MARK_GONE_SQL,
  REDO_SQL,
  TODO_SQL,
  runEmbedStep,
  semanticOn,
  vectorId,
} from "../src/search/embed";
import { normalizeQuery, semanticSearch } from "../src/search/search";
import { hmacHex } from "../src/crypto";
import { embedText } from "../src/search/text";
import type { Env, Listing, VectorizeLike } from "../src/types";

const cfg = settings();

const db = () => env.DB;
const NOW = new Date("2026-11-09T10:00:00Z");

/** Embedding de test : sac de mots haché sur 1 024 dimensions, normalisé (deux textes proches partagent des mots). */
function fakeVector(text: string): number[] {
  const v = new Array<number>(SEMANTIC_DIMENSIONS).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let h = 7;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) % SEMANTIC_DIMENSIONS;
    v[h] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

interface FakeAi {
  run: ReturnType<typeof vi.fn>;
  texts: string[][];
}
function fakeAi(opts: { usage?: boolean; fail?: boolean; badDims?: boolean } = {}): FakeAi {
  const texts: string[][] = [];
  const run = vi.fn(async (model: string, input: unknown) => {
    expect(model).toBe(SEMANTIC_MODEL);
    const t = (input as { text: string[] }).text;
    texts.push(t);
    if (opts.fail) throw new Error("capacité");
    return {
      shape: [t.length, SEMANTIC_DIMENSIONS],
      data: t.map((x) => (opts.badDims ? [1, 2, 3] : fakeVector(x))),
      ...(opts.usage === false ? {} : { usage: { prompt_tokens: 100 * t.length, total_tokens: 100 * t.length } }),
    };
  });
  return { run, texts };
}

/** Index Vectorize en mémoire : upsert, requête par cosinus, filtre d'égalité sur les métadonnées. */
function fakeVectorize() {
  const store = new Map<string, { values: number[]; metadata: Record<string, string | number | boolean> }>();
  const calls = { upsert: 0, query: 0 };
  const lastFilter: { value: Record<string, unknown> | undefined } = { value: undefined };
  const index: VectorizeLike = {
    async upsert(vs) {
      calls.upsert++;
      for (const v of vs) store.set(v.id, { values: v.values, metadata: v.metadata ?? {} });
      return { count: vs.length };
    },
    async query(vec, o) {
      calls.query++;
      lastFilter.value = o.filter;
      const ms = [...store.entries()]
        .filter(([, v]) => Object.entries(o.filter ?? {}).every(([k, x]) => v.metadata[k] === x))
        .map(([id, v]) => ({
          id,
          score: v.values.reduce((s, x, i) => s + x * vec[i], 0),
          metadata: v.metadata as Record<string, unknown>,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, o.topK);
      return { matches: ms };
    },
    async deleteByIds(ids) {
      for (const i of ids) store.delete(i);
      return {};
    },
  };
  return { index, store, calls, lastFilter };
}

function mkEnv(over: Partial<Env> = {}): { e: Env; ai: FakeAi; vz: ReturnType<typeof fakeVectorize> } {
  const ai = fakeAi();
  const vz = fakeVectorize();
  const e = {
    ...(env as unknown as Env),
    SEMANTIC_SEARCH: "true",
    AI: { run: ai.run },
    VECTORIZE: vz.index,
    ADMIN_KEY: "secret-key",
    ...over,
  } as Env;
  return { e, ai, vz };
}

const listing = (id: string, o: Partial<Listing> = {}): Listing => ({
  source: "bienici",
  id,
  url: `https://x/${id}`,
  price: 1300,
  charges: null,
  priceIsCC: true,
  surface: 40,
  rooms: 2,
  title: `Annonce ${id}`,
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
interface InsOpts {
  status?: string;
  cluster?: string;
  gone?: string | null;
  first?: string;
  source?: string;
  rent?: number;
  payload?: string;
}
async function ins(id: string, l: Partial<Listing> = {}, o: InsOpts = {}): Promise<void> {
  const source = o.source ?? "bienici";
  const lst = listing(id, { source, ...l });
  const payload =
    o.payload ?? JSON.stringify({ listing: lst, evaluation: { keep: true, rentCC: o.rent ?? lst.price, flags: [] } });
  await db()
    .prepare(
      `INSERT INTO listings (source, listing_id, url, postal_code, surface, rent_cc, cluster, first_seen, last_seen, gone_at, alert_status, alert_kind, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      source,
      id,
      lst.url,
      lst.postalCode,
      lst.surface,
      o.rent ?? lst.price,
      o.cluster ?? `${source}:${id}`,
      o.first ?? "2026-11-09T08:00:00Z",
      "2026-11-09T09:00:00Z",
      o.gone ?? null,
      o.status ?? "sent",
      payload,
    )
    .run();
}
const embeddedIds = async (): Promise<string[]> =>
  (
    await db()
      .prepare("SELECT listing_id FROM listings WHERE embedded_at IS NOT NULL ORDER BY listing_id")
      .all<{ listing_id: string }>()
  ).results.map((r) => r.listing_id);

beforeEach(async () => {
  await db().batch(
    ["listings", "ai_usage", "search_cache", "search_rate", "embed_state"].map((t) => db().prepare(`DELETE FROM ${t}`)),
  );
});

describe("texte embarqué", () => {
  it("titre, dimensions, loyer, adresse, zone, station, description, grille photo", () => {
    const t = embedText(
      {
        listing: listing("a", {
          title: "Beau 2 pièces",
          rooms: 2,
          surface: 41,
          address: "12 rue Brochant",
          district: "Batignolles",
          description: "Parquet et  belle   lumière",
          floor: 3,
        }),
        evaluation: { keep: true, rentCC: 1400, flags: ["quartier"] },
        geo: {
          station: { name: "Brochant", lines: ["13"], meters: 300, minutes: 4, from: "geocode" },
          claim: null,
          rent: null,
          dpe: null,
          geocoded: true,
        },
        photo: { grid: { baignoire: { answer: "oui" }, douche: { answer: "non" } }, summary: null },
      },
      cfg.sources.dedicated.find((s) => s.id === "bienici"),
    );
    expect(t).toContain("Beau 2 pièces");
    expect(t).toContain("2 pièces, 41 m², étage 3");
    expect(t).toContain("Loyer 1400 € charges comprises");
    expect(t).toContain("12 rue Brochant, Batignolles, 75017, Paris 17");
    expect(t).toContain("Station Brochant (13), à 4 min à pied");
    expect(t).toContain("Parquet et belle lumière");
    expect(t).toContain("Photos : baignoire");
    expect(t).not.toContain("douche");
    expect(t).toContain("Batignolles");
  });
  it("mini description préférée à la description brute, texte borné", () => {
    const t = embedText({
      listing: listing("a", { description: "brute ".repeat(400) }),
      photo: { summary: "Mini description." },
    });
    expect(t).toContain("Mini description.");
    expect(t).not.toContain("brute");
    expect(embedText({ listing: listing("a", { description: "mot ".repeat(2000) }) }).length).toBeLessThanOrEqual(1500);
  });
});

describe("runEmbed (socle IA)", () => {
  it("un appel pour le lot, neurons inscrits d'après usage au tarif du modèle", async () => {
    const { e, ai } = mkEnv();
    const out = await runEmbed(e, ["un", "deux", "trois"], NOW);
    expect(out).toHaveLength(3);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const r = await db()
      .prepare("SELECT feature, neurons, calls FROM ai_usage")
      .first<{ feature: string; neurons: number; calls: number }>();
    expect(r?.feature).toBe("embed");
    expect(r!.neurons).toBeCloseTo((300 * 1075) / 1e6, 6);
    expect(r!.calls).toBe(1);
  });
  it("sans usage : estimation ; budget de la fonction épuisé : aucun appel ; binding absent ; dimension fausse : null", async () => {
    const noUsage = { ...mkEnv().e, AI: { run: fakeAi({ usage: false }).run } } as Env;
    await runEmbed(noUsage, ["a", "b"], NOW);
    expect((await db().prepare("SELECT neurons FROM ai_usage").first<{ neurons: number }>())!.neurons).toBeCloseTo(
      1,
      6,
    );
    await db()
      .prepare("UPDATE ai_usage SET neurons = ?")
      .bind(cfg.ai.featureCaps.embed - 0.1)
      .run();
    const { e, ai } = mkEnv();
    expect(await runEmbed(e, ["a"], NOW)).toBeNull();
    expect(ai.run).not.toHaveBeenCalled();
    expect(await runEmbed({ ...e, AI: undefined } as Env, ["a"], NOW)).toBeNull();
    expect(parseEmbeddings({ data: [[1, 2, 3]] }, 1)).toBeNull();
    expect(parseEmbeddings({ data: [] }, 1)).toBeNull();
  });
  it("erreur du modèle : null, rien inscrit ; délai : inscrit à l'estimation", async () => {
    const { e } = mkEnv({
      AI: { run: fakeAi({ fail: true }).run as unknown as (m: string, i: unknown) => Promise<unknown> },
    });
    expect(await runEmbed(e, ["a"], NOW)).toBeNull();
    expect((await db().prepare("SELECT COUNT(*) AS n FROM ai_usage").first<{ n: number }>())!.n).toBe(0);
    const slow = { ...e, AI: { run: () => new Promise(() => {}) } } as Env;
    expect(await runEmbed(slow, ["a"], NOW, 20)).toBeNull();
    expect((await db().prepare("SELECT neurons FROM ai_usage").first<{ neurons: number }>())!.neurons).toBeCloseTo(
      0.5,
      6,
    );
  });
});

describe("pas d'indexation", () => {
  it("éteint (interrupteur) ou binding absent : aucun appel, annonces intactes", async () => {
    await ins("a");
    for (const over of [
      { SEMANTIC_SEARCH: "false" },
      { VECTORIZE: undefined },
      { SEMANTIC_SEARCH: undefined },
      { AI: undefined },
    ] as Partial<Env>[]) {
      const { e, ai, vz } = mkEnv(over);
      expect(semanticOn(e)).toBe(false);
      expect((await runEmbedStep(e, NOW)).result).toBe("éteint");
      expect(ai.run).not.toHaveBeenCalled();
      expect(vz.calls.upsert).toBe(0);
    }
    expect(await embeddedIds()).toEqual([]);
  });

  it("lots de EMBED_BATCH : un appel IA et un upsert par pas, rattrapage du stock en plusieurs pas", async () => {
    for (let i = 0; i < 25; i++)
      await ins(`l${String(i).padStart(2, "0")}`, {}, { first: `2026-11-09T08:${String(i).padStart(2, "0")}:00Z` });
    const { e, ai, vz } = mkEnv();
    const r1 = await runEmbedStep(e, NOW);
    expect(r1).toMatchObject({ result: "pas", embedded: EMBED_BATCH });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(ai.texts[0]).toHaveLength(EMBED_BATCH);
    expect(vz.calls.upsert).toBe(1);
    expect(await embeddedIds()).toHaveLength(10);
    // Les plus récentes d'abord (stock : on commence par ce qui compte le plus).
    expect(await embeddedIds()).toContain("l24");
    expect(await embeddedIds()).not.toContain("l00");
    expect((await runEmbedStep(e, NOW)).embedded).toBe(10);
    expect((await runEmbedStep(e, NOW)).embedded).toBe(5);
    expect((await runEmbedStep(e, NOW)).result).toBe("rien");
    expect(ai.run).toHaveBeenCalledTimes(3);
    expect(vz.store.size).toBe(25);
    expect((await db().prepare("SELECT v FROM embed_state WHERE k = 'vectors'").first<{ v: number }>())!.v).toBe(25);
  });

  it("un seul vecteur par cluster (les doublons et les annonces écartées ne sont pas indexés)", async () => {
    await ins("tete", {}, { cluster: "bienici:tete" });
    await ins("dup", {}, { source: "orpi", cluster: "bienici:tete", status: "duplicate" });
    await ins("ecartee", {}, { status: "filtered" });
    await ins("attente", {}, { status: "pending" });
    await ins("lancement", {}, { status: "silent" });
    const { e, vz } = mkEnv();
    await runEmbedStep(e, NOW);
    expect(await embeddedIds()).toEqual(["attente", "lancement", "tete"]);
    expect(vz.store.size).toBe(3);
    expect(vz.store.has(await vectorId("bienici:tete"))).toBe(true);
    expect([...vz.store.keys()].every((k) => k.length === 40)).toBe(true);
  });

  it("métadonnées : source, annonce, zone et gone (en ligne 0, disparue 1) ; une annonce disparue reste indexée", async () => {
    await ins("vive", { postalCode: "75017" });
    await ins("partie", { postalCode: "92300" }, { gone: "2026-11-09T09:30:00Z" });
    const { e, vz } = mkEnv();
    await runEmbedStep(e, NOW);
    const md = (id: string) =>
      vz.store.get([...vz.store.keys()].find((k) => vz.store.get(k)!.metadata.lid === id)!)!.metadata;
    expect(md("vive")).toEqual({ source: "bienici", lid: "vive", zone: "75017", gone: 0 });
    expect(md("partie")).toEqual({ source: "bienici", lid: "partie", zone: "92300", gone: 1 });
  });

  it("disparition puis réapparition : métadonnée rafraîchie par un nouvel upsert, sans nouveau compte de vecteur", async () => {
    await ins("a");
    const { e, vz } = mkEnv();
    await runEmbedStep(e, NOW);
    const id = await vectorId("bienici:a");
    expect(vz.store.get(id)!.metadata.gone).toBe(0);
    await db().prepare("UPDATE listings SET gone_at = ? WHERE listing_id = 'a'").bind("2026-11-09T11:00:00Z").run();
    const r = await runEmbedStep(e, NOW);
    expect(r).toMatchObject({ result: "pas", embedded: 0, refreshed: 1 });
    expect(vz.store.get(id)!.metadata.gone).toBe(1);
    expect((await runEmbedStep(e, NOW)).result).toBe("rien");
    await db().prepare("UPDATE listings SET gone_at = NULL WHERE listing_id = 'a'").run();
    expect((await runEmbedStep(e, NOW)).refreshed).toBe(1);
    expect(vz.store.get(id)!.metadata.gone).toBe(0);
    expect((await db().prepare("SELECT v FROM embed_state WHERE k = 'vectors'").first<{ v: number }>())!.v).toBe(1);
  });

  it("budget de neurons épuisé : rien d'indexé ni marqué, le pas suivant réessaie", async () => {
    for (let i = 0; i < 3; i++) await ins(`b${i}`);
    await db()
      .prepare("INSERT INTO ai_usage (day, feature, neurons, calls) VALUES (?, 'embed', ?, 1)")
      .bind(NOW.toISOString().slice(0, 10), cfg.ai.featureCaps.embed)
      .run();
    const { e, ai, vz } = mkEnv();
    expect((await runEmbedStep(e, NOW)).result).toBe("budget");
    expect(ai.run).not.toHaveBeenCalled();
    expect(vz.calls.upsert).toBe(0);
    expect(await embeddedIds()).toEqual([]);
    await db().prepare("DELETE FROM ai_usage").run();
    expect((await runEmbedStep(e, NOW)).embedded).toBe(3);
  });

  it("rattrapage borné par le plafond de neurons du jour : le lot qui ne tient plus n'est pas lancé", async () => {
    for (let i = 0; i < 30; i++) await ins(`c${String(i).padStart(2, "0")}`);
    // Reste de quoi payer un seul lot estimé (10 x 0,5 = 5 neurons).
    await db()
      .prepare("INSERT INTO ai_usage (day, feature, neurons, calls) VALUES (?, 'embed', ?, 1)")
      .bind(NOW.toISOString().slice(0, 10), cfg.ai.featureCaps.embed - 5)
      .run();
    const { e } = mkEnv();
    expect((await runEmbedStep(e, NOW)).embedded).toBe(10);
    // usage réel 1 neuron pour 10 textes : il reste de la place ; on bloque en le remplissant.
    await db()
      .prepare("UPDATE ai_usage SET neurons = ?")
      .bind(cfg.ai.featureCaps.embed - 1)
      .run();
    expect((await runEmbedStep(e, NOW)).result).toBe("budget");
    expect(await embeddedIds()).toHaveLength(10);
  });

  it("plafond de vecteurs de l'offre gratuite : plus de nouvelle annonce indexée", async () => {
    await ins("z");
    await db().prepare("INSERT INTO embed_state (k, v) VALUES ('vectors', ?)").bind(SEMANTIC_MAX_VECTORS).run();
    const { e, ai } = mkEnv();
    expect((await runEmbedStep(e, NOW)).result).toBe("rien");
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("payload illisible : marquée sans vecteur, ne bloque pas le rattrapage", async () => {
    await ins("mauvaise", {}, { payload: "{pas du json", first: "2026-11-09T09:59:00Z" });
    await ins("bonne");
    const { e, vz } = mkEnv();
    const r = await runEmbedStep(e, NOW);
    expect(r).toMatchObject({ embedded: 1, skipped: 1 });
    expect(vz.store.size).toBe(1);
    expect((await runEmbedStep(e, NOW)).result).toBe("rien");
  });

  it("échec de Vectorize : rien de marqué, jamais d'exception", async () => {
    await ins("a");
    const { e } = mkEnv({
      VECTORIZE: {
        ...fakeVectorize().index,
        upsert: async () => {
          throw new Error("panne");
        },
      },
    });
    expect((await runEmbedStep(e, NOW)).result).toBe("erreur");
    expect(await embeddedIds()).toEqual([]);
  });

  it("les lectures du pas sont forcées sur les index partiels (INDEXED BY : jamais le stock entier) et s'exécutent", async () => {
    for (const [sql, idx] of [
      [TODO_SQL, "listings_embed_todo"],
      [REDO_SQL, "listings_embed_redo"],
      [MARK_GONE_SQL, "listings_embed_gone"],
      [MARK_BACK_SQL, "listings_embed_back"],
    ]) {
      expect(sql).toContain(`INDEXED BY ${idx}`);
      const n = (sql.match(/\?/g) ?? []).length;
      const plan = (
        await db()
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .bind(...new Array(n).fill(10))
          .all<{ detail: string }>()
      ).results
        .map((r) => r.detail)
        .join(" | ");
      expect(plan).toContain(idx);
    }
  });
});

describe("POST /embed (invocation séparée)", () => {
  const post = async (body: string, sig: string | null, e: Env) =>
    worker.fetch(
      new Request("https://re-search/embed", { method: "POST", body, headers: sig ? { "x-internal-key": sig } : {} }),
      e,
      {} as ExecutionContext,
    );
  it("signature HMAC et horloge vérifiées ; pas exécuté", async () => {
    await ins("a");
    const { e, vz } = mkEnv();
    const body = JSON.stringify({ now: new Date().toISOString() });
    expect((await post(body, null, e)).status).toBe(403);
    expect((await post(body, "mauvaise", e)).status).toBe(403);
    const old = JSON.stringify({ now: "2020-01-01T00:00:00Z" });
    expect((await post(old, await hmacHex("secret-key", old), e)).status).toBe(400);
    const res = await post(body, await hmacHex("secret-key", body), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: "pas", embedded: 1 });
    expect(vz.store.size).toBe(1);
  });
});

describe("normalizeQuery", () => {
  it("espaces réduits, longueurs et caractères admis", () => {
    expect(normalizeQuery("  2   pièces  lumineux ")).toBe("2 pièces lumineux");
    expect(normalizeQuery("balcon, < 1 450 € près du métro (13)")).toBeNull(); // « < »
    expect(normalizeQuery("balcon, 1 450 € près du métro (13)")).not.toBeNull();
    for (const bad of [
      null,
      undefined,
      "",
      " ",
      "a",
      "x".repeat(101),
      "<script>alert(1)</script>",
      "a\u0000b",
      "ligne‮RTL",
    ])
      expect(normalizeQuery(bad as string)).toBeNull();
    expect(normalizeQuery("x".repeat(100))).toHaveLength(100);
  });
});

/** Annonces indexées pour les tests de recherche. */
async function seed(): Promise<ReturnType<typeof mkEnv>> {
  await ins(
    "baignoire17",
    { title: "Appartement baignoire parquet lumineux", postalCode: "75017", surface: 55, price: 1500 },
    { rent: 1500 },
  );
  await ins(
    "studio17",
    { title: "Petit studio calme cuisine équipée", postalCode: "75017", surface: 22, price: 900 },
    { rent: 900 },
  );
  await ins(
    "baignoireLev",
    { title: "Appartement baignoire balcon lumineux", postalCode: "92300", surface: 60, price: 1700 },
    { rent: 1700 },
  );
  await ins(
    "ancienne",
    { title: "Appartement baignoire ancien", postalCode: "75017", surface: 50, price: 1400 },
    { rent: 1400, gone: "2026-11-08T10:00:00Z" },
  );
  const m = mkEnv();
  for (let i = 0; i < 2; i++) await runEmbedStep(m.e, NOW);
  m.ai.run.mockClear();
  return m;
}
const ids = (r: { rows: { listing_id: string }[] }): string[] => r.rows.map((x) => x.listing_id);

describe("semanticSearch", () => {
  it("rangement par similarité, score rendu, annonce disparue exclue par défaut", async () => {
    const { e } = await seed();
    const r = await semanticSearch(e, "appartement baignoire lumineux", { now: NOW });
    expect(r.status).toBe("ok");
    expect(r.query).toBe("appartement baignoire lumineux");
    expect(ids(r).slice(0, 2).sort()).toEqual(["baignoire17", "baignoireLev"]);
    expect(ids(r)).not.toContain("ancienne");
    const scores = r.rows.map((x) => x.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBeGreaterThan(0.3);
    expect(r.rows[0].gone).toBe(false);
  });

  it("includeGone : l'annonce disparue revient, marquée gone ; le filtre de métadonnées change", async () => {
    const { e, vz } = await seed();
    const r = await semanticSearch(e, "appartement baignoire ancien", { now: NOW, includeGone: true });
    expect(r.rows.find((x) => x.listing_id === "ancienne")?.gone).toBe(true);
    expect(vz.lastFilter.value).toEqual({});
    await semanticSearch(e, "autre requête baignoire", { now: NOW, zone: "75017" });
    expect(vz.lastFilter.value).toEqual({ zone: "75017", gone: 0 });
  });

  it("filtres combinés : zone, prix max, surface min (D1) en plus de Vectorize", async () => {
    const { e } = await seed();
    const q = "appartement baignoire lumineux";
    expect(ids(await semanticSearch(e, q, { now: NOW, zone: "92300" }))).toEqual(["baignoireLev"]);
    expect(ids(await semanticSearch(e, q, { now: NOW, zone: "75017" }))).toEqual(["baignoire17"]);
    const cheap = await semanticSearch(e, q, { now: NOW, prix: 1600 });
    expect(ids(cheap)).toContain("baignoire17");
    expect(ids(cheap)).not.toContain("baignoireLev");
    const big = await semanticSearch(e, q, { now: NOW, surface: 58 });
    expect(ids(big)).toEqual(["baignoireLev"]);
    expect(ids(await semanticSearch(e, q, { now: NOW, zone: "75017", prix: 1000 }))).toEqual([]);
    expect(ids(await semanticSearch(e, q, { now: NOW, limit: 1 }))).toHaveLength(1);
  });

  it("topK constant et seuil de similarité : une requête sans rapport ne ramène rien", async () => {
    const { e } = await seed();
    const r = await semanticSearch(e, "zzzzzz qqqqqq", { now: NOW });
    expect(r).toMatchObject({ status: "ok", rows: [] });
    // topK transmis à Vectorize : constante, indépendante de la saisie
    let topK = 0;
    const spy: VectorizeLike = {
      ...fakeVectorize().index,
      query: async (_v, o) => {
        topK = o.topK;
        return { matches: [] };
      },
    };
    await semanticSearch({ ...e, VECTORIZE: spy } as Env, "appartement lumineux", { now: NOW });
    expect(topK).toBe(SEMANTIC_TOPK);
  });

  it("cache D1 : une requête répétée ne coûte ni neuron, ni requête Vectorize, ni jeton horaire", async () => {
    const { e, ai, vz } = await seed();
    const a = await semanticSearch(e, "Appartement  baignoire lumineux", { now: NOW });
    expect(a.cached).toBe(false);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const queries = vz.calls.query;
    const b = await semanticSearch(e, "appartement baignoire lumineux", { now: new Date(NOW.getTime() + 600_000) });
    expect(b.cached).toBe(true);
    expect(ids(b)).toEqual(ids(a));
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(vz.calls.query).toBe(queries);
    expect((await db().prepare("SELECT n FROM search_rate").first<{ n: number }>())!.n).toBe(1);
    // périmé après SEMANTIC_CACHE_TTL_MIN
    const c = await semanticSearch(e, "appartement baignoire lumineux", {
      now: new Date(NOW.getTime() + 3 * 3_600_000),
    });
    expect(c.cached).toBe(false);
  });

  it("limite horaire : au plus SEMANTIC_MAX_PER_HOUR recherches coûteuses, puis « limited » (le cache répond encore)", async () => {
    const { e, ai } = await seed();
    for (let i = 0; i < SEMANTIC_MAX_PER_HOUR; i++)
      expect((await semanticSearch(e, `recherche numéro ${i}`, { now: NOW })).status).toBe("ok");
    const over = await semanticSearch(e, "une de trop", { now: NOW });
    expect(over.status).toBe("limited");
    expect(ai.run).toHaveBeenCalledTimes(SEMANTIC_MAX_PER_HOUR);
    expect((await semanticSearch(e, "recherche numéro 3", { now: NOW })).status).toBe("ok");
    // heure suivante : compteur neuf ; rateLimit:false (assistant) : jamais limité
    expect((await semanticSearch(e, "une de trop", { now: new Date(NOW.getTime() + 3_600_000) })).status).toBe("ok");
    for (let i = 0; i < 3; i++)
      expect((await semanticSearch(e, `assistant ${i}`, { now: NOW, rateLimit: false })).status).toBe("ok");
  });

  it("entrée invalide, interrupteur éteint, binding absent : aucun appel", async () => {
    const { e, ai, vz } = await seed();
    expect((await semanticSearch(e, "<b>x</b>", { now: NOW })).status).toBe("invalid");
    expect((await semanticSearch(e, "x", { now: NOW })).status).toBe("invalid");
    for (const over of [{ SEMANTIC_SEARCH: "false" }, { VECTORIZE: undefined }, { AI: undefined }] as Partial<Env>[]) {
      expect((await semanticSearch({ ...e, ...over } as Env, "appartement lumineux", { now: NOW })).status).toBe("off");
    }
    expect(ai.run).not.toHaveBeenCalled();
    expect(vz.calls.query).toBe(0);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM search_rate").first<{ n: number }>())!.n).toBe(0);
  });

  it("budget de neurons épuisé ou panne : « unavailable », jamais d'exception", async () => {
    const { e } = await seed();
    await db()
      .prepare("INSERT OR REPLACE INTO ai_usage (day, feature, neurons, calls) VALUES (?, 'embed', ?, 1)")
      .bind(NOW.toISOString().slice(0, 10), cfg.ai.featureCaps.embed)
      .run();
    expect((await semanticSearch(e, "appartement lumineux", { now: NOW })).status).toBe("unavailable");
    await db().prepare("DELETE FROM ai_usage").run();
    const down = {
      ...e,
      VECTORIZE: {
        ...fakeVectorize().index,
        query: async () => {
          throw new Error("panne");
        },
      },
    } as Env;
    expect((await semanticSearch(down, "appartement lumineux", { now: NOW })).status).toBe("unavailable");
  });
});

describe("tableau de bord", () => {
  const get = async (path: string, e: Env) =>
    worker.fetch(new Request(`https://re-search.test${path}`), e, {} as ExecutionContext);

  it("fonction éteinte ou binding absent : aucun champ de recherche, ?q= ignoré, aucun appel", async () => {
    const { e, ai, vz } = await seed();
    for (const over of [{ SEMANTIC_SEARCH: "false" }, { VECTORIZE: undefined }] as Partial<Env>[]) {
      const html = await (await get("/?q=baignoire", { ...e, ...over } as Env)).text();
      expect(html).not.toContain('name="q"');
      expect(html).not.toContain("Résultats pour");
    }
    expect(ai.run).not.toHaveBeenCalled();
    expect(vz.calls.query).toBe(0);
  });

  it("fonction allumée : champ de recherche, filtres conservés en champs cachés, sans ?q= la liste habituelle", async () => {
    const { e, ai } = await seed();
    const html = await (await get("/?zone=75017&prix=1600", e)).text();
    expect(html).toContain('<form class="search" method="get" action="/" role="search">');
    expect(html).toContain('name="q"');
    expect(html).toContain('<input type="hidden" name="zone" value="75017">');
    expect(html).toContain('<input type="hidden" name="prix" value="1600">');
    expect(html).toContain("Appartement baignoire parquet lumineux");
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("?q= : résultats rangés avec score discret, échappement, filtres existants appliqués, lien d'effacement", async () => {
    const { e } = await seed();
    const html = await (await get("/?q=appartement+baignoire+lumineux&zone=75017", e)).text();
    expect(html).toContain("Résultats pour « appartement baignoire lumineux »");
    expect(html).toContain("Appartement baignoire parquet lumineux");
    expect(html).not.toContain("Appartement baignoire balcon lumineux"); // Levallois, filtré par la zone
    expect(html).toMatch(/pertinence 0,\d\d/);
    expect(html).toContain('value="appartement baignoire lumineux"');
    expect(html).toContain("effacer la recherche");
    // les chips de filtre conservent la recherche
    expect(html).toContain("q=appartement+baignoire+lumineux");
  });

  it("?q= invalide ou saisie hostile : message, valeur échappée, aucun appel", async () => {
    const { e, ai } = await seed();
    const html = await (await get(`/?q=${encodeURIComponent('"><script>alert(1)</script>')}`, e)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Recherche invalide");
    expect(ai.run).not.toHaveBeenCalled();
    const long = await (await get(`/?q=${"a".repeat(500)}`, e)).text();
    expect(long).toContain("Recherche invalide");
    expect(long.length).toBeLessThan(200_000);
  });

  it("limite atteinte : « recherche indisponible pour l'instant », la liste habituelle reste affichée", async () => {
    const { e } = await seed();
    for (let i = 0; i < SEMANTIC_MAX_PER_HOUR; i++) await semanticSearch(e, `bruit ${i}`);
    const html = await (await get("/?q=nouvelle+recherche", e)).text();
    expect(html).toContain("Recherche indisponible pour l’instant.");
    expect(html).toContain("Appartement baignoire parquet lumineux");
  });

  it("renderDashboard sans recherche : page identique à avant (aucun champ)", async () => {
    await seed();
    const html = await renderDashboard(db(), cfg.sources.dedicated, NOW, new URLSearchParams());
    expect(html).not.toContain('class="search"');
  });
});

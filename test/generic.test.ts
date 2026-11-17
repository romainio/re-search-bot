import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardGate, DASH_COOKIE } from "../src/access";
import { internalFetcher } from "../src/internal";
import worker from "../src/index";
import { applyMigrations, ensureMigrated, splitSql } from "../src/migrate";
import { MIGRATIONS } from "../src/migrations";
import { sendPendingAlerts } from "../src/notify/send";
import { embedViaSelf } from "../src/search/self";
import { runScan, selfRunner } from "../src/scan";
import { getSetting } from "../src/settings";
import { CHAT_KEY, chatId, LINK_CODE_KEY, LINK_CODE_LENGTH, randomCode, webhookSecret } from "../src/telegram/chat";
import { getPendingAlerts, processListings } from "../src/process";
import type { Env, Listing, SourceDef } from "../src/types";
import { FEATURE_SWITCHES } from "../src/config/switches";
import wranglerRaw from "../wrangler.jsonc?raw";
import switchesDoc from "../docs/fonctions.md?raw";

// Installation sans configuration : appel interne par SELF ou ctx.exports, migrations appliquées par le Worker, conversation
// Telegram liée en D1, secret du webhook dérivé, tableau de bord privé.

const db = () => env.DB;
const E = (o: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  ADMIN_KEY: "k",
  TELEGRAM_BOT_TOKEN: "tok",
  WHATSAPP_ENABLED: "false",
  ...o,
});
afterEach(() => vi.restoreAllMocks());

describe("appel interne : SELF s'il existe, sinon ctx.exports.default", () => {
  const fake = (tag: string) =>
    ({ tag, fetch: vi.fn(async () => new Response("{}")) }) as unknown as Fetcher & { tag: string };

  it("choix par injection : SELF prioritaire, puis la boucle ctx.exports.default, sinon null", () => {
    const self = fake("self"),
      loop = fake("loop");
    expect(internalFetcher({ SELF: self }, { exports: { default: loop } })).toBe(self);
    expect(internalFetcher({}, { exports: { default: loop } })).toBe(loop);
    expect(internalFetcher({}, { exports: {} })).toBeNull();
    expect(internalFetcher({}, undefined)).toBeNull();
    expect(internalFetcher({ SELF: undefined }, { exports: { default: {} } })).toBeNull();
  });

  it("le sous-lot part par la boucle quand SELF est absent (signature HMAC, corps { ids, now })", async () => {
    const loop = {
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ sources: [{ id: "sector", ok: true, count: 0, ms: 1 }], events: [] })),
      ),
    };
    const e = E({ SELF: undefined });
    const r = await selfRunner(e, { exports: { default: loop } })(["sector"], new Date());
    expect(r.sources[0]).toMatchObject({ id: "sector", ok: true });
    const [url, init] = loop.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/part$/);
    expect((init.headers as Record<string, string>)["x-internal-key"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(String(init.body)).ids).toEqual(["sector"]);
  });

  it("ni SELF ni boucle : le sous-lot échoue proprement (runScan le compte en échec, sans exception)", async () => {
    await expect(selfRunner(E({ SELF: undefined }))(["sector"], new Date())).rejects.toThrow(/aucun appel interne/);
    const r = await runScan(E({ SELF: undefined }), 0, new Date());
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources.every((s) => !s.ok)).toBe(true);
  });

  it("/embed : même choix (aucune exception sans SELF ni boucle)", async () => {
    const loop = {
      fetch: vi.fn(async () => new Response(JSON.stringify({ result: "pas", embedded: 0, refreshed: 0 }))),
    };
    const e = E({ SELF: undefined, SEMANTIC_SEARCH: "true", VECTORIZE: {} as never });
    expect(await embedViaSelf(e, new Date())).toBeNull();
    expect(await embedViaSelf(e, new Date(), { exports: { default: loop } })).toMatchObject({ result: "pas" });
    expect(loop.fetch).toHaveBeenCalledOnce();
  });

  it("boucle réelle du runtime de test : ctx.exports.default du Worker répond (route /part refusée sans signature)", async () => {
    const ctx = createExecutionContext();
    const loop = internalFetcher({}, ctx);
    expect(loop).not.toBeNull();
    const res = await loop!.fetch("https://re-search/part", { method: "POST", body: "{}" });
    expect(res.status).toBe(403);
    // Même chose par l'import documenté `exports` de cloudflare:workers.
    expect(
      (
        (await (
          exports as unknown as { default: { fetch: (url: string, init: RequestInit) => Promise<Response> } }
        ).default.fetch("https://re-search/part", { method: "POST", body: "{}" })) as Response
      ).status,
    ).toBe(403);
  });

  it("de bout en bout par la boucle réelle : un sous-lot signé est exécuté par /part", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("rien", { status: 500 }));
    const ctx = createExecutionContext();
    const r = await selfRunner(E({ SELF: undefined, ADMIN_KEY: "secret-key" }), ctx)(["sector"], new Date());
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]).toMatchObject({ id: "sector", ok: false });
  });
});

describe("migrations appliquées par le Worker", () => {
  it("la liste embarquée est exactement le dossier migrations/ (une migration oubliée fait échouer ce test)", () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
    expect(MIGRATIONS.map((m) => m.name)).toContain("0015_settings.sql");
  });

  it("le découpage SQL donne les mêmes instructions que le lecteur de migrations de wrangler (nombre et mots de tête)", () => {
    const norm = (s: string) =>
      s
        .replace(/--[^\n]*/g, "")
        .trim()
        .replace(/;$/, "")
        .split(/\s+/)
        .slice(0, 3)
        .join(" ")
        .toUpperCase();
    for (const m of MIGRATIONS) {
      const theirs = env.TEST_MIGRATIONS.find((t) => t.name === m.name)!.queries.map(norm);
      expect(splitSql(m.sql).map(norm), m.name).toEqual(theirs);
    }
  });

  it("splitSql : commentaires, point-virgule dans une chaîne, bloc BEGIN...END", () => {
    expect(
      splitSql("-- un ; commentaire\nCREATE TABLE a (x TEXT DEFAULT 'a;b'); INSERT INTO a VALUES ('c');\n-- fin"),
    ).toEqual(["CREATE TABLE a (x TEXT DEFAULT 'a;b')", "INSERT INTO a VALUES ('c')"]);
    expect(
      splitSql("CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = 1; DELETE FROM a WHERE 0; END; SELECT 1;"),
    ).toEqual(["CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = 1; DELETE FROM a WHERE 0; END", "SELECT 1"]);
  });

  it("instance existante (migrations déjà appliquées par wrangler) : rien n'est rejoué, aucune écriture", async () => {
    const calls: string[] = [];
    const spy = new Proxy(db(), {
      get: (t, p) => {
        const v = Reflect.get(t, p);
        if (p === "batch" || p === "exec")
          return (...a: unknown[]) => {
            calls.push(String(p));
            return v.apply(t, a);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as D1Database;
    expect(await applyMigrations(spy)).toEqual([]);
    expect(calls).toEqual([]);
    const before = (await db().prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<{ n: number }>())!.n;
    await ensureMigrated(spy);
    expect((await db().prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<{ n: number }>())!.n).toBe(before);
  });

  it("table d1_migrations au schéma de wrangler (id, name, applied_at)", async () => {
    const cols = (await db().prepare("PRAGMA table_info(d1_migrations)").all<{ name: string }>()).results.map(
      (c) => c.name,
    );
    expect(cols).toEqual(["id", "name", "applied_at"]);
  });

  it("0017 : l'ancien drapeau de quartier devient « quartier », le reste du payload et les autres annonces sont inchangés", async () => {
    const payload = (flags: string[]) =>
      JSON.stringify({ listing: { title: "T" }, evaluation: { keep: true, rentCC: 1200, flags } });
    const insert =
      "INSERT INTO listings (source, listing_id, url, cluster, first_seen, alert_status, payload) VALUES ('m17', ?, 'https://x/', ?, '2026-01-01T00:00:00Z', 'sent', ?)";
    await db().batch([
      db()
        .prepare(insert)
        .bind("old", "m17-old", payload(["charges_inconnues", "batignolles"])),
      db()
        .prepare(insert)
        .bind("other", "m17-other", payload(["prix_inconnu"])),
      db().prepare(insert).bind("broken", "m17-broken", "{pas du json"),
    ]);
    const m = MIGRATIONS.find((x) => x.name === "0017_quartier_flag.sql")!;
    await db().batch(splitSql(m.sql).map((s) => db().prepare(s)));
    const rows = new Map(
      (
        await db()
          .prepare("SELECT listing_id, payload FROM listings WHERE source = 'm17'")
          .all<{ listing_id: string; payload: string }>()
      ).results.map((r) => [r.listing_id, r.payload]),
    );
    expect(JSON.parse(rows.get("old")!)).toEqual({
      listing: { title: "T" },
      evaluation: { keep: true, rentCC: 1200, flags: ["charges_inconnues", "quartier"] },
    });
    expect(rows.get("other")).toBe(payload(["prix_inconnu"]));
    expect(rows.get("broken")).toBe("{pas du json");
    await db().prepare("DELETE FROM listings WHERE source = 'm17'").run();
  });

  describe("migration neuve", () => {
    const NEW = [
      {
        name: "9001_test_generic.sql",
        sql: "-- test\nCREATE TABLE tmp_generic (a INTEGER);\nINSERT INTO tmp_generic VALUES (1);",
      },
    ];
    const clean = async () => {
      await db().batch([
        db().prepare("DROP TABLE IF EXISTS tmp_generic"),
        db().prepare("DELETE FROM d1_migrations WHERE name = ?").bind(NEW[0]!.name),
      ]);
    };
    beforeEach(clean);
    afterEach(clean);

    it("appliquée dans l'ordre, inscrite dans d1_migrations, idempotente", async () => {
      expect(await applyMigrations(db(), [...MIGRATIONS, ...NEW])).toEqual(["9001_test_generic.sql"]);
      expect((await db().prepare("SELECT a FROM tmp_generic").all()).results).toEqual([{ a: 1 }]);
      expect(
        (await db().prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>())?.name,
      ).toBe("9001_test_generic.sql");
      expect(await applyMigrations(db(), [...MIGRATIONS, ...NEW])).toEqual([]);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM tmp_generic").first<{ n: number }>())!.n).toBe(1);
    });

    it("deux invocations concurrentes : la migration n'est appliquée qu'une fois, aucune ne lève", async () => {
      const [a, b] = await Promise.all([applyMigrations(db(), NEW), applyMigrations(db(), NEW)]);
      expect([...a, ...b]).toEqual(["9001_test_generic.sql"]);
      expect((await db().prepare("SELECT COUNT(*) AS n FROM tmp_generic").first<{ n: number }>())!.n).toBe(1);
      expect(
        (await db()
          .prepare("SELECT COUNT(*) AS n FROM d1_migrations WHERE name = ?")
          .bind(NEW[0]!.name)
          .first<{ n: number }>())!.n,
      ).toBe(1);
    });

    it("migration en erreur : batch annulé en entier (rien d'inscrit), erreur claire ; ensureMigrated ne lève jamais", async () => {
      const bad = [
        {
          name: "9001_test_generic.sql",
          sql: "CREATE TABLE tmp_generic (a INTEGER); INSERT INTO table_absente VALUES (1);",
        },
      ];
      await expect(applyMigrations(db(), bad)).rejects.toThrow(/migration 9001_test_generic.sql/);
      expect(
        (await db()
          .prepare("SELECT COUNT(*) AS n FROM d1_migrations WHERE name = ?")
          .bind(bad[0]!.name)
          .first<{ n: number }>())!.n,
      ).toBe(0);
      expect((await db().prepare("SELECT name FROM sqlite_master WHERE name = 'tmp_generic'").all()).results).toEqual(
        [],
      );
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(ensureMigrated(db(), bad)).resolves.toBeUndefined();
      expect(err).toHaveBeenCalled();
    });
  });
});

describe("conversation Telegram liée en D1 (TELEGRAM_CHAT_ID facultatif)", () => {
  const SECRET = "s3cret_Token-1";
  const tgFetch = () =>
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: true })));
  // biome-ignore lint/suspicious/noExplicitAny: corps JSON envoyé à Telegram, sondé champ par champ par les assertions.
  const tgCalls = (spy: { mock: { calls: unknown[][] } }): [string, any][] =>
    spy.mock.calls
      .filter((c) => String(c[0]).includes("api.telegram.org"))
      .map((c) => [String(c[0]).split("/").pop()!, JSON.parse(String((c[1] as RequestInit).body))]);
  const setup = async (e: Env) =>
    worker.fetch(new Request("https://mon-worker.exemple.workers.dev/telegram/setup?k=k"), e, createExecutionContext());
  const hook = async (text: string, chat: number, e: Env, secret: string | null = null) => {
    const ctx = createExecutionContext();
    const headers: Record<string, string> = secret ? { "x-telegram-bot-api-secret-token": secret } : {};
    const res = await worker.fetch(
      new Request("https://re-search.test/telegram", {
        method: "POST",
        headers,
        body: JSON.stringify({ update_id: 1, message: { message_id: 1, date: 1, text, chat: { id: chat } } }),
      }),
      e,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  };
  const noChat = (o: Partial<Env> = {}) => E({ TELEGRAM_INTERACTIVE: "true", TELEGRAM_CHAT_ID: undefined, ...o });

  beforeEach(async () => {
    await db().prepare("DELETE FROM settings").run();
  });

  it("chatId(env) : le secret prioritaire, sinon D1, sinon null", async () => {
    expect(await chatId(noChat())).toBeNull();
    await db().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, '777', 'x')").bind(CHAT_KEY).run();
    expect(await chatId(noChat())).toBe("777");
    expect(await chatId(noChat({ TELEGRAM_CHAT_ID: "42" }))).toBe("42");
    expect(await chatId(noChat({ TELEGRAM_CHAT_ID: "" }))).toBe("777");
  });

  it("/telegram/setup sans conversation liée renvoie un code de 8 caractères, stable, stocké en D1 ; avec TELEGRAM_CHAT_ID, aucun code", async () => {
    tgFetch();
    const body = (await (await setup(noChat())).json()) as { link?: { code: string; instruction: string } };
    expect(body.link?.code).toMatch(new RegExp(`^[A-HJKMNP-Z2-9]{${LINK_CODE_LENGTH}}$`));
    expect(body.link?.instruction).toContain(`/start ${body.link!.code}`);
    expect(await getSetting(db(), LINK_CODE_KEY)).toBe(body.link!.code);
    expect(((await (await setup(noChat())).json()) as { link: { code: string } }).link.code).toBe(body.link!.code);
    await db().prepare("DELETE FROM settings").run();
    expect(
      ((await (await setup(noChat({ TELEGRAM_CHAT_ID: "42" }))).json()) as { link?: unknown }).link,
    ).toBeUndefined();
    expect(await getSetting(db(), LINK_CODE_KEY)).toBeNull();
  });

  it("le premier /start <code> exact fixe la conversation en D1 et efface le code ; un mauvais code, ou /start seul, ne fait rien", async () => {
    const spy = tgFetch();
    const code = (
      (await (await setup(noChat({ TELEGRAM_WEBHOOK_SECRET: SECRET }))).json()) as { link: { code: string } }
    ).link.code;
    spy.mockClear();
    const e = noChat({ TELEGRAM_WEBHOOK_SECRET: SECRET });
    for (const text of [
      "/start",
      "/start FAUXCODE",
      `/start ${code.toLowerCase()}x`,
      `bonjour ${code}`,
      "/profil baignoire",
    ])
      await hook(text, 555, e, SECRET);
    expect(await chatId(e)).toBeNull();
    expect(tgCalls(spy)).toHaveLength(0);
    expect((await hook(`/start ${code}`, 555, e, SECRET)).status).toBe(200);
    expect(await chatId(e)).toBe("555");
    expect(await getSetting(db(), LINK_CODE_KEY)).toBeNull();
    expect(tgCalls(spy).map(([m, b]) => [m, b.chat_id])).toEqual([["sendMessage", 555]]);
    // Code consommé : un second chat ne peut plus se lier, et un chat étranger est ignoré en silence.
    spy.mockClear();
    await hook(`/start ${code}`, 999, e, SECRET);
    await hook("/aide", 999, e, SECRET);
    expect(await chatId(e)).toBe("555");
    expect(tgCalls(spy)).toHaveLength(0);
    // Le chat lié est écouté.
    await hook("/aide", 555, e, SECRET);
    expect(tgCalls(spy).map(([m, b]) => [m, b.chat_id])).toEqual([["sendMessage", "555"]]);
  });

  it("alertes : tant qu'aucune conversation n'est liée, rien n'est envoyé et l'alerte reste en attente ; liée, elle part vers elle", async () => {
    const spy = tgFetch();
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
    const l: Listing = {
      source: "wagram",
      id: "a1",
      url: "https://x/a1",
      price: 1300,
      charges: 100,
      priceIsCC: false,
      surface: 40,
      rooms: 2,
      title: "Joli 2 pièces",
      address: null,
      district: null,
      postalCode: "75017",
      photo: null,
      agency: null,
      phone: null,
      propertyType: null,
      publishedAt: null,
    };
    await db().prepare("DELETE FROM listings").run();
    await processListings(db(), src, [], new Date(Date.UTC(2026, 10, 9, 8, 0)));
    await processListings(db(), src, [l], new Date(Date.UTC(2026, 10, 9, 12, 5)));
    expect(await sendPendingAlerts(noChat(), [src], new Date())).toEqual({ calls: 0, sent: 0 });
    expect(tgCalls(spy)).toHaveLength(0);
    expect(await getPendingAlerts(db(), 10)).toHaveLength(1);
    await db().prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, '555', 'x')").bind(CHAT_KEY).run();
    expect((await sendPendingAlerts(noChat(), [src], new Date())).sent).toBe(1);
    expect(tgCalls(spy).map(([m, b]) => [m, b.chat_id])).toEqual([["sendMessage", "555"]]);
    expect(await getPendingAlerts(db(), 10)).toHaveLength(0);
  });
});

describe("secret du webhook dérivé d'ADMIN_KEY", () => {
  it("TELEGRAM_WEBHOOK_SECRET prioritaire ; sinon HMAC-SHA256(ADMIN_KEY) en hexadécimal ; sans ADMIN_KEY : null", async () => {
    expect(await webhookSecret({ ADMIN_KEY: "k", TELEGRAM_WEBHOOK_SECRET: "explicite" })).toBe("explicite");
    const a = await webhookSecret({ ADMIN_KEY: "k" }),
      b = await webhookSecret({ ADMIN_KEY: "autre" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(await webhookSecret({ ADMIN_KEY: "k" }));
    expect(a).not.toBe(b);
    expect(await webhookSecret({ ADMIN_KEY: "" })).toBeNull();
  });

  it("le webhook accepte le secret dérivé (setWebhook l'enregistre chez Telegram) et refuse tout autre", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: true })));
    const e = E({ TELEGRAM_INTERACTIVE: "true", TELEGRAM_CHAT_ID: "42" });
    const res = await worker.fetch(
      new Request("https://mon-worker.exemple.workers.dev/telegram/setup?k=k"),
      e,
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const sent = spy.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body))).find((b) => b.secret_token)!
      .secret_token as string;
    expect(sent).toBe(await webhookSecret(e));
    const post = async (secret: string) =>
      worker.fetch(
        new Request("https://re-search.test/telegram", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": secret },
          body: "{}",
        }),
        e,
        createExecutionContext(),
      );
    expect((await post(sent)).status).toBe(200);
    expect((await post("autre")).status).toBe(403);
    expect(
      JSON.stringify(
        await (
          await worker.fetch(
            new Request("https://mon-worker.exemple.workers.dev/telegram/setup?k=k"),
            e,
            createExecutionContext(),
          )
        ).json(),
      ),
    ).not.toContain(sent);
  });
});

describe("tableau de bord privé (DASHBOARD_PUBLIC)", () => {
  const priv = (o: Partial<Env> = {}) => E({ ADMIN_KEY: "cle-admin-123", DASHBOARD_PUBLIC: "false", ...o });
  const get = (path: string, e: Env, headers: Record<string, string> = {}) =>
    worker.fetch(new Request(`https://re-search.test${path}`, { headers }), e, createExecutionContext());

  it('public ("true") : comportement d\'origine, sans clé ni cookie, cache public', async () => {
    const res = await get("/", priv({ DASHBOARD_PUBLIC: "true" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("privé : 403 sans clé (même sans la variable), jamais de contenu", async () => {
    for (const e of [priv(), priv({ DASHBOARD_PUBLIC: undefined })]) {
      const res = await get("/", e);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("<html");
    }
    expect((await get("/?k=faux", priv())).status).toBe(403);
    expect((await get("/", priv({ ADMIN_KEY: "" }))).status).toBe(403);
  });

  it("clé valide : cookie posé (jamais la clé dedans) et redirection vers la page sans la clé ; le cookie ouvre le tableau de bord", async () => {
    const e = priv();
    const res = await get("/?k=cle-admin-123&zone=75017", e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?zone=75017");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`${DASH_COOKIE}=`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).not.toContain("cle-admin-123");
    const pair = cookie.split(";")[0]!;
    const page = await get("/?zone=75017", e, { cookie: `autre=1; ${pair}` });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("private, max-age=60");
    expect(await page.text()).toContain("<html");
    expect((await get("/", e, { cookie: `${DASH_COOKIE}=faux` })).status).toBe(403);
    // Un cookie d'une autre clé ne passe pas.
    expect((await get("/", priv({ ADMIN_KEY: "autre-cle" }), { cookie: pair })).status).toBe(403);
  });

  it("les routes d'administration ne changent pas (?k= exigé), et /part reste signé", async () => {
    expect((await get("/status", priv())).status).toBe(403);
    expect((await get("/status?k=cle-admin-123", priv())).status).toBe(200);
  });

  it("dashboardGate : la page privée n'est pas servie sans accès", async () => {
    expect((await dashboardGate(new Request("https://x/"), priv())).response?.status).toBe(403);
    expect((await dashboardGate(new Request("https://x/"), priv({ DASHBOARD_PUBLIC: "true" }))).response).toBeNull();
  });
});

describe("code de liaison : tirage", () => {
  it("toujours la bonne longueur et l'alphabet sans ambiguïté, sur 2 000 tirages (un tirage sur 5 bits perdait parfois un caractère)", () => {
    for (let i = 0; i < 2000; i++) expect(randomCode(LINK_CODE_LENGTH)).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
  });
});

describe("interrupteurs livrés (wrangler.jsonc, docs/fonctions.md)", () => {
  // Lignes de commentaire retirées : le binding Vectorize n'y figure qu'en exemple.
  const code = wranglerRaw
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const vars = Object.fromEntries([...code.matchAll(/"([A-Z_]+)": "(true|false)"/g)].map((m) => [m[1], m[2]]));
  const bindings = new Set([...code.matchAll(/"binding": "([A-Z_]+)"/g)].map((m) => m[1]));

  it("chaque interrupteur est déclaré ; allumé seulement si ses bindings sont créés au déploiement, sans secret, ses dépendances allumées", () => {
    for (const s of FEATURE_SWITCHES) {
      expect(vars[s.name], s.name).toMatch(/^(true|false)$/);
      if (vars[s.name] !== "true") continue;
      expect(
        (s.bindings ?? []).filter((b) => !bindings.has(b)),
        s.name,
      ).toEqual([]);
      expect(s.secrets ?? [], s.name).toEqual([]);
      expect(
        (s.needs ?? []).filter((n) => vars[n] !== "true"),
        s.name,
      ).toEqual([]);
    }
    expect(vars.DASHBOARD_PUBLIC).toBe("false");
  });

  it("le tableau de docs/fonctions.md donne les mêmes valeurs par défaut", () => {
    for (const s of FEATURE_SWITCHES) {
      const row = switchesDoc.match(new RegExp(String.raw`^\|\s*\`${s.name}\`\s*\|\s*\`(true|false)\``, "m"));
      expect(row?.[1], s.name).toBe(vars[s.name]);
    }
  });
});

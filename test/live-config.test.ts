import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { GROUP_MAX_SOURCES } from "../src/config/schedule";
import { bundledSettings, settings } from "../src/derive";
import { evaluate } from "../src/filter";
import worker from "../src/index";
import { BUNDLED_RAW, INSTANCE } from "../src/instance";
import {
  checkInstance,
  clearInstance,
  configOrigin,
  INSTANCE_KEY,
  loadLiveConfig,
  saveInstance,
  saveSwitches,
  storedInstance,
  storedInstanceVersion,
  storedSwitches,
  SWITCHES_KEY,
} from "../src/live-config";
import { setSetting } from "../src/settings";
import type { Env, Listing, SourceDef } from "../src/types";

// Configuration vivante : instance et interrupteurs enregistrés en D1, mis en vigueur sans redéploiement ; sans ligne en D1, le
// fichier embarqué et les vars font foi.

const db = () => env.DB;
const E = (o: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  ADMIN_KEY: "k",
  TELEGRAM_BOT_TOKEN: "tok",
  ...o,
});

/** Une petite instance pour une autre ville : une zone, d'autres critères, deux sources. */
const lyon = (): Record<string, unknown> => ({
  zones: [{ postalCode: "69003", label: "Lyon 3", town: "\\blyon\\b" }],
  criteria: { rentMin: 500, rentMax: 900, surfaceMin: 20, roomsMin: 1, excludeGroundFloor: false },
  neighborhoodKeywords: ["Montchat"],
  sources: [
    {
      id: "foncia_lyon",
      name: "Foncia Lyon",
      url: "https://fr.foncia.com/location/lyon-69003/appartement",
      parser: "foncia",
      zones: ["69003"],
      filteredToZones: true,
      phone: null,
    },
    {
      id: "era_lyon",
      name: "ERA Lyon",
      url: "https://api.eraimmobilier.com/api/v2/annonces/search?code_postal=69003",
      parser: "era",
      zones: ["69003"],
      filteredToZones: true,
      phone: null,
    },
  ],
});

const listing = (o: Partial<Listing> = {}): Listing =>
  ({
    id: "1",
    url: "https://exemple.fr/1",
    title: "Appartement 2 pièces",
    price: 800,
    priceIsCC: true,
    surface: 30,
    rooms: 2,
    postalCode: "69003",
    ...o,
  }) as Listing;

afterEach(async () => {
  await db().prepare("DELETE FROM settings WHERE key IN (?, ?)").bind(INSTANCE_KEY, SWITCHES_KEY).run();
  await loadLiveConfig(E());
});

describe("configuration vivante : instance en D1", () => {
  it("sans ligne en D1 : fichier embarqué, même objet env, rien ne change", async () => {
    const e = E();
    expect(await loadLiveConfig(e)).toBe(e);
    expect(configOrigin()).toBe("fichier");
    expect(settings()).toBe(bundledSettings());
    expect(settings().instance).toBe(INSTANCE);
    expect(settings().criteria.rentMax).toBe(INSTANCE.criteria.rentMax);
  });

  it("réglages gelés en profondeur : une valeur dérivée ne change jamais en place", () => {
    const s = settings();
    expect(
      [s, s.criteria, s.zones, s.zones[0], s.sources.cron, s.sources.cron[0], s.ai.featureCaps].every(Object.isFrozen),
    ).toBe(true);
    expect(() => {
      (s.criteria as { rentMax: number }).rentMax = 1;
    }).toThrow(TypeError);
  });

  it("une configuration enregistrée remplace critères, zones, registre des sources et valeurs dérivées", async () => {
    const before = settings();
    await saveInstance(db(), lyon());
    await loadLiveConfig(E());
    expect(configOrigin()).toBe("d1");
    const s = settings();
    expect(s.criteria.rentMax).toBe(900);
    expect(s.zones.map((z) => z.postalCode)).toEqual(["69003"]);
    expect(s.allowedPostalCodes).toEqual(["69003"]);
    expect(s.sources.cron.map((x) => x.id)).toEqual(["foncia_lyon", "era_lyon"]);
    expect([...s.sources.readable]).toEqual(["foncia_lyon", "era_lyon"]);
    // Sources virtuelles du mail : reconstruites sur les zones nouvelles.
    expect(s.sources.mail.every((x) => x.zones.join() === "69003")).toBe(true);
    expect(s.sources.all.length).toBeLessThan(before.sources.all.length);
    // Valeurs dérivées : schémas de l'assistant, mots-clés de quartier du filtre, requêtes de marché, mots vides de la prospection.
    expect((s.assistantTools.chercher_annonces.fields.zone as { values: readonly string[] }).values).toContain("69003");
    expect(s.marketZonesJson).toBe('["69003"]');
    expect(s.prospect.stopWords.has("lyon")).toBe(true);
    // Remplacement atomique : qui a lu les réglages avant le changement garde une vue entière de l'ancienne configuration.
    expect(before.criteria.rentMax).toBe(INSTANCE.criteria.rentMax);
    expect(before.sources.cron.map((x) => x.id)).not.toContain("foncia_lyon");
    const src = s.sources.cron[0] as SourceDef;
    expect(evaluate(listing(), src).keep).toBe(true);
    expect(evaluate(listing({ price: 950 }), src)).toMatchObject({ keep: false, reason: "prix_haut" });
    expect(evaluate(listing({ postalCode: "75017" }), src)).toMatchObject({ keep: false, reason: "localisation" });
    expect(evaluate(listing({ title: "2 pièces Montchat" }), src).flags).toContain("quartier");
  });

  it("tableau de bord d'une autre ville : sous-titre, plafonds de prix, surfaces et quartier tirés de la configuration, rien de Paris", async () => {
    await saveInstance(db(), { ...lyon(), neighborhoodLabel: "Montchat" });
    await loadLiveConfig(E());
    const ctx = createExecutionContext();
    const html = await (
      await worker.fetch(new Request("https://w.test/?k=k"), E({ DASHBOARD_PUBLIC: "true" } as Partial<Env>), ctx)
    ).text();
    await waitOnExecutionContext(ctx);
    expect(html).toContain('<p class="sub">Lyon 3 · mis à jour le ');
    expect(html).toContain("≤ 700 €"); // 80 % de 900, arrondi à 50 €
    expect(html).toContain("≤ 900 €");
    expect(html).toContain("≥ 20 m²");
    expect(html).toContain("Montchat seulement");
    expect(html).not.toMatch(/Batignolles|Levallois|Paris 17|1 450/);
  });

  it("retirer la configuration D1 rend le fichier embarqué", async () => {
    await saveInstance(db(), lyon());
    await loadLiveConfig(E());
    await clearInstance(db());
    await loadLiveConfig(E());
    expect(configOrigin()).toBe("fichier");
    expect(settings()).toBe(bundledSettings());
    expect(settings().sources.cron.length).toBe(INSTANCE.sources.length);
  });

  it("écriture conditionnelle : seulement si la ligne n'a pas changé depuis la version lue", async () => {
    const at = new Date("2026-11-16T10:00:00.000Z");
    await saveInstance(db(), lyon(), at, null); // aucune ligne attendue : insertion
    await expect(saveInstance(db(), lyon(), at, null)).rejects.toThrow(/a changé pendant cet appel/);
    const v1 = (await storedInstanceVersion(db()))!.version;
    // Même milliseconde que la version lue : la nouvelle version en diffère quand même.
    await saveInstance(db(), { ...lyon(), neighborhoodLabel: "Montchat" }, at, v1);
    const v2 = (await storedInstanceVersion(db()))!.version;
    expect(v2).not.toBe(v1);
    await expect(saveInstance(db(), lyon(), at, v1)).rejects.toThrow(/a changé pendant cet appel/);
    expect((await storedInstanceVersion(db()))!.raw).toMatchObject({ neighborhoodLabel: "Montchat" });
    await saveInstance(db(), lyon(), at); // sans version (POST /config) : inconditionnelle
  });

  it("une configuration invalide n'est jamais enregistrée, et toutes les erreurs sont nommées", async () => {
    const bad = lyon();
    (bad.criteria as Record<string, unknown>).rentMax = "cher";
    (bad.sources as Record<string, unknown>[])[0].parser = "inconnu";
    await expect(saveInstance(db(), bad)).rejects.toThrow(/criteria\.rentMax[\s\S]*sources\[0:foncia_lyon\]\.parser/);
    await loadLiveConfig(E());
    expect(configOrigin()).toBe("fichier");
  });

  it("trop de sources actives dans un groupe : refusé à l'enregistrement", () => {
    const many = lyon();
    const one = (many.sources as Record<string, unknown>[])[0];
    many.sources = Array.from({ length: GROUP_MAX_SOURCES + 1 }, (_, i) => ({ ...one, id: `s${i}`, group: 0 }));
    expect(() => checkInstance(many)).toThrow(/groupe 0/);
  });

  it("une ligne D1 illisible ou invalide (écrite hors de saveInstance) laisse l'état en vigueur, sans exception", async () => {
    await setSetting(db(), INSTANCE_KEY, "{ pas du json");
    await loadLiveConfig(E());
    expect(configOrigin()).toBe("fichier");
    await setSetting(db(), INSTANCE_KEY, JSON.stringify({ zones: [] }));
    await loadLiveConfig(E());
    expect(configOrigin()).toBe("fichier");
    expect(settings()).toBe(bundledSettings());
  });

  it("D1 indisponible : l'env est rendu tel quel", async () => {
    const e = {
      DB: {
        prepare: () => {
          throw new Error("D1 en panne");
        },
      } as unknown as D1Database,
    };
    expect(await loadLiveConfig(e)).toBe(e);
  });
});

describe("configuration vivante : interrupteurs en D1", () => {
  it("un interrupteur enregistré passe par-dessus la var ; null rend la valeur de la var", async () => {
    await saveSwitches(db(), { GEO_HINTS: true, MARKET_HINTS: false });
    const e = await loadLiveConfig(E({ GEO_HINTS: "false", MARKET_HINTS: "true" } as Partial<Env>));
    expect(e.GEO_HINTS).toBe("true");
    expect(e.MARKET_HINTS).toBe("false");
    expect(e.DB).toBe(env.DB); // les bindings sont conservés
    expect(await saveSwitches(db(), { GEO_HINTS: null })).toEqual({ MARKET_HINTS: false });
    const e2 = await loadLiveConfig(E({ GEO_HINTS: "false" } as Partial<Env>));
    expect(e2.GEO_HINTS).toBe("false");
  });

  it("nom inconnu ou valeur non booléenne : refusé, rien n'est écrit", async () => {
    await expect(saveSwitches(db(), { GEO_HINTS: true, ADMIN_KEY: true })).rejects.toThrow(
      /ADMIN_KEY : interrupteur inconnu/,
    );
    await expect(saveSwitches(db(), { GEO_HINTS: "oui" })).rejects.toThrow(/true, false ou null/);
    expect(await storedSwitches(db())).toEqual({});
  });

  it("une ligne écrite à la main n'allume que des interrupteurs connus (jamais un secret ni un binding)", async () => {
    await setSetting(
      db(),
      SWITCHES_KEY,
      JSON.stringify({ ADMIN_KEY: true, DASHBOARD_PUBLIC: true, PHOTO_SCORING: true }),
    );
    const e = await loadLiveConfig(E({ ADMIN_KEY: "k", DASHBOARD_PUBLIC: "false" } as Partial<Env>));
    expect(e.ADMIN_KEY).toBe("k");
    expect(e.DASHBOARD_PUBLIC).toBe("false");
    expect(e.PHOTO_SCORING).toBe("true");
  });
});

describe("route /config", () => {
  /** `key` : clé envoyée en « Authorization: Bearer » (null : aucun en-tête). */
  const call = async (method: string, path: string, body?: unknown, key: string | null = "k"): Promise<Response> => {
    const ctx = createExecutionContext();
    const headers: Record<string, string> = key === null ? {} : { authorization: `Bearer ${key}` };
    const res = await worker.fetch(
      new Request(`https://w.test${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      E(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  };

  it("exige la clé d'administration, en lecture comme en écriture ; ?k= seulement en lecture", async () => {
    expect((await call("GET", "/config", undefined, null)).status).toBe(403);
    expect((await call("GET", "/config", undefined, "faux")).status).toBe(403);
    expect((await call("GET", "/config?k=k", undefined, null)).status).toBe(200);
    expect((await call("GET", "/config")).status).toBe(200);
    expect((await call("POST", "/config", { switches: {} }, "faux")).status).toBe(403);
    // Écriture : la clé dans l'URL est refusée (journaux, historique), seul l'en-tête compte.
    expect((await call("POST", "/config", { switches: {} }, null)).status).toBe(403);
    expect((await call("POST", "/config", { switches: {} })).status).toBe(200);
    expect((await call("PUT", "/config", {})).status).toBe(404);
  });

  it("route inconnue ou accès refusé : aucune lecture de la configuration en D1", async () => {
    const reads: string[] = [];
    const spy: D1Database = new Proxy(db(), {
      get: (t, p) => {
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        if (p === "prepare")
          return (sql: string) => {
            reads.push(sql);
            return (v as D1Database["prepare"]).call(t, sql);
          };
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    for (const [method, path, key] of [
      ["GET", "/inconnue", "k"],
      ["GET", "/health", null],
      ["POST", "/part", null],
      ["POST", "/embed", null],
    ] as const) {
      const ctx = createExecutionContext();
      const headers: Record<string, string> = key === null ? {} : { authorization: `Bearer ${key}` };
      const res = await worker.fetch(
        new Request(`https://w.test${path}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) }),
        { ...E(), DB: spy },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status, path).toBe(path === "/inconnue" ? 404 : 403);
    }
    expect(reads).toEqual([]);
  });

  it("GET rend le fichier embarqué tant que D1 est vide, puis la configuration enregistrée", async () => {
    const first = (await (await call("GET", "/config")).json()) as { origin: string; instance: unknown };
    expect(first.origin).toBe("fichier");
    expect(first.instance).toEqual(BUNDLED_RAW);
    const res = await call("POST", "/config", { instance: lyon(), switches: { GEO_HINTS: true } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, origin: "d1", switches: { GEO_HINTS: true } });
    const second = (await (await call("GET", "/config")).json()) as {
      origin: string;
      instance: { zones: { postalCode: string }[] };
    };
    expect(second.origin).toBe("d1");
    expect(second.instance.zones[0].postalCode).toBe("69003");
    // /health rapporte l'origine et les critères en vigueur.
    const health = (await (await call("GET", "/health")).json()) as {
      config: { origin: string };
      zones: string[];
      criteria: { rentMax: number };
      switches: { name: string; on: boolean }[];
    };
    expect(health.config.origin).toBe("d1");
    expect(health.zones).toEqual(["69003"]);
    expect(health.criteria.rentMax).toBe(900);
    expect(health.switches.find((s) => s.name === "GEO_HINTS")?.on).toBe(true);
  });

  it("configuration invalide : 400 avec les erreurs, rien n'est enregistré (interrupteurs compris)", async () => {
    const bad = lyon();
    delete bad.criteria;
    const res = await call("POST", "/config", { instance: bad, switches: { GEO_HINTS: true } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/criteria/);
    expect(await storedSwitches(db())).toEqual({});
    expect(((await (await call("GET", "/config")).json()) as { origin: string }).origin).toBe("fichier");
  });

  it("source à l'adresse interne : 400, rien n'est enregistré (même règle que les outils MCP)", async () => {
    const internal = lyon();
    (internal.sources as { url: string }[])[0]!.url = "http://169.254.169.254/latest/meta-data/";
    const res = await call("POST", "/config", { instance: internal });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /sources\[0:foncia_lyon\]\.url : nom de domaine public attendu/,
    );
    expect(await storedInstance(db())).toBeNull();
  });

  it("instance null : retour au fichier embarqué ; corps vide ou illisible : 400", async () => {
    await call("POST", "/config", { instance: lyon() });
    expect(await (await call("POST", "/config", { instance: null })).json()).toMatchObject({
      ok: true,
      origin: "fichier",
    });
    expect((await call("POST", "/config", {})).status).toBe(400);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://w.test/config", { method: "POST", headers: { authorization: "Bearer k" }, body: "{" }),
      E(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
  });
});

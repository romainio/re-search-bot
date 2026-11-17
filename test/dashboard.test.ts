import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { settings } from "../src/derive";
import worker from "../src/index";
import { getClusterStats } from "../src/store";
import { renderDashboard } from "../src/dashboard/render";
import { markAlertSent, processListings } from "../src/process";
import type { Env, Listing, SourceDef } from "../src/types";

const cfg = settings();

const E: Env = {
  ...(env as unknown as Env),
  ADMIN_KEY: "secret-admin-key-123",
  TELEGRAM_BOT_TOKEN: "tok-secret-456",
  TELEGRAM_CHAT_ID: "424242",
  WHATSAPP_ENABLED: "false",
};
const mkSrc = (id: string, name: string): SourceDef => ({
  id,
  name,
  url: "https://x",
  parser: "orpi",
  group: 1,
  filteredToZones: true,
  zones: ["75017"],
  phone: null,
  encoding: "utf-8",
  active: true,
});
const wagram = mkSrc("etude_wagram", "Etude Wagram");
const bien = mkSrc("bienici", "Bien'ici");
const l = (source: string, id: string, o: Partial<Listing> = {}): Listing => ({
  source,
  id,
  url: `https://x/${id}`,
  price: 1300,
  charges: null,
  priceIsCC: true,
  surface: 40,
  rooms: 2,
  title: null,
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
const t = (m: number) => new Date(Date.UTC(2026, 9, 19, 12, m));
const db = () => env.DB;
const get = async (path = "/") => worker.fetch(new Request(`https://re-search.test${path}`), E, {} as ExecutionContext);

beforeEach(async () => {
  await db().batch([db().prepare("DELETE FROM listings"), db().prepare("DELETE FROM source_state")]);
  await processListings(db(), wagram, [], t(0));
  await processListings(db(), bien, [], t(0));
});

describe("GET /", () => {
  it("index sur cluster et first_seen (requetes du tableau de bord public)", async () => {
    const { results } = await db()
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'listings'")
      .all<{ name: string; sql: string }>();
    const byName = new Map(results.map((r) => [r.name, r.sql]));
    expect(byName.get("listings_cluster")).toMatch(/\(\s*cluster\s*\)/);
    expect(byName.get("listings_first_seen")).toMatch(/\(\s*first_seen\s*\)/);
  });

  it("200 html, cache public 60 s, noindex, prix et lien d'une annonce sent", async () => {
    await processListings(
      db(),
      wagram,
      [
        l("etude_wagram", "w1", {
          price: 1450,
          title: "Beau 2P",
          photo: "https://img.test/a.jpg",
          agency: "Agence Test",
        }),
      ],
      t(1),
    );
    await markAlertSent(db(), "etude_wagram", "w1", t(2));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const html = await res.text();
    expect(html).toContain("1 450 € CC");
    expect(html).toContain('href="https://x/w1"');
    expect(html).toContain('src="https://img.test/a.jpg"');
    expect(html).toContain("Agence Test");
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain("14:01"); // 12:01Z = 14:01 Paris (CEST)
    expect(html).toContain("19/10");
  });

  it("n'affiche pas filtered ni duplicate, marque pending", async () => {
    await processListings(
      db(),
      wagram,
      [
        l("etude_wagram", "w2", { price: 1400, surface: 35 }),
        l("etude_wagram", "w3", { price: 5000, title: "Trop cher ZZFILTERED" }),
      ],
      t(1),
    );
    await processListings(db(), bien, [l("bienici", "ZZB9", { price: 1400, surface: 35, title: "ZZDUP" })], t(2));
    const html = await (await get()).text();
    expect(html).toContain("https://x/w2");
    expect(html).toContain("en attente d");
    expect(html).not.toContain('href="https://x/w3"');
    expect(html).not.toContain("ZZFILTERED");
    expect(html).not.toContain("ZZB9");
    expect(html).not.toContain("ZZDUP");
  });

  it("alerte abandonnee apres 5 rejets : marquee echec d'envoi, pas en attente", async () => {
    await processListings(db(), wagram, [l("etude_wagram", "x1", { price: 1444 })], t(1));
    await db().prepare("UPDATE listings SET alert_attempts = 5 WHERE listing_id = 'x1'").run();
    const html = await (await get()).text();
    expect(html).toContain("1 444 € CC");
    expect(html).toContain("échec d’envoi");
    expect(html).not.toContain("en attente d");
  });

  it("description tirée de la fiche : affichée (200 caractères au plus), échappée ; absente : rien", async () => {
    await processListings(
      db(),
      wagram,
      [
        l("etude_wagram", "d1", { description: `ZZDESC <i>calme</i> & lumineux ${"y".repeat(400)}` }),
        l("etude_wagram", "d2", { price: 1401 }),
      ],
      t(1),
    );
    const html = await (await get()).text();
    const m = html.match(/<div class="desc">([^<]*)<\/div>/);
    expect(m).not.toBeNull();
    expect(m![1].startsWith("ZZDESC &lt;i&gt;calme&lt;/i&gt; &amp; lumineux yyy")).toBe(true);
    expect(m![1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").length).toBeLessThanOrEqual(200);
    expect(html.match(/<div class="desc">/g)).toHaveLength(1);
  });

  it("echappe les titres et ignore les URL non http(s)", async () => {
    await processListings(
      db(),
      wagram,
      [
        l("etude_wagram", "w4", {
          title: "<script>alert(1)</script>",
          address: 'a"><img src=x>',
          url: "javascript:alert(1)",
          photo: "javascript:alert(2)",
        }),
      ],
      t(1),
    );
    await markAlertSent(db(), "etude_wagram", "w4", t(2));
    const html = await (await get()).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img src=x>");
    expect(html).not.toContain("javascript:");
  });

  it("source en panne : affiche son motif", async () => {
    await db()
      .prepare("UPDATE source_state SET broken = 1, last_error = ? WHERE source = 'etude_wagram'")
      .bind("http_403 <b>")
      .run();
    const html = await (await get()).text();
    expect(html).toContain("http_403 &lt;b&gt;");
    expect(html).toContain("En panne");
    expect(html).toContain("Etude Wagram");
    expect(html).toContain("Jamais lue"); // sources du registre sans etat
  });

  it("source sans passage depuis plus de 20 min : « En retard »", async () => {
    await db()
      .prepare("UPDATE source_state SET last_run = ? WHERE source = 'etude_wagram'")
      .bind(t(5).toISOString())
      .run();
    await db().prepare("UPDATE source_state SET last_run = ? WHERE source = 'bienici'").bind(t(30).toISOString()).run();
    const html = await renderDashboard(db(), [wagram, bien], t(40)); // 14:40 Paris
    const row = (name: string) => html.split("<tr>").find((r) => r.includes(name))!;
    expect(row("Etude Wagram")).toContain("En retard");
    expect(row("Etude Wagram")).toContain("35 min");
    expect(row("Bien")).not.toContain("En retard");
  });

  it("avance par source pour un cluster a deux sources", async () => {
    await processListings(db(), wagram, [l("etude_wagram", "w5", { price: 1400, surface: 35 })], t(1));
    await markAlertSent(db(), "etude_wagram", "w5", t(2));
    await processListings(db(), bien, [l("bienici", "b5", { price: 1400, surface: 35 })], t(6));
    const html = await renderDashboard(db(), [wagram, bien], t(10));
    expect(html).toContain("5 min");
    expect(html).toContain("Etude Wagram");
  });

  it("n'expose ni secrets ni routes d'administration", async () => {
    await processListings(db(), wagram, [l("etude_wagram", "w6")], t(1));
    await markAlertSent(db(), "etude_wagram", "w6", t(2));
    const html = await (await get()).text();
    for (const s of [
      E.ADMIN_KEY,
      E.TELEGRAM_BOT_TOKEN,
      E.TELEGRAM_CHAT_ID,
      "/scan",
      "/status",
      "/stats",
      "/test",
      "?k=",
    ])
      expect(html).not.toContain(s);
  });

  it("les routes admin restent protegees", async () => {
    expect((await get("/status")).status).toBe(403);
    expect((await get("/autre")).status).toBe(404);
  });

  it("borne la section avance a 20 clusters et la requete a la limite", async () => {
    for (let i = 0; i < 25; i++) {
      const o = { price: 1000 + i * 25, surface: 35 + i * 5 };
      await processListings(db(), wagram, [l("etude_wagram", `c${i}`, o)], t(1));
      await markAlertSent(db(), "etude_wagram", `c${i}`, t(2));
      await processListings(db(), bien, [l("bienici", `d${i}`, o)], t(3));
    }
    expect((await getClusterStats(db())).length).toBe(25);
    expect((await getClusterStats(db(), 3)).length).toBe(3);
    const html = await (await get()).text();
    const rows = html.split("Vue en premier par")[1]!.split("<tr>").length - 1;
    expect(rows).toBe(20);
    expect(rows).toBeLessThanOrEqual(20);
  });

  it("payload invalide ou sans flags : page 200, bonnes annonces conservees", async () => {
    await processListings(db(), wagram, [l("etude_wagram", "g1", { price: 1333 })], t(1));
    await markAlertSent(db(), "etude_wagram", "g1", t(2));
    const ins = (id: string, payload: string, min: number) =>
      db()
        .prepare(
          "INSERT INTO listings (source, listing_id, url, cluster, first_seen, alert_status, payload) VALUES ('etude_wagram', ?, 'https://x/'||?, ?, ?, 'sent', ?)",
        )
        .bind(id, id, `etude_wagram:${id}`, t(min).toISOString(), payload)
        .run();
    await ins("bad1", "null", 3);
    await ins("bad2", "{}", 4);
    await ins("bad3", "not json", 5);
    await ins(
      "noflags",
      JSON.stringify({
        listing: l("etude_wagram", "noflags", { price: 1555 }),
        evaluation: { keep: true, rentCC: 1555 },
      }),
      6,
    );
    const res = await get();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("1 333 € CC");
    expect(html).toContain("1 555 € CC");
    expect(html).not.toContain("bad1");
  });

  describe("annonces deja en ligne au lancement (silent)", () => {
    const firstPass = async (src: SourceDef, ls: Listing[], at: Date) => {
      await db().prepare("DELETE FROM source_state WHERE source = ?").bind(src.id).run();
      await processListings(db(), src, ls, at);
    };
    const insert = (status: string, id: string, min: number) =>
      db()
        .prepare(
          "INSERT INTO listings (source, listing_id, url, cluster, first_seen, alert_status, payload) VALUES ('etude_wagram', ?, 'https://x/'||?, ?, ?, ?, ?)",
        )
        .bind(
          id,
          id,
          `etude_wagram:${id}`,
          t(0)
            .toISOString()
            .replace(/\.\d+Z$/, `.${String(min % 1000).padStart(3, "0")}Z`),
          status,
          JSON.stringify({ listing: l("etude_wagram", id), evaluation: { keep: true, rentCC: 1300, flags: [] } }),
        );

    it("affiche une annonce silent avec badge et libelle « vue le »", async () => {
      await firstPass(wagram, [l("etude_wagram", "s1", { price: 1311 })], t(1));
      const html = await (await get()).text();
      expect(html).toContain("1 311 € CC");
      expect(html).toContain("déjà en ligne au lancement");
      expect(html).toContain("vue le 19/10 14:01");
      expect(html).not.toContain("détectée le");
    });

    it("liste les annonces alertees avant les silent, meme plus anciennes", async () => {
      await firstPass(wagram, [l("etude_wagram", "s2", { price: 1222 })], t(5));
      await processListings(db(), bien, [l("bienici", "a2", { price: 1333, surface: 77 })], t(1));
      await markAlertSent(db(), "bienici", "a2", t(2));
      const html = await (await get()).text();
      expect(html.indexOf("1 333 € CC")).toBeGreaterThan(-1);
      expect(html.indexOf("1 222 € CC")).toBeGreaterThan(html.indexOf("1 333 € CC"));
    });

    it("garde filtered et duplicate masques", async () => {
      await firstPass(
        wagram,
        [l("etude_wagram", "s3", { price: 1244 }), l("etude_wagram", "f3", { price: 5000, title: "ZZFILT3" })],
        t(1),
      );
      await processListings(db(), bien, [l("bienici", "ZZD3", { price: 1244, surface: 40, title: "ZZDUP3" })], t(2));
      const html = await (await get()).text();
      expect(html).toContain("https://x/s3");
      expect(html).not.toContain("ZZFILT3");
      expect(html).not.toContain("ZZDUP3");
      expect(html).not.toContain("ZZD3");
    });

    it("borne la liste a 100 cartes", async () => {
      await db().batch([
        ...Array.from({ length: 60 }, (_, i) => insert("sent", `m${i}`, i + 1)),
        ...Array.from({ length: 60 }, (_, i) => insert("silent", `n${i}`, i + 1)),
      ]);
      const html = await (await get()).text();
      expect(html.split('<article class="card">').length - 1).toBe(100);
    });
  });

  describe("annonces disparues (gone_at, au sens du cluster)", () => {
    const day = (n: number) => new Date(Date.UTC(2026, 9, 19, 12) + n * 86_400_000);
    const NOW = day(0);
    const gone = (id: string, at: Date) =>
      db().prepare("UPDATE listings SET gone_at = ? WHERE listing_id = ?").bind(at.toISOString(), id).run();
    const sent = async (src: SourceDef, id: string, at: Date, o: Partial<Listing> = {}) => {
      await processListings(db(), src, [l(src.id, id, o)], at);
      await markAlertSent(db(), src.id, id, at);
    };
    /** Partie avant la section repliée (en-tête, chiffres, liste principale) et la section elle-même. */
    const parts = (html: string) => {
      const i = html.indexOf("<details");
      expect(i).toBeGreaterThan(-1);
      return { main: html.slice(0, i), section: html.slice(i, html.indexOf("</details>", i)) };
    };

    it("cluster entièrement disparu : hors de la liste principale, dans la section repliée « Disparues récemment » avec « en ligne N j »", async () => {
      await sent(wagram, "w1", day(-3), { price: 1450 });
      await sent(wagram, "w2", day(-1), { price: 1222, surface: 70 });
      await gone("w1", day(-0.5));
      const html = await renderDashboard(db(), [wagram, bien], NOW);
      const { main, section } = parts(html);
      expect(main).not.toContain("https://x/w1");
      expect(main).toContain("https://x/w2");
      expect(section).toContain("Disparues récemment");
      expect(section).toContain("https://x/w1");
      expect(section).toContain("1 450 € CC");
      expect(section).toContain("en ligne 2,5 j"); // gone_at - first_seen
      expect(section).not.toContain("https://x/w2");
      expect(html).toMatch(/<details(?![^>]*\bopen\b)[^>]*>/); // repliée
    });

    it("chaque annonce en ligne affiche « en ligne depuis N j » (première détection du cluster)", async () => {
      await sent(wagram, "w3", day(-1.5), { price: 1333 });
      const html = await renderDashboard(db(), [wagram, bien], NOW);
      expect(parts(html).main).toContain("en ligne depuis 1,5 j");
    });

    it("cluster vivant tant qu'une de ses lignes est en ligne ; disparu quand toutes le sont (durée jusqu'à la dernière disparition)", async () => {
      await sent(wagram, "w5", day(-4), { price: 1400, surface: 35 });
      await processListings(db(), bien, [l("bienici", "b5", { price: 1400, surface: 35 })], day(-3));
      expect(
        (await db()
          .prepare("SELECT alert_status FROM listings WHERE listing_id = 'b5'")
          .first<{ alert_status: string }>())!.alert_status,
      ).toBe("duplicate");
      await gone("w5", day(-2));
      let p = parts(await renderDashboard(db(), [wagram, bien], NOW));
      expect(p.main).toContain("https://x/w5");
      expect(p.section).not.toContain("https://x/w5");
      await gone("b5", day(-1));
      p = parts(await renderDashboard(db(), [wagram, bien], NOW));
      expect(p.main).not.toContain("https://x/w5");
      expect(p.section).toContain("https://x/w5");
      expect(p.section).toContain("en ligne 3,0 j"); // dernière disparition (j-1) - première détection (j-4)
    });

    it("chiffres de tête : disparues sur 30 jours et délai médian (1 décimale, hors annonces déjà en ligne au lancement) ; section bornée à 20", async () => {
      for (const [i, d] of [1, 2, 4].entries()) {
        await sent(wagram, `g${i}`, day(-10 - d), { price: 1100 + i * 10, surface: 40 + i * 5 });
        await gone(`g${i}`, day(-10));
      }
      await sent(wagram, "old", day(-50), { price: 1500, surface: 99 });
      await gone("old", day(-40)); // hors fenêtre de 30 jours
      await db().prepare("DELETE FROM source_state WHERE source = 'bienici'").run();
      await processListings(db(), bien, [l("bienici", "s1", { price: 1250, surface: 88 })], day(-20)); // premier passage : silent
      await gone("s1", day(-5));
      let html = await renderDashboard(db(), [wagram, bien], NOW);
      expect(html).toMatch(/>4<\/b>\s*disparues sur 30 jours/);
      expect(html).toMatch(/>2,0 j<\/b>\s*délai médian avant disparition/);
      const { section } = parts(html);
      expect(section).not.toContain("https://x/old");
      expect(section).toContain("en ligne ≥ 15,0 j"); // déjà en ligne au lancement : durée minimale
      for (let i = 0; i < 25; i++) {
        await sent(wagram, `m${i}`, day(-2), { price: 1000 + i * 20, surface: 100 + i * 3 });
        await gone(`m${i}`, day(-1));
      }
      html = await renderDashboard(db(), [wagram, bien], NOW);
      expect(html).toMatch(/>29<\/b>\s*disparues sur 30 jours/);
      expect(parts(html).section.split("<tr>").length - 2).toBe(20); // en-tête + 20 lignes
    });

    it("section des disparues : titre, adresse et agence échappés, URL non http(s) ignorée", async () => {
      await sent(wagram, "xss", day(-2), {
        price: 1234,
        title: "<script>alert(1)</script>",
        address: 'a"><img src=x onerror=alert(2)>',
        agency: "<b>Ag</b>",
        url: "javascript:alert(3)",
      });
      await gone("xss", day(-1));
      const { section } = parts(await renderDashboard(db(), [wagram, bien], NOW));
      expect(section).toContain("1 234 € CC");
      expect(section).not.toContain("<script>");
      expect(section).not.toContain("<img src=x");
      expect(section).not.toContain("<b>Ag</b>");
      expect(section).toContain("&lt;b&gt;Ag&lt;/b&gt;");
      expect(section).not.toContain("javascript:");
      expect(section).not.toContain("<a href");
    });

    it("liste principale bornée puis complétée : les 100 plus récentes dans l'ordre, « en ligne depuis » = première détection du cluster (une copie plus ancienne)", async () => {
      const ins = (source: string, id: string, cluster: string, status: string, at: Date) =>
        db()
          .prepare(
            "INSERT INTO listings (source, listing_id, url, cluster, first_seen, alert_status, payload) VALUES (?, ?, 'https://x/'||?, ?, ?, ?, ?)",
          )
          .bind(
            source,
            id,
            id,
            cluster,
            at.toISOString(),
            status,
            JSON.stringify({
              listing: l(source, id, { price: 1100 }),
              evaluation: { keep: true, rentCC: 1100, flags: [] },
            }),
          );
      await db().batch([
        ...Array.from({ length: 105 }, (_, i) =>
          ins("etude_wagram", `q${i}`, `etude_wagram:q${i}`, "sent", new Date(day(-1).getTime() + i * 60_000)),
        ),
        ins("bienici", "dq", "etude_wagram:q104", "duplicate", day(-3)), // copie plus ancienne du plus récent
      ]);
      const { main } = parts(await renderDashboard(db(), [wagram, bien], NOW));
      const shown = [...main.matchAll(/href="https:\/\/x\/(q\d+)"/g)].map((m) => m[1]);
      expect(shown).toEqual(Array.from({ length: 100 }, (_, i) => `q${104 - i}`));
      const card104 = main.slice(main.indexOf("https://x/q104") - 1500, main.indexOf("https://x/q104"));
      expect(card104).toContain("en ligne depuis 3,0 j");
      const card103 = main.slice(main.indexOf("https://x/q103") - 1500, main.indexOf("https://x/q103"));
      expect(card103).toContain("en ligne depuis 0,9 j");
    });

    it("annonce en ligne « déjà en ligne au lancement » : « en ligne depuis ≥ N j » (même convention que la section)", async () => {
      await db().prepare("DELETE FROM source_state WHERE source = 'bienici'").run();
      await processListings(db(), bien, [l("bienici", "sl", { price: 1210 })], day(-2)); // premier passage : silent
      const { main } = parts(await renderDashboard(db(), [wagram, bien], NOW));
      expect(main).toContain("en ligne depuis ≥ 2,0 j");
    });

    it("aucune disparition : chiffres à 0 et « – », pas d'erreur", async () => {
      const html = await renderDashboard(db(), [wagram, bien], NOW);
      expect(html).toMatch(/>0<\/b>\s*disparues sur 30 jours/);
      expect(html).toMatch(/>–<\/b>\s*délai médian avant disparition/);
    });
  });

  describe("dernier passage", () => {
    const off: SourceDef = { ...mkSrc("off", "Source Off"), active: false };
    const run = (source: string, at: Date) =>
      db()
        .prepare(
          "INSERT INTO source_state (source, last_run) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET last_run = excluded.last_run",
        )
        .bind(source, at.toISOString())
        .run();
    const line = (html: string) => html.match(/<p class="([^"]*)" id="dernier-passage">([^<]*)<\/p>/);

    it("fenêtre 9h-20h : « Dernier passage : il y a N min » (max des last_run des sources actives), en rouge au-delà de 20 min", async () => {
      await run("etude_wagram", t(5));
      await run("bienici", t(30));
      await run("off", t(39)); // désactivée : ignorée
      let m = line(await renderDashboard(db(), [wagram, bien, off], t(40))); // 14:40 Paris
      expect(m![2]).toBe("Dernier passage : il y a 10 min");
      expect(m![1]).not.toContain("bad");
      m = line(await renderDashboard(db(), [wagram, bien, off], t(51)));
      expect(m![2]).toBe("Dernier passage : il y a 21 min");
      expect(m![1]).toContain("bad");
    });

    it("même délai de grâce que la détection des retards (staleCheckOpen) : pas de rouge avant 9h20 ; « aucun » jamais en rouge", async () => {
      await run("bienici", new Date(Date.UTC(2026, 9, 18, 17, 55))); // la veille, 19:55 Paris
      let m = line(await renderDashboard(db(), [wagram, bien], new Date(Date.UTC(2026, 9, 19, 7, 10)))); // 9:10 Paris
      expect(m![2]).toMatch(/^Dernier passage : il y a \d+ min$/);
      expect(m![1]).not.toContain("bad");
      await run("bienici", new Date(Date.UTC(2026, 9, 19, 7, 0))); // 9:00 Paris
      m = line(await renderDashboard(db(), [wagram, bien], new Date(Date.UTC(2026, 9, 19, 7, 25)))); // 9:25 Paris
      expect(m![2]).toBe("Dernier passage : il y a 25 min");
      expect(m![1]).toContain("bad");
      await db().prepare("DELETE FROM source_state").run();
      m = line(await renderDashboard(db(), [wagram, bien], t(40)));
      expect(m![2]).toBe("Dernier passage : aucun");
      expect(m![1]).not.toContain("bad");
    });

    it("hors fenêtre : « Prochain passage à 9h00 »", async () => {
      await run("bienici", t(30));
      const late = new Date(Date.UTC(2026, 9, 19, 19, 5)); // 21:05 Paris
      const m = line(await renderDashboard(db(), [wagram, bien], late));
      expect(m![2]).toBe("Prochain passage à 9h00");
      expect(m![1]).not.toContain("bad");
    });
  });

  it("sous-titre tiré des libellés des zones (« Paris 17 et Levallois ») ; badge « Levallois » sur une annonce 92300 (code, ou ville du titre), aucun badge de zone pour le 17e ; Batignolles inchangé", async () => {
    await processListings(
      db(),
      wagram,
      [
        l("etude_wagram", "lv1", { postalCode: "92300", title: "ZZLEV1" }),
        l("etude_wagram", "lv2", { postalCode: null, title: "ZZLEV2 Levallois-Perret", surface: 45 }),
        l("etude_wagram", "p17", { price: 1350, surface: 50, title: "ZZP17" }),
        l("etude_wagram", "bt1", { price: 1500, surface: 60, address: "rue Legendre", title: "ZZBAT" }),
      ],
      t(1),
    );
    const html = await renderDashboard(db(), [wagram, bien], t(5));
    expect(html).toContain('<p class="sub">Paris 17 et Levallois · mis à jour le ');
    const cardOf = (marker: string) => {
      const i = html.indexOf(marker);
      expect(i).toBeGreaterThan(0);
      return html.slice(html.lastIndexOf('<article class="card">', i), html.indexOf("</article>", i));
    };
    expect(cardOf("ZZLEV1")).toContain('<span class="badge">Levallois</span>');
    // Ville seule dans le titre sur une source filtrée sur le 17e : zone de la source (pas de badge) ; source non filtrée : Levallois.
    expect(cardOf("ZZLEV2")).not.toContain('class="badge"');
    const html2 = await renderDashboard(db(), [{ ...wagram, filteredToZones: false }, bien], t(5));
    const i2 = html2.indexOf("ZZLEV2");
    expect(html2.slice(html2.lastIndexOf('<article class="card">', i2), html2.indexOf("</article>", i2))).toContain(
      '<span class="badge">Levallois</span>',
    );
    expect(cardOf("ZZP17")).not.toContain('class="badge"');
    expect(cardOf("ZZBAT")).toContain('<span class="badge">Batignolles</span>');
    expect(cardOf("ZZBAT")).not.toContain("Levallois");
  });

  it("registre complet sans erreur sur base vide", async () => {
    const html = await renderDashboard(db(), cfg.sources.dedicated, t(0));
    expect(html).toContain("Aucune annonce");
  });

  it("source desactivee du registre : « Désactivée » et non « Jamais lue »", async () => {
    const html = await renderDashboard(
      db(),
      [
        {
          id: "off",
          name: "Source Off",
          url: "https://x.test/",
          parser: "netty",
          group: 1,
          filteredToZones: false,
          zones: ["75017"],
          phone: null,
          encoding: "utf-8",
          active: false,
        },
      ],
      t(0),
    );
    expect(html).toContain("Source Off");
    expect(html).toContain("Désactivée");
    expect(html).not.toContain("Jamais lue");
  });
});

describe("GET / : filtres, tri, €/m²", () => {
  const lev = { ...mkSrc("agence_levallois", "Agence Levallois"), zones: ["92300"] };
  const srcs = [wagram, bien, lev];
  const page = async (q = "") => {
    const res = await get(`/${q}`);
    expect(res.status).toBe(200);
    return res.text();
  };
  const order = (html: string, ids: string[]) => ids.map((id) => html.indexOf(`href="https://x/${id}"`));
  const seed = async () => {
    await processListings(db(), lev, [], t(0));
    await processListings(
      db(),
      wagram,
      [
        l("etude_wagram", "a1", { price: 1450, surface: 50, title: "ZZA1" }), // 29,0 €/m²
        l("etude_wagram", "a2", { price: 1200, surface: 36, title: "ZZA2", address: "rue Legendre" }), // 33,3 €/m², Batignolles
        l("etude_wagram", "a3", { price: 1550, surface: 41, title: "ZZA3" }), // 37,8 €/m²
        l("etude_wagram", "a4", { price: 1300, surface: null, title: "ZZA4" }), // surface inconnue
      ],
      t(1),
    );
    await processListings(
      db(),
      lev,
      [
        l("agence_levallois", "v1", { price: 1350, surface: 38, postalCode: "92300", title: "ZZV1" }),
        l("agence_levallois", "v2", { price: 1250, surface: 45, postalCode: null, title: "ZZV2" }), // zone de la source
      ],
      t(2),
    );
  };

  it("chaque carte affiche le prix au m² (loyer CC ou affiché / surface, 1 décimale) ; surface inconnue : rien", async () => {
    await seed();
    const html = await renderDashboard(db(), srcs, t(5));
    const cardOf = (m: string) => {
      const i = html.indexOf(m);
      return html.slice(html.lastIndexOf('<article class="card">', i), html.indexOf("</article>", i));
    };
    expect(cardOf("ZZA1")).toContain("29,0 €/m²");
    expect(cardOf("ZZA2")).toContain("33,3 €/m²");
    expect(cardOf("ZZV1")).toContain("35,5 €/m²");
    expect(cardOf("ZZA4")).not.toContain("€/m²");
  });

  it("filtres en SQL : zone (code postal, ou zone de la source sans code), quartier, prix max, surface min (valeurs inconnues gardées)", async () => {
    await seed();
    const shown = (html: string) =>
      ["a1", "a2", "a3", "a4", "v1", "v2"].filter((id) => html.includes(`href="https://x/${id}"`));
    const html = (q: string) => renderDashboard(db(), srcs, t(5), new URLSearchParams(q));
    expect(shown(await html(""))).toEqual(["a1", "a2", "a3", "a4", "v1", "v2"]);
    expect(shown(await html("zone=92300"))).toEqual(["v1", "v2"]);
    expect(shown(await html("zone=75017"))).toEqual(["a1", "a2", "a3", "a4"]);
    expect(shown(await html("zone=quartier"))).toEqual(["a2"]);
    // Anciens liens : nom du quartier en minuscules.
    expect(shown(await html("zone=batignolles"))).toEqual(["a2"]);
    expect(shown(await html("prix=1300"))).toEqual(["a2", "a4", "v2"]);
    expect(shown(await html("surface=40"))).toEqual(["a1", "a3", "a4", "v2"]);
    expect(shown(await html("zone=75017&prix=1450&surface=40"))).toEqual(["a1", "a4"]);
  });

  it("tri : plus récentes (défaut), prix croissant, €/m² croissant, surface décroissante ; inconnues en dernier", async () => {
    await seed();
    const ids = ["a1", "a2", "a3", "a4", "v1", "v2"];
    const sorted = async (q: string) => {
      const h = await renderDashboard(db(), srcs, t(5), new URLSearchParams(q));
      return ids
        .map((id) => [id, h.indexOf(`href="https://x/${id}"`)] as const)
        .sort((a, b) => a[1] - b[1])
        .map(([id]) => id);
    };
    expect(await sorted("tri=prix")).toEqual(["a2", "v2", "a4", "v1", "a1", "a3"]);
    expect(await sorted("tri=m2")).toEqual(["v2", "a1", "a2", "v1", "a3", "a4"]);
    expect(await sorted("tri=surface")).toEqual(["a1", "v2", "a3", "v1", "a2", "a4"]);
    const recent = await sorted("");
    expect(recent.slice(0, 2).sort()).toEqual(["v1", "v2"]); // détectées en dernier (t(2))
  });

  it("barre de filtres : état courant visible (aria-current), liens qui gardent les autres paramètres, « réinitialiser » si filtré", async () => {
    const plain = await page();
    expect(plain).toContain('class="filtres"');
    expect(plain).not.toContain("réinitialiser");
    expect(plain).toMatch(/<a class="chip on" aria-current="true" href="\/">Toutes<\/a>/);
    const html = await page("?zone=92300&prix=1450&tri=m2");
    expect(html).toContain('aria-current="true" href="/?zone=92300&amp;prix=1450&amp;tri=m2">Levallois</a>');
    expect(html).toContain('href="/?zone=92300&amp;prix=1450&amp;surface=40&amp;tri=m2">≥ 40 m²</a>');
    expect(html).toContain('href="/?prix=1450&amp;tri=m2">Toutes</a>');
    expect(html).toMatch(/<a class="chip on" aria-current="true" href="[^"]*">≤ 1 450 €<\/a>/);
    expect(html).toMatch(/<a class="chip on" aria-current="true" href="[^"]*">€\/m² croissant<\/a>/);
    expect(html).toContain('<a class="reset" href="/">réinitialiser</a>');
  });

  it("paramètres hors liste blanche : ignorés (page par défaut), jamais réinjectés", async () => {
    await seed();
    const q = "zone=%3Cscript%3Ealert(1)%3C%2Fscript%3E&prix=99999&surface=1%27%22&tri=%22%3E%3Cb%3E&auto=yes&k=secret";
    expect(await renderDashboard(db(), srcs, t(5), new URLSearchParams(q))).toBe(
      await renderDashboard(db(), srcs, t(5)),
    );
    const evil = await page(`?${q}`);
    expect(evil).not.toContain("<script>");
    expect(evil).not.toContain("99999");
    expect(evil).not.toContain("secret");
    expect(evil).not.toContain("http-equiv");
  });

  it("actualisation automatique (auto=1) : meta refresh 60 s, absente par défaut", async () => {
    expect(await page()).not.toContain('http-equiv="refresh"');
    const html = await page("?auto=1");
    expect(html).toContain('<meta http-equiv="refresh" content="60">');
    expect(html).toMatch(/<a class="chip on" aria-current="true" href="\/\?auto=1">toutes les 60 s<\/a>/);
  });

  it("filtré sans résultat : message dédié ; requête bornée à 100 cartes avec un tri", async () => {
    await seed();
    expect(await renderDashboard(db(), srcs, t(5), new URLSearchParams("zone=92300&surface=50"))).toContain(
      "Aucune annonce ne correspond à ces filtres",
    );
    await processListings(
      db(),
      wagram,
      Array.from({ length: 105 }, (_, i) => l("etude_wagram", `n${i}`, { price: 1000 + i, surface: 35 + 2 * i })),
      t(3),
    );
    const html = await renderDashboard(db(), srcs, t(5), new URLSearchParams("tri=prix"));
    expect(html.match(/<article class="card">/g)).toHaveLength(100);
    expect(order(html, ["n0", "n1"])[0]).toBeLessThan(order(html, ["n0", "n1"])[1]);
  });
});

describe("GET / : annonces écartées par motif", () => {
  it("décompte par motif (anciennes lignes sans motif : « Motif non enregistré »), échappé, absent des cartes", async () => {
    await processListings(
      db(),
      wagram,
      [
        l("etude_wagram", "e1", { price: 1700 }),
        l("etude_wagram", "e2", { price: 1800 }),
        l("etude_wagram", "e3", { price: 900 }),
        l("etude_wagram", "e4", { price: 1300, propertyType: "Parking" }),
      ],
      t(1),
    );
    await db().prepare("UPDATE listings SET alert_kind = NULL WHERE listing_id = 'e4'").run();
    await db().prepare("UPDATE listings SET alert_kind = '<b>x</b>' WHERE listing_id = 'e3'").run();
    const html = await (await get()).text();
    expect(html).toContain("Annonces écartées");
    expect(html).toMatch(/Loyer trop haut<\/td><td>2<\/td>/);
    expect(html).toMatch(/Motif non enregistré<\/td><td>1<\/td>/);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("Annonces (4)");
    expect(html).not.toContain('href="https://x/e1"');
  });

  it("aucune annonce écartée : message dédié", async () => {
    expect(await (await get()).text()).toContain("Aucune annonce écartée");
  });

  it("migration 0006 : motif repris du payload des lignes déjà filtrées", async () => {
    await processListings(db(), wagram, [l("etude_wagram", "m1", { price: 1700 })], t(1));
    await db().prepare("UPDATE listings SET alert_kind = NULL WHERE listing_id = 'm1'").run();
    await db()
      .prepare(
        "UPDATE listings SET alert_kind = COALESCE(json_extract(payload, '$.evaluation.reason'), 'inconnu') WHERE alert_status = 'filtered' AND alert_kind IS NULL AND json_valid(payload)",
      )
      .run();
    expect(
      (await db().prepare("SELECT alert_kind FROM listings WHERE listing_id = 'm1'").first<{ alert_kind: string }>())!
        .alert_kind,
    ).toBe("prix_haut");
  });
});

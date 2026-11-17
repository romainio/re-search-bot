import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clip } from "../src/format";
import { formatHealth, formatTelegram, formatWhatsApp } from "../src/notify/format";
import { sendHealthEvents, sendPendingAlerts } from "../src/notify/send";
import { getPendingAlerts, processListings } from "../src/process";
import type { Env, Listing, SourceDef } from "../src/types";

const src: SourceDef = {
  id: "wagram",
  name: "Wagram Immobilier",
  url: "https://x",
  parser: "orpi",
  group: 1,
  filteredToZones: true,
  zones: ["75017"],
  phone: "01 44 90 03 94",
  encoding: "utf-8",
  active: true,
};
const l = (id: string, o: Partial<Listing> = {}): Listing => ({
  source: "wagram",
  id,
  url: `https://x/${id}`,
  price: 1300,
  charges: 100,
  priceIsCC: false,
  surface: 40,
  rooms: 2,
  title: "Joli 2 pièces",
  address: "rue Legendre",
  district: null,
  postalCode: "75017",
  photo: null,
  agency: "Wagram",
  phone: null,
  propertyType: null,
  publishedAt: null,
  ...o,
});
const at = (h: number, m: number) => new Date(Date.UTC(2026, 9, 19, h, m));
const db = () => env.DB;
const E = (o: Partial<Env> = {}): Env => ({
  ...(env as unknown as Env),
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  WHATSAPP_ENABLED: "false",
  ...o,
});

async function seed(listings: Listing[], when = at(12, 5)) {
  await processListings(db(), src, [], at(8, 0));
  await processListings(db(), src, listings, when);
}
const pending = () => getPendingAlerts(db(), 10);
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const urls = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

beforeEach(async () => {
  await db().batch([db().prepare("DELETE FROM listings"), db().prepare("DELETE FROM source_state")]);
});
afterEach(() => vi.restoreAllMocks());

describe("format", () => {
  it("formatTelegram : Batignolles, CC, telephone, heure de Paris, echappement", async () => {
    await seed([l("a1", { title: "Bel <b>appart</b> & co" })]);
    const [a] = await pending();
    const { caption, buttonUrl } = formatTelegram(a, src);
    expect(caption).toContain("Batignolles");
    expect(caption).toContain("1 400 € CC");
    expect(caption).toContain("01 44 90 03 94");
    expect(caption).toContain("Détectée à 14:05");
    expect(caption).toContain("&lt;b&gt;appart&lt;/b&gt; &amp; co");
    expect(caption).not.toContain("<b>appart");
    expect(buttonUrl).toBe("https://x/a1");
  });

  it("caption <= 1024 caracteres", async () => {
    await seed([l("a2", { title: "T".repeat(3000), address: `rue Legendre ${"x".repeat(3000)}` })]);
    const [a] = await pending();
    expect(formatTelegram(a, src).caption.length).toBeLessThanOrEqual(1024);
  });

  it("description tirée de la fiche : en fin de légende, au plus 200 caractères, échappée ; sans description rien ne change", async () => {
    const desc = `Très <b>beau</b> 2 pièces & calme, ${"lumineux ".repeat(60)}`;
    await seed([l("d1", { description: desc }), l("d2")]);
    const [a1, a2] = await pending();
    const lines = formatTelegram(a1, src).caption.split("\n");
    const last = lines[lines.length - 1];
    expect(lines[lines.length - 2]).toBe("Détectée à 14:05");
    expect(last.startsWith("Très &lt;b&gt;beau&lt;/b&gt; 2 pièces &amp; calme, lumineux")).toBe(true);
    expect(last.endsWith("…")).toBe(true);
    const plain = last.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(plain.length).toBeLessThanOrEqual(200);
    expect(desc.startsWith(plain.slice(0, -1).trimEnd())).toBe(true);
    const c2 = formatTelegram(a2, src).caption.split("\n");
    expect(c2[c2.length - 1]).toBe("Détectée à 14:05");
  });

  it("clip ne coupe jamais une paire UTF-16 (emoji à la coupure) : légende sans demi-paire isolée", async () => {
    // Assertions booléennes : une demi-paire dans un message d'échec casse le canal du pool de test (UTF-8 invalide).
    const lone = (x: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(x);
    expect(clip(`${"a".repeat(198)}😀zzz`, 200) === `${"a".repeat(198)}…`).toBe(true);
    expect(clip(`${"a".repeat(197)}😀zzz`, 200) === `${"a".repeat(197)}😀…`).toBe(true);
    await seed([
      l("e1", { description: `${"a".repeat(198)}😀${"z".repeat(50)}`, title: `${"t".repeat(198)}🏠${"x".repeat(20)}` }),
    ]);
    const [a] = await pending();
    expect(lone(formatTelegram(a, src).caption)).toBe(false);
  });

  it("caption <= 1024 caracteres avec titre, adresse et description tres longs", async () => {
    await seed([l("d3", { title: "&".repeat(3000), address: "<".repeat(3000), description: ">".repeat(300) })]);
    const [a] = await pending();
    expect(formatTelegram(a, src).caption.length).toBeLessThanOrEqual(1024);
  });

  it("tête « 🏠 Levallois » pour une annonce 92300 (code de l'annonce, ou ville du titre), « 🏠 Paris 17 » pour le 17e, Batignolles inchangé ; WhatsApp idem", async () => {
    await seed([
      l("z1", { postalCode: "92300", address: "rue Anatole France" }),
      l("z2", { address: "avenue de Wagram", surface: 50 }),
      l("z3", { postalCode: null, address: null, title: "Appartement Levallois-Perret 2 pièces", surface: 60 }),
      l("z4", { surface: 70 }), // rue Legendre (75017)
    ]);
    const by = Object.fromEntries((await pending()).map((a) => [a.id, a]));
    const head = (id: string, s: SourceDef = src) => formatTelegram(by[id], s).caption.split("\n")[0];
    const unfiltered: SourceDef = { ...src, filteredToZones: false };
    expect([head("z1"), head("z2"), head("z3", unfiltered), head("z4")]).toEqual([
      "🏠 Levallois",
      "🏠 Paris 17",
      "🏠 Levallois",
      "🏠 Batignolles",
    ]);
    // Ville seule dans le titre sur une source filtrée sur le 17e : la zone de la source l'emporte.
    expect(head("z3")).toBe("🏠 Paris 17");
    expect(formatTelegram(by.z1, src).caption).toContain("rue Anatole France");
    expect(formatWhatsApp(by.z1, src).split("\n")[0]).toBe("🏠 Levallois");
    expect(formatWhatsApp(by.z3).split("\n")[0]).toBe("🏠 Levallois");
  });

  it("localisation inconnue -> zone de la source si elle n'en couvre qu'une, sinon « Paris 17 ou Levallois »", async () => {
    await seed([l("u1", { postalCode: null, address: "rue X", title: "Joli 2 pièces" })]);
    const [a] = await pending();
    const head = (s: SourceDef | undefined) => formatTelegram(a, s).caption.split("\n")[0];
    expect(head(src)).toBe("🏠 Paris 17");
    expect(head({ ...src, zones: ["92300"] })).toBe("🏠 Levallois");
    expect(head({ ...src, zones: ["75017", "92300"] })).toBe("🏠 Paris 17 ou Levallois");
    expect(head(undefined)).toBe("🏠 Paris 17 ou Levallois");
  });

  it("formatWhatsApp et formatHealth", async () => {
    await seed([l("a3")]);
    const [a] = await pending();
    const wa = formatWhatsApp(a);
    expect(wa).toContain("1 400 € CC");
    expect(wa).not.toContain("<");
    expect(formatHealth({ type: "broken", sourceId: "wagram", reason: "HTTP 500" }, "Wagram")).toContain("Wagram");
    expect(formatHealth({ type: "restored", sourceId: "wagram", reason: "" }, "Wagram")).toContain("Wagram");
  });
});

describe("sendPendingAlerts", () => {
  it("Telegram 500 : l'alerte reste pending", async () => {
    await seed([l("b1")]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("err", { status: 500 }));
    await sendPendingAlerts(E(), [src], at(12, 6));
    expect((await pending()).map((a) => a.id)).toEqual(["b1"]);
  });

  it("exception reseau : l'alerte reste pending", async () => {
    await seed([l("b2")]);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    await sendPendingAlerts(E(), [src], at(12, 6));
    expect(await pending()).toHaveLength(1);
  });

  it("sendPhoto 400 : repli sendMessage, alerte sent, 2 sous-requetes", async () => {
    await seed([l("c1", { photo: "https://img/x.jpg" })]);
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (u) => (String(u).includes("sendPhoto") ? new Response("bad", { status: 400 }) : ok()));
    const r = await sendPendingAlerts(E(), [src], at(12, 6));
    expect(urls(spy).map((u) => u.split("/").pop())).toEqual(["sendPhoto", "sendMessage"]);
    expect(r).toEqual({ calls: 2, sent: 1 });
    expect(await pending()).toHaveLength(0);
  });

  it("sans photo : sendMessage direct", async () => {
    await seed([l("c2")]);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    expect(await sendPendingAlerts(E(), [src], at(12, 6))).toEqual({ calls: 1, sent: 1 });
    expect(urls(spy)[0]).toContain("/bottok/sendMessage");
  });

  it("WHATSAPP_ENABLED=false : aucun appel CallMeBot", async () => {
    await seed([l("d1")]);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    await sendPendingAlerts(E({ CALLMEBOT_PHONE: "+33600000000", CALLMEBOT_APIKEY: "k" }), [src], at(12, 6));
    expect(urls(spy).some((u) => u.includes("callmebot"))).toBe(false);
  });

  it("WHATSAPP_ENABLED=true + echec CallMeBot : alerte quand meme sent", async () => {
    await seed([l("d2")]);
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (u) => (String(u).includes("callmebot") ? new Response("x", { status: 500 }) : ok()));
    const r = await sendPendingAlerts(
      E({ WHATSAPP_ENABLED: "true", CALLMEBOT_PHONE: "+33600000000", CALLMEBOT_APIKEY: "k" }),
      [src],
      at(12, 6),
    );
    expect(urls(spy).filter((u) => u.includes("api.callmebot.com/whatsapp.php"))).toHaveLength(1);
    expect(r).toEqual({ calls: 2, sent: 1 });
    expect(await pending()).toHaveLength(0);
  });

  const photos = (n: number) =>
    Array.from({ length: n }, (_, i) => l(`p${i}`, { price: 1300 + i, photo: "https://img/x.jpg" }));
  const all400 = () =>
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (u) => (String(u).includes("sendPhoto") ? new Response("bad", { status: 400 }) : ok()));

  it("budget de sous-requetes 5, WhatsApp off, 3 alertes avec photo (repli 400) : 2 envoyees", async () => {
    await seed(photos(3));
    const spy = all400();
    const r = await sendPendingAlerts(E(), [src], at(12, 6), 5);
    expect(r).toEqual({ calls: 4, sent: 2 });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(await pending()).toHaveLength(1);
  });

  it("budget 2 avec WhatsApp actif : rien n'est envoye", async () => {
    await seed(photos(1));
    const spy = all400();
    const r = await sendPendingAlerts(
      E({ WHATSAPP_ENABLED: "true", CALLMEBOT_PHONE: "+33600000000", CALLMEBOT_APIKEY: "k" }),
      [src],
      at(12, 6),
      2,
    );
    expect(r).toEqual({ calls: 0, sent: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(await pending()).toHaveLength(1);
  });

  it("le nombre de fetch ne depasse jamais le budget", async () => {
    await seed(photos(6));
    for (const budget of [3, 4, 7, 10]) {
      const spy = all400();
      const { calls: n } = await sendPendingAlerts(
        E({ WHATSAPP_ENABLED: "true", CALLMEBOT_PHONE: "+33600000000", CALLMEBOT_APIKEY: "k" }),
        [src],
        at(12, 6),
        budget,
      );
      expect(spy.mock.calls.length).toBe(n);
      expect(n).toBeLessThanOrEqual(budget);
      vi.restoreAllMocks();
    }
  });

  it("jamais plus de ALERT_BUDGET alertes", async () => {
    await seed(Array.from({ length: 20 }, (_, i) => l(`m${i}`, { price: 1200 + i })));
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    await sendPendingAlerts(E(), [src], at(12, 6), 50);
    expect(spy).toHaveBeenCalledTimes(15);
  });

  it("echec de markAlertSent : la boucle continue", async () => {
    await seed([l("f1", { price: 1300 }), l("f2", { price: 1310 })]);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    let failed = false;
    const realDb = env.DB;
    const db = new Proxy(realDb, {
      get(t, k) {
        if (k === "prepare")
          return (q: string) => {
            if (q.startsWith("UPDATE") && !failed) {
              failed = true;
              throw new Error("d1 down");
            }
            return t.prepare(q);
          };
        const v = (t as unknown as Record<string | symbol, unknown>)[k];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const r = await sendPendingAlerts(E({ DB: db as D1Database }), [src], at(12, 6));
    expect(r).toEqual({ calls: 2, sent: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await pending()).map((a) => a.id)).toEqual(["f1"]);
  });

  it("alerte empoisonnee (400 sur sendPhoto et sendMessage) : abandonnee apres 5 tentatives", async () => {
    await seed([l("z1", { photo: "https://img/x.jpg" })]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 400 }));
    for (let i = 0; i < 4; i++) await sendPendingAlerts(E(), [src], at(12, 6 + i));
    expect((await pending()).map((a) => a.id)).toEqual(["z1"]);
    await sendPendingAlerts(E(), [src], at(12, 10));
    expect(await pending()).toHaveLength(0);
    const row = await db().prepare("SELECT alert_status, alert_attempts FROM listings WHERE listing_id = 'z1'").first();
    expect(row).toEqual({ alert_status: "pending", alert_attempts: 5 });
  });

  it("alerte empoisonnee : ne bloque pas la file des suivantes", async () => {
    await seed(
      Array.from({ length: 15 }, (_, i) => l(`z${i}`, { price: 1200 + i, title: "POISON" })),
      at(12, 0),
    );
    await processListings(db(), src, [l("ok1", { price: 1500 })], at(12, 1));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) =>
      String((init as RequestInit).body).includes("POISON") ? new Response("bad", { status: 400 }) : ok(),
    );
    let sent = 0;
    for (let i = 0; i < 6; i++) sent += (await sendPendingAlerts(E(), [src], at(12, 6 + i), 50)).sent;
    expect(sent).toBe(1);
  });

  it("echec 500 ou reseau : pas compte comme tentative (panne Telegram transitoire)", async () => {
    await seed([l("z2")]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("err", { status: 500 }));
    for (let i = 0; i < 6; i++) await sendPendingAlerts(E(), [src], at(12, 6 + i));
    expect((await pending()).map((a) => a.id)).toEqual(["z2"]);
  });

  it("les appels Telegram et CallMeBot portent un AbortSignal", async () => {
    await seed([l("g1")]);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    await sendPendingAlerts(
      E({ WHATSAPP_ENABLED: "true", CALLMEBOT_PHONE: "+33600000000", CALLMEBOT_APIKEY: "k" }),
      [src],
      at(12, 6),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    for (const c of spy.mock.calls) expect((c[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});

describe("sendHealthEvents", () => {
  it("un sendMessage par evenement", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());
    const r = await sendHealthEvents(E(), [{ type: "broken", sourceId: "wagram", reason: "HTTP 500" }], [src]);
    expect(r.calls).toBe(1);
    expect(r.delivered).toHaveLength(1);
    expect(urls(spy)[0]).toContain("sendMessage");
  });
  it("evenement non livre si Telegram echoue", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x", { status: 500 }));
    const r = await sendHealthEvents(E(), [{ type: "broken", sourceId: "wagram", reason: "HTTP 500" }], [src]);
    expect(r.calls).toBe(1);
    expect(r.delivered).toHaveLength(0);
  });
});

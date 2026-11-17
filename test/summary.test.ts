import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { markAlertSent, processListings } from "../src/process";
import { buildDailySummary, isSummaryTime, parisDate, sendDailySummary } from "../src/summary";
import type { Env, Listing, SourceDef } from "../src/types";
import wranglerRaw from "../wrangler.jsonc?raw";

const E: Env = {
  ...(env as unknown as Env),
  ADMIN_KEY: "k",
  TELEGRAM_BOT_TOKEN: "tok-secret",
  TELEGRAM_CHAT_ID: "4242",
  WHATSAPP_ENABLED: "false",
};
const mk = (id: string, name: string, active = true): SourceDef => ({
  id,
  name,
  url: "https://x",
  parser: "orpi",
  group: 1,
  filteredToZones: true,
  zones: ["75017"],
  phone: null,
  encoding: "utf-8",
  active,
});
const wagram = mk("etude_wagram", "Wagram <&>");
const off = mk("off", "Source Off", false);
const srcs = [wagram, mk("bienici", "Bien'ici"), off];
const l = (id: string, o: Partial<Listing> = {}): Listing => ({
  source: "etude_wagram",
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
const db = () => env.DB;
/** 19/10/2026 (heure d'été, UTC+2), h:m UTC. */
const at = (h: number, m: number, day = 19) => new Date(Date.UTC(2026, 9, day, h, m));
const EVENING = at(18, 5); // 20h05 Paris
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const tgBodies = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .filter((c) => String(c[0]).includes("api.telegram.org"))
    .map((c) => JSON.parse(String((c[1] as RequestInit).body)));

beforeEach(async () => {
  await db().batch([
    db().prepare("DELETE FROM listings"),
    db().prepare("DELETE FROM source_state"),
    db().prepare("DELETE FROM daily_summary"),
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("résumé du soir : créneau", () => {
  it("20h05-20h59 de Paris, été comme hiver ; jamais pendant la fenêtre active ; date de Paris", () => {
    expect(isSummaryTime(at(18, 5))).toBe(true); // 20h05 (UTC+2)
    expect(isSummaryTime(at(18, 59))).toBe(true);
    expect(isSummaryTime(at(18, 4))).toBe(false); // 20h04
    expect(isSummaryTime(at(19, 5))).toBe(false); // 21h05 l'été
    expect(isSummaryTime(new Date("2026-11-10T19:05:00Z"))).toBe(true); // 20h05 l'hiver (UTC+1)
    expect(isSummaryTime(new Date("2026-11-10T18:05:00Z"))).toBe(false); // 19h05 l'hiver : fenêtre active
    expect(parisDate(new Date("2026-10-19T22:30:00Z"))).toBe("2026-10-20"); // 0h30 à Paris
  });

  it("cron d'hiver déclaré (5-59 19 * * * : tout le créneau 20h05-20h59 l'hiver) à côté du cron de chaque minute", () => {
    expect(wranglerRaw).toContain('"crons": ["* 7-18 * * *", "5-59 19 * * *"]');
    expect(isSummaryTime(new Date("2026-11-10T19:59:00Z"))).toBe(true); // dernière minute du cron d'hiver : 20h59
    expect(isSummaryTime(new Date("2026-10-19T19:59:00Z"))).toBe(false); // le même cron l'été : 21h59, hors créneau
  });
});

describe("résumé du soir : contenu", () => {
  it("alertes envoyées aujourd'hui, clusters disparus aujourd'hui, sources actives en panne (échappées), prochain passage", async () => {
    await processListings(db(), wagram, [], at(6, 0, 18));
    await processListings(
      db(),
      wagram,
      [l("a1"), l("a2", { surface: 50 }), l("a3", { surface: 60 }), l("g1", { surface: 70 }), l("g2", { surface: 80 })],
      at(7, 0, 18),
    );
    await markAlertSent(db(), "etude_wagram", "a1", at(8, 0)); // aujourd'hui 10h
    await markAlertSent(db(), "etude_wagram", "a2", at(16, 0)); // aujourd'hui 18h
    await markAlertSent(db(), "etude_wagram", "a3", at(16, 0, 18)); // hier : non comptée
    await db().prepare("UPDATE listings SET gone_at = ? WHERE listing_id = 'g1'").bind(at(12, 0).toISOString()).run();
    await db()
      .prepare("UPDATE listings SET gone_at = ? WHERE listing_id = 'g2'")
      .bind(at(12, 0, 18).toISOString())
      .run();
    await db().batch([
      db().prepare("UPDATE source_state SET broken = 1 WHERE source = 'etude_wagram'"),
      db().prepare("INSERT INTO source_state (source, broken) VALUES ('off', 1)"),
    ]);
    expect(await buildDailySummary(db(), srcs, EVENING)).toBe(
      "<b>Bilan du jour</b> : 2 alertes, 1 annonce disparue, sources en panne : Wagram &lt;&amp;&gt;, prochain passage à 9h00.",
    );
  });

  it("journée calme : 0 alerte, 0 annonce disparue, aucune source en panne", async () => {
    expect(await buildDailySummary(db(), srcs, EVENING)).toBe(
      "<b>Bilan du jour</b> : 0 alerte, 0 annonce disparue, sources en panne : aucune, prochain passage à 9h00.",
    );
  });
});

describe("résumé du soir : une seule fois par jour", () => {
  it("premier passage du créneau : un sendMessage HTML ; les suivants du même jour : rien ; le lendemain : de nouveau", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => ok());
    expect(await sendDailySummary(E, srcs, EVENING)).toBe("envoyé");
    expect(await sendDailySummary(E, srcs, at(18, 6))).toBe("déjà envoyé");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toBe("https://api.telegram.org/bottok-secret/sendMessage");
    expect(tgBodies(spy)[0]).toMatchObject({ chat_id: "4242", parse_mode: "HTML" });
    expect(tgBodies(spy)[0].text).toContain("Bilan du jour");
    expect(await sendDailySummary(E, srcs, at(18, 5, 20))).toBe("envoyé");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("refus de Telegram (400, 429) : la minute suivante réessaie ; 5xx ou erreur réseau : pas de second essai (le message a pu partir)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    for (const [status, day] of [
      [400, 19],
      [429, 20],
    ] as const) {
      spy.mockReset();
      spy.mockResolvedValueOnce(new Response("refusé", { status })).mockImplementation(async () => ok());
      expect(await sendDailySummary(E, srcs, at(18, 5, day))).toBe("échec");
      expect(await sendDailySummary(E, srcs, at(18, 6, day))).toBe("envoyé");
      expect(await sendDailySummary(E, srcs, at(18, 7, day))).toBe("déjà envoyé");
      expect(spy).toHaveBeenCalledTimes(2);
    }
    for (const [fail, day] of [
      [() => spy.mockResolvedValueOnce(new Response("boom", { status: 500 })), 21],
      [() => spy.mockRejectedValueOnce(new Error("réseau")), 22],
    ] as const) {
      spy.mockReset();
      fail();
      spy.mockImplementation(async () => ok());
      expect(await sendDailySummary(E, srcs, at(18, 5, day))).toBe("échec");
      expect(await sendDailySummary(E, srcs, at(18, 6, day))).toBe("déjà envoyé");
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it("scheduled : à 20h05 de Paris (été et hiver) le résumé part une fois, sans passage de scan ; à 20h04 rien", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => ok());
    const self = { fetch: vi.fn(async () => new Response("{}", { status: 500 })) } as unknown as Fetcher;
    const run = async (iso: string) => {
      // Le créneau se juge sur l'horloge réelle (cron en retard) : le cron part ici à l'heure prévue.
      vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(iso) });
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: Date.parse(iso) }), { ...E, SELF: self }, ctx);
      await waitOnExecutionContext(ctx);
    };
    await run("2026-10-19T18:04:00Z");
    expect(spy).not.toHaveBeenCalled();
    await run("2026-10-19T18:05:00Z");
    await run("2026-10-19T18:06:00Z");
    await run("2026-11-10T19:05:00Z");
    await run("2026-11-10T19:06:00Z");
    expect(tgBodies(spy).map((b) => b.text.startsWith("<b>Bilan du jour</b>"))).toEqual([true, true]);
    expect(self.fetch).not.toHaveBeenCalled();
  });
});

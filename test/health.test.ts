import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { detectStale, markRun, recordOutcome, staleMinutes } from "../src/health";

const t = (n: number) => new Date(Date.UTC(2026, 9, 19, 8, n));
const db = () => env.DB;
const fail = (reason = "HTTP 403") => ({ ok: false as const, reason });
const row = (s: string) =>
  db().prepare("SELECT * FROM source_state WHERE source = ?").bind(s).first<Record<string, unknown>>();

beforeEach(async () => {
  await db().prepare("DELETE FROM source_state").run();
});

describe("recordOutcome", () => {
  it("passe en panne au 3e échec, une seule fois, puis rétabli au premier succès", async () => {
    for (const i of [1, 2]) expect(await recordOutcome(db(), "x", fail(), t(i))).toBeNull();
    expect(await recordOutcome(db(), "x", fail(), t(3))).toEqual({ type: "broken", sourceId: "x", reason: "HTTP 403" });
    expect(await recordOutcome(db(), "x", fail(), t(4))).toBeNull();
    expect(await recordOutcome(db(), "x", { ok: true, count: 5 }, t(5))).toMatchObject({
      type: "restored",
      sourceId: "x",
    });
    expect(await recordOutcome(db(), "x", { ok: true, count: 5 }, t(6))).toBeNull();
    expect(await row("x")).toMatchObject({ broken: 0, consecutive_failures: 0, last_count: 5 });
  });

  it("zéro annonce après des annonces : panne au 3e passage", async () => {
    await recordOutcome(db(), "y", { ok: true, count: 4 }, t(1));
    await recordOutcome(db(), "y", { ok: true, count: 0 }, t(2));
    await recordOutcome(db(), "y", { ok: true, count: 0 }, t(3));
    expect(await recordOutcome(db(), "y", { ok: true, count: 0 }, t(4))).toMatchObject({
      type: "broken",
      reason: expect.stringContaining("0 annonce"),
    });
    expect((await row("y"))!.last_count).toBe(4);
  });

  it("un retour des annonces avant la confirmation remet le compteur à zéro", async () => {
    await recordOutcome(db(), "y", { ok: true, count: 4 }, t(1));
    await recordOutcome(db(), "y", { ok: true, count: 0 }, t(2));
    await recordOutcome(db(), "y", { ok: true, count: 3 }, t(3));
    expect(await row("y")).toMatchObject({ consecutive_failures: 0, last_count: 3, broken: 0 });
    expect(await recordOutcome(db(), "y", { ok: true, count: 0 }, t(4))).toBeNull();
  });

  it("petit stock (1 ou 2) puis zéro : page vide légitime, jamais en échec, last_count remis à 0 ; une panne ancienne se rétablit", async () => {
    await recordOutcome(db(), "w", { ok: true, count: 1 }, t(1));
    for (const i of [2, 3, 4]) expect(await recordOutcome(db(), "w", { ok: true, count: 0 }, t(i))).toBeNull();
    expect(await row("w")).toMatchObject({ broken: 0, consecutive_failures: 0, last_count: 0 });
    await db()
      .prepare(
        "INSERT INTO source_state (source, consecutive_failures, last_count, broken, last_error) VALUES ('v', 3, 1, 1, '0 annonce (contre 1 au passage précédent)')",
      )
      .run();
    expect(await recordOutcome(db(), "v", { ok: true, count: 0 }, t(5))).toMatchObject({
      type: "restored",
      sourceId: "v",
    });
    expect(await row("v")).toMatchObject({ broken: 0, last_count: 0, last_error: null });
  });

  it("page de pagination (emptyOk) : zéro annonce après un gros stock n'est jamais suspect", async () => {
    await recordOutcome(db(), "p2", { ok: true, count: 12 }, t(1));
    for (const i of [2, 3, 4])
      expect(await recordOutcome(db(), "p2", { ok: true, count: 0, emptyOk: true }, t(i))).toBeNull();
    expect(await row("p2")).toMatchObject({ broken: 0, consecutive_failures: 0, last_count: 0 });
  });

  it("source toujours vide : jamais en panne", async () => {
    for (const i of [1, 2, 3, 4]) expect(await recordOutcome(db(), "z", { ok: true, count: 0 }, t(i))).toBeNull();
    expect(await row("z")).toMatchObject({ broken: 0, consecutive_failures: 0 });
  });

  it("ne touche pas à initialized", async () => {
    await db().prepare("INSERT INTO source_state (source, initialized) VALUES ('i', 1)").run();
    for (const i of [1, 2, 3]) await recordOutcome(db(), "i", fail(), t(i));
    await recordOutcome(db(), "i", { ok: true, count: 2 }, t(4));
    expect((await row("i"))!.initialized).toBe(1);
  });

  it("n'écrit pas quand rien ne change", async () => {
    await recordOutcome(db(), "w", { ok: true, count: 5 }, t(1));
    const before = await row("w");
    await recordOutcome(db(), "w", { ok: true, count: 5 }, t(30));
    expect(await row("w")).toEqual(before); // last_ok inchangé
    for (const i of [1, 2, 3]) await recordOutcome(db(), "w", fail(), t(40 + i));
    const broken = await row("w");
    await recordOutcome(db(), "w", fail(), t(50));
    expect(await row("w")).toEqual(broken);
  });
});

describe("markRun / detectStale (passages manquants)", () => {
  const at = (iso: string) => new Date(iso);
  const srcs = [
    { id: "s1", active: true },
    { id: "s2", active: true },
    { id: "off", active: false },
  ];
  const setRun = (s: string, lastRun: string | null, broken = 0) =>
    db().prepare("INSERT INTO source_state (source, last_run, broken) VALUES (?, ?, ?)").bind(s, lastRun, broken).run();

  it("markRun ecrit last_run, meme sans ligne existante", async () => {
    await markRun(db(), "s1", at("2026-10-19T10:00:00Z"));
    expect((await row("s1"))!.last_run).toBe("2026-10-19T10:00:00.000Z");
    await markRun(db(), "s1", at("2026-10-19T10:05:00Z"));
    expect((await row("s1"))!.last_run).toBe("2026-10-19T10:05:00.000Z");
  });

  it("source sans passage depuis plus de 20 min : panne emise une fois", async () => {
    await setRun("s1", "2026-10-19T09:35:00.000Z");
    await setRun("s2", "2026-10-19T09:50:00.000Z");
    const now = at("2026-10-19T10:00:00Z"); // 12:00 Paris
    expect(await detectStale(db(), srcs, now)).toEqual([
      { type: "broken", sourceId: "s1", reason: "aucun passage depuis 25 min" },
    ]);
    expect(await row("s1")).toMatchObject({ broken: 1, last_error: "aucun passage depuis 25 min" });
    expect(await detectStale(db(), srcs, at("2026-10-19T10:01:00Z"))).toEqual([]);
  });

  it("cadence réduite (every 15) : 25 min sans passage est normal, 35 min est une panne", async () => {
    await setRun("s1", "2026-10-19T09:35:00.000Z");
    await setRun("s2", "2026-10-19T09:25:00.000Z");
    const slow = [
      { id: "s1", active: true, every: 15 },
      { id: "s2", active: true, every: 15 },
    ];
    expect(await detectStale(db(), slow, at("2026-10-19T10:00:00Z"))).toEqual([
      { type: "broken", sourceId: "s2", reason: "aucun passage depuis 35 min" },
    ]);
    expect(staleMinutes("2026-10-19T09:35:00.000Z", at("2026-10-19T10:00:00Z"), 15)).toBeNull();
    expect(staleMinutes("2026-10-19T09:35:00.000Z", at("2026-10-19T10:00:00Z"))).toBe(25);
  });

  it("puis retablie au premier passage reussi", async () => {
    await setRun("s1", "2026-10-19T09:35:00.000Z");
    await detectStale(db(), srcs, at("2026-10-19T10:00:00Z"));
    expect(await recordOutcome(db(), "s1", { ok: true, count: 3 }, at("2026-10-19T10:02:00Z"))).toMatchObject({
      type: "restored",
      sourceId: "s1",
    });
  });

  it("rien avant 9h20 Paris, hors fenetre, sans last_run, pour une source inactive ou hors registre", async () => {
    await setRun("s1", "2026-10-18T17:55:00.000Z");
    await setRun("s2", null);
    await setRun("off", "2026-10-18T17:55:00.000Z");
    await setRun("gone", "2026-10-18T17:55:00.000Z");
    expect(await detectStale(db(), srcs, at("2026-10-19T07:15:00Z"))).toEqual([]); // 9:15 Paris
    expect(await detectStale(db(), srcs, at("2026-10-18T19:00:00Z"))).toEqual([]); // 21:00 Paris
    expect(await detectStale(db(), srcs, at("2026-10-19T07:21:00Z"))).toMatchObject([{ sourceId: "s1" }]); // 9:21 Paris
  });

  it("staleMinutes : null si recent, absent ou hors fenetre", () => {
    expect(staleMinutes("2026-10-19T09:30:00.000Z", at("2026-10-19T10:00:00Z"))).toBe(30);
    expect(staleMinutes("2026-10-19T09:45:00.000Z", at("2026-10-19T10:00:00Z"))).toBeNull();
    expect(staleMinutes(null, at("2026-10-19T10:00:00Z"))).toBeNull();
    expect(staleMinutes("2026-10-19T09:30:00.000Z", at("2026-10-19T19:00:00Z"))).toBeNull();
  });
});

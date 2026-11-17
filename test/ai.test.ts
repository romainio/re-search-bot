import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canSpend, neuronsFromUsage, record, spentToday, utcDay } from "../src/ai/budget";
import { answerText, extractJson, runJson } from "../src/ai/run";
import { AI_FALLBACK_RATE, AI_MODEL_RATES } from "../src/config/ai";
import { settings } from "../src/derive";
import type { Env } from "../src/types";

const cfg = settings();

const MODEL = "@cf/google/gemma-4-26b-a4b-it";
const db = () => env.DB;
const D1 = new Date("2026-11-09T10:00:00Z");
const D2 = new Date("2026-11-10T00:00:00Z");
type Run = (model: string, input: unknown) => Promise<unknown>;
const withAi = (run: Run): Env => ({ ...(env as unknown as Env), AI: { run: vi.fn(run) } });
const runOf = (e: Env) => e.AI!.run as unknown as ReturnType<typeof vi.fn>;
const rows = () =>
  db()
    .prepare("SELECT day, feature, neurons, calls FROM ai_usage ORDER BY day, feature")
    .all<{ day: string; feature: string; neurons: number; calls: number }>()
    .then((r) => r.results);

beforeEach(async () => {
  await db().prepare("DELETE FROM ai_usage").run();
});
afterEach(() => vi.useRealTimers());

describe("budget : neuronsFromUsage", () => {
  it("jetons d'entrée et de sortie au tarif du modèle", () => {
    const r = AI_MODEL_RATES[MODEL];
    expect(neuronsFromUsage(MODEL, { prompt_tokens: 1000, completion_tokens: 100 })).toBeCloseTo(
      (1000 * r.inPerM + 100 * r.outPerM) / 1e6,
      6,
    );
  });
  it("modèle inconnu : tarif de repli pessimiste", () => {
    expect(neuronsFromUsage("@cf/autre", { prompt_tokens: 1000, completion_tokens: 0 })).toBeCloseTo(
      (1000 * AI_FALLBACK_RATE.inPerM) / 1e6,
      6,
    );
    expect(AI_FALLBACK_RATE.inPerM).toBeGreaterThan(AI_MODEL_RATES[MODEL].inPerM);
  });
  it("seul total_tokens connu : tout au tarif de sortie ; un seul des deux champs : l'autre vaut 0", () => {
    expect(neuronsFromUsage(MODEL, { total_tokens: 1000 })).toBeCloseTo(
      (1000 * AI_MODEL_RATES[MODEL].outPerM) / 1e6,
      6,
    );
    expect(neuronsFromUsage(MODEL, { completion_tokens: 10 })).toBeCloseTo(
      (10 * AI_MODEL_RATES[MODEL].outPerM) / 1e6,
      6,
    );
  });
  it("usage absent ou inexploitable : null", () => {
    for (const u of [
      undefined,
      null,
      "x",
      5,
      {},
      { prompt_tokens: "12" },
      { prompt_tokens: -1 },
      { prompt_tokens: NaN },
    ])
      expect(neuronsFromUsage(MODEL, u)).toBeNull();
  });
});

describe("budget : cumul, plafonds, jour UTC", () => {
  it("record cumule par (jour, fonction) en une seule ligne par couple", async () => {
    await record(db(), "photo", MODEL, { prompt_tokens: 1000, completion_tokens: 0 }, 50, D1);
    await record(db(), "photo", MODEL, { prompt_tokens: 1000, completion_tokens: 0 }, 50, D1);
    await record(db(), "profil", MODEL, null, 12, D1);
    const r = await rows();
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ day: "2026-11-09", feature: "photo", calls: 2 });
    expect(r[0].neurons).toBeCloseTo((2 * (1000 * AI_MODEL_RATES[MODEL].inPerM)) / 1e6, 4);
    expect(r[1]).toMatchObject({ feature: "profil", neurons: 12, calls: 1 });
    expect((await spentToday(db(), D1)).total).toBeCloseTo(r[0].neurons + 12, 4);
  });

  it("repli prudent sans usage : l'estimation de l'appelant est inscrite", async () => {
    expect(await record(db(), "photo", MODEL, undefined, 70, D1)).toBe(70);
    expect((await rows())[0].neurons).toBe(70);
  });

  it("plafond par fonction : refusé au-delà, accepté pile au plafond", async () => {
    const cap = cfg.ai.featureCaps.photo;
    await record(db(), "photo", MODEL, null, cap - 70, D1);
    expect(await canSpend(db(), "photo", 70, D1)).toBe(true);
    expect(await canSpend(db(), "photo", 70.5, D1)).toBe(false);
    expect(await canSpend(db(), "autre", 70, D1)).toBe(true); // fonction sans plafond propre : seul le global compte
  });

  it("plafond global : toutes fonctions confondues", async () => {
    await record(db(), "a", MODEL, null, cfg.ai.dailyNeurons - 100, D1);
    expect(await canSpend(db(), "b", 100, D1)).toBe(true);
    expect(await canSpend(db(), "b", 101, D1)).toBe(false);
    await record(db(), "b", MODEL, null, 100, D1);
    expect(await canSpend(db(), "c", 1, D1)).toBe(false);
  });

  it("le jour UTC change à 00:00 UTC : le cumul repart de zéro", async () => {
    await record(db(), "photo", MODEL, null, cfg.ai.featureCaps.photo, new Date("2026-11-09T23:59:59Z"));
    expect(await canSpend(db(), "photo", 1, new Date("2026-11-09T23:59:59Z"))).toBe(false);
    expect(await canSpend(db(), "photo", 1, D2)).toBe(true);
    expect(utcDay(D2)).toBe("2026-11-10");
    expect(utcDay(new Date("2026-11-09T23:59:59Z"))).toBe("2026-11-09");
  });

  it("erreur D1 (table absente) : canSpend refuse, record ne lève pas", async () => {
    const broken = {
      prepare: () => {
        throw new Error("no such table: ai_usage");
      },
    } as unknown as D1Database;
    expect(await canSpend(broken, "photo", 1, D1)).toBe(false);
    expect(await record(broken, "photo", MODEL, null, 5, D1)).toBe(0);
  });
});

describe("run : extraction", () => {
  it("answerText : choices ou response, sinon null", () => {
    expect(answerText({ choices: [{ message: { content: "a" } }] })).toBe("a");
    expect(answerText({ response: "b" })).toBe("b");
    expect(answerText({ response: { x: 1 } })).toBeNull();
    expect(answerText(null)).toBeNull();
    expect(answerText({ choices: [] })).toBeNull();
  });
  it("extractJson : texte entouré, balises, objet direct ; sinon null", () => {
    expect(extractJson('Voici ```json\n{"a":1}\n``` fin')).toEqual({ a: 1 });
    expect(extractJson({ a: 2 })).toEqual({ a: 2 });
    expect(extractJson("{pas du json}")).toBeNull();
    expect(extractJson("rien")).toBeNull();
    expect(extractJson(undefined)).toBeNull();
    expect(extractJson("}{")).toBeNull();
  });
});

describe("run : runJson", () => {
  const call = (o: object = {}) => ({
    feature: "photo",
    model: MODEL,
    input: { messages: [] },
    estimate: 40,
    timeoutMs: 1000,
    now: D1,
    validate: (j: unknown) => ((j as { ok?: unknown })?.ok === true ? { ok: true } : null),
    ...o,
  });
  const ok =
    (extra: object = {}): Run =>
    async () => ({ choices: [{ message: { content: '{"ok":true}' } }], ...extra });

  it("succès : valeur validée, entrée transmise au modèle, une ligne D1 avec les neurons d'usage", async () => {
    const e = withAi(ok({ usage: { prompt_tokens: 2000, completion_tokens: 200 } }));
    expect(await runJson(e, call())).toEqual({ ok: true });
    expect(runOf(e).mock.calls[0]).toEqual([MODEL, { messages: [] }]);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].neurons).toBeCloseTo(
      (2000 * AI_MODEL_RATES[MODEL].inPerM + 200 * AI_MODEL_RATES[MODEL].outPerM) / 1e6,
      4,
    );
  });

  it("format « response » accepté ; sans usage : estimation inscrite", async () => {
    expect(
      await runJson(
        withAi(async () => ({ response: '{"ok":true}' })),
        call(),
      ),
    ).toEqual({ ok: true });
    expect((await rows())[0].neurons).toBe(40);
  });

  it("JSON invalide ou validation refusée : null, mais l'appel (facturé) est inscrit", async () => {
    expect(
      await runJson(
        withAi(async () => ({ response: "n'importe quoi" })),
        call(),
      ),
    ).toBeNull();
    expect(
      await runJson(
        withAi(async () => ({ response: '{"ok":false}' })),
        call(),
      ),
    ).toBeNull();
    expect((await rows())[0].calls).toBe(2);
  });

  it("validateur qui lève : null, sans exception", async () => {
    expect(
      await runJson(
        withAi(ok()),
        call({
          validate: () => {
            throw new Error("x");
          },
        }),
      ),
    ).toBeNull();
  });

  it("erreur du modèle : null et rien d'inscrit (non facturé)", async () => {
    expect(
      await runJson(
        withAi(async () => {
          throw new Error("3040");
        }),
        call(),
      ),
    ).toBeNull();
    expect(await rows()).toHaveLength(0);
  });

  it("délai dépassé : null, estimation inscrite (l'appel a pu tourner)", async () => {
    vi.useFakeTimers();
    const p = runJson(
      withAi(() => new Promise(() => {})),
      call({ timeoutMs: 6000 }),
    );
    await vi.advanceTimersByTimeAsync(5999);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toBeNull();
    vi.useRealTimers();
    expect((await rows())[0]).toMatchObject({ neurons: 40, calls: 1 });
  });

  it("budget épuisé : aucun appel au modèle, rien d'inscrit", async () => {
    await record(db(), "photo", MODEL, null, cfg.ai.featureCaps.photo, D1);
    const e = withAi(ok());
    expect(await runJson(e, call())).toBeNull();
    expect(runOf(e)).not.toHaveBeenCalled();
    expect((await rows())[0].calls).toBe(1);
  });

  it("sans binding AI : null", async () => {
    expect(await runJson({ ...(env as unknown as Env), AI: undefined }, call())).toBeNull();
    expect(await rows()).toHaveLength(0);
  });
});

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PART_SIZE } from "../src/config/scan";
import { TOTAL_GROUPS } from "../src/config/schedule";
import { settings } from "../src/derive";
import { fetchSource } from "../src/fetch-source";
import { evaluate } from "../src/filter";
import { groupParts, parseSource, runScan } from "../src/scan";
import type { Env } from "../src/types";
import { FIXTURE_BY_ID } from "./source-fixtures";

const cfg = settings();

// Mesure de CPU : lancée seule (npm run test:cpu, sans parallélisme de fichiers), jamais avec la suite.

const E: Env = {
  ...(env as unknown as Env),
  ADMIN_KEY: "secret-key",
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_CHAT_ID: "42",
  WHATSAPP_ENABLED: "false",
};
const t = (h: number, m: number) => new Date(Date.UTC(2026, 9, 19, h, m));
const ACTIVE = cfg.sources.dedicated.filter((s) => s.active);
const GROUPS = Array.from({ length: TOTAL_GROUPS }, (_, g) => g);

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM listings"), env.DB.prepare("DELETE FROM source_state")]);
  // /part refuse un instant trop éloigné de l'horloge : horloge simulée (Date seulement) près des passages t(10, x).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(t(10, 2));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CPU d'un sous-lot /part", () => {
  it("CPU par sous-lot (une invocation /part, une source) : fetch + parse + evaluate avec la fixture de chaque source (E/S D1 exclues), meilleur de 9 passages a chaud < 8 ms pour chaque sous-lot (mediane et octets lus journalises) ; pages a marqueur lues jusqu'au marqueur seulement", async () => {
    // Octets préparés une fois (la conversion du banc n'est pas mesurée) : utf-8, ou vrai cp1252 (euro = 0x80) pour les pages windows-1252.
    const WIRE = new Map<string, Uint8Array>(
      ACTIVE.map((s) => {
        const raw = FIXTURE_BY_ID[s.id];
        return [
          s.url,
          s.encoding === "windows-1252"
            ? Uint8Array.from(raw, (c) => (c === "€" ? 0x80 : c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f))
            : new TextEncoder().encode(raw),
        ];
      }),
    );
    // Corps d'octets natif, comme un corps de fetch : lu par readAtLeast en morceaux de 64 Ko, donc arrêté au stopMarker (vérifié plus
    // bas : octets lus < taille de la page).
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input instanceof Request ? input.url : input);
      return new Response(WIRE.get(u) ?? "{}");
    });
    // Pas de vrai minuteur de 10 s par lecture : des milliers d'AbortSignal.timeout expirant ensemble bloquent la boucle de workerd en
    // local et font échouer d'autres tests à minuteurs simulés. En production, une invocation lit une page, donc un minuteur.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    // fetchSource (lecture et décodage) + parseSource + evaluate de chaque source d'un sous-lot, E/S D1 exclues (attente, pas de CPU).
    const PARTS = GROUPS.flatMap((g) =>
      groupParts(g).map((ids) => ({ g, ids, srcs: ids.map((id) => ACTIVE.find((s) => s.id === id)!) })),
    );
    const bytesRead = new Map<string, number>();
    const REPS = 5; // performance.now() avance par pas de 1 ms : un échantillon = moyenne de 5 passages (résolution 0,2 ms)
    const cpu = async (k: number) => {
      const t0 = performance.now();
      for (let rep = 0; rep < REPS; rep++)
        for (const s of PARTS[k].srcs) {
          const res = await fetchSource(s);
          if (!res.ok) throw new Error(`${s.id}: ${res.reason}`);
          const p = parseSource(s, res.body, res.truncated);
          if (!p.ok) throw new Error(`${s.id}: ${p.reason}`);
          for (const l of p.listings) evaluate(l, s);
          if (rep === 0) {
            bytesRead.set(s.id, res.bytes);
            if (s.stopMarker) expect(res.stopped, s.id).toBe(true);
            else expect(res.bytes, s.id).toBe(WIRE.get(s.url)!.length);
          }
        }
      return (performance.now() - t0) / REPS;
    };
    const runs: number[][] = PARTS.map(() => []),
      wall: number[] = [];
    for (let r = 0; r < 3; r++) for (let k = 0; k < PARTS.length; k++) await cpu(k); // chauffe de chaque lecteur (JIT) avant la mesure
    for (let r = 0; r < 9; r++) for (let k = 0; k < PARTS.length; k++) runs[k].push(await cpu(k)); // entrelacé : GC et bruit touchent tous les sous-lots
    for (const r of runs) r.sort((a, b) => a - b);
    const med = runs.map((r) => r[4]),
      q1 = runs.map((r) => r[0]); // médiane journalisée ; la jauge prend le meilleur des 9 (le bruit n'ajoute que du temps)
    for (const g of GROUPS.filter((x) => groupParts(x).length > 0)) {
      await runScan(E, g, t(10, 0));
      await runScan(E, g, t(10, 1)); // pour information : orchestrateur et appels /part, lectures et écritures D1 comprises
      const t1 = performance.now();
      await runScan(E, g, t(10, 2));
      wall.push(performance.now() - t1);
    }
    const label = (k: number) => `g${PARTS[k].g}:${PARTS[k].ids.join("+")}`;
    console.log(
      "PART-TIMING cpu ms (median of 9, warm) " +
        med.map((m, k) => `${label(k)}=${m.toFixed(1)}`).join(" ") +
        " | best of 9 " +
        q1.map((m, k) => `${label(k)}=${m.toFixed(1)}`).join(" ") +
        " | runScan wall incl. D1 " +
        wall.map((m, g) => `g${g}=${m.toFixed(0)}`).join(" ") +
        " | bytes read/page (stopMarker) " +
        ACTIVE.filter((s) => s.stopMarker)
          .map((s) => `${s.id}=${bytesRead.get(s.id)}/${WIRE.get(s.url)!.length}`)
          .join(" "),
    );
    // Jauge : 8 ms par sous-lot (une source), meilleur de 9. La vraie vérification reste le cpuTime des invocations /part en
    // production, plus élevé que les chiffres locaux (limite de 10 ms).
    expect(PARTS.every((p) => p.ids.length <= PART_SIZE)).toBe(true);
    for (const s of ACTIVE.filter((x) => x.stopMarker))
      expect(bytesRead.get(s.id)!, s.id).toBeLessThan(WIRE.get(s.url)!.length);
    for (let k = 0; k < PARTS.length; k++) expect(q1[k], label(k)).toBeLessThan(8);
  }, 30_000); // une quarantaine de sources, 12 passages chacune
});

import { describe, expect, it } from "vitest";
import { UNIVERSAL_MAX_CHARS } from "../src/config/universal";
import { fingerprint } from "../src/universal/fingerprint";
import { reduceMarkdown } from "../src/universal/reduce";
import laforet from "./fixtures/laforet.html?raw";
import { fakeMarkdown } from "./universal-helpers";

// Mesure de CPU : lancée seule (npm run test:cpu, sans parallélisme de fichiers), jamais avec la suite.

describe("lecteur universel : CPU", () => {
  it("CPU : la réduction d'un Markdown de page lourde (Laforêt, 1,2 Mo de HTML) reste sous la mesure d'un /part (8 ms, meilleur de 9)", () => {
    const md = fakeMarkdown(laforet);
    expect(md.length).toBeGreaterThan(100_000);
    const REPS = 5; // performance.now() avance par pas de 1 ms ici : moyenne de 5 passages
    const run = () => {
      const t0 = performance.now();
      for (let i = 0; i < REPS; i++) reduceMarkdown(md);
      return (performance.now() - t0) / REPS;
    };
    for (let i = 0; i < 3; i++) run(); // chauffe (JIT)
    const best = Math.min(...Array.from({ length: 9 }, run));
    expect(reduceMarkdown(md).length).toBeLessThanOrEqual(UNIVERSAL_MAX_CHARS);
    expect(best).toBeLessThan(8);
  }, 30_000);
  it("CPU : normalisation et SHA-256 d'un texte réduit au plafond (6 000 caractères) restent négligeables (moins de 3 ms par empreinte)", async () => {
    const big = reduceMarkdown(fakeMarkdown(laforet));
    expect(big.length).toBeGreaterThan(3_000);
    for (let i = 0; i < 20; i++) await fingerprint(big);
    const REPS = 100; // performance.now() avance par pas de 1 ms ici : moyenne de 100 passages
    const t0 = performance.now();
    for (let i = 0; i < REPS; i++) await fingerprint(big);
    expect((performance.now() - t0) / REPS).toBeLessThan(3);
  }, 30_000);
});

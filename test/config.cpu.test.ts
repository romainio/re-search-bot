import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import example from "../examples/paris-17-levallois.json";
import { derive } from "../src/derive";
import { validateInstance } from "../src/instance";
import { applyMigrations } from "../src/migrate";

// Mesure de CPU : lancée seule (npm run test:cpu, sans parallélisme de fichiers), jamais avec la suite.

describe("configuration et migrations : coût par invocation", () => {
  it("validation faite une fois par isolat : le coût d'un chargement reste très sous 10 ms", () => {
    validateInstance(example); // échauffement
    const t = performance.now();
    validateInstance(example);
    expect(performance.now() - t).toBeLessThan(10);
  });
  it("dérivation des réglages (refaite seulement quand la configuration D1 change) : pas plus coûteuse que la validation", () => {
    // performance.now() avance par pas de 1 ms ici : moyenne de REPS passages. Instances validées d'avance, une par passage : derive
    // gèle l'instance reçue, une instance déjà gelée fausserait la mesure.
    const REPS = 40;
    const fresh = Array.from({ length: REPS + 1 }, () => validateInstance(example));
    derive(fresh[REPS]); // échauffement
    let t = performance.now();
    for (let i = 0; i < REPS; i++) validateInstance(example);
    const validation = (performance.now() - t) / REPS;
    t = performance.now();
    for (let i = 0; i < REPS; i++) derive(fresh[i]);
    const derivation = (performance.now() - t) / REPS;
    console.log(
      `validation ${validation.toFixed(2)} ms, dérivation ${derivation.toFixed(2)} ms (${example.sources.length} sources)`,
    );
    expect(derivation).toBeLessThan(10);
    expect(derivation).toBeLessThanOrEqual(validation * 1.5); // marge : deux mesures successives, bruit de la machine
  });
  it("coût de la vérification d'une base déjà migrée : une lecture, quelques millisecondes", async () => {
    await applyMigrations(env.DB);
    const t = performance.now();
    await applyMigrations(env.DB);
    expect(performance.now() - t).toBeLessThan(25);
  });
});

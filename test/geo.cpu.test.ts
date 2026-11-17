import { describe, expect, it } from "vitest";
import { buildHints } from "../src/geo/hints";
import type { Listing, SourceDef } from "../src/types";

// Mesure de CPU : lancée seule (npm run test:cpu, sans parallélisme de fichiers), jamais avec la suite.

const src: SourceDef = {
  id: "wagram",
  name: "Wagram Immobilier",
  url: "https://x",
  parser: "orpi",
  group: 1,
  filteredToZones: true,
  zones: ["75017"],
  phone: null,
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
const BROCHANT = { lat: 48.89059, lon: 2.32017 };

describe("CPU des indices", () => {
  it("point dans un polygone + station la plus proche + DPE + loyer + promesse d'une annonce : bien moins de 1 ms ; 60 annonces d'une page < 8 ms (meilleur de 9)", () => {
    const listing = l("cpu", {
      title: "2P proche métro Brochant à 2 min, DPE D, non meublé construit en 1930",
      description: "Lumineux ".repeat(40),
      price: 1450,
    });
    const run = (n: number): number => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) buildHints(listing, src, { ...BROCHANT, precision: "street" });
      return (performance.now() - t0) / n;
    };
    for (let i = 0; i < 3; i++) run(60); // chauffe (JIT, expressions régulières des stations compilées à la première utilisation)
    const best = Math.min(...Array.from({ length: 9 }, () => run(60)));
    console.log(
      `GEO-TIMING ms par annonce (meilleur de 9) ${best.toFixed(3)}, pour 60 annonces ${(best * 60).toFixed(1)}`,
    );
    expect(best * 60).toBeLessThan(8);
    expect(best).toBeLessThan(1);
  });
});

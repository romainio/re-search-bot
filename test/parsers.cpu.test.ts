import { describe, expect, it } from "vitest";
import era17Raw from "./fixtures/era_17.json?raw";
import consultantsRaw from "./fixtures/consultants.html?raw";
import consultantsAllRaw from "./fixtures/consultants_all.html?raw";
import consultantsEmptyRaw from "./fixtures/consultants_empty.html?raw";
import pniRaw from "./fixtures/pni.html?raw";
import safarRaw from "./fixtures/safar.html?raw";
import { parseEra } from "../src/parsers/era";
import { parseWpapimo } from "../src/parsers/wpapimo";
import { decodeWindows1252 } from "../src/util";
import type { SourceDef } from "../src/types";

// Mesure de CPU : lancée seule (npm run test:cpu, sans parallélisme de fichiers), jamais avec la suite.

const src = (id: string, zone: string, parser = "era"): SourceDef => ({
  id,
  name: id,
  url: `https://example.com/${zone}`,
  parser: parser as SourceDef["parser"],
  group: 0,
  filteredToZones: true,
  zones: [zone],
  phone: null,
  encoding: "utf-8",
  active: true,
});
const toCp1252 = (s: string): Uint8Array =>
  Uint8Array.from(s, (ch) => (ch === "€" ? 0x80 : ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 0x3f));

describe("era : temps de parse", () => {
  it("temps de parse < 8 ms (meilleur de 9 passages à chaud)", () => {
    const s = src("era_17", "75017");
    parseEra(era17Raw, s);
    let best = Infinity;
    for (let i = 0; i < 9; i++) {
      const t = performance.now();
      parseEra(era17Raw, s);
      best = Math.min(best, performance.now() - t);
    }
    expect(best).toBeLessThan(8);
  });
});

describe("wpapimo : temps de parse", () => {
  it.each([
    ["consultants", consultantsRaw],
    ["consultants_all", consultantsAllRaw],
    ["consultants_empty", consultantsEmptyRaw],
    ["pni", pniRaw],
  ])("%s : < 8 ms (meilleur de 9 passages à chaud)", (_, raw) => {
    const s = src("x", "75017", "wpapimo");
    parseWpapimo(raw, s);
    let best = Infinity;
    for (let i = 0; i < 9; i++) {
      const t = performance.now();
      parseWpapimo(raw, s);
      best = Math.min(best, performance.now() - t);
    }
    expect(best).toBeLessThan(8);
  });
});

describe("decodeWindows1252 (chemin de production des pages ISO-8859-1)", () => {
  it("peu coûteux sur une page de 205 Ko (médiane à chaud < 1 ms) et plage 0x80-0x9F convertie", () => {
    // 205 Ko de la page de Safar, en vrais octets cp1252 : la taille de la plus grosse page windows-1252 lue jusqu'ici.
    const bytes = toCp1252(safarRaw.slice(0, 205_000));
    const d = (b: number[]) => decodeWindows1252(Uint8Array.from(b));
    expect(d([0x80, 0x85, 0x92, 0x9f, 0xe9, 0xb2])).toBe("€…’Ÿé²");
    for (let i = 0; i < 5; i++) decodeWindows1252(bytes);
    const runs: number[] = [];
    for (let b = 0; b < 15; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) decodeWindows1252(bytes);
      runs.push((performance.now() - t0) / 20);
    }
    runs.sort((x, y) => x - y);
    expect(bytes.length).toBeGreaterThan(200000);
    expect(runs[7]).toBeLessThan(1);
  });
});

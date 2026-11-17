import { afterEach, describe, expect, it, vi } from "vitest";
import { settings } from "../src/derive";
import { evaluate } from "../src/filter";

const cfg = settings();

// Mesure de CPU : lancée seule (npm run test:cpu, sans parallélisme de fichiers), jamais avec la suite.

afterEach(() => vi.restoreAllMocks());

describe("CPU des fiches (fixtures réelles, fetch mocké, octets préparés hors mesure)", () => {
  const FIX = import.meta.glob("./fixtures/detail/*.html", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >;
  const LIST = import.meta.glob("./fixtures/*", { query: "?raw", import: "default", eager: true }) as Record<
    string,
    string
  >;
  // Famille -> source, fiche, URL de fiche acceptée par le lecteur, page liste de la source.
  const CASES = [
    {
      family: "orpi",
      src: "orpi_17",
      detail: "orpi.html",
      url: "https://www.orpi.com/annonce-location-x/",
      list: "orpi.html",
    },
    {
      family: "fnaim",
      src: "fnaim_17",
      detail: "fnaim.html",
      url: "https://www.fnaim.fr/annonce-immobiliere/1/x.htm",
      list: "fnaim.html",
    },
    {
      family: "laforet",
      src: "laforet_17",
      detail: "laforet.html",
      url: "https://www.laforet.com/agence-immobiliere/x/louer/paris-17/appartement-1",
      list: "laforet.html",
    },
    {
      family: "foncia",
      src: "foncia_17",
      detail: "foncia.html",
      url: "https://fr.foncia.com/location/paris-75017/appartement/42047-14.htm",
      list: "foncia.html",
    },
  ];
  const listing = (source: string, url: string) => ({
    source,
    id: "1",
    url,
    price: 1500,
    charges: null,
    priceIsCC: null,
    surface: null,
    rooms: null,
    title: null,
    address: null,
    district: null,
    postalCode: null,
    photo: null,
    agency: null,
    phone: null,
    propertyType: null,
    publishedAt: null,
  });
  const stats = (runs: number[]) => {
    const r = [...runs].sort((a, b) => a - b);
    return { best: r[0], med: r[Math.floor(r.length / 2)] };
  };

  it("best-of-9 par fiche (lecture en flux bornée + décodage + lecteur + fusion) < 8 ms (cible 3 ms) ; sous-lot pire cas (1 source + les fiches d'un passage) < 12 ms", async () => {
    const { detailCap, enrichOne } = await import("../src/enrich");
    const { fetchSource } = await import("../src/fetch-source");
    const { parseSource } = await import("../src/scan");
    const wire = new Map<string, Uint8Array>();
    for (const c of CASES) {
      wire.set(c.url, new TextEncoder().encode(FIX[`./fixtures/detail/${c.detail}`]));
      wire.set(
        cfg.sources.dedicated.find((s) => s.id === c.src)!.url,
        new TextEncoder().encode(LIST[`./fixtures/${c.list}`]),
      );
    }
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) => new Response(wire.get(String(input instanceof Request ? input.url : input)) ?? new Uint8Array()),
    );
    // performance.now() avance par pas de 1 ms dans workerd : une mesure = moyenne de 10 fiches lues l'une après l'autre.
    const one = async (c: (typeof CASES)[number]) => {
      const src = cfg.sources.dedicated.find((s) => s.id === c.src)!;
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) {
        const r = await enrichOne(src, listing(src.id, c.url));
        if (!r.enriched) throw new Error(`${c.family}: fiche non lue`);
      }
      return (performance.now() - t0) / 10;
    };
    const part = async (c: (typeof CASES)[number]) => {
      const src = cfg.sources.dedicated.find((s) => s.id === c.src)!;
      const t0 = performance.now();
      const res = await fetchSource(src);
      if (!res.ok) throw new Error(c.src);
      const p = parseSource(src, res.body);
      if (!p.ok) throw new Error(c.src);
      for (const l of p.listings) evaluate(l, src);
      await Promise.all(Array.from({ length: detailCap(src) }, () => enrichOne(src, listing(src.id, c.url))));
      return performance.now() - t0;
    };
    const per: number[][] = CASES.map(() => []),
      parts: number[][] = CASES.map(() => []);
    for (let r = 0; r < 3; r++)
      for (const c of CASES) {
        await one(c);
        await part(c);
      } // chauffe (JIT)
    for (let r = 0; r < 9; r++)
      for (let k = 0; k < CASES.length; k++) {
        per[k].push(await one(CASES[k]));
        parts[k].push(await part(CASES[k]));
      }
    const fmt = (runs: number[][]) =>
      CASES.map((c, k) => {
        const s = stats(runs[k]);
        return `${c.family}=${s.best.toFixed(2)}/${s.med.toFixed(2)}`;
      }).join(" ");
    console.log(
      `DETAIL-TIMING ms best/median of 9 (one fiche, mean of 10) ${fmt(per)} | sub-batch = list fetch+parse+evaluate + fiches of one pass (orpi 1, others 3) ${fmt(parts)}`,
    );
    // Jauges lâches, garde-fous de régression (machine partagée avec les autres fichiers de test). La vraie vérification reste le
    // cpuTime des invocations /part en production.
    for (let k = 0; k < CASES.length; k++) expect(stats(per[k]).best, CASES[k].family).toBeLessThan(8);
    for (let k = 0; k < CASES.length; k++) expect(stats(parts[k]).best, CASES[k].family).toBeLessThan(12);
  });
});

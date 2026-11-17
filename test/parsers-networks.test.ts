// Réseaux nationaux sur une deuxième zone (commune voisine, 92300 dans l'exemple) : lecteur century21 et sources du registre de
// l'exemple rebranchées sur cette zone. Pages enregistrées telles que servies au moment de l'enregistrement, une requête par URL.
import { describe, expect, it } from "vitest";
import c21Raw from "./fixtures/century21_levallois.html?raw";
import bieniciRaw from "./fixtures/bienici_2z.json?raw";
import orpiRaw from "./fixtures/orpi_levallois.html?raw";
import fonciaRaw from "./fixtures/foncia_levallois.html?raw";
import laforetRaw from "./fixtures/laforet_levallois.html?raw";
import fnaimRaw from "./fixtures/fnaim_levallois.html?raw";
import nestennRaw from "./fixtures/nestenn_courbevoie.html?raw";
import { settings } from "../src/derive";
import { FNAIM_EMPTY } from "../src/parsers/fnaim";
import { PARSERS } from "../src/parsers/index";
import { evaluate } from "../src/filter";
import type { Listing, SourceDef } from "../src/types";

const cfg = settings();

const src = (id: string, parser: SourceDef["parser"], url: string, o: Partial<SourceDef> = {}): SourceDef => ({
  id,
  name: id,
  url,
  parser,
  group: 0,
  filteredToZones: true,
  zones: ["92300"],
  phone: null,
  encoding: "utf-8",
  active: true,
  ...o,
});

function invariants(out: Listing[], sourceId: string, count: number) {
  expect(out).toHaveLength(count);
  expect(new Set(out.map((l) => l.id)).size).toBe(count);
  for (const l of out) {
    expect(l.source).toBe(sourceId);
    expect(l.id).not.toBe("");
    expect(l.url.startsWith("https://")).toBe(true);
    expect(l.title ?? "").not.toContain("�");
    expect(l.price === null || (Number.isFinite(l.price) && l.price > 0)).toBe(true);
  }
}

describe("century21 parser (century21.fr, liste Tailwind rendue côté serveur ; v-levallois+perret)", () => {
  const C21 = "https://www.century21.fr/annonces/location-appartement/v-levallois+perret/";
  const s = src("century21_levallois", "century21", C21);
  const out = PARSERS.century21(c21Raw, s);
  const CARD = 'class="c-the-property-thumbnail-with-content js-the-property-thumbnail-with-content';

  it("5 cards of the list (« 5 annonces »), the 9 « Biens se rapprochant » cards are not read; ids = data-uid, absolute urls", () => {
    invariants(out, "century21_levallois", 5);
    expect(c21Raw).toContain("5 annonces");
    expect(c21Raw.split('data-uid="').length - 1).toBe(14); // 5 de la liste + 9 biens voisins (Neuilly…)
    expect(out.map((l) => l.id)).toEqual(["17033543879", "16974736645", "17003743854", "15743955296", "15357985824"]);
    for (const l of out) expect(l.url).toBe(`https://www.century21.fr/trouver_logement/detail/${l.id}/`);
    expect(out.every((l) => l.postalCode === "92300")).toBe(true); // « LEVALLOIS PERRET  92 » : département seul, ville reconnue
  });

  it("hand-checked: studio 38,07 m², 1 pièce, 1 146 € « par mois charges comprises » (CC), headline as title, place as address", () => {
    expect(out[0]).toEqual({
      source: "century21_levallois",
      id: "17033543879",
      url: "https://www.century21.fr/trouver_logement/detail/17033543879/",
      price: 1146,
      charges: null,
      priceIsCC: true,
      surface: 38.07,
      rooms: 1,
      title: "GRAND STUDIO NON MEUBLE AVEC BALCON A LOUER - RUE EDOUARD VAILLANT",
      address: "LEVALLOIS PERRET 92",
      district: null,
      postalCode: "92300",
      photo:
        "https://www.century21.fr/imagesBien/s3/202/3425/c21_202_3425_3298_8_F40EA746-75AF-42E2-A366-3E2D804293B4.jpg",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
  });

  it("other cards: lazy photo (data-src), surfaces, rooms and prices; the 34 m² office sold as « Appartement F2 » keeps the card's type", () => {
    expect(out.slice(1).map((l) => [l.price, l.priceIsCC, l.surface, l.rooms])).toEqual([
      [1199, true, 31.1, 1],
      [1690, true, 46.93, 2],
      [2250, true, 53.71, 3],
      [1400, true, 34, 2],
    ]);
    expect(out[1].photo).toBe(
      "https://www.century21.fr/imagesBien/s3/202/2864/c21_202_2864_10407_8_D2903DDB-0AC5-42F6-AA5E-921D742ACF9A.jpg",
    );
    expect(out[1].title).toBe("EXCLUSIVITÉ LEVALLOIS-PERRET AVENUE ANDRÉ MALRAUX");
    expect(out[4]).toMatchObject({ title: "BUREAUX A LOUER - Rue Jules Guesde", propertyType: "Appartement" });
  });

  it("evaluation (Levallois): 38,07 m² at 1 146 € CC dropped (1 room); 46,93 m² at 1 690 € and 53,71 m² at 2 250 € above; 31,10 m² and 34 m² below 35 m²", () => {
    expect(out.map((l) => (evaluate(l, s).keep ? "keep" : evaluate(l, s).reason))).toEqual([
      "pieces",
      "surface",
      "prix_haut",
      "prix_haut",
      "surface",
    ]);
  });

  it("M7 : ville ni Levallois ni Paris (« NEUILLY SUR SEINE 92 ») -> sentinelle 00000, écartée en « localisation » ; « PARIS 75017 » -> 75017", () => {
    const one = c21Raw.slice(c21Raw.indexOf(CARD), c21Raw.indexOf(CARD, c21Raw.indexOf(CARD) + 10));
    expect(one).toContain("LEVALLOIS PERRET&nbsp;  92");
    const neuilly = PARSERS.century21(one.replace("LEVALLOIS PERRET&nbsp;  92", "NEUILLY SUR SEINE&nbsp;  92"), s)[0];
    expect(neuilly).toMatchObject({ address: "NEUILLY SUR SEINE 92", postalCode: "00000" });
    expect(evaluate(neuilly, s)).toMatchObject({ keep: false, reason: "localisation" });
    expect(PARSERS.century21(one.replace("LEVALLOIS PERRET&nbsp;  92", "PARIS&nbsp;  75017"), s)[0].postalCode).toBe(
      "75017",
    );
  });

  it("price element only: « hors charges » means HC, no mention means unknown (never from the free text)", () => {
    const one = c21Raw.slice(c21Raw.indexOf(CARD), c21Raw.indexOf(CARD, c21Raw.indexOf(CARD) + 10));
    expect(PARSERS.century21(one.replace("par mois charges comprises", "par mois hors charges"), s)[0].priceIsCC).toBe(
      false,
    );
    expect(PARSERS.century21(one.replace("par mois charges comprises", "par mois"), s)[0].priceIsCC).toBeNull();
  });

  it("dedupes the same card twice; a card without data-uid is skipped; mutated card marker throws; zero cards throws (no empty state known)", () => {
    const i = c21Raw.indexOf(CARD);
    const one = c21Raw.slice(i, c21Raw.indexOf(CARD, i + 10));
    expect(PARSERS.century21(one + one, s).map((l) => l.id)).toEqual(["17033543879"]);
    expect(() => PARSERS.century21(one.replace(/data-uid="\d+"/, ""), s)).toThrow(/century21: aucune carte trouvée/);
    expect(
      PARSERS.century21(one.replace(/data-uid="\d+"/, "") + c21Raw.slice(c21Raw.indexOf(CARD, i + 10)), s),
    ).toHaveLength(4);
    expect(() => PARSERS.century21(c21Raw.split(CARD).join('class="c-the-property-x'), s)).toThrow(
      /century21: aucune carte trouvée/,
    );
    expect(() => PARSERS.century21("<html><h2>0 annonce immobilière</h2></html>", s)).toThrow(
      /century21: aucune carte trouvée/,
    );
  });
});

describe("sources rebranchées sur Levallois : URL du registre, page enregistrée (une requête), parseur existant inchangé", () => {
  const by = (id: string) => {
    const s = cfg.sources.dedicated.find((x) => x.id === id);
    if (!s) throw new Error(`source ${id} absente du registre`);
    return s;
  };
  const run = (id: string, raw: string) => PARSERS[by(id).parser](raw, by(id));
  const verdicts = (id: string, out: Listing[]) =>
    out.map((l) => {
      const e = evaluate(l, by(id));
      return e.keep ? "keep" : e.reason;
    });

  it("bienici (requête bi-zone 75017 + 92300, size 100) : 32 annonces = total, 16 du 17e et 16 de Levallois ; 5 gardées à Levallois (studios et rez-de-chaussée écartés), 4 dans le 17e", () => {
    const out = run("bienici", bieniciRaw);
    invariants(out, "bienici", 32);
    expect(JSON.parse(bieniciRaw).total).toBe(32); // tout tient dans une page de 100
    expect(out.filter((l) => l.postalCode === "75017")).toHaveLength(16);
    expect(out.filter((l) => l.postalCode === "92300")).toHaveLength(16);
    const kept = out.filter((l) => evaluate(l, by("bienici")).keep);
    expect(kept.filter((l) => l.postalCode === "92300").map((l) => l.id)).toEqual([
      "ag313862-554969873",
      "immo-facile-61536581",
      "immo-facile-56177858",
      "immo-facile-54646399",
      "dauchez-26740",
    ]);
    expect(kept.filter((l) => l.postalCode === "75017").map((l) => l.id)).toEqual([
      "ag755289-553974347",
      "ag941161-553470770",
      "ag753758-553240049",
      "hektor-cmb-194",
    ]);
  });

  it("orpi_levallois : 4 annonces, toutes en 92300 ; le T2 40,32 m² à 1 380 € (S-Immo) gardé", () => {
    const out = run("orpi_levallois", orpiRaw);
    invariants(out, "orpi_levallois", 4);
    expect(out.map((l) => [l.id, l.postalCode, l.agency])).toEqual([
      ["1506954", "92300", "JBM Levallois"],
      ["1384466", "92300", "JBM Levallois"],
      ["1365219", "92300", "Agence Gambetta"],
      ["1432575", "92300", "S-Immo"],
    ]);
    expect(out[3]).toMatchObject({ price: 1380, surface: 40.32, rooms: 2, district: "Trézel" });
    expect(verdicts("orpi_levallois", out)).toEqual(["prix_haut", "prix_haut", "surface", "keep"]);
  });

  it("foncia_levallois : 15 annonces, toutes en 92300 ; 49 m² à 1 600 € et 70 m² à 1 595 € (CC) gardés", () => {
    const out = run("foncia_levallois", fonciaRaw);
    invariants(out, "foncia_levallois", 15);
    expect(out.every((l) => l.postalCode === "92300")).toBe(true);
    expect(
      out.filter((l) => evaluate(l, by("foncia_levallois")).keep).map((l) => [l.id, l.price, l.priceIsCC, l.surface]),
    ).toEqual([
      ["30089-562", 1600, true, 49],
      ["30089-1152", 1595, true, 70],
    ]);
  });

  it("laforet_levallois : 4 annonces de Levallois avant la section « à proximité » (même parseur et même marqueur que le 17e), aucune gardée", () => {
    const out = run("laforet_levallois", laforetRaw);
    invariants(out, "laforet_levallois", 4);
    expect(out.map((l) => [l.id, l.postalCode, l.price, l.surface])).toEqual([
      ["52981751", "92300", 1150, 28.07],
      ["52973043", "92300", 4700, 112],
      ["52765717", "92300", 1400, 30],
      ["52763738", "92300", 1600, 30],
    ]);
    expect(laforetRaw.split(by("laforet_levallois").stopMarker!)).toHaveLength(2);
    expect(verdicts("laforet_levallois", out)).toEqual(["surface", "prix_haut", "surface", "surface"]);
  });

  it("fnaim_levallois (localité 38051, 900-1 700 €) : 0 annonce, état vide reconnu (bloc noResultMsg), donc [] et non une erreur", () => {
    expect(FNAIM_EMPTY.test(fnaimRaw)).toBe(true);
    expect(run("fnaim_levallois", fnaimRaw)).toEqual([]);
    expect(by("fnaim_levallois").url).toContain("%2238051%22");
    expect(by("fnaim_levallois").url).toContain("PRIX_MIN=900&PRIX_MAX=1700");
  });

  it("nestenn_courbevoie, century21_levallois : les fixtures des tests de parseur lues avec la définition du registre", () => {
    expect(run("nestenn_courbevoie", nestennRaw).map((l) => [l.postalCode, l.agency])).toEqual([
      ["92400", "Nestenn Courbevoie"],
      ["92300", "Nestenn Courbevoie"],
      ["92400", "Nestenn Courbevoie"],
    ]);
    expect(run("century21_levallois", c21Raw)).toHaveLength(5);
  });
});

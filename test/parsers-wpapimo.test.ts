// Sites maison alimentés par Apimo (Consultants Immobilier, Paris Neuilly Immobilier) : lecteur src/parsers/wpapimo.ts.
// Pages enregistrées telles que servies au moment de l'enregistrement, une requête par URL.
import { describe, expect, it } from "vitest";
import consultantsRaw from "./fixtures/consultants.html?raw";
import consultantsAllRaw from "./fixtures/consultants_all.html?raw";
import consultantsEmptyRaw from "./fixtures/consultants_empty.html?raw";
import pniRaw from "./fixtures/pni.html?raw";
import { parseWpapimo, WPAPIMO_EMPTY } from "../src/parsers/wpapimo";
import { evaluate } from "../src/filter";
import type { Listing, SourceDef } from "../src/types";

const src = (id: string, url: string, o: Partial<SourceDef> = {}): SourceDef => ({
  id,
  name: id,
  url,
  parser: "wpapimo" as SourceDef["parser"],
  group: 0,
  filteredToZones: false,
  zones: ["75017", "92300"],
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
    expect(l.id).toMatch(/^\d+$/);
    expect(l.url.startsWith("https://")).toBe(true);
    expect(l.title ?? "").not.toContain("�");
    expect(l.price === null || (Number.isFinite(l.price) && l.price > 0)).toBe(true);
    expect(l.priceIsCC).toBeNull(); // aucune mention de charges sur ces cartes
  }
}
const verdict = (l: Listing, s: SourceDef): string => {
  const e = evaluate(l, s);
  return e.keep ? "keep" : e.reason!;
};

describe("wpapimo : Consultants Immobilier (WordPress, div.property_snippet)", () => {
  const URL =
    "https://www.consultants-immobilier.com/nos-annonces/louer/?a=c_32566%2Cc_38340&t=appartement&pr=1700&srt=prix_asc";
  const s = src("consultants", URL, { filteredToZones: true });
  const out = parseWpapimo(consultantsRaw, s);

  it("liste filtrée (17e + Levallois, appartements ≤ 1 700 €) : 1 carte, complète", () => {
    invariants(out, "consultants", 1);
    expect(out[0]).toMatchObject({
      id: "85091153",
      url: "https://www.consultants-immobilier.com/annonces/louer/4424/85091153/",
      price: 1540,
      charges: null,
      priceIsCC: null,
      surface: 35,
      rooms: 2,
      title: "Appartement 2 pièces de 35.00 m²",
      address: "Levallois-Perret",
      postalCode: "92300",
      photo: "https://media.apimo.pro/cache/c0f7b3ca30d8b565f311d68255fca686_50c9cf4ad9_1920-original.jpg",
      propertyType: "Appartement",
    });
  });

  it("evaluate : le 2 pièces de Levallois (35 m², 1 540 €) est gardé, charges inconnues", () => {
    expect(evaluate(out[0], s)).toMatchObject({ keep: true, rentCC: 1540, flags: ["charges_inconnues"] });
  });

  it("liste non filtrée (16 cartes) : ids, lieux (Neuilly 92200 et Boulogne 92100 : leur code), types, carte sans surface", () => {
    const all = parseWpapimo(
      consultantsAllRaw,
      src("consultants", "https://www.consultants-immobilier.com/nos-annonces/louer/"),
    );
    invariants(all, "consultants", 16);
    expect(all.map((l) => l.id)).toEqual([
      "86822696",
      "86917446",
      "87499928",
      "87358000",
      "87505192",
      "85959431",
      "86283815",
      "85000827",
      "85488960",
      "87113756",
      "87320939",
      "83236722",
      "87021502",
      "7264800",
      "86962528",
      "87509079",
    ]);
    expect(all.map((l) => l.postalCode)).toEqual([
      "75009",
      "75009",
      "92100",
      "75003",
      "75016",
      "75017",
      "75015",
      "75007",
      "75002",
      "75016",
      "75016",
      "92200",
      "92300",
      "75005",
      "75016",
      "75016",
    ]);
    expect(all.find((l) => l.id === "85000827")).toMatchObject({
      title: "Local commercial",
      surface: null,
      rooms: null,
      price: 4616,
    });
    expect(all.find((l) => l.id === "87021502")).toMatchObject({
      propertyType: "Boutique",
      surface: 85,
      rooms: 1,
      price: 4150,
    });
    const s2 = src("consultants", "https://www.consultants-immobilier.com/nos-annonces/louer/");
    expect(all.filter((l) => verdict(l, s2) === "keep")).toEqual([]);
    expect(verdict(all.find((l) => l.id === "85959431")!, s2)).toBe("type"); // local commercial du 17e
  });

  it("carte en double ignorée", () => {
    const i = consultantsRaw.indexOf('<div class="property_snippet">');
    const card = consultantsRaw.slice(i, consultantsRaw.indexOf('<div class="attribs">', i));
    expect(parseWpapimo(consultantsRaw.slice(0, i) + card + consultantsRaw.slice(i), s)).toHaveLength(1);
  });

  it("état vide : vraie page à zéro résultat (pr=100) => [] ; marqueur absent des pages peuplées", () => {
    expect(WPAPIMO_EMPTY.test(consultantsEmptyRaw)).toBe(true);
    expect(WPAPIMO_EMPTY.test(consultantsRaw)).toBe(false);
    expect(WPAPIMO_EMPTY.test(consultantsAllRaw)).toBe(false);
    expect(WPAPIMO_EMPTY.test(pniRaw)).toBe(false);
    expect(parseWpapimo(consultantsEmptyRaw, s)).toEqual([]);
  });

  it("zéro carte sans état vide : lève", () => {
    expect(() => parseWpapimo(consultantsRaw.split('<div class="property_snippet">').join("<div>"), s)).toThrow(
      "wpapimo: aucune carte trouvée",
    );
    expect(() => parseWpapimo("<html><body>Maintenance</body></html>", s)).toThrow("wpapimo: aucune carte trouvée");
  });
});

describe("wpapimo : Paris Neuilly Immobilier (div.finder-item, attributs data-finder*)", () => {
  const s = src("pni", "https://www.parisneuillyimmobilier.com/louer.html", { phone: "01 40 55 07 77" });
  const out = parseWpapimo(pniRaw, s);

  it("6 cartes, les 20 emplacements « flexfix » et les zones de la carte SVG ignorés", () => {
    invariants(out, "pni", 6);
    expect(pniRaw.split('<div class="finder-item flexfix"></div>').length - 1).toBe(20);
    expect(out.map((l) => l.id)).toEqual(["87445649", "752868", "87333909", "87133319", "85105729", "85410887"]);
    expect(out.map((l) => l.postalCode)).toEqual(["75016", "92150", "75017", "75016", "75017", "92300"]);
    expect(out.every((l) => l.rooms === null)).toBe(true); // data-finderrooms = chambres, pas pièces
  });

  it("une carte complète", () => {
    expect(out[2]).toMatchObject({
      id: "87333909",
      url: "https://www.parisneuillyimmobilier.com/louer/87333909.html",
      price: 2295,
      charges: null,
      priceIsCC: null,
      surface: 52,
      rooms: null,
      title: "Paris 17ème",
      address: "Paris 17ème",
      postalCode: "75017",
      photo: "https://media.apimo.pro/cache/a6921e45255f3ca6a2a70ee853fb2a48_979e67adc1_1920-original.jpg",
      propertyType: null,
    });
  });

  it("evaluate : aucune gardée aujourd'hui (17e et Levallois au-dessus du plafond, autres villes hors zones)", () => {
    expect(out.map((l) => verdict(l, s))).toEqual([
      "localisation",
      "localisation",
      "prix_haut",
      "localisation",
      "prix_haut",
      "prix_haut",
    ]);
  });

  it("carte en double ignorée", () => {
    const i = pniRaw.indexOf('<div class="finder-item hidden"');
    const card = pniRaw.slice(i, pniRaw.indexOf("</a>", i) + 4);
    expect(parseWpapimo(pniRaw.slice(0, i) + card + pniRaw.slice(i), s)).toHaveLength(6);
  });

  it("zéro carte : lève (le panneau « finder-empty », toujours présent et masqué, n'est pas un état vide)", () => {
    expect(pniRaw).toContain('class="finder-empty');
    expect(() => parseWpapimo(pniRaw.split('<div class="finder-item hidden"').join("<div"), s)).toThrow(
      "wpapimo: aucune carte trouvée",
    );
  });
});

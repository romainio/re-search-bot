// Lecteur at1605 (gabarit « _siteAT1605 ») : Levallois Immobilier (LEVIMMO). Pages enregistrées telles que servies au moment de l'enregistrement,
// une requête par URL ; page vide : même liste avec budget max 1 € (&max=1).
import { describe, expect, it } from "vitest";
import levimmoRaw from "./fixtures/levimmo.html?raw";
import levimmoEmptyRaw from "./fixtures/levimmo_empty.html?raw";
import { AT1605_EMPTY, parseAt1605 } from "../src/parsers/at1605";
import { evaluate } from "../src/filter";
import type { Listing, SourceDef } from "../src/types";

const URL = "https://www.levallois-immobilier.fr/location-appartement-levallois/&new_research=1";
const s: SourceDef = {
  id: "levimmo",
  name: "Levallois Immobilier",
  url: URL,
  parser: "at1605" as SourceDef["parser"],
  group: 0,
  zones: ["92300"],
  filteredToZones: false,
  phone: "01 40 89 07 07",
  encoding: "utf-8",
  active: true,
};
const CARD = '<article class="annonce_listing"';

function invariants(out: Listing[], count: number) {
  expect(out).toHaveLength(count);
  expect(new Set(out.map((l) => l.id)).size).toBe(count);
  for (const l of out) {
    expect(l.source).toBe("levimmo");
    expect(l.url.startsWith("https://www.levallois-immobilier.fr/vente-location-appartement-levallois/ref-")).toBe(
      true,
    );
    expect(l.title ?? "").not.toContain("�");
    expect(l.price === null || (Number.isFinite(l.price) && l.price > 0)).toBe(true);
  }
}

describe("at1605 parser (Levallois Immobilier, liste des locations, une page)", () => {
  const out = parseAt1605(levimmoRaw, s);

  it("5 cartes ; id = référence du lien (ref-zk1-<n>) ; 2 appartements, 2 bureaux et un local Paris 6e", () => {
    invariants(out, 5);
    expect(out.map((l) => l.id)).toEqual(["zk1-2213", "zk1-1630", "zk1-2210", "zk1-2216", "zk1-2215"]);
    expect(out.map((l) => l.propertyType)).toEqual([
      "Local d'activité",
      "Bureau",
      "Bureau",
      "Appartement",
      "Appartement",
    ]);
    expect(out.map((l) => l.postalCode)).toEqual(["75006", "92300", "92300", "92300", "92300"]);
  });

  it("carte relue à la main : 2 pièces 32 m², « Loyer : 1 050 € par mois » + « Charges comprises * » (CC)", () => {
    expect(out[3]).toEqual({
      source: "levimmo",
      id: "zk1-2216",
      url: "https://www.levallois-immobilier.fr/vente-location-appartement-levallois/ref-zk1-2216/location-appartement-2-pieces-1-chambre-levallois-perret-92300/",
      price: 1050,
      charges: null,
      priceIsCC: true,
      surface: 32,
      rooms: 2,
      title: "appartement 2 pièces en location sur LEVALLOIS PERRET (92300)",
      address: "LEVALLOIS PERRET 92300",
      district: null,
      postalCode: "92300",
      photo: "https://www.levallois-immobilier.fr/datas/biens/thumbs/1599/1599_00-2026-10-20-0220.jpg",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
    expect(out[4]).toMatchObject({ id: "zk1-2215", price: 915, priceIsCC: true, surface: 25, rooms: 2 });
  });

  it("loyers annuels « /an HC HT* » (bureaux, local) : pas de prix ; surfaces lues, pas de pièces", () => {
    expect(levimmoRaw).toMatch(/Loyer : 21\s600\s&euro; \/an HC HT\*/);
    expect(out.slice(0, 3).map((l) => [l.price, l.priceIsCC, l.surface, l.rooms])).toEqual([
      [null, null, 33, null],
      [null, null, 75, null],
      [null, null, 36, null],
    ]);
  });

  it("evaluate aujourd'hui : rien de gardé (local et bureaux exclus par le type, appartements de 32 et 25 m² sous 35 m²)", () => {
    expect(out.map((l) => evaluate(l, s).reason ?? "keep")).toEqual(["type", "type", "type", "surface", "surface"]);
    const big = parseAt1605(
      levimmoRaw.replace("<strong> de 32 m&sup2;</strong>", "<strong> de 40 m&sup2;</strong>"),
      s,
    )[3];
    expect(evaluate(big, s)).toEqual({ keep: true, rentCC: 1050, flags: [] });
  });

  it("CC/HC lu dans le seul bloc du prix : sans « Charges comprises » inconnu, « Hors charges » HC", () => {
    const j = levimmoRaw.lastIndexOf(CARD, levimmoRaw.indexOf("ref-zk1-2216"));
    const card = levimmoRaw.slice(j, levimmoRaw.indexOf("</article>", j) + 10);
    expect(parseAt1605(card.replace("Charges comprises", ""), s)[0].priceIsCC).toBeNull();
    expect(parseAt1605(card.replace("Charges comprises", "Hors charges"), s)[0].priceIsCC).toBe(false);
  });

  it("carte en double ignorée ; carte sans lien sautée ; zéro carte lève", () => {
    const i = levimmoRaw.lastIndexOf(CARD);
    const card = levimmoRaw.slice(i, levimmoRaw.indexOf("</article>", i) + 10);
    expect(parseAt1605(card + card, s).map((l) => l.id)).toEqual(["zk1-2215"]);
    expect(() => parseAt1605(card.replace(/\/ref-zk1-2215\//g, "/x/"), s)).toThrow(/at1605: aucune carte trouvée/);
    expect(() => parseAt1605(levimmoRaw.split(CARD).join('<article class="x"'), s)).toThrow(
      /at1605: aucune carte trouvée/,
    );
  });

  it("état vide réel (budget max 1 €, 20/10) : [] ; marqueur absent de la page peuplée ; sans lui, zéro carte lève", () => {
    expect(levimmoEmptyRaw).toMatch(AT1605_EMPTY);
    expect(levimmoRaw).not.toMatch(AT1605_EMPTY);
    expect(levimmoEmptyRaw).not.toContain(CARD);
    expect(parseAt1605(levimmoEmptyRaw, s)).toEqual([]);
    expect(() => parseAt1605(levimmoEmptyRaw.replace(AT1605_EMPTY, "<p>"), s)).toThrow(/at1605: aucune carte trouvée/);
  });
});

// Lecteur caimmo : Crédit Agricole Immobilier, location, listes filtrées par commune.
// Pages enregistrées telles que servies au moment de l'enregistrement, une requête par URL ; page vide : commune sans stock (23001 Ahun).
import { describe, expect, it } from "vitest";
import levRaw from "./fixtures/ca_immo_levallois.html?raw";
import p17Raw from "./fixtures/ca_immo_17.html?raw";
import emptyRaw from "./fixtures/ca_immo_empty.html?raw";
import levEmptyRaw from "./fixtures/ca_immo_levallois_empty.html?raw";
import { CAIMMO_EMPTY, parseCaImmo } from "../src/parsers/caimmo";
import { evaluate } from "../src/filter";
import type { Listing, SourceDef } from "../src/types";

const src = (id: string, url: string, zone: string): SourceDef => ({
  id,
  name: "Crédit Agricole Immobilier",
  url,
  parser: "caimmo" as SourceDef["parser"],
  group: 0,
  zones: [zone],
  filteredToZones: true,
  phone: "05 34 40 17 98",
  encoding: "utf-8",
  active: true,
});
const LEV = src(
  "ca_immo_levallois",
  "https://www.ca-immobilier.fr/louer/location/appartement/92044/Levallois-Perret",
  "92300",
);
const P17 = src("ca_immo_17", "https://www.ca-immobilier.fr/louer/location/appartement/75117/Paris%2017e", "75017");
const CARD = '<article class="sub_card-entities">';

function invariants(out: Listing[], sourceId: string, count: number) {
  expect(out).toHaveLength(count);
  expect(new Set(out.map((l) => l.id)).size).toBe(count);
  for (const l of out) {
    expect(l.source).toBe(sourceId);
    expect(l.url).toBe(`https://www.ca-immobilier.fr/biens/location/C3A/${l.id}`);
    expect(l.title ?? "").not.toContain("�");
    expect(l.price === null || (Number.isFinite(l.price) && l.price > 0)).toBe(true);
  }
}

describe("caimmo parser (ca-immobilier.fr, location filtrée par commune)", () => {
  const lev = parseCaImmo(levRaw, LEV);
  const p17 = parseCaImmo(p17Raw, P17);

  it("Levallois : 2 cartes (« 2 résultats ») ; les encarts --push et --blocliens ne sont pas lus ; id = numéro de lot", () => {
    invariants(lev, "ca_immo_levallois", 2);
    expect(levRaw).toContain('id="nombre-resultat"><span>2</span> résultats');
    expect(levRaw).toContain("sub_card-entities--push");
    expect(lev.map((l) => l.id)).toEqual(["56666", "56670"]);
  });

  it("carte relue à la main : T2 35 m² « au prix de (par mois) 1 017 € », « Loyer hors charges : 897 € » -> 897 HC + 120 de charges", () => {
    expect(lev[1]).toEqual({
      source: "ca_immo_levallois",
      id: "56670",
      url: "https://www.ca-immobilier.fr/biens/location/C3A/56670",
      price: 897,
      charges: 120,
      priceIsCC: false,
      surface: 35,
      rooms: 2,
      title: "T2 - 35m²",
      address: "LEVALLOIS PERRET (92300)",
      district: null,
      postalCode: "92300",
      photo: "https://www.ca-immobilier.fr/assets/media-infos/1052400/small",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
    expect(lev[0]).toMatchObject({
      id: "56666",
      price: 837,
      charges: 85,
      priceIsCC: false,
      surface: 21,
      rooms: 1,
      title: "Studio - 21m²",
    });
  });

  it("17e : 2 cartes (T5 238 m², T6 174 m²), « PARIS (75017) » et « PARIS 17EME (75017) »", () => {
    invariants(p17, "ca_immo_17", 2);
    expect(p17.map((l) => [l.id, l.price, l.charges, l.surface, l.rooms, l.postalCode])).toEqual([
      ["66003", 5957, 705, 238, 5, "75017"],
      ["116737", 6090, 700, 174, 6, "75017"],
    ]);
  });

  it("evaluate aujourd'hui : Levallois 35 m² à 1 017 € CC gardé, studio 21 m² écarté ; 17e au-dessus du budget", () => {
    expect(lev.map((l) => evaluate(l, LEV).reason ?? "keep")).toEqual(["surface", "keep"]);
    expect(evaluate(lev[1], LEV)).toEqual({ keep: true, rentCC: 1017, flags: [] });
    expect(p17.map((l) => evaluate(l, P17))).toMatchObject([
      { keep: false, reason: "prix_haut", rentCC: 6662 },
      { keep: false, reason: "prix_haut", rentCC: 6790 },
    ]);
  });

  it("sans « Loyer hors charges » : prix affiché, CC inconnu ; loyer HC égal au prix : HC, charges inconnues", () => {
    const i = levRaw.lastIndexOf(CARD);
    const card = levRaw.slice(i, levRaw.indexOf("</article>", i) + 10);
    const noHc = parseCaImmo(card.replace(/<div class="charge">[\s\S]*?<\/div><\/div>/, ""), LEV)[0];
    expect(noHc).toMatchObject({ price: 1017, charges: null, priceIsCC: null });
    expect(evaluate(noHc, LEV).flags).toEqual(["charges_inconnues"]);
    expect(parseCaImmo(card.replace("<span>897 €</span>", "<span>1 017 €</span>"), LEV)[0]).toMatchObject({
      price: 1017,
      charges: null,
      priceIsCC: false,
    });
  });

  it("carte en double ignorée ; carte sans lien sautée ; zéro carte lève", () => {
    const i = levRaw.lastIndexOf(CARD);
    const card = levRaw.slice(i, levRaw.indexOf("</article>", i) + 10);
    expect(parseCaImmo(card + card, LEV).map((l) => l.id)).toEqual(["56670"]);
    expect(() => parseCaImmo(card.replace(/C3A&#x2F;56670/g, "C3A&#x2F;x"), LEV)).toThrow(
      /caimmo: aucune carte trouvée/,
    );
    expect(() => parseCaImmo(levRaw.split(CARD).join('<article class="x">'), LEV)).toThrow(
      /caimmo: aucune carte trouvée/,
    );
  });

  it("état vide réel (commune 23001 Ahun, 20/10 : « 0 résultat ») : [] ; marqueur absent des pages peuplées ; sans lui, zéro carte lève", () => {
    expect(emptyRaw).toMatch(CAIMMO_EMPTY);
    expect(levRaw).not.toMatch(CAIMMO_EMPTY);
    expect(p17Raw).not.toMatch(CAIMMO_EMPTY);
    expect(emptyRaw).not.toContain(CARD);
    expect(emptyRaw).toContain("sub_card-entities--blocliens"); // encart de liens présent même sans bien
    expect(parseCaImmo(emptyRaw, LEV)).toEqual([]);
    expect(() => parseCaImmo(emptyRaw.replace(CAIMMO_EMPTY, "<p"), LEV)).toThrow(/caimmo: aucune carte trouvée/);
  });

  it("Levallois le 09/11 : la vraie page de l'URL de la source dit « 0 résultat » (le 20/10 : 2) ; [] sans erreur, marqueur strict absent de la page peuplée", () => {
    expect(levEmptyRaw).toMatch(CAIMMO_EMPTY);
    expect(levEmptyRaw).not.toContain(CARD);
    expect(levRaw).not.toMatch(CAIMMO_EMPTY);
    expect(parseCaImmo(levEmptyRaw, LEV)).toEqual([]);
    expect(() => parseCaImmo(levEmptyRaw.replace(CAIMMO_EMPTY, "<p"), LEV)).toThrow(/caimmo: aucune carte trouvée/);
  });
});

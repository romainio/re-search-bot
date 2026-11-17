// Réseau Frédélion (plateforme Billie.immo) : liste du réseau entier, triée par prix décroissant, deux pages. Pages enregistrées telles que servies au moment de l'enregistrement,
// une requête par URL ; ?page=9 (au-delà de la dernière) pour l'état vide.
import { describe, expect, it } from "vitest";
import p1Raw from "./fixtures/fredelion.html?raw";
import p2Raw from "./fixtures/fredelion_p2.html?raw";
import emptyRaw from "./fixtures/fredelion_p2-empty.html?raw";
import { BILLIE_EMPTY, parseBillie } from "../src/parsers/billie";
import { evaluate } from "../src/filter";
import type { Listing, SourceDef } from "../src/types";

const URL1 = "https://www.fredelion.com/fr/immobilier/location";
const URL2 = "https://www.fredelion.com/fr/immobilier/location?page=2";
const src = (id: string, url: string): SourceDef => ({
  id,
  name: id,
  url,
  parser: "billie" as SourceDef["parser"],
  group: 0,
  filteredToZones: false,
  zones: ["75017", "92300"],
  phone: null,
  encoding: "utf-8",
  active: true,
});
const CARD = '<div class="item-property';
const STOP = "container-cta-purchase-project"; // stopMarker proposé : une fois, après la dernière carte

function invariants(out: Listing[], sourceId: string, count: number) {
  expect(out).toHaveLength(count);
  expect(new Set(out.map((l) => l.id)).size).toBe(count);
  for (const l of out) {
    expect(l.source).toBe(sourceId);
    expect(l.id).toMatch(/^\d+$/);
    expect(l.url).toBe(`${l.url.slice(0, l.url.lastIndexOf("/"))}/${l.id}`);
    expect(l.url.startsWith("https://www.fredelion.com/fr/immobilier/location/")).toBe(true);
    expect(l.title ?? "").not.toContain("�");
    expect(l.price === null || (Number.isFinite(l.price) && l.price > 0)).toBe(true);
    expect(l.priceIsCC).toBe(true); // « €/mois CC » sur toutes les cartes
  }
}
/** Verdict d'evaluate : « keep » ou la raison du rejet. */
const verdict = (l: Listing, s: SourceDef): string => {
  const e = evaluate(l, s);
  return e.keep ? "keep" : e.reason!;
};

describe("billie parser (Frédélion, page 1 : biens les plus chers du réseau)", () => {
  const s = src("fredelion", URL1);
  const out = parseBillie(p1Raw, s);

  it("23 annonces sur 24 cartes : la carte « loué » (/fr/immobilier/loue/…/66151) est ignorée ; ids = id final du lien", () => {
    invariants(out, "fredelion", 23);
    expect(p1Raw.split(CARD)).toHaveLength(25);
    expect(p1Raw).toContain("42 biens à louer");
    expect(p1Raw).toContain(
      "/fr/immobilier/loue/appartement/paris/5-pieces-loue-meuble-rue-saint-charles-paris-xv/66151",
    );
    expect(out.map((l) => l.id)).not.toContain("66151");
    expect(out.slice(0, 3).map((l) => l.id)).toEqual(["113715", "114050", "118683"]);
    expect(out.map((l) => l.price)).toEqual([...out.map((l) => l.price)].sort((a, b) => b! - a!)); // tri par prix décroissant
  });

  it("codes postaux : arrondissement du titre (« PARIS 16e », « PARIS 75011 », « Paris XIII »), « NATION » inconnu, autre ville : son code (commune exclue de la configuration) ou 00000", () => {
    const pc = (id: string) => out.find((l) => l.id === id)!.postalCode;
    expect(pc("118683")).toBe("75016"); // PARIS 16e - ÉLÉGANT 121 M²…
    expect(pc("118410")).toBe("75011"); // PARIS 75011 RUE OBERKAMPF
    expect(pc("118779")).toBe("75013"); // F2 loué meublé - Paris XIII - Rue Cantagrel
    expect(pc("115513")).toBeNull(); // NATION - 5 PIECES (lien /paris/, pas d'arrondissement)
    expect(pc("112305")).toBe("92100"); // /boulogne-billancourt/ : commune exclue de l'exemple
    expect(pc("119065")).toBe("92200"); // /neuilly-sur-seine/ : commune exclue de l'exemple
  });

  it("local professionnel « 0 pièce(s) » : type « Immobilier professionnel », pièces inconnues", () => {
    expect(out.find((l) => l.id === "117914")).toMatchObject({
      propertyType: "Immobilier professionnel",
      rooms: null,
      surface: 38,
      price: 1800,
    });
  });

  it("evaluate : rien de gardé en page 1 (tout hors zones ou au-dessus du loyer maximum)", () => {
    expect(out.filter((l) => verdict(l, s) === "keep")).toEqual([]);
    expect(verdict(out.find((l) => l.id === "115513")!, s)).toBe("prix_haut");
  });
});

describe("billie parser (Frédélion, page 2 : biens les moins chers, dont Ternes et Levallois)", () => {
  const s = src("fredelion_p2", URL2);
  const out = parseBillie(p2Raw, s);

  it("18 cartes, ids et URL absolues", () => {
    invariants(out, "fredelion_p2", 18);
    expect(p2Raw.split(CARD)).toHaveLength(19);
    expect(out.map((l) => l.id)).toEqual([
      "114894",
      "117341",
      "120422",
      "119066",
      "120562",
      "119633",
      "120061",
      "117749",
      "119794",
      "119063",
      "120563",
      "119220",
      "110380",
      "50426",
      "88177",
      "117234",
      "108984",
      "60617",
    ]);
  });

  it("carte complète : PARIS 17 - TERNES, 2 pièces 41 m², 1 279 € CC", () => {
    expect(out[4]).toEqual({
      source: "fredelion_p2",
      id: "120562",
      url: "https://www.fredelion.com/fr/immobilier/location/appartement/paris/paris-17-ternes/120562",
      price: 1279,
      charges: null,
      priceIsCC: true,
      surface: 41,
      rooms: 2,
      title: "PARIS 17 - TERNES",
      address: null,
      district: null,
      postalCode: "75017",
      photo: "https://d1qnwm12upkw2t.cloudfront.net/P4578/WyPDLh4HQq/PARIS_17_TERNES_0_stamp.webp",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
    expect(out[3]).toMatchObject({
      id: "119066",
      title: "LEVALLOIS-PERRET - IMPASSE GRAVEL",
      postalCode: "92300",
      price: 1361,
      surface: 43,
      rooms: 3,
    });
    expect(out[2]).toMatchObject({ id: "120422", postalCode: "92110" }); // CLICHY 92110 : code du titre, hors zones
  });

  it("evaluate : Levallois 43 m² 1 361 € CC et Ternes 41 m² 1 279 € CC gardés ; le reste hors zones, parkings ou trop petit", () => {
    expect(out.map((l) => verdict(l, s))).toEqual([
      "localisation",
      "localisation",
      "localisation",
      "keep",
      "keep",
      "localisation",
      "localisation",
      "localisation",
      "localisation",
      "localisation",
      "type",
      "type",
      "type",
      "type",
      "type",
      "type",
      "type",
      "type",
    ]);
    expect(evaluate(out[3], s)).toEqual({ keep: true, rentCC: 1361, flags: [] });
    expect(evaluate(out[4], s)).toEqual({ keep: true, rentCC: 1279, flags: [] });
  });

  it("Paris en chiffres romains (« Paris XV ») ; « Parking / box Paris » sans arrondissement : inconnu", () => {
    expect(out.find((l) => l.id === "50426")!.postalCode).toBe("75015");
    expect(out.find((l) => l.id === "110380")!.postalCode).toBeNull();
  });
});

describe("billie parser : robustesse, état vide, stopMarker, CPU", () => {
  const s = src("fredelion_p2", URL2);
  const i = p2Raw.indexOf(CARD, p2Raw.indexOf(CARD, p2Raw.indexOf(CARD) + 10) + 10); // 3e carte (CLICHY)
  const one = p2Raw.slice(i, p2Raw.indexOf(CARD, i + 10));

  it("carte en double ignorée ; prix HC ou sans mention : priceIsCC false / null ; prix annuel non lu", () => {
    const twice = parseBillie(one + one, s);
    expect(twice).toHaveLength(1);
    expect(twice[0].id).toBe("120422");
    expect(parseBillie(one.replace("/mois CC", "/mois HC"), s)[0].priceIsCC).toBe(false);
    expect(parseBillie(one.replace("/mois CC", "/mois"), s)[0].priceIsCC).toBeNull();
    expect(parseBillie(one.replace("/mois CC", "/an CC"), s)[0]).toMatchObject({ price: null, priceIsCC: null });
  });

  it("ville du lien : levallois-perret -> 92300 même sans le nom dans le titre ; autre ville nommant Levallois -> jamais 92300", () => {
    expect(
      parseBillie(one.replaceAll("/clichy/", "/levallois-perret/").replaceAll("CLICHY 92110 RUE", "RUE"), s)[0]
        .postalCode,
    ).toBe("92300");
    expect(
      parseBillie(
        one.replaceAll("/clichy/", "/neuilly-sur-seine/").replaceAll("CLICHY 92110 RUE", "PONT DE LEVALLOIS RUE"),
        s,
      )[0].postalCode,
    ).toBe("92200"); // la commune du lien, jamais 92300
    expect(
      parseBillie(
        one.replaceAll("/clichy/", "/paris/").replaceAll("CLICHY 92110 RUE", "PARIS - PONT DE LEVALLOIS"),
        s,
      )[0].postalCode,
    ).toBeNull();
  });

  it("zéro carte lève ; page seulement « loué » : liste vide sans erreur", () => {
    expect(() => parseBillie("<html><body>maintenance</body></html>", s)).toThrow("billie: aucune carte trouvée");
    expect(() => parseBillie(p2Raw.replaceAll(CARD, '<div class="item-x'), s)).toThrow("billie: aucune carte trouvée");
    expect(parseBillie(one.replaceAll("/immobilier/location/", "/immobilier/loue/"), s)).toEqual([]);
  });

  it('état vide (vraie page ?page=9) : <div class="no-results">, liste vide ; marqueur absent des pages peuplées', () => {
    expect(emptyRaw).toMatch(BILLIE_EMPTY);
    expect(emptyRaw).not.toContain(CARD);
    expect(p1Raw).not.toMatch(BILLIE_EMPTY);
    expect(p2Raw).not.toMatch(BILLIE_EMPTY);
    expect(parseBillie(emptyRaw, s)).toEqual([]);
  });

  it("stopMarker « container-cta-purchase-project » : une seule fois, après la dernière carte ; mêmes annonces sur la page coupée", () => {
    for (const [raw, id] of [
      [p1Raw, "fredelion"],
      [p2Raw, "fredelion_p2"],
    ] as const) {
      expect(raw.split(STOP)).toHaveLength(2);
      expect(raw.lastIndexOf(CARD)).toBeLessThan(raw.indexOf(STOP));
      const cut = raw.slice(0, raw.indexOf(STOP) + STOP.length);
      expect(parseBillie(cut, src(id, URL1))).toEqual(parseBillie(raw, src(id, URL1)));
    }
    expect(emptyRaw).not.toContain(STOP); // page vide lue en entier (142 Ko)
  });
});

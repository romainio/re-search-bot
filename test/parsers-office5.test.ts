// Lecteur office5 (immo-facile, pages ISO-8859-1) : Imax (Levallois, Paris), Mister Property, F.G.D.I Pereire, Safar.
// Pages enregistrées telles que servies au moment de l'enregistrement, une requête par URL ; page vide : Imax sur une commune
// sans stock (Marseille), même gabarit d'URL.
import { describe, expect, it } from "vitest";
import imaxRaw from "./fixtures/imax_levallois.html?raw";
import imaxEmptyRaw from "./fixtures/imax_levallois_empty.html?raw";
import imaxParisRaw from "./fixtures/imax_paris.html?raw";
import misterRaw from "./fixtures/mister_property.html?raw";
import pereireRaw from "./fixtures/agence_pereire.html?raw";
import safarRaw from "./fixtures/safar.html?raw";
import { OFFICE5_EMPTY, parseOffice5 } from "../src/parsers/office5";
import { evaluate } from "../src/filter";
import { decodeWindows1252 } from "../src/util";
import type { Listing, SourceDef } from "../src/types";

const src = (id: string, url: string, zones: string[], filteredToZones: boolean): SourceDef => ({
  id,
  name: id,
  url,
  parser: "office5" as SourceDef["parser"],
  group: 0,
  zones,
  filteredToZones,
  phone: null,
  encoding: "windows-1252",
  active: true,
});

// ?raw lit la page cp1252 comme de l'utf-8 (², è, é deviennent U+FFFD) : on rend les caractères des champs testés, puis on passe par
// de vrais octets cp1252 -> decodeWindows1252, le chemin de fetchSource en production (les autres U+FFFD deviennent « ? »).
const toCp1252 = (s: string): Uint8Array =>
  Uint8Array.from(s, (ch) => (ch === "€" ? 0x80 : ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 0x3f));
const page = (raw: string): string =>
  decodeWindows1252(
    toCp1252(
      raw
        .replace(/m�/g, "m²")
        .replace(/pi�ce/g, "pièce")
        .replace(/PI�CE/g, "PIÈCE")
        .replace(/meubl�/g, "meublé")
        .replace(/MEUBL�/g, "MEUBLÉ")
        .replace(/R�f/g, "Réf")
        .replace(/ �\/mois/gi, " €/mois")
        .replace(/Kl�ber/g, "Kléber")
        .replace(/Ch�telet/g, "Châtelet")
        .replace(/d�rogatoire/g, "dérogatoire")
        .replace(/ � louer/g, " à louer")
        .replace(/pure (\d)�/g, "pure $1è"),
    ),
  );

const IMAX = "https://www.imax.fr/ville_bien/Levallois+Perret__1__Location/immobilier-levallois-perret.html";
const IMAX_PARIS = "https://www.imax.fr/ville_bien/Paris__1__Location/immobilier-paris.html";
const MISTER = "https://www.mister-property.fr/annonces/transaction/Location.html";
const PEREIRE = "https://www.agencepereire.com/annonces/transaction/Location.html";
const SAFAR = "https://www.safar.fr/annonces/transaction/Location.html";
const SAFAR_STOP = '<div class="barre-navigation-bottom">';

function invariants(out: Listing[], sourceId: string, count: number) {
  expect(out).toHaveLength(count);
  expect(new Set(out.map((l) => l.id)).size).toBe(count);
  for (const l of out) {
    expect(l.source).toBe(sourceId);
    expect(l.id).toMatch(/^\d+$/);
    expect(l.url).toMatch(new RegExp(`^https://www\\.[a-z-]+\\.(fr|com)/fiches/[\\d-]+_${l.id}/`));
    expect(l.title ?? "").not.toContain("�");
    expect(l.price === null || (Number.isFinite(l.price) && l.price > 0)).toBe(true);
  }
}
const verdicts = (out: Listing[], s: SourceDef) =>
  out.map((l) => {
    const e = evaluate(l, s);
    return e.keep ? "keep" : e.reason;
  });

describe("office5 parser : Imax Levallois (habillage listing__item, URL filtrée sur Levallois-Perret)", () => {
  const s = src("imax_levallois", IMAX, ["92300"], true);
  const out = parseOffice5(page(imaxRaw), s);

  it("7 cartes (page du 09/11) ; id = numéro de bien du lien ../fiches/<catégorie>_<id>/ (pas la « Réf. 8960 »), url absolue sous la <base> /catalog/", () => {
    invariants(out, "imax_levallois", 7);
    expect(out.map((l) => l.id)).toEqual([
      "61724488",
      "61724272",
      "61724384",
      "61724390",
      "61716584",
      "61717242",
      "61679843",
    ]);
    expect(out[0].url).toMatch(/^https:\/\/www\.imax\.fr\/fiches\/3-32-\d+_61724488\//);
    expect(
      out.every(
        (l) => l.postalCode === "92300" && l.address === "92300 LEVALLOIS PERRET" && l.propertyType === "Appartement",
      ),
    ).toBe(true);
  });

  it("carte vérifiée à la main : 2 pièces 25,03 m², « Loyer 1 305 €/mois » sans mention de charges (CC inconnu)", () => {
    expect(out[2]).toEqual({
      source: "imax_levallois",
      id: "61724384",
      url: "https://www.imax.fr/fiches/3-32-35_61724384/appartement-levallois-perret-2-piece-s-25-03-m2.html",
      price: 1305,
      charges: null,
      priceIsCC: null,
      surface: 25.03,
      rooms: 2,
      title: "Appartement Levallois Perret 2 pièce(s) 25.03 m2",
      address: "92300 LEVALLOIS PERRET",
      district: null,
      postalCode: "92300",
      photo: "https://www.imax.fr/office5/imaxparis9_290524/catalog/images/pr_p/6/1/7/2/4/3/8/4/61724384a.jpg",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
    expect(out.map((l) => [l.price, l.surface, l.rooms])).toEqual([
      [2200, 72, 3],
      [1780, 50, 2],
      [1305, 25.03, 2],
      [1400, 47, 3],
      [1600, 45, 2],
      [3300, 82, 4],
      [2000, 60, 3],
    ]);
  });

  it("evaluate : le 47 m² à 1 400 € et le 45 m² à 1 600 € sont gardés (charges inconnues) ; 25 m² sous la surface, les autres au-dessus du budget", () => {
    expect(verdicts(out, s)).toEqual(["prix_haut", "prix_haut", "surface", "keep", "keep", "prix_haut", "prix_haut"]);
    expect(evaluate(out[3], s)).toEqual({ keep: true, rentCC: 1400, flags: ["charges_inconnues"] });
  });

  it('état vide réel (même URL sur Marseille, 20/10 : <div id="page_no_products"> « Nous n\'avons pas de biens… ») : [] ; marqueur absent des 5 pages peuplées ; sans lui, zéro carte lève', () => {
    expect(imaxEmptyRaw).toContain(OFFICE5_EMPTY);
    expect(imaxEmptyRaw).toContain("Nous n'avons pas de biens &agrave; vous proposer");
    for (const raw of [imaxRaw, imaxParisRaw, misterRaw, pereireRaw, safarRaw])
      expect(raw).not.toContain(OFFICE5_EMPTY);
    expect(parseOffice5(imaxEmptyRaw, s)).toEqual([]);
    expect(() => parseOffice5(imaxEmptyRaw.replace(OFFICE5_EMPTY, "<div>"), s)).toThrow(
      /office5: aucune carte trouvée/,
    );
  });
});

describe("office5 parser : Imax Paris (même habillage, Paris entier)", () => {
  const s = src("imax_paris", IMAX_PARIS, ["75017"], false);
  const out = parseOffice5(page(imaxParisRaw), s);
  it("4 cartes du 16e, 18e (2) et 15e, code postal lu sur la carte, écartées en « localisation »", () => {
    invariants(out, "imax_paris", 4);
    expect(out.map((l) => [l.id, l.postalCode, l.price, l.surface, l.rooms])).toEqual([
      ["61724417", "75016", 2534, 65, 3],
      ["61724095", "75018", 950, 24, 1],
      ["61715658", "75018", 1100, 26, 2],
      ["60839070", "75015", 1400, 36, 2],
    ]);
    expect(verdicts(out, s)).toEqual(["localisation", "localisation", "localisation", "localisation"]);
  });

  it('gabarit du 09/11 : title de la carte après class="listing__link" (et non juste après href) : même lecture que l\'ancien ordre', () => {
    const old = page(imaxParisRaw).replace(
      /(href="[^"]*\/fiches\/[^"]*")\s+class="listing__link"\s+title="([^"]*)"/g,
      '$1 title="$2" class="listing__link"',
    );
    expect(old).not.toBe(page(imaxParisRaw));
    expect(parseOffice5(old, s).map((l) => l.id)).toEqual(out.map((l) => l.id));
  });
});

describe("office5 parser : Mister Property (habillage box-listing__item / card-bien)", () => {
  const s = src("mister_property", MISTER, ["92300"], false);
  const out = parseOffice5(page(misterRaw), s);
  it("10 cartes (tout le réseau : Alpes-Maritimes, Rueil, Nanterre, Asnières), code postal de la carte, type par la catégorie du lien", () => {
    invariants(out, "mister_property", 10);
    expect(out.map((l) => l.postalCode)).toEqual([
      "06800",
      "06610",
      "06640",
      "92000",
      "92500",
      "92500",
      "92500",
      "06610",
      "92600",
      "92500",
    ]);
    expect(out.map((l) => l.propertyType)).toEqual([
      "Appartement",
      "Local professionnel",
      "Maison",
      "Appartement",
      "Appartement",
      "Appartement",
      "Appartement",
      "Local professionnel",
      "Local professionnel",
      "Parking",
    ]);
    // « 4 PIÈCES … / PARKING / CAVE » reste un appartement (catégorie 3), pas un parking lu dans le titre.
    expect(out[4]).toMatchObject({
      id: "60988934",
      propertyType: "Appartement",
      price: 2940,
      surface: 120,
      rooms: 4,
      priceIsCC: null,
    });
    expect(out[9]).toMatchObject({
      id: "56456717",
      url: "https://www.mister-property.fr/fiches/7_56456717/.html",
      surface: null,
      rooms: null,
      price: 595,
    });
    expect(verdicts(out, s)).toEqual([
      "localisation",
      "type",
      "localisation",
      "localisation",
      "localisation",
      "localisation",
      "localisation",
      "type",
      "type",
      "type",
    ]);
  });
});

describe("office5 parser : F.G.D.I Pereire (habillage listing-item / ui-price, « charges comprises »)", () => {
  const s = src("agence_pereire", PEREIRE, ["75017", "92300"], false);
  const out = parseOffice5(page(pereireRaw), s);
  it("2 boutiques (« 2 annonce(s) trouvée(s) ») ; les copies de la carte Google Maps ne sont pas lues ; « , Paris » sans arrondissement : pas de code", () => {
    invariants(out, "agence_pereire", 2);
    expect(pereireRaw).toContain("2 annonce(s) trouv&eacute;e(s)");
    expect(out[0]).toEqual({
      source: "agence_pereire",
      id: "61633231",
      url: "https://www.agencepereire.com/fiches/24-206-208_61633231/boutique.html",
      price: 2961,
      charges: null,
      priceIsCC: true,
      surface: 72,
      rooms: 2,
      title: "Boutique",
      address: "Paris",
      district: null,
      postalCode: null,
      photo:
        "https://www.agencepereire.com/office12/import_beyat_poliris/catalog/images/pr_p/6/1/6/3/3/2/3/1/61633231a.jpg",
      agency: null,
      phone: null,
      propertyType: "Local professionnel",
      publishedAt: null,
    });
    expect(verdicts(out, s)).toEqual(["type", "type"]);
  });
});

describe("office5 parser : Safar (habillage listing-item, page lourde, 25 cartes sur 45)", () => {
  const s = src("safar", SAFAR, ["75017"], false);
  const body = page(safarRaw);
  const out = parseOffice5(body, s);

  it("25 cartes de la page 1 (« 45 annonce(s) », page 2 en lien rel=next) ; loyers annuels des bureaux (« €/an ») non lus", () => {
    invariants(out, "safar", 25);
    expect(safarRaw).toContain("45 annonce(s) trouv&eacute;e(s)");
    expect(safarRaw).toContain(
      '<link rel="next" href="https://www.safar.fr/annonces/transaction/location.html?manufacturers_id=transaction&page=2">',
    );
    expect(out.filter((l) => l.price === null).map((l) => l.id)).toEqual([
      "61646035",
      "61642455",
      "61622663",
      "61580103",
      "61558303",
      "59477360",
      "60618382",
      "55952786",
      "60962719",
      "60883867",
      "60807254",
      "60807064",
    ]);
    expect(out.filter((l) => l.price === null).every((l) => l.propertyType === "Local professionnel")).toBe(true);
  });

  it("code postal : lu dans le titre (« Studio 75002 Paris »), « Paris » seul : null (pas de 75017 inventé), autre ville sans code : 00000", () => {
    expect(out[0]).toMatchObject({
      id: "61655614",
      title: "Studio 75002 Paris 30.54m²",
      address: "Paris",
      postalCode: "75002",
      price: 1300,
      priceIsCC: true,
      surface: 31,
      rooms: 1,
    });
    expect(out.find((l) => l.id === "42475549")).toMatchObject({
      title: "3 PIECES",
      address: "Paris",
      postalCode: null,
      price: 2797,
      priceIsCC: true,
      surface: 60,
      rooms: 3,
    });
    expect(out.find((l) => l.id === "52335183")).toMatchObject({ address: "Creteil", postalCode: "00000" });
    expect(out.find((l) => l.id === "42475420")).toMatchObject({
      address: "Vincennes",
      postalCode: "94300",
      propertyType: "Parking",
    });
  });

  it("evaluate : aucune annonce gardée (bureaux, boutiques et parkings en « type », autres arrondissements et villes en « localisation », grands appartements au-dessus du budget)", () => {
    expect(verdicts(out, s)).toEqual([
      "localisation",
      "type",
      "type",
      "type",
      "localisation",
      "prix_haut",
      "localisation",
      "type",
      "type",
      "type",
      "type",
      "prix_haut",
      "prix_haut",
      "localisation",
      "localisation",
      "type",
      "type",
      "type",
      "type",
      "type",
      "localisation",
      "type",
      "type",
      "type",
      "type",
    ]);
  });

  it('stopMarker « <div class="barre-navigation-bottom"> » : une seule fois, après la dernière carte ; mêmes annonces sur la page coupée', () => {
    expect(safarRaw.split(SAFAR_STOP).length - 1).toBe(1);
    expect(safarRaw.lastIndexOf('<div class="listing-item">')).toBeLessThan(safarRaw.indexOf(SAFAR_STOP));
    const cut = body.slice(0, body.indexOf(SAFAR_STOP) + SAFAR_STOP.length);
    expect(cut.length).toBeLessThan(170_000);
    expect(parseOffice5(cut, s)).toEqual(out);
  });
});

describe("office5 parser : règles communes", () => {
  const s = src("imax_levallois", IMAX, ["92300"], true);
  const imax = page(imaxRaw);
  const CARD = '<div class="listing__item">';
  const one = imax.slice(imax.indexOf(CARD), imax.indexOf(CARD, imax.indexOf(CARD) + 10));

  it("CC / HC lus seulement dans le texte du prix ; loyer annuel ou HT : pas de prix", () => {
    const p = page(pereireRaw);
    expect(parseOffice5(p, src("x", PEREIRE, ["75017"], false))[0].priceIsCC).toBe(true);
    expect(
      parseOffice5(p.replace(/charges comprises/g, "hors charges"), src("x", PEREIRE, ["75017"], false))[0].priceIsCC,
    ).toBe(false);
    expect(parseOffice5(one, s)[0]).toMatchObject({ price: 2200, priceIsCC: null });
    expect(parseOffice5(one.replace("/mois</span>", "/mois HT</span>"), s)[0].price).toBeNull();
    expect(parseOffice5(one.replace("/mois</span>", "/an</span>"), s)[0].price).toBeNull();
  });

  it("carte en double ignorée ; carte sans lien de fiche ignorée ; zéro carte lève", () => {
    expect(parseOffice5(one + one, s).map((l) => l.id)).toEqual(["61724488"]);
    expect(() => parseOffice5(one.replace(/fiches\//g, "x/"), s)).toThrow(/office5: aucune carte trouvée/);
    expect(() => parseOffice5(imax.split(CARD).join('<div class="listing__x">'), s)).toThrow(
      /office5: aucune carte trouvée/,
    );
    expect(() => parseOffice5("<html><body></body></html>", s)).toThrow(/office5: aucune carte trouvée/);
  });
});

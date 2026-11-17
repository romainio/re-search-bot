import { describe, expect, it } from "vitest";
import wagramRaw from "./fixtures/etude_wagram.html?raw";
import wagramAllRaw from "./fixtures/etude_wagram_all.html?raw";
import wagramEmptyRaw from "./fixtures/etude_wagram_empty.html?raw";
import cmbRaw from "./fixtures/cmb.html?raw";
import lbiSprRaw from "./fixtures/lbi_spr.html?raw";
import lbiOdiRaw from "./fixtures/lbi_odi.html?raw";
import lbiArmailleRaw from "./fixtures/lbi_armaille.html?raw";
import lbiArmailleEmptyRaw from "./fixtures/lbi_armaille_empty.html?raw";
import lbiAgbRaw from "./fixtures/lbi_agb.html?raw";
import fnaimRaw from "./fixtures/fnaim.html?raw";
import nestennRaw from "./fixtures/nestenn.html?raw";
import nestennCourbevoieRaw from "./fixtures/nestenn_courbevoie.html?raw";
import azoulayRaw from "./fixtures/azoulay.html?raw";
import equinimoRaw from "./fixtures/equinimo.html?raw";
import sectorRaw from "./fixtures/sector.html?raw";
import feauRaw from "./fixtures/danielfeau.html?raw";
import feauEmptyRaw from "./fixtures/danielfeau_empty.html?raw";
import laforetEmptyRaw from "./fixtures/laforet_empty.html?raw";
import { LAFORET_EMPTY, NEARBY } from "../src/parsers/laforet";
import domiereRaw from "./fixtures/domiere.html?raw";
import laforetRaw from "./fixtures/laforet.html?raw";
import { APIMO_EMPTY } from "../src/parsers/apimo";
import { PARSERS } from "../src/parsers/index";
import { decodeWindows1252 } from "../src/util";
import { LBI_EMPTY } from "../src/parsers/lbi";
import { FNAIM_EMPTY } from "../src/parsers/fnaim";
import fnaimEmptyRaw from "./fixtures/fnaim_empty.html?raw";
import { evaluate } from "../src/filter";
import type { Listing, SourceDef } from "../src/types";

const src = (id: string, parser: SourceDef["parser"], url: string): SourceDef => ({
  id,
  name: id,
  url,
  parser,
  group: 0,
  filteredToZones: true,
  zones: ["75017"],
  phone: null,
  encoding: "utf-8",
  active: true,
});
const WAGRAM = "https://www.etude-wagram.com/location/1-paris/17-paris-17eme-arrondissement/appartement/1";
const WAGRAM_ALL = "https://www.etude-wagram.com/location/1";
const CMB = "https://www.cmb-artimmo.com/location/1";
const FNAIM =
  "https://www.fnaim.fr/18-location.htm?localites=%5B%7B%22id%22%3A%226612%22%7D%5D&PRIX_MIN=900&PRIX_MAX=1700";

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

describe("lbi parser (Etude Wagram)", () => {
  const all = PARSERS.lbi(wagramAllRaw, src("etude_wagram", "lbi", WAGRAM_ALL));
  const filtered = PARSERS.lbi(wagramRaw, src("etude_wagram", "lbi", WAGRAM));
  it("filtered page: the single 17e apartment", () => {
    invariants(filtered, "etude_wagram", 1);
    expect(filtered[0]).toMatchObject({
      id: "1401",
      price: 2700,
      priceIsCC: true,
      surface: 69.04,
      rooms: 3,
      postalCode: "75017",
      title: "Appartement 3 pièce(s) 2 chambre(s) 69.04 m²",
      propertyType: "Appartement",
      url: "https://www.etude-wagram.com/location/1-paris/17-paris-17eme-arrondissement/appartement/t3/1401-paris-17e-quartier-des-ternes-duplex/",
    });
  });
  it("unfiltered page: 6 cards incl. parkings and non-17e ads", () => {
    invariants(all, "etude_wagram", 6);
    expect(all.map((l) => l.id)).toEqual(["1401", "1387", "1377", "1348", "1341", "1336"]);
    expect(all[1]).toMatchObject({ postalCode: "75018", price: 1860, surface: 51.45, rooms: 2 });
    expect(all[2]).toMatchObject({
      propertyType: "Parking",
      price: 190,
      surface: null,
      rooms: null,
      postalCode: "75017",
      priceIsCC: true,
    });
    expect(all[5].postalCode).toBe("75008");
  });
  it("accents are correct (no replacement char)", () => {
    expect(all[0].title).toContain("pièce");
    expect(all.every((l) => !(l.title ?? "").includes("�"))).toBe(true);
  });
  it("windows-1252 body: decodeWindows1252 on cp1252 bytes yields the same accents", () => {
    const bytes = new Uint8Array(wagramAllRaw.length);
    for (let i = 0; i < wagramAllRaw.length; i++) {
      const c = wagramAllRaw.charCodeAt(i);
      bytes[i] = c === 0x20ac ? 0x80 : c < 256 ? c : 0x3f;
    }
    const out = PARSERS.lbi(decodeWindows1252(bytes), src("etude_wagram", "lbi", WAGRAM_ALL));
    expect(out[0].title).toContain("pièce");
    expect(out[0].title).not.toContain("�");
    expect(out[0]).toMatchObject({ id: "1401", postalCode: "75017", price: 2700, priceIsCC: true });
  });
  it("09/11 : la page filtrée (17e, appartements) est vide pour de bon, avec 3 parkings du 17e, 1 appartement du 18e et 1 parking du 8e sur la liste complète : [] sans erreur, marqueur LBI_EMPTY", () => {
    expect(wagramEmptyRaw).not.toContain('<article class="item');
    expect(LBI_EMPTY.test(wagramEmptyRaw)).toBe(true);
    expect(PARSERS.lbi(wagramEmptyRaw, src("etude_wagram", "lbi", WAGRAM))).toEqual([]);
    expect(() =>
      PARSERS.lbi(wagramEmptyRaw.replace(/aucun bien n'est disponible/i, "x"), src("etude_wagram", "lbi", WAGRAM)),
    ).toThrow(/lbi: aucune carte trouvée/);
  });
  it("throws on a page without any article list", () => {
    expect(() => PARSERS.lbi("<html></html>", src("x", "lbi", WAGRAM))).toThrow();
  });
});

describe("lbi parser (CMB)", () => {
  const out = PARSERS.lbi(cmbRaw, src("cmb", "lbi", CMB));
  it("returns the 20 ads (pagination article ignored), unique ids", () => {
    invariants(out, "cmb", 20);
  });
  it("keeps parkings and garages (type filter is applied later)", () => {
    const parkings = out.filter((l) => l.propertyType === "Parking");
    expect(parkings.map((l) => l.id)).toEqual(["9255", "7546", "7213", "6753", "6495", "2815", "2711", "1395"]);
    expect(out.find((l) => l.id === "2566")).toMatchObject({ propertyType: "Garage", surface: 25, price: 318 });
  });
  it("priceIsCC is true for every 'CC' price", () => {
    expect(out.every((l) => l.priceIsCC === true)).toBe(true);
  });
  it("maps the first ads field by field", () => {
    expect(out[0]).toMatchObject({
      id: "10005",
      price: 1205,
      priceIsCC: true,
      surface: 28.79,
      rooms: 1,
      postalCode: "75010",
      title: "Studio 1 pièce(s) 28.79 m²",
      propertyType: "Studio",
      agency: "CMB",
      phone: null,
      url: "https://www.cmb-artimmo.com/location/1-paris/studio/10005-studio-loue-vide-rue-louis-blanc-paris-10eme",
      photo:
        "https://cmb.staticlbi.com/900xauto/images/biens/1/bd50b7d66b1ff2cef0f3ef225ef14479/photo_0e4334667f49769305a38068a816fccf_Inc_0.jpg",
    });
    expect(out[1]).toMatchObject({ id: "10004", price: 1340, postalCode: "75017", surface: 29.81 });
    expect(out[4]).toMatchObject({ id: "9790", postalCode: "92200" });
  });
});

describe("fnaim parser", () => {
  const out = PARSERS.fnaim(fnaimRaw, src("fnaim_17", "fnaim", FNAIM));
  it("returns the 3 ads (other li.item are not ads), id = data-id", () => {
    invariants(out, "fnaim_17", 3);
    expect(out.map((l) => l.id)).toEqual(["53201554", "53199034", "53169927"]);
    expect(out.map((l) => l.price)).toEqual([1361, 1490, 1560]);
    expect(out.every((l) => /^\d+$/.test(l.id))).toBe(true);
  });
  it("maps the first ad field by field", () => {
    expect(out[0]).toMatchObject({
      id: "53201554",
      price: 1361,
      priceIsCC: null,
      surface: 32,
      rooms: 1,
      postalCode: "75017",
      title: "Appartement 1 pièce Meublé 32m² PARIS 17ème",
      agency: "PERENIUM",
      phone: "01 43 70 03 32",
      url: "https://www.fnaim.fr/annonce-immobiliere/53201554/18-location-appartement-paris-17-75017.htm",
      photo: "https://imagesv2.fnaim.fr/images1/img/6ad2524bf708185a1ba892b5.jpg",
    });
  });
  it("throws on a page without list items", () => {
    expect(() => PARSERS.fnaim("<html></html>", src("x", "fnaim", FNAIM))).toThrow();
  });
});

describe("lbi2 parser (SPR, ODI, Armaille, Agence des Batignolles templates)", () => {
  const SPR = "https://www.spr-immobilier.fr/a-louer/1";
  const ODI = "https://www.odi-immobilier.com/location/1";
  const ARM = "https://www.armaille-immobilier.com/location/1";
  const AGB = "https://ag-batignolles.la-boite-immo.com/location/1";
  const spr = PARSERS.lbi2(lbiSprRaw, src("spr", "lbi2", SPR));
  const odi = PARSERS.lbi2(lbiOdiRaw, src("odi", "lbi2", ODI));
  const arm = PARSERS.lbi2(lbiArmailleRaw, src("armaille", "lbi2", ARM));
  const agb = PARSERS.lbi2(lbiAgbRaw, src("agence_batignolles", "lbi2", AGB));
  it("counts, unique ids, absolute urls", () => {
    invariants(spr, "spr", 1);
    invariants(odi, "odi", 2);
    invariants(arm, "armaille", 1);
    invariants(agb, "agence_batignolles", 4);
    for (const l of [...spr, ...odi, ...arm, ...agb])
      expect(l.photo === null || l.photo.startsWith("https://")).toBe(true);
  });
  it("spr: parking 180 EUR CC", () => {
    expect(spr[0]).toMatchObject({
      id: "312",
      url: "https://www.spr-immobilier.fr/312-batignolles.html",
      price: 180,
      priceIsCC: true,
      surface: null,
      postalCode: null,
      propertyType: "Parking",
    });
  });
  it("odi: two parkings", () => {
    expect(odi.map((l) => [l.id, l.price, l.priceIsCC])).toEqual([
      ["2752", 180, true],
      ["2753", 125, true],
    ]);
    expect(odi[1].url).toBe("https://www.odi-immobilier.com/location/75-paris/1-paris/place-de-parking/2753-parking");
    expect(odi[1].propertyType).toBe("Parking");
  });
  it("armaille: Paris 2 apartment 4 300 EUR CC", () => {
    expect(arm[0]).toMatchObject({
      id: "2145",
      price: 4300,
      priceIsCC: true,
      surface: 101,
      rooms: 3,
      postalCode: "75002",
      propertyType: "Appartement",
    });
    expect(arm[0].url).toBe(
      "https://www.armaille-immobilier.com/location/75-paris/1-paris/paris-2-a-louer-vide-superbe-appartement-refait-a-neuf-dernier/2145-appartement",
    );
  });
  it("agence_batignolles: four listings", () => {
    const by = Object.fromEntries(agb.map((l) => [l.id, l]));
    expect(Object.keys(by).sort()).toEqual(["6718", "6776", "7444", "7459"]);
    expect(by["7444"]).toMatchObject({ price: 1490, priceIsCC: true, surface: 38, rooms: 2, postalCode: "75017" });
    expect(by["7459"]).toMatchObject({ price: 1453, surface: 82.74, postalCode: "94400" });
    expect(by["7459"].url).toBe(
      "https://ag-batignolles.la-boite-immo.com/location/94-val-de-marne/402-vitry-sur-seine/18-duplex/t3/7459-vitry-sur-seine-94-duplex-82-74-m/",
    );
    expect(by["6776"]).toMatchObject({ price: 2432, surface: 63, rooms: 3, postalCode: "75018" });
    expect(by["6718"]).toMatchObject({ price: 125, postalCode: "75018", surface: null });
    // le type vient du chemin de l'URL (« .../parking/6718-... »), pas du sous-titre de la ville
    expect(by["6718"].propertyType).toBe("Parking");
  });
  it("dedupes the same card twice; a card without id is skipped (and with nothing else throws)", () => {
    const art = lbiAgbRaw.slice(lbiAgbRaw.indexOf('<article class="property-v2'), lbiAgbRaw.indexOf("</article>") + 10);
    expect(PARSERS.lbi2(art + art, src("x", "lbi2", AGB))).toHaveLength(1);
    expect(() =>
      PARSERS.lbi2('<article class="property-v2 "><a href="/location/x">y</a></article>', src("x", "lbi2", AGB)),
    ).toThrow(/aucune carte trouvée/);
  });
  it("no empty-state marker is known for these templates: an empty-sentence page still throws", () => {
    expect(() =>
      PARSERS.lbi2("<html><p>Aucun bien n'est disponible pour le moment</p></html>", src("x", "lbi2", AGB)),
    ).toThrow(/aucune carte trouvée/);
  });

  it("Armaillé : page sans bien (« Désolé, aucun bien ne correspond », 26/10/2026) = état vide reconnu, pas une panne du parseur", () => {
    expect(PARSERS.lbi2(lbiArmailleEmptyRaw, src("armaille", "lbi2", ARM))).toEqual([]);
    // Le marqueur seul compte : la même page sans la phrase, ou une phrase hors du bloc « no-good », reste une erreur.
    expect(() =>
      PARSERS.lbi2(lbiArmailleEmptyRaw.replace("Désolé, aucun bien ne correspond", "x"), src("armaille", "lbi2", ARM)),
    ).toThrow(/aucune carte trouvée/);
    expect(() =>
      PARSERS.lbi2("<p>Désolé, aucun bien ne correspond à vos critères</p>", src("armaille", "lbi2", ARM)),
    ).toThrow(/aucune carte trouvée/);
  });
});

describe("nestenn parser (Nestenn Paris 17 Batignolles, Immo-facile)", () => {
  const NESTENN = "https://immobilier-paris-17.nestenn.com/louer";
  const out = PARSERS.nestenn(nestennRaw, src("nestenn", "nestenn", NESTENN));
  const by = Object.fromEntries(out.map((l) => [l.id, l]));
  it("3 cards incl. a non-Paris flat and a commercial local, unique ids, absolute urls", () => {
    invariants(out, "nestenn", 3);
    expect(out.map((l) => l.id)).toEqual(["38813892", "39747924", "39526020"]);
  });
  it("hand-checked: Paris 17 flat, 48 m2, 2 pièces, 1 844 EUR CC", () => {
    expect(by["38813892"]).toMatchObject({
      price: 1844,
      charges: null,
      priceIsCC: true,
      surface: 48,
      rooms: 2,
      postalCode: "75017",
      agency: "Nestenn Paris 17 Batignolles",
      url: "https://immobilier-paris-17.nestenn.com/quartier-levis-75017-3-pieces-meuble-47-m-ref-38813892",
      propertyType: "Appartement",
      address: "75017 PARIS",
      photo:
        "https://media-nestenn.immo-facile.com/office15/nestenn_paris_17/catalog/images/pr_p/3/8/8/1/3/8/9/2/38813892a.jpg",
    });
  });
  it("other cards: Cergy flat at 942 EUR CC; local commercial at 833 EUR HT HC (priceIsCC false)", () => {
    expect(by["39747924"]).toMatchObject({ price: 942, priceIsCC: true, surface: 50, rooms: 2, postalCode: "95800" });
    expect(by["39526020"]).toMatchObject({
      price: 833,
      priceIsCC: false,
      surface: 31,
      postalCode: "95000",
      propertyType: "Local commercial",
    });
  });
  it("dedupes the same card twice; a card without id is skipped", () => {
    const i = nestennRaw.indexOf('<div class="bien_item');
    const card = nestennRaw.slice(i, nestennRaw.indexOf('<div class="bien_item', i + 10));
    expect(PARSERS.nestenn(card + card, src("x", "nestenn", NESTENN))).toHaveLength(1);
    expect(() =>
      PARSERS.nestenn('<div class="bien_item"><p class="price">900 €</p></div>', src("x", "nestenn", NESTENN)),
    ).toThrow(/aucune carte trouvée/);
  });
});

describe("nestenn parser, agence de Courbevoie (Levallois ; page enregistrée en une requête)", () => {
  const URL = "https://immobilier-courbevoie.nestenn.com/louer";
  const s = {
    ...src("nestenn_courbevoie", "nestenn", URL),
    name: "Nestenn Courbevoie",
    zones: ["92300"],
    filteredToZones: false,
  };
  const out = PARSERS.nestenn(nestennCourbevoieRaw, s);
  const by = Object.fromEntries(out.map((l) => [l.id, l]));
  it("3 cards (1 in Levallois-Perret, 2 in Courbevoie), unique ids, absolute urls on the Courbevoie site", () => {
    invariants(out, "nestenn_courbevoie", 3);
    expect(out.map((l) => [l.id, l.postalCode])).toEqual([
      ["39773300", "92400"],
      ["39773301", "92300"],
      ["39760919", "92400"],
    ]);
    for (const l of out) expect(l.url.startsWith("https://immobilier-courbevoie.nestenn.com/")).toBe(true);
  });
  it("agency name read on the page (« Louer à Courbevoie … avec Nestenn »), not the Paris 17 name; Paris 17 page unchanged", () => {
    expect(out.every((l) => l.agency === "Nestenn Courbevoie")).toBe(true);
    expect(
      PARSERS.nestenn(nestennRaw, src("nestenn", "nestenn", "https://immobilier-paris-17.nestenn.com/louer")).every(
        (l) => l.agency === "Nestenn Paris 17 Batignolles",
      ),
    ).toBe(true);
  });
  it("hand-checked: Levallois-Perret 2 pièces, 43 m² on the card (42.38 in the title), 1 383 EUR CC, kept; Courbevoie flats rejected as localisation", () => {
    expect(by["39773301"]).toMatchObject({
      price: 1383,
      charges: null,
      priceIsCC: true,
      surface: 43,
      rooms: 2,
      postalCode: "92300",
      address: "92300 LEVALLOIS PERRET",
      url: "https://immobilier-courbevoie.nestenn.com/appartement-levallois-perret-2-pieces-42-38-m2-loggia-de-5-38m2-parking-cave-ref-39773301",
      title: "Appartement Levallois Perret 2 pièces 42.38 m2 + loggia de 5.38m2 + Parking + Cave",
      propertyType: "Appartement",
    });
    expect(evaluate(by["39773301"], s)).toEqual({ keep: true, rentCC: 1383, flags: [] });
    expect(evaluate(by["39773300"], s)).toMatchObject({ keep: false, reason: "localisation" });
    expect(evaluate(by["39760919"], s)).toMatchObject({ keep: false, reason: "localisation" });
  });
  it("page without the agency title: falls back to the source name", () => {
    const noTitle = nestennCourbevoieRaw.replace(/<title>[^<]*<\/title>/, "<title>Nestenn</title>");
    expect(PARSERS.nestenn(noTitle, s)[0].agency).toBe("Nestenn Courbevoie");
    expect(PARSERS.nestenn(noTitle, { ...s, name: "Autre nom" })[0].agency).toBe("Autre nom");
  });
});

describe("Cabinet Azoulay (lbi2 property-v2), Equinimo (lbi), Sector Immobilier (lbi2 panelBien)", () => {
  const AZ = "https://www.azoulay.net/location/1";
  const EQ = "https://www.equinimo.fr/location/1";
  const SE = "https://www.sectorimmobilier.fr/a-louer/1";
  const az = PARSERS.lbi2(azoulayRaw, src("azoulay", "lbi2", AZ));
  const eq = PARSERS.lbi(equinimoRaw, src("equinimo", "lbi", EQ));
  const se = PARSERS.lbi2(sectorRaw, src("sector", "lbi2", SE));
  it("counts, unique ids, absolute urls and photos", () => {
    invariants(az, "azoulay", 7);
    invariants(eq, "equinimo", 4);
    invariants(se, "sector", 1);
    for (const l of [...az, ...eq, ...se]) expect(l.photo === null || l.photo.startsWith("https://")).toBe(true);
    expect(az.map((l) => l.id)).toEqual(["1127", "1113", "1101", "356", "263", "72", "69"]);
    expect(eq.map((l) => l.id)).toEqual(["7783", "719", "3047", "6401"]);
  });
  it("azoulay: apartment 3 797,61 EUR CC (Paris 15e), type and rooms read from the url", () => {
    expect(az[0]).toMatchObject({
      id: "1127",
      price: 3797.61,
      priceIsCC: true,
      surface: null,
      rooms: 4,
      postalCode: "75015",
      propertyType: "Appartement",
      title: "Paris XVe - Breteuil",
      url: "https://www.azoulay.net/location/1-paris/appartement/t4/1127-paris-xve-breteuil-prestige/",
      photo:
        "https://cabinetazoulay.staticlbi.com/600xauto/images/biens/1/7bf36b0ab741fd220096a078c514c276/photo_360c68ae86c97e6e4b306306a20ca3a9.jpg",
    });
    expect(az[1]).toMatchObject({
      id: "1113",
      price: 1712,
      rooms: 1,
      postalCode: "75005",
      propertyType: "Appartement",
    });
  });
  it("azoulay: parkings keep a parking type (not the city) so the type filter still works", () => {
    const parkings = az.filter((l) => l.propertyType === "Parking").map((l) => l.id);
    expect(parkings).toEqual(["356", "263", "72", "69"]);
    expect(az.find((l) => l.id === "356")).toMatchObject({ postalCode: "94200", price: 90, rooms: null });
    expect(evaluate(az[3], { ...src("azoulay", "lbi2", AZ), filteredToZones: false })).toMatchObject({
      keep: false,
      reason: "type",
    });
  });
  it("equinimo: studio in Levallois 1 200 EUR CC, 26.19 m2", () => {
    expect(eq[0]).toMatchObject({
      id: "7783",
      price: 1200,
      priceIsCC: true,
      surface: 26.19,
      rooms: 1,
      postalCode: "92300",
      propertyType: "Studio",
      url: "https://www.equinimo.fr/location/11-levallois-perret/studio/7783-studio-meuble-grefulhe",
    });
    expect(eq[1]).toMatchObject({ id: "719", price: 760, surface: 18, postalCode: "75009" });
    expect(eq.filter((l) => l.propertyType === "Parking").map((l) => l.id)).toEqual(["3047", "6401"]);
  });
  it("sector: panelBien card (parking 120 EUR CC, Paris 18e), id from the url, protocol-relative photo made absolute", () => {
    expect(se[0]).toMatchObject({
      id: "2143",
      price: 120,
      priceIsCC: true,
      surface: null,
      rooms: null,
      postalCode: "75018",
      propertyType: "Parking",
      title: "Paris 18ème - Place de parking - Guy Môquet",
      url: "https://www.sectorimmobilier.fr/2143-paris-18eme-place-de-parking-guy-moquet.html",
      photo:
        "https://agencesector.staticlbi.com/700xauto/images/biens/1/974ca9c80e0f722d1d5b02bbb45cbadf/photo_54ac1182a627ae608631f7f15a7fc11b.png",
    });
  });
  it("sector: footer / banner articles are not cards; the same card twice dedupes; a card without id is skipped", () => {
    const i = sectorRaw.indexOf('<article class="row panelBien"');
    const card = sectorRaw.slice(i, sectorRaw.indexOf("</article>", i) + 10);
    expect(PARSERS.lbi2(card + card, src("x", "lbi2", SE))).toHaveLength(1);
    expect(() => PARSERS.lbi2('<article class="row panelBien"><h1>x</h1></article>', src("x", "lbi2", SE))).toThrow(
      /aucune carte trouvée/,
    );
  });
  it("lbi (equinimo): the empty-state sentence is absent from the populated fixture", () => {
    expect(LBI_EMPTY.test(equinimoRaw)).toBe(false);
  });
});

describe("apimo parser (CMS Realtix variant)", () => {
  const FEAU = "https://danielfeau.com/fr/listing/france/location/paris/paris-17eme";
  const feau = PARSERS.apimo(feauRaw, src("feau_17", "apimo", FEAU));
  it("counts, unique ids, absolute urls and photos", () => {
    invariants(feau, "feau_17", 5);
    for (const l of feau) expect(l.photo === null || l.photo.startsWith("https://")).toBe(true);
    expect(feau.map((l) => l.id)).toEqual(["87493300", "87448099", "87434380", "87430090", "86884098"]);
  });
  it("feau: 'Charges comprises' in the price text means CC; surface, rooms, postal code from the card; no agency name hard-coded", () => {
    expect(feau[0]).toMatchObject({
      id: "87493300",
      price: 4085,
      priceIsCC: true,
      surface: 142,
      rooms: 5,
      postalCode: "75017",
      propertyType: "Appartement",
      title: "Location appartement, Paris 17ème (75017), 5 pièces, 142 m², ref 87493300",
      agency: null,
      url: "https://danielfeau.com/fr/annonce-immobiliere/87493300",
      photo: "https://d36vnx92dgl2c5.cloudfront.net/prod/Danielfeau/1/media/d3940ec15fa96614998ce85776c5b0d9.jpg",
    });
    expect(feau[4]).toMatchObject({
      id: "86884098",
      price: 6330,
      surface: 200,
      rooms: 8,
      propertyType: "Duplex",
      postalCode: "75017",
    });
    expect(feau[1]).toMatchObject({ surface: 111.96, price: 4200 });
  });
  it("empty state: a real zero-result page gives [] only when its marker matches and the populated fixture never matches it", () => {
    expect(APIMO_EMPTY.test(feauRaw)).toBe(false);
    expect(APIMO_EMPTY.test(feauEmptyRaw)).toBe(true);
    expect(PARSERS.apimo(feauEmptyRaw, src("feau_17", "apimo", FEAU))).toEqual([]);
  });
  it("a cards-free page without the empty-state marker throws", () => {
    expect(() => PARSERS.apimo("<html></html>", src("x", "apimo", FEAU))).toThrow(/aucune carte trouvée/);
    expect(() => PARSERS.apimo("<html>Aucun résultat, 0 bien</html>", src("x", "apimo", FEAU))).toThrow(
      /aucune carte trouvée/,
    );
  });
  it("dedupes the same card twice; a card without id is skipped (and with nothing else throws)", () => {
    const f = feauRaw.indexOf('class="property initial" data-property-id="');
    const feauCard = feauRaw.slice(f, feauRaw.indexOf("</li>", f) + 5);
    expect(PARSERS.apimo(feauCard + feauCard, src("x", "apimo", FEAU))).toHaveLength(1);
    const noId = feauCard.split('href="/fr/annonce-immobiliere/').join('href="/fr/x/');
    expect(() => PARSERS.apimo(noId, src("x", "apimo", FEAU))).toThrow(/aucune carte trouvée/);
  });
});

describe("zero-card pages throw unless a strict empty-state marker is present", () => {
  const mutate = (raw: string, from: string, to: string) => {
    expect(raw).toContain(from);
    return raw.split(from).join(to);
  };
  const cases: [string, SourceDef["parser"], string, string, string][] = [
    ["lbi wagram", "lbi", wagramAllRaw, '<article class="item', '<section class="item'],
    ["lbi cmb", "lbi", cmbRaw, '<article class="item', '<section class="item'],
    ["lbi2 spr", "lbi2", lbiSprRaw, '<article itemscope itemtype="https://schema.org/Product"', "<section itemscope"],
    ["lbi2 odi", "lbi2", lbiOdiRaw, '<article itemprop="itemListElement"', '<section itemprop="itemListElement"'],
    [
      "lbi2 armaille",
      "lbi2",
      lbiArmailleRaw,
      '<article itemprop="itemListElement"',
      '<section itemprop="itemListElement"',
    ],
    ["lbi2 agb", "lbi2", lbiAgbRaw, '<article class="property-v2', '<section class="property-v2'],
    ["fnaim", "fnaim", fnaimRaw, '<li class="item"', '<li class="itm"'],
    ["nestenn", "nestenn", nestennRaw, '<div class="bien_item', '<div class="bien_itm'],
    ["lbi equinimo", "lbi", equinimoRaw, '<article class="item', '<section class="item'],
    ["lbi2 azoulay", "lbi2", azoulayRaw, '<article class="property-v2', '<section class="property-v2'],
    ["lbi2 sector", "lbi2", sectorRaw, '<article class="row panelBien"', '<section class="row panelBien"'],
    [
      "apimo feau",
      "apimo",
      feauRaw,
      'class="property initial" data-property-id="',
      'class="property initial" data-pid="',
    ],
  ];
  for (const [name, parser, raw, from, to] of cases) {
    it(`${name}: mutated card marker -> throws "aucune carte trouvée"`, () => {
      expect(() => PARSERS[parser](mutate(raw, from, to), src("x", parser, "https://x.test/"))).toThrow(
        /aucune carte trouvée/,
      );
    });
  }
  it("lbi: the empty-state sentence does not match any populated fixture, but matches the real empty page", () => {
    for (const raw of [wagramRaw, wagramAllRaw, cmbRaw]) expect(LBI_EMPTY.test(raw)).toBe(false);
    const empty = `<div class="properties-list-v1"><p>Désolé, aucun bien n'est disponible pour le moment.</p></div>`;
    expect(LBI_EMPTY.test(empty)).toBe(true);
    expect(PARSERS.lbi(empty, src("x", "lbi", WAGRAM))).toEqual([]);
  });
  it("lbi: the generic list wrapper alone is not an empty state", () => {
    expect(() => PARSERS.lbi('<div class="properties-list-v1"></div>', src("x", "lbi", WAGRAM))).toThrow(
      /aucune carte trouvée/,
    );
  });
  it("lbi: an article without idbien is skipped and, with nothing else, throws", () => {
    expect(() =>
      PARSERS.lbi('<article class="item"><a href="/location/x">y</a></article>', src("x", "lbi", WAGRAM)),
    ).toThrow();
  });
  it("fnaim (no marker): a page like '10 annonces / 10 biens / aucun résultat' still throws", () => {
    const body = "<html><p>10 annonces</p><p>10 biens trouvés</p><p>no result</p><p>Aucun résultat</p></html>";
    for (const p of ["fnaim"] as const)
      expect(() => PARSERS[p](body, src("x", p, "https://x.test/"))).toThrow(/aucune carte trouvée/);
  });
});

describe("fnaim empty result", () => {
  it("real zero-result page (PRIX_MIN=1&PRIX_MAX=2) gives []", () => {
    expect(FNAIM_EMPTY.test(fnaimEmptyRaw)).toBe(true);
    expect(PARSERS.fnaim(fnaimEmptyRaw, src("fnaim_17", "fnaim", FNAIM))).toEqual([]);
  });
  it("the empty-state marker does not match the populated fixture", () => {
    expect(FNAIM_EMPTY.test(fnaimRaw)).toBe(false);
  });
  it("populated fixture with mutated card marker still throws", () => {
    expect(() =>
      PARSERS.fnaim(fnaimRaw.split('<li class="item"').join('<li class="itm"'), src("f", "fnaim", FNAIM)),
    ).toThrow(/aucune carte trouvée/);
  });
});

describe("lbi dedup", () => {
  it("the same article twice gives one listing", () => {
    const art = wagramRaw.slice(wagramRaw.indexOf('<article class="item'), wagramRaw.indexOf("</article>") + 10);
    const out = PARSERS.lbi(art + art, src("x", "lbi", WAGRAM));
    expect(out.map((l) => l.id)).toEqual(["1401"]);
  });
});

describe("priceIsCC evidence comes from the price element only (fnaim)", () => {
  const fnaimCard = (price: string, desc: string) =>
    `<li class="item"><a data-id="1" href="/annonce-immobiliere/1/x.htm"></a><h3>Appartement 2 pièces 30m²</h3><p class="price">${price}</p><p class="description">${desc}</p></li>`;
  it("fnaim", () => {
    const f = (p: string, d: string) => PARSERS.fnaim(fnaimCard(p, d), src("f", "fnaim", FNAIM))[0].priceIsCC;
    expect(f("1 200&euro; par mois", "Loyer 1200 CC dont 50 de charges")).toBeNull();
    expect(f("1 200&euro; par mois", "charges comprises")).toBeNull();
    expect(f("1 200&euro; CC par mois", "")).toBe(true);
    expect(f("1 200&euro; charges comprises", "")).toBe(true);
  });
});

describe("netty parser (Domiere, Netty: _TEMPLATE_DATA en JSON base64)", () => {
  const DOM = "https://www.domiere.com/location";
  const out = PARSERS.netty(domiereRaw, src("domiere", "netty", DOM));
  const MARK = '_TEMPLATE_DATA = JSON.parse(b64_to_utf8("';
  // Rebuilds a page whose _TEMPLATE_DATA is the given object (UTF-8 -> base64, as the site's utf8_to_b64 does).
  const pageWith = (data: unknown) => {
    const bin = String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data)));
    return `<html><script>window.${MARK}${btoa(bin)}"));</script></html>`;
  };
  const decoded = () => {
    const i = domiereRaw.indexOf(MARK) + MARK.length;
    return JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(domiereRaw.slice(i, domiereRaw.indexOf('"', i))), (c) => c.charCodeAt(0)),
      ),
    );
  };
  it("2 cards, unique ids, absolute urls", () => {
    invariants(out, "domiere", 2);
    expect(out.map((l) => l.id)).toEqual(["LA2386", "LS020"]);
    expect(out.every((l) => l.url.startsWith("https://www.domiere.com/location/"))).toBe(true);
  });
  it("hand-checked: T2 48.57 m2, rent 1 610 + 150 charges (= rent_total 1 760), 75017", () => {
    expect(out[0]).toMatchObject({
      url: "https://www.domiere.com/location/appartement-t2-2-pieces-paris-75017,LA2386",
      price: 1610,
      charges: 150,
      priceIsCC: false,
      surface: 48.57,
      rooms: 2,
      postalCode: "75017",
      title: "Appartement à louer, 2 pièces - Paris 75017",
      propertyType: "Appartement",
      agency: "Domiere",
      phone: "+33 1 45 74 08 08",
      photo:
        "https://img.netty.immo/product/domiere/LA2386/appartement-t2-2-pieces-paris-75017-1792169871-LA2386_15_original.jpg",
    });
    expect(out[1]).toMatchObject({
      id: "LS020",
      price: 145,
      charges: 25,
      priceIsCC: false,
      surface: 12,
      postalCode: "75017",
      propertyType: "Parking",
    });
  });
  it("evaluation: rent + charges 1 760 is above the range, the parking is excluded by type", () => {
    const s = src("domiere", "netty", DOM);
    expect(evaluate(out[0], s)).toMatchObject({ keep: false, reason: "prix_haut", rentCC: 1760 });
    expect(evaluate(out[1], s)).toMatchObject({ keep: false, reason: "type" });
  });
  it("no evidence that rent excludes charges (rent_total != rent + charges): price from rent_total, CC unknown; non-Paris city without code gets 00000", () => {
    const d = decoded();
    d.prodId.LA2386.rent_total = 1800;
    delete d.prodId.LS020.cp;
    d.prodId.LS020.city = "Garches";
    const o = PARSERS.netty(pageWith(d), src("domiere", "netty", DOM));
    expect(o[0]).toMatchObject({ price: 1800, charges: 150, priceIsCC: null });
    expect(o[1].postalCode).toBe("00000");
  });
  it("ville d'une zone suivie sans code postal (Levallois-Perret) -> 92300, plus la sentinelle de rejet", () => {
    const d = decoded();
    delete d.prodId.LS020.cp;
    d.prodId.LS020.city = "LEVALLOIS-PERRET";
    // Source du registre : liste non filtrée (filteredToZones false), donc la commune décide.
    expect(PARSERS.netty(pageWith(d), { ...src("domiere", "netty", DOM), filteredToZones: false })[1].postalCode).toBe(
      "92300",
    );
  });
  it("empty state: decoded prodCount 0 with no product gives []; absent from the populated page", () => {
    expect(decoded().prodCount).toBe(2);
    expect(
      PARSERS.netty(pageWith({ ...decoded(), prodId: {}, prodResults: {}, prodCount: 0 }), src("x", "netty", DOM)),
    ).toEqual([]);
    // un bloc qui n'a pas la forme de la page peuplée n'est pas pris pour un état vide
    expect(() => PARSERS.netty(pageWith({ prodId: {}, prodCount: 0 }), src("x", "netty", DOM))).toThrow(
      /netty: aucune carte trouvée/,
    );
  });
  it("zero cards without the empty marker throws: mutated block name, products emptied but count 2, undecodable data", () => {
    expect(() =>
      PARSERS.netty(domiereRaw.replace("_TEMPLATE_DATA = JSON", "_TEMPLATE_DATX = JSON"), src("x", "netty", DOM)),
    ).toThrow(/netty: aucune carte trouvée/);
    const d = decoded();
    d.prodId = {};
    expect(() => PARSERS.netty(pageWith(d), src("x", "netty", DOM))).toThrow(/netty: aucune carte trouvée/);
    expect(() => PARSERS.netty(`<script>${MARK}!!!not-base64"));</script>`, src("x", "netty", DOM))).toThrow(
      /netty: aucune carte trouvée/,
    );
  });
});

describe("laforet parser (Laforêt, 4 agences du 17e, back-office propriétaire, page de 1,2 Mo)", () => {
  const LF = "https://www.laforet.com/ville/location-appartement-paris-75017";
  const out = PARSERS.laforet(laforetRaw, src("laforet", "laforet", LF));
  it("état vide réel (filter[max]=1, 20/10 : « 0 annonces à louer », « Aucune annonce ne correspond à votre recherche. », pas de section à proximité) : [] ; marqueur absent des pages peuplées ; sans lui, zéro carte lève", async () => {
    const levRaw = (await import("./fixtures/laforet_levallois.html?raw")).default;
    expect(laforetEmptyRaw).toMatch(LAFORET_EMPTY);
    expect(laforetEmptyRaw).not.toContain(NEARBY); // lecture bornée : sans repère de fin, toute la page (265 Ko) est lue
    for (const raw of [laforetRaw, levRaw]) expect(raw).not.toMatch(LAFORET_EMPTY);
    expect(PARSERS.laforet(laforetEmptyRaw, src("laforet", "laforet", LF))).toEqual([]);
    expect(() => PARSERS.laforet(laforetEmptyRaw.replace(LAFORET_EMPTY, "<p>"), src("laforet", "laforet", LF))).toThrow(
      /laforet: aucune carte trouvée/,
    );
  });
  it("3 cards of the Paris 17 list (« 3 appartements à louer »), the 40 « à proximité » cards are not read", () => {
    invariants(out, "laforet", 3);
    expect(out.map((l) => l.id)).toEqual(["52958912", "52835618", "52706522"]);
    expect(laforetRaw.split('data-counter-model-value="property"').length - 1).toBe(43); // 3 + 40 voisines, sur la page
    expect(out.every((l) => l.url.startsWith("https://www.laforet.com/agence-immobiliere/"))).toBe(true);
    expect(out.every((l) => l.postalCode === "75017")).toBe(true);
  });
  it("hand-checked: Ternes 3 pièces 65.18 m2 at 2 500 EUR/mois, no CC/HC evidence", () => {
    expect(out[0]).toMatchObject({
      url: "https://www.laforet.com/agence-immobiliere/paris17ternes/louer/paris-17/appartement-3-pieces-52958912",
      price: 2500,
      charges: null,
      priceIsCC: null,
      surface: 65.18,
      rooms: 3,
      postalCode: "75017",
      title: "Appartement T3 PARIS",
      address: "PARIS (75017)",
      propertyType: "Appartement",
      agency: "Laforêt",
      phone: "01 58 05 00 45",
      photo:
        "https://www.laforet.com/glide/office6/laforet_paris17villiers/catalog/images/pr_p/5/2/9/5/8/9/1/2/52958912a.jpg?w=400&h=250&v=1792234526&fit=crop&q=75&fm=webp&s=d2451682b70adcfe16edae54a04c7a6e",
    });
  });
  it("the two other cards: 1 750 EUR 41 m2 T2 (Neuilly agency phone), 700 EUR 10 m2 T1", () => {
    expect(out[1]).toMatchObject({ id: "52835618", price: 1750, surface: 41, rooms: 2, phone: "01 41 92 04 73" });
    expect(out[2]).toMatchObject({ id: "52706522", price: 700, surface: 10, rooms: 1, phone: "01 58 05 00 45" });
  });
  it("evaluation: 1 750 EUR is above the range, 10 m2 for 700 EUR is below", () => {
    const s = src("laforet", "laforet", LF);
    expect(evaluate(out[1], s)).toMatchObject({ keep: false, reason: "prix_haut" });
    expect(evaluate(out[2], s)).toMatchObject({ keep: false, reason: "surface" });
  });
  it("without the « proximité » section marker the whole page is read (nearby cards keep their own postal code for the filter)", () => {
    const all = PARSERS.laforet(
      laforetRaw.replace('id="nearest--area--0"', 'id="nx--area--0"'),
      src("laforet", "laforet", LF),
    );
    expect(all).toHaveLength(43);
    expect(all.filter((l) => l.postalCode === "75017")).toHaveLength(3);
  });
  it("Paris 17 list emptied (its 3 cards removed): throws, nearby cards of other cities are never returned", () => {
    const i = laforetRaw.indexOf('data-counter-model-value="property"'),
      e = laforetRaw.indexOf('id="nearest--area--');
    const emptied =
      laforetRaw.slice(0, i) +
      laforetRaw.slice(i, e).split('data-counter-model-value="property"').join('data-x="y"') +
      laforetRaw.slice(e);
    expect(emptied.split('data-counter-model-value="property"').length - 1).toBe(40);
    expect(() => PARSERS.laforet(emptied, src("x", "laforet", LF))).toThrow(/laforet: aucune carte trouvée/);
  });
  it("dedupes the same card twice; a card without id is skipped; mutated marker throws; no empty-state marker is known so [] is never returned", () => {
    const i = laforetRaw.indexOf('data-counter-model-value="property"');
    const card = laforetRaw.slice(i, laforetRaw.indexOf('data-counter-model-value="property"', i + 10));
    expect(PARSERS.laforet(card + card, src("x", "laforet", LF)).map((l) => l.id)).toEqual(["52958912"]);
    expect(() =>
      PARSERS.laforet(
        '<article data-counter-model-value="property"><a href="https://www.laforet.com/x">y</a></article>',
        src("x", "laforet", LF),
      ),
    ).toThrow(/laforet: aucune carte trouvée/);
    expect(() =>
      PARSERS.laforet(
        laforetRaw.split('data-counter-model-value="property"').join('data-counter-model-value="prop"'),
        src("x", "laforet", LF),
      ),
    ).toThrow(/laforet: aucune carte trouvée/);
  });
});

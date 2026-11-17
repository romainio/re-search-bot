// Agences supplémentaires du 17e : variantes de familles existantes (apimo, lbi2) et lecteurs propres. Pages enregistrées telles que servies au moment de l'enregistrement,
// une requête par URL du registre.
import { describe, expect, it } from "vitest";
import impactRaw from "./fixtures/impact.html?raw";
import connexionRaw from "./fixtures/connexion.html?raw";
import aream from "./fixtures/aream.html?raw";
import immediatRaw from "./fixtures/immediat.html?raw";
import aubaneRaw from "./fixtures/sainte_aubane.html?raw";
import c21Raw from "./fixtures/century21_17.html?raw";
import oraliaRaw from "./fixtures/oralia.html?raw";
import elgerRaw from "./fixtures/elger.html?raw";
import { PARSERS } from "../src/parsers/index";
import { evaluate } from "../src/filter";
import type { Listing, SourceDef } from "../src/types";

const src = (id: string, parser: SourceDef["parser"], url: string, o: Partial<SourceDef> = {}): SourceDef => ({
  id,
  name: id,
  url,
  parser,
  group: 0,
  filteredToZones: false,
  zones: ["75017"],
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
/** Verdict d'evaluate : « keep » ou la raison du rejet. */
const verdict = (l: Listing, s: SourceDef): string => {
  const e = evaluate(l, s);
  return e.keep ? "keep" : e.reason!;
};

// ---------------------------------------------------------------------------------------------------------------------------
// Famille apimo : sites alimentés par Apimo, une variante par CMS (src/parsers/apimo.ts).
// ---------------------------------------------------------------------------------------------------------------------------

describe("apimo : Impact Immo (CMS Apimo « Mira », cartes <li> enveloppées dans un seul lien, agence de Puteaux)", () => {
  const IMPACT = "https://impact-immo.com/fr/locations";
  const s = src("impact", "apimo", IMPACT);
  const out = PARSERS.apimo(impactRaw, s);
  // Guillemet collé à data-property-id (sans espace) : propre au gabarit Mira, classe supplémentaire comprise (5e carte « portrait »).
  const CARD = '"data-property-id="';

  it("5 cartes (une page, pas de pagination), dont une à classe supplémentaire (portrait) ; id = data-property-id ; URL absolues", () => {
    invariants(out, "impact", 5);
    expect(impactRaw.split(CARD)).toHaveLength(6);
    expect(impactRaw).toContain('property initial portrait"data-property-id="87300123"');
    expect(out.map((l) => l.id)).toEqual(["87363311", "87487045", "87490621", "87449641", "87300123"]);
    expect(out[1].url).toBe("https://impact-immo.com/fr/propriete/location+appartement+puteaux+87487045");
  });

  it("hand-checked: Paris 7e, 2 pièces meublé 58,3 m², 2 300 € « Charges comprises » (CC), titre = texte de l'image", () => {
    expect(out[0]).toEqual({
      source: "impact",
      id: "87363311",
      url: "https://impact-immo.com/fr/propriete/location+appartement+paris-7eme+paris-7e-rue-de-verneuil-elegant-2-pieces-a-louer-meuble-cachet-de-l-ancien-disponible-immediatement+87363311",
      price: 2300,
      charges: null,
      priceIsCC: true,
      surface: 58.3,
      rooms: 2,
      title:
        "PARIS 7e — RUE DE VERNEUIL - ELEGANT 2 PIECES A LOUER MEUBLÉ Cachet de l’ancien — Disponible immédiatement",
      address: null,
      district: null,
      postalCode: "75007",
      photo: "https://d36vnx92dgl2c5.cloudfront.net/prod/Mira/3783/media/d97f9320e6e1ab656dba6e97d0dab965.jpg",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
  });

  it("lieu = ville de l'agence ou arrondissement : Puteaux et Clichy -> leur code (92800, 92110 ; écartées en « localisation »), « Paris 7ème » -> 75007 ; sans mention CC, charges inconnues", () => {
    expect(out.map((l) => l.postalCode)).toEqual(["75007", "92800", "92110", "92800", "92150"]);
    expect(out.map((l) => [l.price, l.priceIsCC, l.surface])).toEqual([
      [2300, true, 58.3],
      [2200, true, 74],
      [1913, true, 65.2],
      [1200, null, 30.5],
      [80, true, null],
    ]);
    expect(out[4]).toMatchObject({ propertyType: "Parking", title: "EMPLACEMENT PARKING SURESNES LIMITE PUTEAUX" });
    // Paris 7e, Puteaux, Clichy, Puteaux, puis un parking à Suresnes (écarté en « type »).
    expect(out.map((l) => verdict(l, s))).toEqual([
      "localisation",
      "localisation",
      "localisation",
      "localisation",
      "type",
    ]);
  });

  it("carte sans lien sautée ; marqueur muté lève (pas d'état vide connu)", () => {
    expect(() => PARSERS.apimo(impactRaw.split(CARD).join('" data-x-id="'), s)).toThrow(/apimo: aucune carte trouvée/);
    expect(
      PARSERS.apimo(
        impactRaw.replace(/<a href="\/fr\/propriete\/location\+appartement\+puteaux\+87487045">/, "<a>"),
        s,
      ).map((l) => l.id),
    ).toEqual(["87363311", "87490621", "87449641", "87300123"]);
  });
});

describe("apimo : Connexion Immobilier (Locagest) et Aream, CMS Apimo « Zenia » (une seule variante pour les deux sites)", () => {
  const CONNEXION = "https://connexion.immo/fr/locations-paris";
  const AREAM = "https://aream.fr/fr/locations";
  const sc = src("connexion", "apimo", CONNEXION);
  const sa = src("aream", "apimo", AREAM);
  const oc = PARSERS.apimo(connexionRaw, sc);
  const oa = PARSERS.apimo(aream, sa);
  const CARD = '" class=" col-1 property initial';

  it("Connexion : 24 cartes, mais 10 seulement dans le HTML (data-loaded), les 14 suivantes sont des squelettes chargés en JavaScript : 10 annonces, les plus récentes d'abord", () => {
    invariants(oc, "connexion", 10);
    expect(connexionRaw.split(CARD)).toHaveLength(25);
    expect(connexionRaw.split('data-loaded="true"')).toHaveLength(11);
    expect(connexionRaw.split('data-appear-top-offset="600"')).toHaveLength(15);
    expect(oc.map((l) => l.id)).toEqual([
      "87495102",
      "87430178",
      "87314697",
      "87274822",
      "87274782",
      "87216178",
      "87000552",
      "86938677",
      "86889411",
      "86503818",
    ]);
    expect(oc[0].url).toBe("https://connexion.immo/fr/propri%C3%A9t%C3%A9/appartement+paris-17eme+87495102");
  });

  it("Connexion, hand-checked: appartement du 17e (Ternes), 6 pièces 209 m², 8 716 € « Charges comprises » (CC), hors budget", () => {
    expect(oc[0]).toEqual({
      source: "connexion",
      id: "87495102",
      url: "https://connexion.immo/fr/propri%C3%A9t%C3%A9/appartement+paris-17eme+87495102",
      price: 8716,
      charges: null,
      priceIsCC: true,
      surface: 209,
      rooms: 6,
      title: "Paris 17:Location appartement 6 pièces 209 m²",
      address: null,
      district: null,
      postalCode: "75017",
      photo: "https://d36vnx92dgl2c5.cloudfront.net/prod/Zenia/699/media/3a2f0842cb082fbf73718e68e5d26e53.jpg",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
    expect(verdict(oc[0], sc)).toBe("prix_haut");
  });

  it("Connexion : lieu et type du <h3> (« Appartement, Paris 17ème »), autre ville -> 00000 ou son code (Clichy 92110), local et bureau écartés en « type », parking sans surface", () => {
    expect(oc.map((l) => l.postalCode)).toEqual([
      "75017",
      "75020",
      "92110",
      "75010",
      "00000",
      "75017",
      "75015",
      "00000",
      "75003",
      "75016",
    ]);
    expect(oc.map((l) => l.propertyType)).toEqual([
      "Appartement",
      "Appartement",
      "Appartement",
      "Local commercial",
      "Maison de ville",
      "Appartement",
      "Local commercial",
      "Bureau",
      "Appartement",
      "Parking",
    ]);
    expect(oc.map((l) => verdict(l, sc))).toEqual([
      "prix_haut",
      "localisation",
      "localisation",
      "type",
      "localisation",
      "prix_haut",
      "type",
      "type",
      "localisation",
      "type",
    ]);
    expect(oc[9]).toMatchObject({ price: 150, priceIsCC: null, surface: null });
    expect(oc[4]).toMatchObject({ price: 2700, priceIsCC: null, surface: 176.84 });
  });

  it("Aream : 3 cartes, id = data-property-id, icônes <i> dans les lignes, « 50 000 € / Mois » sans mention CC -> inconnu ; hand-checked : 2 pièces du 16e, 42,9 m², 1 750 € CC", () => {
    invariants(oa, "aream", 3);
    expect(oa.map((l) => l.id)).toEqual(["7145254", "85592236", "87102944"]);
    expect(oa[2]).toEqual({
      source: "aream",
      id: "87102944",
      url: "https://aream.fr/fr/propri%C3%A9t%C3%A9/87102944",
      price: 1750,
      charges: null,
      priceIsCC: true,
      surface: 42.9,
      rooms: 2,
      title: "Rue Jean-Richepin - Bail Code Civil uniquement",
      address: null,
      district: null,
      postalCode: "75016",
      photo: "https://d36vnx92dgl2c5.cloudfront.net/prod/Zenia/3087/media/88bad79dcb92e60e1c52969ecfaffaad.jpg",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
    expect(oa.map((l) => [l.price, l.priceIsCC, l.surface, l.rooms])).toEqual([
      [60000, null, 1200, 16],
      [50000, null, 291, 6],
      [1750, true, 42.9, 2],
    ]);
    expect(oa[0]).toMatchObject({
      propertyType: "Hôtel particulier",
      postalCode: "75016",
      title: "Hôtel particulier - Avenue d'Iéna",
    });
    expect(oa.map((l) => verdict(l, sa))).toEqual(["localisation", "localisation", "localisation"]); // Paris 16e, 7e, 16e
  });

  it("carte sans lien (squelette) sautée, pas de lecture des squelettes comme annonces ; page sans carte lève ; marqueur Zenia muté lève", () => {
    expect(() => PARSERS.apimo(connexionRaw.split(CARD).join('" class="x'), sc)).toThrow(/apimo: aucune carte trouvée/);
    expect(() => PARSERS.apimo('<html><ul class="_list listing"></ul></html>', sc)).toThrow(
      /apimo: aucune carte trouvée/,
    );
    // Les 14 squelettes seuls (aucune carte chargée) : rien à lire, la page échoue plutôt que de renvoyer [].
    const skeletons =
      connexionRaw.slice(0, connexionRaw.indexOf(CARD)) +
      connexionRaw.slice(connexionRaw.lastIndexOf('<li id="85934260"')).replace(/<\/ul>[\s\S]*$/, "</ul>");
    expect(() => PARSERS.apimo(skeletons, sc)).toThrow(/apimo: aucune carte trouvée/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Famille lbi2 : La Boîte Immo, gabarits en <div> « property-listing-v2 » (Agence Immédiat) et « property-listing-v3 » (Sainte Aubane).
// ---------------------------------------------------------------------------------------------------------------------------

describe('lbi2 : Agence Immédiat (La Boîte Immo, property-listing-v2, <div href> + <a class="item__link">)', () => {
  const IMMEDIAT = "https://www.agence-immediat.fr/location/1";
  const s = src("immediat", "lbi2", IMMEDIAT);
  const out = PARSERS.lbi2(immediatRaw, s);
  const CARD = '<div class="property-listing-v2__item item">';

  it("3 cartes, toutes à Rueil-Malmaison (92500) ; id = idbien du bouton « Sélectionner », URL absolues", () => {
    invariants(out, "immediat", 3);
    expect(immediatRaw.split(CARD)).toHaveLength(4);
    expect(out.map((l) => l.id)).toEqual(["20680", "20663", "20323"]);
    expect(out[0].url).toBe(
      "https://www.agence-immediat.fr/location/1-rueil-malmaison/appartement/t3/20680-location-meublee-rueil-malmaison-appartement-3-pieces-centre-ville/",
    );
    expect(out.every((l) => l.postalCode === "92500")).toBe(true);
  });

  it("hand-checked: appartement meublé 3 pièces de 67,46 m², 1 735,27 € « CC* » (CC), photo protocole-relatif rendue absolue, type lu dans l'URL", () => {
    expect(out[0]).toEqual({
      source: "immediat",
      id: "20680",
      url: "https://www.agence-immediat.fr/location/1-rueil-malmaison/appartement/t3/20680-location-meublee-rueil-malmaison-appartement-3-pieces-centre-ville/",
      price: 1735.27,
      charges: null,
      priceIsCC: true,
      surface: 67.46,
      rooms: 3,
      title: "LOCATION MEUBLÉE - RUEIL-MALMAISON - APPARTEMENT 3 PIECES -...",
      address: null,
      district: null,
      postalCode: "92500",
      photo:
        "https://aptimm.staticlbi.com/800xauto/images/biens/1/ba7c39ede3b24b82163017553f052890/photo_7df4ec108134c498e4aea50ffb55610f.jpg",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
  });

  it("la surface vient de son élément, pas du titre (« 147M² » dans le titre, 146,74 m² mesurés) ; évaluation : Rueil-Malmaison écartée en « localisation »", () => {
    expect(out.map((l) => [l.price, l.priceIsCC, l.surface, l.rooms])).toEqual([
      [1735.27, true, 67.46, 3],
      [1850, true, 80.38, 3],
      [3432, true, 146.74, 4],
    ]);
    expect(out[2].title).toMatch(/^4 PIÈCES 147M²/);
    expect(out.map((l) => verdict(l, s))).toEqual(["localisation", "localisation", "localisation"]);
    // Le même bien annoncé au 17e serait gardé (CC prouvé, 67,46 m²).
    expect(evaluate({ ...out[0], postalCode: "75017", price: 1500 }, s)).toEqual({
      keep: true,
      rentCC: 1500,
      flags: [],
    });
  });

  it("carte sans idbien sautée, doublon ignoré ; marqueur muté lève (aucun état vide connu)", () => {
    const i = immediatRaw.indexOf(CARD);
    const one = immediatRaw.slice(i, immediatRaw.indexOf(CARD, i + 10));
    expect(PARSERS.lbi2(one + one, s).map((l) => l.id)).toEqual(["20680"]);
    expect(
      PARSERS.lbi2(one.replace(/idbien=\d+/g, "x") + immediatRaw.slice(immediatRaw.indexOf(CARD, i + 10)), s).map(
        (l) => l.id,
      ),
    ).toEqual(["20663", "20323"]);
    expect(() => PARSERS.lbi2(immediatRaw.split(CARD).join('<div class="property-listing-v2__x">'), s)).toThrow(
      /lbi2: aucune carte trouvée/,
    );
  });
});

describe("lbi2 : Sainte Aubane (La Boîte Immo, property-listing-v3, <a> dans item__drawing)", () => {
  const AUBANE = "https://www.sainteaubane.com/locations/1";
  const s = src("sainte_aubane", "lbi2", AUBANE);
  const out = PARSERS.lbi2(aubaneRaw, s);
  const CARD = '<div class="property-listing-v3__item item">';

  it("7 cartes (une page) : Le Perreux, Paris 13e, Savigny-sur-Orge, Paris 18e, 13e et 12e (deux box) ; id = idbien ; aucune du 17e ce jour", () => {
    invariants(out, "sainte_aubane", 7);
    expect(aubaneRaw.split(CARD)).toHaveLength(8);
    expect(out.map((l) => l.id)).toEqual(["1817", "1809", "1457", "1166", "948", "819", "498"]);
    expect(out.map((l) => l.postalCode)).toEqual(["94170", "75013", "91600", "75018", "75013", "75012", "75012"]);
    expect(out[4].url).toBe(
      "https://www.sainteaubane.com/location/75-paris/1-paris/2-appartement/t2/948-2-pieces-27m-les-gobelins/",
    );
  });

  it("hand-checked: 2 pièces de 27,20 m² (Gobelins, Paris 13e), 1 029 € « CC* » ; type lu dans l'URL (garage, parking, maison, appartement)", () => {
    expect(out[4]).toEqual({
      source: "sainte_aubane",
      id: "948",
      url: "https://www.sainteaubane.com/location/75-paris/1-paris/2-appartement/t2/948-2-pieces-27m-les-gobelins/",
      price: 1029,
      charges: null,
      priceIsCC: true,
      surface: 27.2,
      rooms: 2,
      title: "2 pièces - 27m² - Les Gobelins",
      address: null,
      district: null,
      postalCode: "75013",
      photo: out[4].photo,
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
    expect(out[4].photo).toMatch(/^https:\/\/steaubaneimmo\.staticlbi\.com\/800xauto\/images\/biens\/1\//);
    expect(out.map((l) => l.propertyType)).toEqual([
      "Appartement",
      "Garage",
      "Maison",
      "Parking",
      "Appartement",
      "Parking",
      "Parking",
    ]);
    expect(out.map((l) => [l.price, l.surface, l.rooms])).toEqual([
      [1100, 49.81, 3],
      [130, null, null],
      [1297, 78.61, 4],
      [120, null, null],
      [1029, 27.2, 2],
      [139, null, null],
      [122, null, null],
    ]);
  });

  it("evaluation : parkings et garage en « type », Le Perreux et Savigny en « localisation », Paris 13e en « localisation », le 2 pièces de 27 m² écarté", () => {
    expect(out.map((l) => verdict(l, s))).toEqual([
      "localisation",
      "type",
      "localisation",
      "type",
      "localisation",
      "type",
      "type",
    ]);
  });

  it("marqueur muté lève ; carte sans lien sautée", () => {
    expect(() => PARSERS.lbi2(aubaneRaw.split(CARD).join('<div class="property-listing-v3__x">'), s)).toThrow(
      /lbi2: aucune carte trouvée/,
    );
    const i = aubaneRaw.indexOf(CARD);
    const one = aubaneRaw.slice(i, aubaneRaw.indexOf(CARD, i + 10)).replace(/href="\/location\/[^"]*"/g, 'href="/x"');
    expect(PARSERS.lbi2(one + aubaneRaw.slice(aubaneRaw.indexOf(CARD, i + 10)), s)).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Nouveaux lecteurs et réutilisations.
// ---------------------------------------------------------------------------------------------------------------------------

describe("century21 : Paris 17 (cpv-75017_paris), même lecteur que pour Levallois", () => {
  const C21 = "https://www.century21.fr/annonces/location-appartement/cpv-75017_paris/";
  const s = src("century21_17", "century21", C21, { filteredToZones: true });
  const out = PARSERS.century21(c21Raw, s);
  const CARD = 'class="c-the-property-thumbnail-with-content js-the-property-thumbnail-with-content';

  it("2 cartes de la liste (« 2 annonces »), les 9 « Biens se rapprochant » (autre gabarit) ne sont pas lus ; id = data-uid", () => {
    invariants(out, "century21_17", 2);
    expect(c21Raw).toContain("2 annonces");
    expect(c21Raw.split(CARD)).toHaveLength(3);
    expect(c21Raw.split('data-uid="').length - 1).toBe(11);
    expect(out.map((l) => l.id)).toEqual(["17049600142", "16836413442"]);
    for (const l of out) expect(l.url).toBe(`https://www.century21.fr/trouver_logement/detail/${l.id}/`);
    expect(out.every((l) => l.postalCode === "75017")).toBe(true);
  });

  it("hand-checked: 3 pièces meublé de 73,28 m² rue Nollet, 2 450 € « par mois charges comprises » (CC), hors budget", () => {
    expect(out[0]).toEqual({
      source: "century21_17",
      id: "17049600142",
      url: "https://www.century21.fr/trouver_logement/detail/17049600142/",
      price: 2450,
      charges: null,
      priceIsCC: true,
      surface: 73.28,
      rooms: 3,
      title: "3 PIECES MEUBLE A LOUER - RUE NOLLET",
      address: "PARIS 75017",
      district: null,
      postalCode: "75017",
      photo:
        "https://www.century21.fr/imagesBien/s3/202/3425/c21_202_3425_3306_8_CC741B52-6812-44F3-90BE-49C05F0638C4.jpg",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
    expect(out[1]).toMatchObject({
      price: 4543,
      priceIsCC: true,
      surface: 117.33,
      rooms: 5,
      title: "PARIS 17 - PARC MONCEAU / RUE DE PRONY",
    });
    expect(out.map((l) => verdict(l, s))).toEqual(["prix_haut", "prix_haut"]);
  });

  it("dedupes, skips a card without data-uid, mutated marker throws (même comportement que Levallois)", () => {
    const i = c21Raw.indexOf(CARD);
    const one = c21Raw.slice(i, c21Raw.indexOf(CARD, i + 10));
    expect(PARSERS.century21(one + one, s).map((l) => l.id)).toEqual(["17049600142"]);
    expect(() => PARSERS.century21(c21Raw.split(CARD).join('class="c-the-property-x'), s)).toThrow(
      /century21: aucune carte trouvée/,
    );
  });
});

describe("oralia parser (Oralia, administrateur de biens : liste du 17e rendue côté serveur)", () => {
  const ORALIA = "https://oralia.fr/location/nos-biens-a-louer/ile-de-france/paris-75/paris-75017";
  const s = src("oralia", "oralia", ORALIA, { filteredToZones: true });
  const out = PARSERS.oralia(oraliaRaw, s);
  const CARD = '<div class="estate-item search-item"';

  it("7 cartes (3 appartements, 4 parkings) ; id = data-id de la carte, URL absolues", () => {
    invariants(out, "oralia", 7);
    expect(oraliaRaw.split(CARD)).toHaveLength(8);
    expect(out.map((l) => l.id)).toEqual(["5920", "8761", "8850", "8766", "3969", "8126", "8644"]);
    expect(out[2].url).toBe(
      "https://oralia.fr/location/nos-biens-a-louer/ile-de-france/paris-75/paris-75017/appartement-paris-75017-caz81360014-919",
    );
    expect(out.every((l) => l.postalCode === "75017")).toBe(true);
  });

  it("hand-checked: appartement 3 pièces de 67 m², 2 130 € « par mois / CC » (CC), hors budget", () => {
    expect(out[2]).toEqual({
      source: "oralia",
      id: "8850",
      url: "https://oralia.fr/location/nos-biens-a-louer/ile-de-france/paris-75/paris-75017/appartement-paris-75017-caz81360014-919",
      price: 2130,
      charges: null,
      priceIsCC: true,
      surface: 67,
      rooms: 3,
      title: "Appartement · 3 pièces · 67m²",
      address: "Paris (75017)",
      district: null,
      postalCode: "75017",
      photo:
        "https://res.cloudinary.com/evoriel/image/private/c_fit,f_auto,fl_progressive,q_auto:best,w_340/oralia_annonces_prod/imgln/TRA_69269c8d7c702ca96324dbb97ecf1cab.jpg",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
    expect(verdict(out[2], s)).toBe("prix_haut");
  });

  it("autres cartes : prix CC, parkings (type écarté, surface de 5 m² lue), 3 990 et 4 941 € hors budget", () => {
    expect(out.map((l) => [l.price, l.priceIsCC, l.surface, l.rooms, l.propertyType])).toEqual([
      [106, true, null, null, "Parking"],
      [3990, true, 157, 5, "Appartement"],
      [2130, true, 67, 3, "Appartement"],
      [200, true, null, null, "Parking"],
      [85, true, null, null, "Parking"],
      [4941, true, 141, 6, "Appartement"],
      [185, true, 5, null, "Parking"],
    ]);
    expect(out.map((l) => verdict(l, s))).toEqual([
      "type",
      "prix_haut",
      "prix_haut",
      "type",
      "type",
      "prix_haut",
      "type",
    ]);
  });

  it("mention du bloc du prix seulement : « par mois / HC » -> HC, aucune mention -> inconnu ; carte sans data-id sautée ; doublon ignoré ; marqueur muté lève", () => {
    const i = oraliaRaw.indexOf(CARD);
    const one = oraliaRaw.slice(i, oraliaRaw.indexOf(CARD, i + 10));
    expect(PARSERS.oralia(one.replace("par mois / CC", "par mois / HC"), s)[0].priceIsCC).toBe(false);
    expect(PARSERS.oralia(one.replace("par mois / CC", "par mois"), s)[0].priceIsCC).toBeNull();
    expect(PARSERS.oralia(one + one, s).map((l) => l.id)).toEqual(["5920"]);
    expect(
      PARSERS.oralia(one.replace(/data-id="\d+"/, "") + oraliaRaw.slice(oraliaRaw.indexOf(CARD, i + 10)), s),
    ).toHaveLength(6);
    expect(() => PARSERS.oralia(oraliaRaw.split(CARD).join('<div class="estate-x"'), s)).toThrow(
      /oralia: aucune carte trouvée/,
    );
  });
});

describe("osl parser (famille _siteOSL2208 : Elger Immobilier ; même gabarit que Square's et Sotheby's)", () => {
  const ELGER = "https://www.elger-immobilier.com/fr/location-maison-appartement-paris/&new_research=1";
  const s = src("elger", "osl", ELGER);
  const out = PARSERS.osl(elgerRaw, s);
  const CARD = '<div class="section container_grid container_grid_mob">';

  it("9 cartes (une page, pas de pagination) ; id = référence du lien (ref-la3577-elger), URL absolues", () => {
    invariants(out, "elger", 9);
    expect(elgerRaw.split(CARD)).toHaveLength(10);
    expect(out.map((l) => l.id)).toEqual([
      "la3577-elger",
      "la2198-elger",
      "la2390-elger",
      "la4060-elger",
      "lp090-elger",
      "la3851-elger",
      "ls060-elger",
      "lp087-elger",
      "lp070-elger",
    ]);
    expect(out[2].url).toBe(
      "https://www.elger-immobilier.com/fr/vente-location-maison-appartement-paris/ref-la2390-elger/location-appartement-paris-2-pieces-1-chambre-75017/",
    );
  });

  it("hand-checked: appartement 2 pièces du 17e, 47,61 m², 2 708 € / mois (charges non précisées), hors budget", () => {
    expect(out[2]).toEqual({
      source: "elger",
      id: "la2390-elger",
      url: "https://www.elger-immobilier.com/fr/vente-location-maison-appartement-paris/ref-la2390-elger/location-appartement-paris-2-pieces-1-chambre-75017/",
      price: 2708,
      charges: null,
      priceIsCC: null,
      surface: 47.61,
      rooms: 2,
      title: "Location Appartement Paris 17 2 Pièces 47.61 m²",
      address: "Paris (75017)",
      district: null,
      postalCode: "75017",
      photo: "https://www.elger-immobilier.com/datas/biens/images/647/l2_medium/647_00-2026-10-08-0143.jpg",
      agency: null,
      phone: null,
      propertyType: "Appartement",
      publishedAt: null,
    });
    expect(evaluate(out[2], s)).toMatchObject({ keep: false, reason: "prix_haut" });
  });

  it("prix mensuels seulement : « Prix sur demande » et « /an HC HT* » (locaux d'activité) -> prix inconnu ; autres villes écartées en « localisation », locaux et parking en « type »", () => {
    expect(out.map((l) => l.price)).toEqual([1800, null, 2708, 1193, null, 1746, 108, null, null]);
    expect(out.map((l) => l.postalCode)).toEqual([
      "93400",
      "75015",
      "75017",
      "93700",
      "75009",
      "75016",
      "75015",
      "75008",
      "92200",
    ]);
    expect(out.map((l) => l.propertyType)).toEqual([
      "Appartement",
      "Appartement",
      "Appartement",
      "Appartement",
      "Local d'activité",
      "Appartement",
      "Parking",
      "Local d'activité",
      "Local d'activité",
    ]);
    expect(out.map((l) => verdict(l, s))).toEqual([
      "localisation",
      "localisation",
      "prix_haut",
      "localisation",
      "type",
      "localisation",
      "type",
      "type",
      "type",
    ]);
    expect(out.map((l) => [l.surface, l.rooms])).toEqual([
      [67.25, 3],
      [18.51, 1],
      [47.61, 2],
      [63.57, 3],
      [null, 5],
      [31.05, 1],
      [10, null],
      [42, 2],
      [34, 1],
    ]);
  });

  it("carte sans lien sautée, doublon ignoré, marqueur muté lève (aucun état vide connu)", () => {
    const i = elgerRaw.indexOf(CARD);
    const one = elgerRaw.slice(i, elgerRaw.indexOf(CARD, i + 10));
    expect(PARSERS.osl(one + one, s)).toHaveLength(1);
    expect(
      PARSERS.osl(one.replace(/class="ctn_img/, 'class="x') + elgerRaw.slice(elgerRaw.indexOf(CARD, i + 10)), s),
    ).toHaveLength(8);
    expect(() => PARSERS.osl(elgerRaw.split(CARD).join('<div class="section">'), s)).toThrow(
      /osl: aucune carte trouvée/,
    );
  });
});

import { describe, it, expect } from "vitest";
import {
  parseEuro,
  parseSurface,
  parseRooms,
  decodeEntities,
  decodeWindows1252,
  findPostalCode,
  townZone,
} from "../src/util";
import type { SourceDef } from "../src/types";

describe("util", () => {
  it("parseEuro", () => {
    expect(parseEuro(decodeEntities("1&nbsp;340&nbsp;&euro; CC*"))).toBe(1340);
    expect(parseEuro("1 490 € par mois")).toBe(1490);
    expect(parseEuro("1.340 €")).toBe(1340);
    expect(parseEuro("1 353,42 €")).toBe(1353.42);
    expect(parseEuro("EUR 1,250 /Month")).toBe(1250);
    expect(parseEuro("Loyer sur demande")).toBeNull();
    expect(parseEuro(null)).toBeNull();
    expect(parseEuro("1450 120 €")).toBe(1450);
    expect(parseEuro("1 340 € CC")).toBe(1340);
  });
  it("parseSurface / parseRooms", () => {
    expect(parseSurface("29,81 m²")).toBe(29.81);
    expect(parseSurface("rien")).toBeNull();
    expect(parseSurface("29,81 m2")).toBe(29.81);
    expect(parseRooms("Appartement 2 pièce(s)")).toBe(2);
    expect(parseRooms("Studio meublé")).toBe(1);
    expect(parseRooms("T3 lumineux")).toBe(3);
    expect(parseRooms("2p")).toBe(2);
  });
  it("decode", () => {
    expect(decodeEntities("a&#99999999;b")).toBe("a&#99999999;b");
    expect(decodeEntities("caf&eacute; &amp; &#233; &#xE8;")).toBe("café & é è");
    expect(decodeWindows1252(new Uint8Array([0x50, 0x69, 0xe8, 0x63, 0x65, 0x80]))).toBe("Pièce€");
  });
  it("findPostalCode", () => {
    expect(findPostalCode("Paris (75017)")).toBe("75017");
    expect(findPostalCode("PARIS 17ème")).toBe("75017");
    expect(findPostalCode("Paris 17e")).toBe("75017");
    expect(findPostalCode("Vitry-sur-Seine (94400)")).toBe("94400");
    expect(findPostalCode("nulle part")).toBeNull();
    expect(findPostalCode("Paris 17ème – réf 12345")).toBe("75017");
    expect(findPostalCode("Paris (17e)")).toBe("75017");
    expect(findPostalCode("17e arrondissement")).toBe("75017");
    expect(findPostalCode("Réf 12345")).toBeNull();
    expect(findPostalCode("5e et dernier étage")).toBeNull();
    expect(findPostalCode("3e ét.")).toBeNull();
    expect(findPostalCode("3e étage")).toBeNull();
    expect(findPostalCode("Paris 2 pièces")).toBeNull();
    expect(findPostalCode("Paris 3 pièces Batignolles")).toBeNull();
    expect(findPostalCode("Paris 2 p")).toBeNull();
    expect(findPostalCode("Paris 30 m²")).toBeNull();
    expect(findPostalCode("Paris 2 chambres")).toBeNull();
    expect(findPostalCode("Paris 17")).toBe("75017");
    expect(findPostalCode("Paris 17e 2 pièces")).toBe("75017");
  });

  it("findPostalCode : arrondissements de Lyon et de Marseille, adresses « 44000 Nantes »", () => {
    expect(findPostalCode("Lyon 3e")).toBe("69003");
    expect(findPostalCode("LYON 3EME ARRONDISSEMENT")).toBe("69003");
    expect(findPostalCode("Appartement Lyon 1er")).toBe("69001");
    expect(findPostalCode("Lyon 6")).toBe("69006");
    expect(findPostalCode("LYON IIIe")).toBe("69003");
    expect(findPostalCode("Lyon 2 pièces")).toBeNull();
    expect(findPostalCode("Lyon 12e")).toBeNull(); // Lyon n'a que 9 arrondissements
    expect(findPostalCode("Marseille 8ème")).toBe("13008");
    expect(findPostalCode("Marseille 1er")).toBe("13001");
    expect(findPostalCode("Marseille (13)")).toBeNull(); // le département, pas le 13e arrondissement
    expect(findPostalCode("Marseille 13")).toBeNull();
    expect(findPostalCode("Marseille 13e")).toBe("13013");
    expect(findPostalCode("2 pièces 13006 Marseille")).toBe("13006");
    expect(findPostalCode("12 rue Crébillon 44000 Nantes")).toBe("44000");
    expect(findPostalCode("Réf 44000 Appartement")).toBeNull();
    expect(findPostalCode("loyer 12000 € par an")).toBeNull();
    expect(findPostalCode("Nantes")).toBeNull();
  });
  it("findPostalCode : Levallois-Perret sans code postal -> 92300 (zone suivie) ; un code explicite reste prioritaire", () => {
    expect(findPostalCode("Levallois-Perret")).toBe("92300");
    expect(findPostalCode("LEVALLOIS PERRET")).toBe("92300");
    expect(findPostalCode("Appartement à Levallois, 2 pièces")).toBe("92300");
    expect(findPostalCode("Levallois-Perret / Parc des 5 continents")).toBe("92300"); // titre d'annonce sans code postal
    expect(findPostalCode("LEVALLOIS PERRET  92")).toBe("92300"); // Century 21 : département seul
    expect(findPostalCode("Levallois-Perret (92300)")).toBe("92300");
    expect(findPostalCode("Clichy (92110) à 1km de Levallois-Perret")).toBe("92110"); // annonce de portail : la ville du bien est Clichy
    expect(findPostalCode("Paris 17e, porte de Champerret, proche Levallois")).toBe("75017");
    expect(findPostalCode("Neuilly-sur-Seine")).toBe("92200"); // commune voisine hors zones : lue, écartée par evaluate
    expect(findPostalCode("Levalloisien")).toBeNull();
  });
  it("M5 : zone de la source (townZone) préférée à une commune nommée sans code ; jamais à un code explicite", () => {
    expect(findPostalCode("Studio Pont de Levallois", "75017")).toBe("75017"); // titre d'une source filtrée sur le 17e
    expect(findPostalCode("Studio Pont de Levallois", null)).toBe("92300");
    expect(findPostalCode("Studio Pont de Levallois")).toBe("92300");
    expect(findPostalCode("LEVALLOIS PERRET 92", "92300")).toBe("92300");
    expect(findPostalCode("Paris 17e, Pont de Levallois", "92300")).toBe("75017"); // arrondissement explicite
    expect(findPostalCode("Clichy (92110) près de Levallois", "75017")).toBe("92110"); // code explicite
    expect(findPostalCode("Neuilly-sur-Seine", "75017")).toBeNull(); // source filtrée sur le 17e : l'URL fait foi
    const src = (zones: string[], filteredToZones: boolean) => ({ zones, filteredToZones }) as SourceDef;
    expect(townZone(src(["75017"], true))).toBe("75017");
    expect(townZone(src(["92300"], true))).toBe("92300");
    expect(townZone(src(["75017"], false))).toBeNull();
    expect(townZone(src(["75017", "92300"], true))).toBeNull();
  });
});

describe("localisations ambiguës ou mal lues (findPostalCode)", () => {
  it("« Paris » suivi d'un nombre qui n'est pas un arrondissement", () => {
    expect(findPostalCode("Paris 2e étage ascenseur")).toBeNull();
    expect(findPostalCode("Paris 3ème étage")).toBeNull();
    expect(findPostalCode("à 10 min de Paris 17")).toBe("75017"); // l'arrondissement reste lu s'il est donné
    expect(findPostalCode("Paris 20 min du centre")).toBeNull();
    expect(findPostalCode("Paris 4 couchages")).toBeNull();
    expect(findPostalCode("Paris 17e étage")).toBeNull();
  });
  it("arrondissement en chiffres romains", () => {
    expect(findPostalCode("Boutique-Général Leclerc-Paris XIV")).toBe("75014");
    expect(findPostalCode("PARIS XVIIe")).toBe("75017");
    expect(findPostalCode("Paris XVIIème - Batignolles")).toBe("75017");
    expect(findPostalCode("Paris IV")).toBe("75004");
    expect(findPostalCode("Paris vie de quartier")).toBeNull();
    expect(findPostalCode("Paris XXI")).toBeNull();
  });
  it("commune voisine nommée sans code : lue (source non filtrée), sauf voie, repère ou Clichy-Batignolles", () => {
    expect(findPostalCode("Appartement 3 pièces Neuilly-sur-Seine")).toBe("92200");
    expect(findPostalCode("CLICHY – 3 PIÈCES LUMINEUX")).toBe("92110");
    expect(findPostalCode("Boulogne Billancourt / République")).toBe("92100");
    expect(findPostalCode("Courbevoie, quartier Faubourg de l'Arche")).toBe("92400");
    expect(findPostalCode("Bois-Colombes centre")).toBe("92270");
    expect(findPostalCode("Asnières-sur-Seine")).toBe("92600");
    expect(findPostalCode("Avenue de Clichy")).toBeNull(); // voie du 17e
    expect(findPostalCode("Studio Porte de Clichy")).toBeNull();
    expect(findPostalCode("Place de Clichy, Paris 17e")).toBe("75017");
    expect(findPostalCode("Métro Clichy, 2 pièces")).toBeNull();
    expect(findPostalCode("Quartier Clichy-Batignolles")).toBeNull();
    expect(findPostalCode("Batignolles Clichy")).toBeNull();
    expect(findPostalCode("3 pièces proche Neuilly")).toBeNull();
    expect(findPostalCode("Centre Neuilly")).toBe("92200"); // « entre » dans « Centre » n'est pas le repère « entre »
    expect(findPostalCode("Paris 17e, Neuilly à 5 min")).toBe("75017");
    expect(findPostalCode("Puteaux (92800)")).toBe("92800");
  });
  it("commune voisine et zone suivie nommées ensemble : la première citée l'emporte", () => {
    expect(findPostalCode("Clichy, à 5 min de Levallois")).toBe("92110");
    expect(findPostalCode("Levallois-Perret, limite Clichy")).toBe("92300");
    expect(findPostalCode("Levallois, Neuilly")).toBe("92300");
  });
  it("source filtrée sur une zone : une commune voisine citée dans le texte ne change rien", () => {
    expect(findPostalCode("Studio Clichy", "75017")).toBeNull();
    expect(findPostalCode("Levallois, Clichy", "75017")).toBe("75017");
    expect(findPostalCode("Neuilly-sur-Seine", "92300")).toBeNull();
  });
});

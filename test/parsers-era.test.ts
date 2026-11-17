// ERA Immobilier : API publique JSON (src/parsers/era.ts). Réponses enregistrées telles que
// servies au moment de l'enregistrement : code_postal=75017 (1 annonce) et code_postal=92300 (total 0, état vide).
import { describe, expect, it } from "vitest";
import era17Raw from "./fixtures/era_17.json?raw";
import eraEmptyRaw from "./fixtures/era_levallois_empty.json?raw";
import { parseEra } from "../src/parsers/era";
import { evaluate } from "../src/filter";
import type { SourceDef } from "../src/types";

const API =
  "https://api.eraimmobilier.com/api/v2/annonces/search?page=1&type_annonce=location&per_page=50&order_dir=desc&statut=0,1,11&type_bien=appartement&code_postal=";
const src = (id: string, zone: string): SourceDef => ({
  id,
  name: id,
  url: API + zone,
  parser: "era" as SourceDef["parser"],
  group: 0,
  filteredToZones: true,
  zones: [zone],
  phone: null,
  encoding: "utf-8",
  active: true,
});

describe("era : API JSON eraimmobilier.com", () => {
  const s = src("era_17", "75017");
  const out = parseEra(era17Raw, s);

  it("75017 : 1 annonce, complète ; URL publique de la fiche construite sur l'id", () => {
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      source: "era_17",
      id: "470139",
      url: "https://www.eraimmobilier.com/annonces/470139",
      price: 4000,
      charges: null,
      priceIsCC: null,
      surface: 88,
      rooms: 3,
      title: "Appartement Paris 3 pièce(s) 88.34 m2",
      address: "paris 17e arrondissement",
      district: null,
      postalCode: "75017",
      photo: "https://api.eraimmobilier.com/medias/annonces/big/5c94c3f28dc7cfe56f6feccf008c0f04.jpg",
      agency: "ERA VILLIERS",
      phone: "01 44 70 16 00",
      propertyType: "Appartement",
      publishedAt: "2026-01-05",
    });
  });

  it("evaluate : le 3 pièces à 4 000 € est écarté (prix_haut)", () => {
    expect(evaluate(out[0], s)).toMatchObject({ keep: false, reason: "prix_haut" });
  });

  it("annonce en double ou sans id ignorée", () => {
    const j = JSON.parse(era17Raw);
    j.data = [j.data[0], j.data[0], { ...j.data[0], id: null }];
    expect(parseEra(JSON.stringify(j), s).map((l) => l.id)).toEqual(["470139"]);
  });

  it("état vide : vraie réponse 92300 (data [] et total 0) => []", () => {
    expect(JSON.parse(eraEmptyRaw).meta.total).toBe(0);
    expect(parseEra(eraEmptyRaw, src("era_levallois", "92300"))).toEqual([]);
  });

  it("JSON invalide, structure absente, ou zéro annonce avec un total non nul : lève", () => {
    expect(() => parseEra("<html>Service indisponible</html>", s)).toThrow("era: JSON invalide");
    expect(() => parseEra('{"message":"Too Many Attempts."}', s)).toThrow("era: data ou meta absents");
    expect(() => parseEra('{"data":[]}', s)).toThrow("era: data ou meta absents");
    expect(() => parseEra('{"data":[],"meta":{"total":3}}', s)).toThrow("era: aucune carte trouvée");
    expect(() => parseEra('{"data":[{"id":null}],"meta":{"total":1}}', s)).toThrow("era: aucune carte trouvée");
  });
});

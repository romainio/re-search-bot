import { describe, it, expect } from "vitest";
import { settings } from "../src/derive";
import { evaluate, postalOf, zoneOf } from "../src/filter";
import type { Listing, SourceDef } from "../src/types";

const cfg = settings();

const listing = (o: Partial<Listing> = {}): Listing => ({
  source: "s",
  id: "1",
  url: "https://x/1",
  price: null,
  charges: null,
  priceIsCC: null,
  surface: null,
  rooms: null,
  title: null,
  address: null,
  district: null,
  postalCode: null,
  photo: null,
  agency: null,
  phone: null,
  propertyType: null,
  publishedAt: null,
  ...o,
});
const base: SourceDef = {
  id: "s",
  name: "S",
  url: "https://x",
  parser: "orpi",
  group: 1,
  filteredToZones: true,
  zones: ["75017"],
  phone: null,
  encoding: "utf-8",
  active: true,
};
const src17 = base;
const srcAll: SourceDef = { ...base, filteredToZones: false };
const srcLev: SourceDef = { ...base, zones: ["92300"] };
const srcLevAll: SourceDef = { ...base, zones: ["92300"], filteredToZones: false };
const srcBoth: SourceDef = { ...base, zones: ["75017", "92300"] };

describe("evaluate", () => {
  it("prix", () => {
    expect(
      evaluate(listing({ price: 1450, charges: 120, priceIsCC: false, postalCode: "75017" }), src17),
    ).toMatchObject({ keep: true, rentCC: 1570 });
    const hi = evaluate(listing({ price: 1550, charges: 120, priceIsCC: false, postalCode: "75017" }), src17);
    expect(hi.keep).toBe(false);
    expect(hi.reason).toBe("prix_haut");
    expect(evaluate(listing({ price: 1600, priceIsCC: true, postalCode: "75017" }), src17).keep).toBe(true);
    const lo = evaluate(listing({ price: 999, priceIsCC: true, postalCode: "75017" }), src17);
    expect(lo.keep).toBe(false);
    expect(lo.reason).toBe("prix_bas");
    expect(
      evaluate(listing({ price: 1550, charges: null, priceIsCC: null, postalCode: "75017" }), src17),
    ).toMatchObject({ keep: true, flags: expect.arrayContaining(["charges_inconnues"]) });
    expect(evaluate(listing({ price: null, postalCode: "75017" }), src17)).toMatchObject({
      keep: true,
      flags: expect.arrayContaining(["prix_inconnu"]),
    });
  });
  it("localisation", () => {
    const r = evaluate(listing({ price: 1300, priceIsCC: true, postalCode: "75018" }), srcAll);
    expect(r.keep).toBe(false);
    expect(r.reason).toBe("localisation");
    expect(evaluate(listing({ price: 1300, priceIsCC: true, postalCode: null }), src17).flags).not.toContain(
      "localisation_non_confirmee",
    );
    expect(evaluate(listing({ price: 1300, priceIsCC: true, postalCode: null }), srcAll)).toMatchObject({
      keep: true,
      flags: expect.arrayContaining(["localisation_non_confirmee"]),
    });
  });
  it("surface minimale 35 m²", () => {
    const k = (o: Partial<Listing>) =>
      evaluate(listing({ price: 1300, priceIsCC: true, postalCode: "75017", ...o }), src17);
    const small = k({ surface: 34.9 });
    expect(small.keep).toBe(false);
    expect(small.reason).toBe("surface");
    expect(k({ surface: 35 }).keep).toBe(true);
    expect(k({ surface: 80 }).keep).toBe(true);
    const unknown = k({ surface: null });
    expect(unknown.keep).toBe(true);
    expect(unknown.flags).toEqual([]);
    expect(k({ surface: 20, propertyType: "Parking" }).reason).toBe("type");
    expect(evaluate(listing({ price: 1300, priceIsCC: true, postalCode: "75018", surface: 20 }), srcAll).reason).toBe(
      "localisation",
    );
    expect(k({ surface: 20, price: 1700 }).reason).toBe("surface");
  });
  it("au moins 2 pièces, pas de rez-de-chaussée ; inconnu : gardée", () => {
    const k = (o: Partial<Listing>) =>
      evaluate(listing({ price: 1300, priceIsCC: true, postalCode: "75017", surface: 40, ...o }), src17);
    expect(k({ rooms: 1 }).reason).toBe("pieces");
    expect(k({ rooms: 2 }).keep).toBe(true);
    expect(k({ rooms: null }).keep).toBe(true);
    expect(k({ rooms: 0 }).keep).toBe(true);
    expect(k({ floor: 0 }).reason).toBe("rdc");
    expect(k({ floor: 1 }).keep).toBe(true);
    expect(k({ floor: null }).keep).toBe(true);
    expect(k({ title: "Appartement 2 pièces en rez-de-chaussée" }).reason).toBe("rdc");
    expect(k({ title: "Appartement RDC lumineux" }).reason).toBe("rdc");
    expect(k({ title: "Appartement 3 pièces, 4e étage" }).keep).toBe(true);
  });
  it("type", () => {
    const r = evaluate(
      listing({
        price: 1300,
        priceIsCC: true,
        postalCode: "75017",
        propertyType: "Parking",
        title: "Parking Batignolles",
      }),
      src17,
    );
    expect(r.keep).toBe(false);
    expect(r.reason).toBe("type");
  });
  it("type: ne pas exclure les mentions annexes", () => {
    const k = (o: Partial<Listing>) =>
      evaluate(listing({ price: 1300, priceIsCC: true, postalCode: "75017", ...o }), src17);
    expect(k({ title: "Appartement 2 pièces avec cave et parking" }).keep).toBe(true);
    expect(k({ propertyType: "Appartement", title: "Bel appartement proche commerces" }).keep).toBe(true);
    expect(k({ propertyType: "Appartement", title: "Studio proche boutiques" }).keep).toBe(true);
    expect(k({ propertyType: "Appartement", title: "Bel appartement, boutique en pied d'immeuble" }).keep).toBe(true);
    const r = k({ title: "Parking Batignolles" });
    expect(r.keep).toBe(false);
    expect(r.reason).toBe("type");
  });
  it("type au pluriel (Bureaux, Locaux, Parkings) : exclu comme au singulier", () => {
    const k = (o: Partial<Listing>) =>
      evaluate(listing({ price: 1300, priceIsCC: true, postalCode: "75017", ...o }), src17);
    for (const t of ["Bureaux", "Locaux commerciaux", "Locaux", "Parkings", "Boutiques", "Caves"])
      expect(k({ propertyType: t }).reason, t).toBe("type");
    expect(k({ title: "Bureaux 45 m² Levallois" }).reason).toBe("type");
    expect(k({ propertyType: "Appartement", title: "Appartement proche bureaux et commerces" }).keep).toBe(true);
  });
  it("drapeau quartier (mots-clés de quartier)", () => {
    expect(
      evaluate(listing({ price: 1300, priceIsCC: true, postalCode: "75017", address: "rue Lemercier" }), src17).flags,
    ).toContain("quartier");
    expect(
      evaluate(
        listing({ price: 1300, priceIsCC: true, postalCode: "75017", district: "Batignolles - Cardinet" }),
        src17,
      ).flags,
    ).toContain("quartier");
    expect(
      evaluate(listing({ price: 1300, priceIsCC: true, postalCode: "75017", address: "rue Guy Moquet" }), src17).flags,
    ).toContain("quartier");
  });
});

describe("zones : Paris 17 et Levallois-Perret", () => {
  const ok = { price: 1300, priceIsCC: true };
  it("deux zones, codes postaux autorisés dérivés", () => {
    expect(cfg.zones.map((z) => [z.postalCode, z.label])).toEqual([
      ["75017", "Paris 17"],
      ["92300", "Levallois"],
    ]);
    expect(cfg.allowedPostalCodes).toEqual(["75017", "92300"]);
  });
  it("92300 accepté (quelle que soit la source), 92200 et 92110 refusés en « localisation » ; 75017 inchangé", () => {
    for (const s of [src17, srcAll, srcLev, srcLevAll, srcBoth]) {
      expect(evaluate(listing({ ...ok, postalCode: "92300" }), s)).toEqual({ keep: true, rentCC: 1300, flags: [] });
      expect(evaluate(listing({ ...ok, postalCode: "75017" }), s)).toEqual({ keep: true, rentCC: 1300, flags: [] });
      expect(evaluate(listing({ ...ok, postalCode: "92200" }), s)).toMatchObject({
        keep: false,
        reason: "localisation",
      });
      expect(evaluate(listing({ ...ok, postalCode: "92110" }), s)).toMatchObject({
        keep: false,
        reason: "localisation",
      });
    }
  });
  it("« Levallois-Perret » sans code postal (titre ou adresse) -> 92300 : gardée, localisation confirmée même sur une source non filtrée", () => {
    expect(evaluate(listing({ ...ok, title: "Appartement Levallois-Perret 2 pièces" }), srcAll)).toEqual({
      keep: true,
      rentCC: 1300,
      flags: [],
    });
    expect(evaluate(listing({ ...ok, address: "LEVALLOIS PERRET" }), srcAll)).toEqual({
      keep: true,
      rentCC: 1300,
      flags: [],
    });
    expect(zoneOf(listing({ title: "Levallois-Perret / Parc des 5 continents" }), srcAll)?.label).toBe("Levallois");
  });
  it("localisation inconnue : drapeau inchangé (source non filtrée seulement)", () => {
    expect(evaluate(listing(ok), srcLev).flags).toEqual([]);
    expect(evaluate(listing(ok), srcBoth).flags).toEqual([]);
    expect(evaluate(listing(ok), srcLevAll).flags).toEqual(["localisation_non_confirmee"]);
  });
  it("drapeau quartier : inchangé en 75017 et en localisation inconnue (source du 17e) ; jamais pour une annonce de Levallois", () => {
    const kw = { ...ok, address: "rue Legendre", title: "2 pièces Dames" };
    expect(evaluate(listing({ ...kw, postalCode: "75017" }), src17).flags).toEqual(["quartier"]);
    expect(evaluate(listing(kw), src17).flags).toEqual(["quartier"]);
    expect(evaluate(listing(kw), srcAll).flags).toEqual(["localisation_non_confirmee", "quartier"]);
    expect(evaluate(listing({ ...kw, postalCode: "92300" }), srcBoth).flags).toEqual([]);
    expect(evaluate(listing({ ...ok, title: "Levallois, rue des Dames" }), srcAll).flags).toEqual([]);
    expect(evaluate(listing(kw), srcLev).flags).toEqual([]); // source de la seule zone Levallois, code inconnu
  });
  it("M5 : commune nommée sans code (« Pont de Levallois ») sur une source filtrée sur une seule zone : la zone de la source l'emporte", () => {
    const pont = listing({ ...ok, title: "Studio lumineux Pont de Levallois" });
    expect(evaluate(pont, src17)).toEqual({ keep: true, rentCC: 1300, flags: [] });
    expect(zoneOf(pont, src17)?.postalCode).toBe("75017");
    expect(postalOf(pont, src17)).toBe("75017");
    // Sans filtre d'URL sur une seule zone, la commune décide : 92300.
    expect(postalOf(pont, srcAll)).toBe("92300");
    expect(postalOf(pont, srcBoth)).toBe("92300");
    expect(zoneOf(pont, undefined)?.postalCode).toBe("92300");
    // Un code explicite l'emporte toujours sur la source.
    expect(postalOf(listing({ title: "Levallois (92300)" }), src17)).toBe("92300");
    expect(postalOf(listing({ title: "Paris 17e" }), srcLev)).toBe("75017");
  });

  it("zoneOf : zone du code postal, sinon celle de la source si elle n'en couvre qu'une, sinon null", () => {
    expect(zoneOf(listing({ postalCode: "92300" }), src17)?.postalCode).toBe("92300");
    expect(zoneOf(listing({ postalCode: "75017" }), srcLev)?.postalCode).toBe("75017");
    expect(zoneOf(listing({ address: "Paris 17e" }), srcLev)?.postalCode).toBe("75017");
    expect(zoneOf(listing(), srcLev)?.postalCode).toBe("92300");
    expect(zoneOf(listing(), src17)?.postalCode).toBe("75017");
    expect(zoneOf(listing(), srcBoth)).toBeNull();
    expect(zoneOf(listing(), undefined)).toBeNull();
    expect(zoneOf(listing({ postalCode: "92200" }), srcLev)).toBeNull();
  });
});

describe("commune voisine repérée sans code postal", () => {
  const k = (o: Partial<Listing>, src = srcAll) => evaluate(listing({ price: 1300, priceIsCC: true, ...o }), src);
  it("source non filtrée : écartée en localisation (titre, adresse) au lieu d'être gardée « non confirmée »", () => {
    expect(k({ title: "Boulogne Billancourt / République" })).toMatchObject({ keep: false, reason: "localisation" });
    expect(k({ address: "Neuilly-sur-Seine" })).toMatchObject({ keep: false, reason: "localisation" });
    expect(k({ title: "CLICHY – 3 PIÈCES LUMINEUX" })).toMatchObject({ keep: false, reason: "localisation" });
    expect(k({ title: "Appartement Général Leclerc-Paris XIV", surface: 50 })).toMatchObject({
      keep: false,
      reason: "localisation",
    });
  });
  it("annonces valides gardées : voie ou repère, Clichy-Batignolles, zone nommée avant la commune, source filtrée", () => {
    expect(k({ title: "2 pièces Avenue de Clichy" })).toMatchObject({
      keep: true,
      flags: ["localisation_non_confirmee"],
    });
    expect(k({ title: "Studio métro Brochant, proche Clichy" })).toMatchObject({
      keep: true,
      flags: ["localisation_non_confirmee", "quartier"],
    });
    expect(k({ title: "Clichy-Batignolles 2 pièces" })).toMatchObject({ keep: true });
    expect(k({ title: "Levallois-Perret, limite Neuilly" }, srcLevAll)).toMatchObject({ keep: true, flags: [] });
    expect(k({ title: "Studio Clichy" }, src17)).toMatchObject({ keep: true, flags: [] });
    expect(k({ title: "Appartement Paris 2e étage" })).toMatchObject({
      keep: true,
      flags: ["localisation_non_confirmee"],
    });
  });
});

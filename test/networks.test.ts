import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "../src/config/fetch";
import { bieniciUrl, NETWORKS, slugOf } from "../src/data/networks";
import type { Place } from "../src/data/networks";
import { arrPlace, proposeSources } from "../src/mcp/propose";
import paris from "../examples/paris-17-levallois.json";
import nantes from "../examples/nantes.json";

// Catalogue national (src/data/networks.ts) : les modèles d'adresse doivent redonner, à l'octet près, les adresses des sources des
// exemples, lues avec succès (Paris 17, Levallois-Perret, Nantes).

const urlOf = (id: string, p: Place): string => NETWORKS.find((n) => n.id === id)!.url(p);
const exampleUrl = (j: { sources: { id: string; url: string }[] }, id: string): string =>
  j.sources.find((s) => s.id === id)!.url;
const LEVALLOIS: Place = {
  name: "Levallois-Perret",
  town: "Levallois-Perret",
  slug: "levallois-perret",
  postalCode: "92300",
  insee: "92044",
};
const NANTES: Place = { name: "Nantes", town: "Nantes", slug: "nantes", postalCode: "44000", insee: "44109" };

describe("catalogue national : modèles d'adresse", () => {
  it("arrondissements calculés sans requête (code INSEE, nom, numéro)", () => {
    expect(arrPlace("75017")).toEqual({
      name: "Paris 17e",
      town: "Paris",
      slug: "paris",
      postalCode: "75017",
      insee: "75117",
      arr: 17,
    });
    expect(arrPlace("69001")).toMatchObject({ name: "Lyon 1er", insee: "69381", arr: 1 });
    expect(arrPlace("13008")).toMatchObject({ name: "Marseille 8e", insee: "13208" });
    expect(arrPlace("69100")).toBeNull(); // Villeurbanne
    expect(arrPlace("13090")).toBeNull(); // Aix-en-Provence
    expect(arrPlace("75000")).toBeNull();
  });

  it("slugOf : accents, apostrophes, espaces", () => {
    expect(slugOf("Saint-Étienne")).toBe("saint-etienne");
    expect(slugOf("L'Haÿ-les-Roses")).toBe("l-hay-les-roses");
    expect(slugOf("Levallois-Perret")).toBe("levallois-perret");
  });

  it("redonne les adresses des exemples : Paris 17", () => {
    const p17 = arrPlace("75017")!;
    expect(urlOf("foncia", p17)).toBe(exampleUrl(paris, "foncia_17"));
    expect(urlOf("laforet", p17)).toBe(exampleUrl(paris, "laforet_17"));
    expect(urlOf("orpi", p17)).toBe(exampleUrl(paris, "orpi_17"));
    expect(urlOf("era", p17)).toBe(exampleUrl(paris, "era_17"));
    expect(urlOf("ca_immo", p17)).toBe(exampleUrl(paris, "ca_immo_17"));
    expect(urlOf("century21", p17)).toBe(exampleUrl(paris, "century21_17"));
  });

  it("redonne les adresses des exemples : Levallois-Perret et Nantes", () => {
    expect(urlOf("foncia", LEVALLOIS)).toBe(exampleUrl(paris, "foncia_levallois"));
    expect(urlOf("laforet", LEVALLOIS)).toBe(exampleUrl(paris, "laforet_levallois"));
    expect(urlOf("orpi", LEVALLOIS)).toBe(exampleUrl(paris, "orpi_levallois"));
    expect(urlOf("era", LEVALLOIS)).toBe(exampleUrl(paris, "era_levallois"));
    expect(urlOf("ca_immo", LEVALLOIS)).toBe(exampleUrl(paris, "ca_immo_levallois"));
    expect(urlOf("foncia", NANTES)).toBe(exampleUrl(nantes, "foncia_nantes"));
    expect(urlOf("laforet", NANTES)).toBe(exampleUrl(nantes, "laforet_loire_atlantique"));
    expect(urlOf("orpi", NANTES)).toBe(exampleUrl(nantes, "orpi_nantes"));
    expect(urlOf("ca_immo", NANTES)).toBe(exampleUrl(nantes, "ca_immo_nantes"));
    expect(bieniciUrl(["-59874"], 500, 1100)).toBe(exampleUrl(nantes, "bienici"));
  });
});

describe("proposeSources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Lyon 3e et Villeurbanne : arrondissement calculé, commune par l'API, Bien'ici par la suggestion ; aucune lecture des sites", async () => {
    const urls: string[] = [];
    const agents: unknown[] = [];
    const doFetch = async (u: string, init?: RequestInit): Promise<Response> => {
      urls.push(u);
      agents.push((init?.headers as Record<string, string> | undefined)?.["User-Agent"]);
      if (u.includes("geo.api.gouv.fr") && u.includes("69100"))
        return new Response(
          JSON.stringify([{ nom: "Villeurbanne", code: "69266", codesPostaux: ["69100"], population: 150_000 }]),
        );
      if (u.includes("suggest.json?q=69003"))
        return new Response(
          JSON.stringify([
            { postalCodes: ["13003"], zoneIds: ["-1"] },
            { postalCodes: ["69003"], zoneIds: ["-120967"] },
          ]),
        );
      if (u.includes("suggest.json?q=69100"))
        return new Response(JSON.stringify([{ postalCodes: ["69100"], zoneIds: ["-120900"] }]));
      return new Response("[]");
    };
    const { proposals, unknown } = await proposeSources(["69003", "69100"], { min: 500, max: 1000 }, doFetch);
    expect(unknown).toEqual([]);
    // Ni page d'agence ni portail lus : seulement l'API des communes (Villeurbanne) et la suggestion de Bien'ici.
    expect(
      urls.every(
        (u) => u.startsWith("https://geo.api.gouv.fr/") || u.startsWith("https://res.bienici.com/suggest.json"),
      ),
    ).toBe(true);
    expect(urls.filter((u) => u.includes("geo.api.gouv.fr"))).toHaveLength(1);
    // Chaque requête s'identifie (API des communes comprise).
    expect(agents.every((a) => a === USER_AGENT)).toBe(true);
    const byId = new Map(proposals.map((p) => [p.id, p]));
    expect(proposals[0]!.id).toBe("bienici");
    expect(decodeURIComponent(proposals[0]!.adresse)).toContain('"zoneIds":["-120967","-120900"]');
    expect(decodeURIComponent(proposals[0]!.adresse)).toContain('"minPrice":400,"maxPrice":1100');
    expect(byId.get("foncia_lyon_3e")).toMatchObject({
      adresse: "https://fr.foncia.com/location/lyon-69003/appartement",
      zones: ["69003"],
      filtree_sur_les_zones: true,
    });
    expect(byId.get("foncia_villeurbanne")?.adresse).toBe(
      "https://fr.foncia.com/location/villeurbanne-69100/appartement",
    );
    expect(byId.get("ca_immo_lyon_3e")?.adresse).toBe(
      "https://www.ca-immobilier.fr/louer/location/appartement/69383/Lyon%203e",
    );
    expect(byId.get("era_69100")?.zones).toEqual(["69100"]);
    expect(byId.get("century21_69003")).toMatchObject({ verifie: false });
    expect(new Set(proposals.map((p) => p.id)).size).toBe(proposals.length);
    expect(proposals.every((p) => /^[a-z0-9_]+$/.test(p.id))).toBe(true);
  });

  it("commune à plusieurs codes postaux : une source par commune pour ses codes suivis, non filtrée s'il lui en reste d'autres ; code inconnu nommé", async () => {
    const doFetch = async (u: string): Promise<Response> => {
      if (u.includes("codePostal=44000") || u.includes("codePostal=44100"))
        return new Response(
          JSON.stringify([
            { nom: "Nantes", code: "44109", codesPostaux: ["44000", "44100", "44200", "44300"], population: 320_000 },
          ]),
        );
      if (u.includes("codePostal=99999")) return new Response("[]");
      return new Response("[]", { status: 503 });
    };
    const { proposals, unknown } = await proposeSources(["44000", "44100", "99999"], { min: 600, max: 1000 }, doFetch);
    expect(unknown).toEqual(["99999"]);
    const foncia = proposals.filter((p) => p.lecteur === "foncia");
    expect(foncia).toHaveLength(1);
    expect(foncia[0]).toMatchObject({ id: "foncia_nantes", zones: ["44000", "44100"], filtree_sur_les_zones: false });
    expect(proposals.filter((p) => p.lecteur === "era").map((p) => p.id)).toEqual(["era_44000", "era_44100"]);
    expect(proposals.some((p) => p.id === "bienici")).toBe(false); // suggestion indisponible : pas de Bien'ici, pas d'erreur
  });
});

import { describe, expect, it } from "vitest";
import bieniciRaw from "./fixtures/bienici.json?raw";
import orpiRaw from "./fixtures/orpi.html?raw";
import fonciaRaw from "./fixtures/foncia.html?raw";
import { PARSERS } from "../src/parsers/index";
import { evaluate, postalOf } from "../src/filter";
import type { SourceDef } from "../src/types";

const src = (id: string, parser: SourceDef["parser"]): SourceDef => ({
  id,
  name: id,
  url: "https://example.test/",
  parser,
  group: 0,
  filteredToZones: true,
  zones: ["75017"],
  phone: null,
  encoding: "utf-8",
  active: true,
});

describe("bienici parser", () => {
  const out = PARSERS.bienici(bieniciRaw, src("bienici", "bienici"));
  it("returns all 18 ads with unique ids and https urls", () => {
    expect(out).toHaveLength(18);
    expect(new Set(out.map((l) => l.id)).size).toBe(18);
    expect(out.every((l) => l.id !== "" && l.url.startsWith("https://"))).toBe(true);
    expect(out.every((l) => l.source === "bienici")).toBe(true);
  });
  it("maps the first ad field by field", () => {
    expect(out[0]).toMatchObject({
      id: "ag751948-554438852",
      url: "https://www.bienici.com/annonce/ag751948-554438852",
      price: 1629,
      charges: 100,
      priceIsCC: true,
      surface: 41,
      rooms: 2,
      postalCode: "75017",
      district: "Batignolles - Cardinet",
      agency: "L'IMMOBILIER PARISIEN - MONTMARTRE",
      title: "2 PIECES MEUBLE RUE DES BATIGNOLLES",
      propertyType: "flat",
      phone: null,
      publishedAt: "2026-10-16T10:28:27.100Z",
      photo:
        "https://file.bienici.com/photo/ag751948-554438852_photos.ubiflow.net_751948_554438852_photos_1.jpg_INSOON_EB_5512801818_20261016120334",
    });
  });
  it("ignores the 1970-01-01 publication date", () => {
    const l = out.find((x) => x.id === "ag754025-544911131")!;
    expect(l.publishedAt).toBeNull();
    expect(out.filter((x) => x.publishedAt === null)).toHaveLength(7);
  });
  it("sets priceIsCC only when rentWithoutCharges + charges equals price", () => {
    expect(out.find((x) => x.id === "apimo-5794568")!.priceIsCC).toBe(true); // 1346 + 221.35 = 1567.35
    expect(out.find((x) => x.id === "hektor-cmb-10004")!.priceIsCC).toBeNull(); // no rentWithoutCharges
    expect(out.find((x) => x.id === "gedeon-32238766")!.charges).toBeNull();
  });
  it("M2 : annonce sans code postal : la ville (« Paris 17e », « Levallois-Perret ») sert d'adresse et donne la zone ; avec code postal, adresse nulle (le quartier s'affiche comme avant)", () => {
    expect(out[0].address).toBeNull();
    const ad = JSON.parse(bieniciRaw).realEstateAds[0];
    delete ad.postalCode;
    const lev = { ...ad, id: "lev-1", city: "Levallois-Perret" };
    const [p17, l92] = PARSERS.bienici(JSON.stringify({ realEstateAds: [ad, lev] }), src("bienici", "bienici"));
    expect(p17).toMatchObject({ postalCode: null, address: "Paris 17e", district: "Batignolles - Cardinet" });
    expect(l92).toMatchObject({ postalCode: null, address: "Levallois-Perret" });
    const unfiltered: SourceDef = { ...src("bienici", "bienici"), zones: ["75017", "92300"], filteredToZones: false };
    expect(postalOf(p17, unfiltered)).toBe("75017");
    expect(postalOf(l92, unfiltered)).toBe("92300");
    expect(evaluate(p17, unfiltered).flags).not.toContain("localisation_non_confirmee");
    expect(evaluate({ ...p17, address: null }, unfiltered).flags).toContain("localisation_non_confirmee"); // sans l'adresse qui nomme la ville
  });
  it("throws when the JSON is missing or has no realEstateAds", () => {
    expect(() => PARSERS.bienici("<html></html>", src("bienici", "bienici"))).toThrow();
    expect(() => PARSERS.bienici("{}", src("bienici", "bienici"))).toThrow();
    expect(PARSERS.bienici('{"realEstateAds":[]}', src("bienici", "bienici"))).toEqual([]);
  });
});

describe("orpi parser", () => {
  const out = PARSERS.orpi(orpiRaw, src("orpi", "orpi"));
  it("returns the 6 items and none of the 9 similars", () => {
    expect(out.map((l) => l.id)).toEqual(["1503261", "1260124", "1500213", "1505183", "1504748", "1492133"]);
    for (const sim of [
      "1507720",
      "1506954",
      "1155573",
      "1497541",
      "1505332",
      "1384466",
      "1503814",
      "1365219",
      "1432575",
    ])
      expect(out.some((l) => l.id === sim)).toBe(false);
    expect(out.every((l) => l.url.startsWith("https://"))).toBe(true);
  });
  it("maps the first item field by field", () => {
    expect(out[0]).toMatchObject({
      id: "1503261",
      url: "https://www.orpi.com/annonce-location-appartement-t1-paris-17-75017-6d348061-077a-4d23-9105-85de0568042c/",
      price: 1090,
      surface: 25,
      rooms: 1,
      postalCode: "75017",
      district: "Guy Moquet",
      agency: "Agence immobilière Paris 17 Orpi Nouallet",
      propertyType: "appartement",
      priceIsCC: null,
      publishedAt: "2026-10-06T00:00:00+02:00",
      phone: null,
      photo:
        "https://cutjhqvjma.cloudimg.io/_prod_/sweepbright-s3/6d348061-077a-4d23-9105-85de0568042c--83c52b2d-c3d0-46e5-96b7-29bde1890e0b.jpg?p=estate-result-item&ci_url_encoded=1&ci_sign=7d1dc1898316f2431fa9d6bb7341bf581de39999",
    });
    expect(out[3]).toMatchObject({ price: 1990, surface: 54.8, rooms: 3, district: "Wagram" });
  });
  it("throws without data-result", () => {
    expect(() => PARSERS.orpi("<html></html>", src("orpi", "orpi"))).toThrow();
  });
});

describe("foncia parser", () => {
  const out = PARSERS.foncia(fonciaRaw, src("foncia", "foncia"));
  it("returns the 3 annonces (not nearbyAnnonces)", () => {
    expect(out.map((l) => l.id)).toEqual(["42047-14", "21833-323", "331692394"]);
    expect(out.every((l) => l.url.startsWith("https://"))).toBe(true);
  });
  it("maps the first annonce field by field", () => {
    expect(out[0]).toMatchObject({
      id: "42047-14",
      url: "https://fr.foncia.com/location/paris-75017/appartement/42047-14.htm",
      price: 1583,
      surface: 45.8,
      rooms: 2,
      postalCode: "75017",
      priceIsCC: true,
      photo: "https://img.prod.fonciatech.net/esset/lot/42047/14/IMG_3135.jpeg",
      publishedAt: "2026-10-16T03:01:03.989Z",
      propertyType: "appartement",
      phone: null,
    });
    expect(out[1].priceIsCC).toBe(true); // "10 000 € charges comprises"
    expect(out[2]).toMatchObject({ price: 1353.42, priceIsCC: null }); // description muette sur les charges
  });
  it("decodes Angular entities in text", () => {
    expect(out[0].title).toBe("Location Appartement 2 pièces 45.8 m² - Paris 75017");
  });
  it("throws without serverApp-state or search entry", () => {
    expect(() => PARSERS.foncia("<html></html>", src("foncia", "foncia"))).toThrow();
    expect(() =>
      PARSERS.foncia(
        '<script id="serverApp-state" type="application/json">{&q;a&q;:1}</script>',
        src("foncia", "foncia"),
      ),
    ).toThrow();
  });
});

describe("robustness (links, entity decoding)", () => {
  const esc = (o: unknown) =>
    JSON.stringify(o)
      .replace(/"/g, "&quot;")
      .replace(/&(?!quot;)/g, "&amp;");
  const orpiBody = (items: unknown[]) => `<div data-result="${esc({ items, similars: [] })}"></div>`;
  const s = (parser: SourceDef["parser"]) => ({ ...src("t", parser), url: "https://search.test/page" });

  it("orpi: item without slug links to the search page (src.url), not a guessed URL", () => {
    const out = PARSERS.orpi(orpiBody([{ id: 7, price: 1000 }]), s("orpi"));
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://search.test/page");
  });
  it("orpi: decodes numeric hex/decimal refs and named entities in one pass", () => {
    const body = `<div data-result="&#x7B;&quot;items&quot;&#x3A;&#x5B;&#x7B;&quot;id&quot;&#58;3,&quot;slug&quot;&#x3A;&quot;a&amp;b&#39;s&quot;,&quot;price&quot;&#x3A;5&#x7D;&#x5D;&#x7D;"></div>`;
    const out = PARSERS.orpi(body, s("orpi"));
    expect(out[0].id).toBe("3");
    expect(out[0].url).toBe("https://www.orpi.com/annonce-location-a&b's/");
    expect(out[0].price).toBe(5);
  });
  it("orpi: skips items without id", () => {
    const out = PARSERS.orpi(orpiBody([{ price: 1 }, { id: 2, slug: "x" }]), s("orpi"));
    expect(out.map((l) => l.id)).toEqual(["2"]);
  });
  it("bienici: skips ads without id", () => {
    const out = PARSERS.bienici(
      JSON.stringify({ realEstateAds: [{ price: 1 }, { id: "a1", price: 2 }] }),
      s("bienici"),
    );
    expect(out.map((l) => l.id)).toEqual(["a1"]);
  });
  it("foncia: skips annonces without reference", () => {
    const entry = {
      "POST.https://fnc-api.prod.fonciatech.net/annonces/annonces/search.{&q;x&q;:1}": {
        body: { annonces: [{ loyer: 1 }, { reference: "r1", canonicalUrl: "/x.htm", loyer: 2 }] },
      },
    };
    const raw = JSON.stringify(entry).replace(/"/g, "&q;");
    const out = PARSERS.foncia(`<script id="serverApp-state" type="application/json">${raw}</script>`, s("foncia"));
    expect(out.map((l) => l.id)).toEqual(["r1"]);
  });
  it("foncia: canonicalUrl absent or not starting with / falls back to the search page (src.url)", () => {
    const entry = {
      "POST.https://fnc-api.prod.fonciatech.net/annonces/annonces/search.{&q;x&q;:1}": {
        body: {
          annonces: [
            { reference: "r1", loyer: 2 },
            { reference: "r2", canonicalUrl: "https://evil.test/x", loyer: 2 },
            { reference: "r3", canonicalUrl: 42, loyer: 2 },
            { reference: "r4", canonicalUrl: "/ok.htm", loyer: 2 },
          ],
        },
      },
    };
    const raw = JSON.stringify(entry).replace(/"/g, "&q;");
    const out = PARSERS.foncia(`<script id="serverApp-state" type="application/json">${raw}</script>`, s("foncia"));
    expect(out.map((l) => l.url)).toEqual([
      "https://search.test/page",
      "https://search.test/page",
      "https://search.test/page",
      "https://fr.foncia.com/ok.htm",
    ]);
  });
});

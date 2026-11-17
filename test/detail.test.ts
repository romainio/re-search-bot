import { describe, expect, it } from "vitest";
import orpiDetail from "./fixtures/detail/orpi.html?raw";
import fnaimDetail from "./fixtures/detail/fnaim.html?raw";
import laforetDetail from "./fixtures/detail/laforet.html?raw";
import fonciaDetail from "./fixtures/detail/foncia.html?raw";
import { DESCRIPTION_MAX, DETAIL_MAX_BYTES, GALLERY_MAX } from "../src/config/fetch";
import { settings } from "../src/derive";
import { excerpt, gallery } from "../src/detail/common";
import { DETAIL_PARSERS } from "../src/detail/index";
import { mergeDetail } from "../src/enrich";
import { evaluate } from "../src/filter";
import type { Listing, ParserId, SourceDef } from "../src/types";

const cfg = settings();

const by = (id: string): SourceDef => cfg.sources.dedicated.find((s) => s.id === id)!;
const L = (source: string, o: Partial<Listing> = {}): Listing => ({
  source,
  id: "1",
  url: "https://example.test/annonce/1",
  price: 1500,
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
const read = (parser: ParserId, body: string, srcId: string, o: Partial<Listing> = {}) =>
  DETAIL_PARSERS[parser]!.read(body, L(srcId, o), by(srcId));
/** Corps d'une fiche Orpi minimale : attribut data-estate encodé comme sur le site (guillemets en &quot;). */
const estate = (o: object) =>
  `<html><div data-estate="${JSON.stringify(o).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div></html>`;

// Valeurs vérifiées à la main dans les fiches enregistrées (extraits par source).
describe("lecteurs de fiche (fixtures réelles)", () => {
  it("orpi : data-estate décodé, CC prouvé par price - priceHC = chargeReserve (1 500 - 1 460 = 40)", () => {
    const d = read("orpi", orpiDetail, "orpi_17");
    expect(d).toMatchObject({
      price: 1500,
      priceIsCC: true,
      charges: 40,
      surface: 41.2,
      rooms: 2,
      postalCode: "75017",
      district: "Guy Moquet",
      agency: "Agence immobilière Paris 17 Orpi Nouallet",
      phone: "01 40 25 48 28",
      photo:
        "https://cutjhqvjma.cloudimg.io/_prod_/sweepbright-s3/5fdff345-e338-477b-b953-ee02dc4c8f9d--43eb4ef2-d61a-492a-9671-3f24cae8c15a.jpg?p=estate-v2&ci_url_encoded=1&ci_sign=22575246ecbbfc9a77614ef57f5c84dca63948fa",
    });
    expect(d.description).toMatch(
      /^APPARTEMENT COUR RDC DEUX PIECES MEUBLES AGENCE ORPI NOUALLET\. EXCLUSIVITÉ - QUARTIER GUY MOQUET - VISITES/,
    );
    expect(d.description!.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(d.address ?? null).toBeNull(); // coordonnées floutées : pas de rue
  });

  it("orpi : code postal du bien (zipCode), jamais celui de l'agence ni du siège ; sans preuve CC, ni loyer ni charges", () => {
    const d = read(
      "orpi",
      estate({
        price: 1500,
        priceHC: 1460,
        chargeReserve: 100,
        zipCode: "75016",
        agency: { name: "Orpi X", phone: "01 00 00 00 00", zipcode: "75017", address1: "59 Avenue De Saint-Ouen" },
        legals: { HQAddress: "59 Avenue de Saint-Ouen, 75017 PARIS" },
      }),
      "orpi_17",
    );
    expect(d.postalCode).toBe("75016");
    expect(d.price).toBeUndefined();
    expect(d.priceIsCC).toBeUndefined();
    expect(d.charges).toBeUndefined();
  });

  it("orpi : chargeReserve 0 (price = priceHC) ne prouve pas le CC ; la mention « Charges comprises » sous le même prix, si", () => {
    const e = { price: 1500, priceHC: 1500, chargeReserve: 0, zipCode: "75017" };
    const d0 = read("orpi", estate(e), "orpi_17");
    expect(d0.priceIsCC).toBeUndefined();
    expect(d0.price).toBeUndefined();
    const label = (price: string) =>
      `<p><strong class="h2 text-primary">${price}</strong> <small>par mois</small></p>` +
      '<p class="mt-xs-bis"><small class="text-xs text-dark-grey"> Charges comprises </small></p>';
    const d1 = read("orpi", label("1&nbsp;500&nbsp;&euro;") + estate(e), "orpi_17");
    expect(d1).toMatchObject({ price: 1500, priceIsCC: true });
    expect(d1.charges).toBeUndefined(); // 0 n'est pas un montant de charges prouvé
    expect(read("orpi", label("1&nbsp;450&nbsp;&euro;") + estate(e), "orpi_17").priceIsCC).toBeUndefined(); // autre prix affiché
    expect(
      read("orpi", label("1&nbsp;500&nbsp;&euro;").replace("Charges comprises", "Hors charges") + estate(e), "orpi_17")
        .priceIsCC,
    ).toBeUndefined();
  });

  it("orpi : pas de data-estate (ou attribut tronqué par la lecture bornée) -> aucun champ, sans exception", () => {
    expect(read("orpi", "<html>rien</html>", "orpi_17")).toEqual({});
    const i = orpiDetail.indexOf('data-estate="');
    expect(read("orpi", orpiDetail.slice(0, i + 5000), "orpi_17")).toEqual({});
  });

  it("fnaim : « Loyer : 1 490 € par mois charges comprises », 120 € de provision (pas le complément de loyer de 169 €), surface / pièces / CP du bien", () => {
    const d = read("fnaim", fnaimDetail, "fnaim_17");
    expect(d).toMatchObject({ price: 1490, priceIsCC: true, charges: 120, surface: 37, rooms: 2, postalCode: "75017" });
    expect(d.description).toMatch(
      /^Pour cette annonce contcatez-nous via l'anonce ou par mail uniquement\. NE PAS APPELER L'AGENCE\./,
    );
  });

  it("laforet : phrase légale (HC 1 595 + provision 155 = CC 1 750), CP 75017 de l'objet viewItem et pas 92200 (agence)", () => {
    const d = read("laforet", laforetDetail, "laforet_17");
    expect(d).toMatchObject({ price: 1750, priceIsCC: true, charges: 155, surface: 41, rooms: 2, postalCode: "75017" });
    expect(d.postalCode).not.toBe("92200");
    expect(d.photo).toBe(
      "https://laforetbusiness.laforet-intranet.com/office9/laforet_neuillysurseine_lr/catalog/images/pr_p/5/2/8/3/5/6/1/8/52835618a.jpg",
    );
    expect(d.description).toMatch(/^\/\/ BAIL DROIT CIVIL UNIQUEMENT : DESTINE POUR UNE RESIDENCE SECONDAIRE/);
  });

  it("laforet : sans la phrase légale, la mention « Charges comprises » sous le prix suffit (CC sans montant de charges)", () => {
    const body = laforetDetail
      .replace(/loyer charges comprises/g, "xx")
      .replace(/provision charges/g, "yy")
      .replace(/Loyer hors charges/g, "zz");
    const d = read("laforet", body, "laforet_17");
    expect(d).toMatchObject({ price: 1750, priceIsCC: true });
    expect(d.charges).toBeUndefined();
  });

  it("foncia : rue et code postal du JSON-LD du bien, 99 € de provision pour charges, description", () => {
    const d = read("foncia", fonciaDetail, "foncia_17");
    expect(d).toMatchObject({ address: "97 RUE JOUFFROY D'ABBANS, 75017 Paris", postalCode: "75017", charges: 99 });
    expect(d.description).toMatch(/^Rue Jouffroy d.Abbans\. Agréable appartement 2 pièces au 6ème étage/);
    expect(d.description!.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(d.price).toBeUndefined(); // loyer et CC : déjà donnés par la liste
  });

  it("foncia : le code postal vient du JSON-LD du bien, jamais d'une adresse d'agence ailleurs dans la page ; sans JSON-LD, rien", () => {
    const ld = (o: object) =>
      `<script id="seo-annonce-structured-data" type="application/ld+json">${JSON.stringify(o)}</script>`;
    const body =
      "<footer>Agence Foncia Paris 17, 12 rue X, 75017 Paris</footer>" +
      ld({
        "@type": "apartment",
        description: "Loyer : 1500€/mois CC.",
        address: { postalCode: "75016", streetAddress: "3 RUE DE LA POMPE" },
      });
    expect(read("foncia", body, "foncia_17")).toMatchObject({
      postalCode: "75016",
      address: "3 RUE DE LA POMPE, 75016 Paris",
    });
    expect(read("foncia", body, "foncia_17").charges).toBeUndefined();
    expect(read("foncia", "<footer>Agence Foncia, 75017 Paris</footer>", "foncia_17")).toEqual({});
  });

  it("chaque lecteur, sur une page sans ses repères, ne renvoie rien sans lever", () => {
    for (const [p, r] of Object.entries(DETAIL_PARSERS)) {
      expect(r!.read("<html><body>Page d'accueil</body></html>", L("x"), by("orpi_17")), p).toEqual({});
    }
  });

  it("registre : orpi, fnaim, laforet, foncia (réseaux nationaux) ; lecture bornée par famille (défaut 300 Ko, Orpi et Foncia à part)", () => {
    expect(Object.keys(DETAIL_PARSERS).sort()).toEqual(["fnaim", "foncia", "laforet", "orpi"]);
    expect(DETAIL_MAX_BYTES).toBe(300_000);
    // Orpi : data-estate finit à 275 746 octets sur la fixture ; plus de photos ou un texte plus long le repoussent : 450 Ko.
    expect(DETAIL_PARSERS.orpi!.maxBytes).toBe(450_000);
    // Repère de fin de chaque fixture (octets UTF-8) sous la borne de sa famille.
    const bytes = (s: string, marker: string) =>
      new TextEncoder().encode(s.slice(0, s.indexOf(marker) + marker.length)).length;
    const cap = (p: ParserId) => DETAIL_PARSERS[p]!.maxBytes ?? DETAIL_MAX_BYTES;
    const estateEnd = orpiDetail.indexOf('"', orpiDetail.indexOf('data-estate="') + 13);
    expect(new TextEncoder().encode(orpiDetail.slice(0, estateEnd + 1)).length).toBeLessThan(cap("orpi"));
    expect(bytes(fnaimDetail, 'itemprop="postalcode"')).toBeLessThan(cap("fnaim"));
    expect(bytes(laforetDetail, "loyer charges comprises")).toBeLessThan(cap("laforet"));
    const ld = fonciaDetail.indexOf('id="seo-annonce-structured-data"');
    expect(
      new TextEncoder().encode(fonciaDetail.slice(0, fonciaDetail.indexOf("</script>", ld) + 9)).length,
    ).toBeLessThan(cap("foncia"));
  });
});

describe("extrait de description", () => {
  it("coupé à DESCRIPTION_MAX sans laisser une moitié de paire UTF-16 (emoji à la coupure)", () => {
    // Assertions booléennes : une demi-paire dans un message d'échec casse le canal du pool de test (UTF-8 invalide).
    const lone = (x: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(x);
    const s = `${"a".repeat(DESCRIPTION_MAX - 2)}😀bbb`; // l'emoji occupe les positions 298-299 : la coupure à 299 tombe dedans
    const out = excerpt(s)!;
    expect(lone(out)).toBe(false);
    expect(out === `${"a".repeat(DESCRIPTION_MAX - 2)}…`).toBe(true);
    expect(excerpt(`${"a".repeat(DESCRIPTION_MAX - 3)}😀bbb`) === `${"a".repeat(DESCRIPTION_MAX - 3)}😀…`).toBe(true);
  });
});

describe("fusion liste + fiche", () => {
  it("la fiche complète les champs nuls et remplace seulement par du non nul ; la photo de la liste est gardée", () => {
    const l = L("orpi_17", {
      surface: null,
      rooms: 2,
      address: "Texte de la carte",
      postalCode: null,
      photo: "https://list/p.jpg",
      district: "Ternes",
    });
    const m = mergeDetail(l, {
      surface: 30,
      rooms: undefined,
      address: "Rue Laugier, 75017 Paris",
      postalCode: "75017",
      photo: "https://detail/p.jpg",
      district: null,
      description: "Beau 2 pièces",
    });
    expect(m).toMatchObject({
      surface: 30,
      rooms: 2,
      address: "Rue Laugier, 75017 Paris",
      postalCode: "75017",
      photo: "https://list/p.jpg",
      district: "Ternes",
      description: "Beau 2 pièces",
    });
    expect(mergeDetail(L("x", { photo: null }), { photo: "https://detail/p.jpg" }).photo).toBe("https://detail/p.jpg");
    expect(l.surface).toBeNull(); // pas de mutation de l'annonce de la liste
  });

  it("loyer CC explicite : remplace le prix, fixe priceIsCC = true et les charges", () => {
    const m = mergeDetail(L("orpi_17", { price: 1460, priceIsCC: null, charges: null }), {
      price: 1500,
      priceIsCC: true,
      charges: 40,
    });
    expect(m).toMatchObject({ price: 1500, priceIsCC: true, charges: 40 });
    expect(evaluate(m, by("orpi_17"))).toMatchObject({ keep: true, rentCC: 1500, flags: [] });
  });

  it("HC + charges seulement : price = HC, charges, priceIsCC = false (loyer CC = HC + charges)", () => {
    const m = mergeDetail(L("fnaim_17", { price: 1500, priceIsCC: null, postalCode: "75017" }), {
      price: 1400,
      priceIsCC: false,
      charges: 100,
    });
    expect(m).toMatchObject({ price: 1400, priceIsCC: false, charges: 100 });
    expect(evaluate(m, by("fnaim_17")).rentCC).toBe(1500);
  });

  it("un prix sans mention CC/HC n'est pas appliqué ; source, id et url ne sont jamais remplacés", () => {
    const l = L("orpi_17", { price: 1300 });
    const m = mergeDetail(l, { price: 1440, source: "autre", id: "9", url: "https://ailleurs/" } as Partial<Listing>);
    expect(m).toMatchObject({
      price: 1300,
      priceIsCC: null,
      source: "orpi_17",
      id: "1",
      url: "https://example.test/annonce/1",
    });
    expect(mergeDetail(l, { priceIsCC: true }).priceIsCC).toBeNull();
  });
});

// Galerie : lecteurs dont la fiche expose la liste des photos (Orpi : data-estate.images).
describe("galerie de photos des fiches", () => {
  it("orpi : jusqu'à 5 photos https, la première est la vignette", () => {
    const d = read("orpi", orpiDetail, "orpi_17");
    expect(d.photos).toHaveLength(GALLERY_MAX);
    expect(d.photos![0]).toBe(d.photo);
    for (const u of d.photos!) expect(u).toMatch(/^https:\/\//);
    expect(new Set(d.photos).size).toBe(d.photos!.length);
  });

  it("lecteurs sans galerie (foncia, fnaim...) : pas de champ photos", () => {
    expect(read("fnaim", fnaimDetail, "fnaim_17").photos).toBeUndefined();
    expect(read("foncia", fonciaDetail, "foncia_17").photos).toBeUndefined();
  });

  it("gallery : https seulement, sans doublon, GALLERY_MAX au plus, valeurs étrangères ignorées", () => {
    expect(gallery(["http://a/1.jpg", "https://a/2.jpg", "https://a/2.jpg", 3, null, " https://a/3.jpg "])).toEqual([
      "https://a/2.jpg",
      "https://a/3.jpg",
    ]);
    expect(gallery(Array.from({ length: 9 }, (_, i) => `https://a/${i}.jpg`))).toHaveLength(GALLERY_MAX);
    expect(gallery("https://a/1.jpg")).toEqual([]);
    expect(gallery(undefined)).toEqual([]);
  });

  it("fusion : galerie de la liste puis de la fiche, sans doublon, 5 au plus ; sans galerie de fiche : inchangée", () => {
    const l = L("x", { photos: ["https://l/1.jpg"] });
    expect(mergeDetail(l, { photos: ["https://l/1.jpg", "https://d/2.jpg"] }).photos).toEqual([
      "https://l/1.jpg",
      "https://d/2.jpg",
    ]);
    expect(mergeDetail(L("x"), { photos: ["https://d/1.jpg"] }).photos).toEqual(["https://d/1.jpg"]);
    expect(mergeDetail(l, { photos: Array.from({ length: 9 }, (_, i) => `https://d/${i}.jpg`) }).photos).toHaveLength(
      GALLERY_MAX,
    );
    expect(mergeDetail(l, { surface: 30 }).photos).toEqual(["https://l/1.jpg"]);
    expect(mergeDetail(L("x"), { surface: 30 }).photos).toBeUndefined();
  });
});

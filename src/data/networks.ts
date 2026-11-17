import type { ParserId } from "../types";

/**
 * Catalogue national : réseaux et portails dont l'adresse de la liste des locations se déduit d'une commune (proposer_sources).
 * Chaque adresse n'est qu'une proposition, lue par ajouter_source avant enregistrement ; `verified: false` : modèle supposé, pas
 * encore lu sur une vraie ville. Un lieu est une commune, ou un arrondissement de Paris, Lyon ou Marseille.
 */
export interface Place {
  /** Nom affiché (« Lyon 3e », « Levallois-Perret »). */
  name: string;
  /** Nom de la commune sans arrondissement (« Lyon », « Levallois-Perret »). */
  town: string;
  /** Commune en minuscules sans accents, mots liés par « - » (« levallois-perret »). */
  slug: string;
  /** Code postal de la zone. */
  postalCode: string;
  /** Code INSEE (de l'arrondissement s'il y en a un : 75117, 69383, 13208). */
  insee: string;
  arr?: number;
}

export interface Network {
  id: string;
  name: string;
  parser: ParserId;
  /** Une source par code postal (« postal ») ou par lieu (« place ») ; « portal » : une seule source pour toutes les zones (Bien'ici). */
  scope: "postal" | "place";
  /** La page ne liste que ce lieu (filteredToZones). */
  filtered: boolean;
  url: (p: Place) => string;
  verified: boolean;
  note?: string;
}

const q = encodeURIComponent;

export const NETWORKS: readonly Network[] = [
  {
    id: "foncia",
    name: "Foncia",
    parser: "foncia",
    scope: "place",
    filtered: true,
    verified: true,
    url: (p) => `https://fr.foncia.com/location/${p.slug}-${p.postalCode}/appartement`,
  },
  {
    id: "laforet",
    name: "Laforêt",
    parser: "laforet",
    scope: "place",
    filtered: true,
    verified: true,
    url: (p) => `https://www.laforet.com/ville/location-appartement-${p.slug}-${p.postalCode}`,
  },
  {
    id: "orpi",
    name: "Orpi",
    parser: "orpi",
    scope: "place",
    filtered: true,
    verified: true,
    // Arrondissement : « paris-17 » / « Paris 17 » (relevé à Paris ; même modèle supposé pour Lyon et Marseille).
    url: (p) => {
      const value = p.arr ? `${p.slug}-${p.arr}` : p.slug;
      const label = p.arr ? `${p.town} ${p.arr}` : p.town;
      return `https://www.orpi.com/recherche/rent?realEstateTypes%5B0%5D=appartement&locations%5B0%5D%5Bvalue%5D=${q(value)}&locations%5B0%5D%5Blabel%5D=${q(label)}&sort=date-down&layoutType=mixte`;
    },
  },
  {
    id: "era",
    name: "ERA",
    parser: "era",
    scope: "postal",
    filtered: true,
    verified: true,
    url: (p) =>
      `https://api.eraimmobilier.com/api/v2/annonces/search?page=1&type_annonce=location&per_page=50&order_dir=desc&statut=0,1,11&type_bien=appartement&code_postal=${p.postalCode}`,
  },
  {
    id: "ca_immo",
    name: "Crédit Agricole Immobilier",
    parser: "caimmo",
    scope: "place",
    filtered: true,
    verified: true,
    url: (p) =>
      `https://www.ca-immobilier.fr/louer/location/appartement/${p.insee}/${q(p.arr ? `${p.town} ${p.arr}${p.arr === 1 ? "er" : "e"}` : p.town)}`,
  },
  {
    id: "century21",
    name: "Century 21",
    parser: "century21",
    scope: "postal",
    filtered: true,
    verified: false,
    note: "Century 21 limite le débit depuis les adresses de Cloudflare (HTTP 429) : souvent refusé à l'essai.",
    url: (p) => `https://www.century21.fr/annonces/location-appartement/cpv-${p.postalCode}_${p.slug}/`,
  },
];

/** Bien'ici (portail national) : une seule source pour toutes les zones, loyer borné par la recherche ; zoneIds : API de suggestion. */
export const BIENICI = {
  id: "bienici",
  name: "Bien'ici",
  parser: "bienici" as ParserId,
  suggest: "https://res.bienici.com/suggest.json?q=",
};
export function bieniciUrl(zoneIds: readonly string[], minPrice: number, maxPrice: number): string {
  const filters = {
    size: 100,
    from: 0,
    showAllModels: false,
    filterType: "rent",
    propertyType: ["flat"],
    minPrice,
    maxPrice,
    page: 1,
    sortBy: "publicationDate",
    sortOrder: "desc",
    onTheMarket: [true],
    zoneIdsByTypes: { zoneIds: [...zoneIds] },
  };
  return `https://www.bienici.com/realEstateAds.json?filters=${q(JSON.stringify(filters))}`;
}

/** « Levallois-Perret » -> « levallois-perret », « Saint-Étienne » -> « saint-etienne », « L'Haÿ-les-Roses » -> « l-hay-les-roses ». */
export function slugOf(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Villes à arrondissements : code INSEE de l'arrondissement n (Paris 75101..75120, Lyon 69381..69389, Marseille 13201..13216). */
export const ARR_INSEE: Readonly<Record<string, { postalPrefix: string; insee: (n: number) => string; max: number }>> =
  {
    Paris: { postalPrefix: "750", insee: (n) => String(75100 + n), max: 20 },
    Lyon: { postalPrefix: "690", insee: (n) => String(69380 + n), max: 9 },
    Marseille: { postalPrefix: "130", insee: (n) => String(13200 + n), max: 16 },
  };

/// <reference types="vite/client" />
// Page enregistrée de chaque source de l'exemple (examples/paris-17-levallois.json), servie par les tests de passage et de CPU.
// Toute source ajoutée à l'exemple y déclare sa page.
const FIX = import.meta.glob("./fixtures/*", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
export const fx = (n: string) => FIX[`./fixtures/${n}`];
export const FIXTURE_BY_ID: Record<string, string> = {
  bienici: fx("bienici_2z.json"),
  orpi_17: fx("orpi.html"),
  foncia_17: fx("foncia.html"),
  etude_wagram: fx("etude_wagram.html"),
  cmb: fx("cmb.html"),
  cmb_p2: fx("cmb.html"),
  agence_batignolles: fx("lbi_agb.html"),
  spr: fx("lbi_spr.html"),
  armaille: fx("lbi_armaille.html"),
  odi: fx("lbi_odi.html"),
  fnaim_17: fx("fnaim.html"),
  nestenn_17: fx("nestenn.html"),
  sector: fx("sector.html"),
  azoulay: fx("azoulay.html"),
  equinimo: fx("equinimo.html"),
  feau_17: fx("danielfeau.html"),
  domiere: fx("domiere.html"),
  laforet_17: fx("laforet.html"),
  // Levallois-Perret : pages enregistrées avec l'URL du registre (bienici : la requête bi-zone).
  orpi_levallois: fx("orpi_levallois.html"),
  foncia_levallois: fx("foncia_levallois.html"),
  laforet_levallois: fx("laforet_levallois.html"),
  fnaim_levallois: fx("fnaim_levallois.html"),
  nestenn_courbevoie: fx("nestenn_courbevoie.html"),
  century21_levallois: fx("century21_levallois.html"),
};
// Agences supplémentaires du 17e : pages enregistrées avec l'URL du registre, une par source, pour les tests par source (CPU, marqueurs
// de fin) ; le réseau simulé générique (mockFetch) sert une page légère par famille, pour ne pas relire des pages de 700 Ko.
const EXTRA_17_FIXTURES: Record<string, string> = {
  impact: fx("impact.html"),
  connexion: fx("connexion.html"),
  aream: fx("aream.html"),
  immediat: fx("immediat.html"),
  sainte_aubane: fx("sainte_aubane.html"),
  century21_17: fx("century21_17.html"),
  oralia: fx("oralia.html"),
  elger: fx("elger.html"),
};
Object.assign(FIXTURE_BY_ID, EXTRA_17_FIXTURES);
export const EXTRA_17_IDS = Object.keys(EXTRA_17_FIXTURES);
// Seconde voie de lecture (partenaires Jinka, comptes Bien'ici de Levallois) : pages enregistrées avec l'URL du registre ;
// era_levallois n'a que sa réponse vide réelle (total 0).
const SECOND_LANE_FIXTURES: Record<string, string> = {
  fredelion: fx("fredelion.html"),
  fredelion_p2: fx("fredelion_p2.html"),
  ca_immo_17: fx("ca_immo_17.html"),
  ca_immo_levallois: fx("ca_immo_levallois.html"),
  era_17: fx("era_17.json"),
  era_levallois: fx("era_levallois_empty.json"),
  imax_levallois: fx("imax_levallois.html"),
  imax_paris: fx("imax_paris.html"),
  consultants: fx("consultants.html"),
  mister_property: fx("mister_property.html"),
  agence_pereire: fx("agence_pereire.html"),
  safar: fx("safar.html"),
  levimmo: fx("levimmo.html"),
  pni: fx("pni.html"),
};
Object.assign(FIXTURE_BY_ID, SECOND_LANE_FIXTURES);
export const SECOND_LANE_IDS = Object.keys(SECOND_LANE_FIXTURES);

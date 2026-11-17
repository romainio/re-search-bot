import type { ParserId } from "../types";

/** Agence candidate telle que lue par une source ouverte, avant rapprochement avec le registre. */
export interface Candidate {
  /** SIRET (API Recherche d'entreprises) ou « osm:<type>/<id> » : stable d'une campagne à l'autre. */
  id: string;
  /** Noms connus (raison sociale, enseigne, nom OSM) ; le premier est affiché. */
  names: string[];
  address: string | null;
  postalCode: string | null;
  website: string | null;
  phone: string | null;
  origin: "entreprises" | "osm";
}

export type Verdict = "oui" | "non" | "incertain";

/** Gabarit reconnu : `template` (nom lisible), `parser` (lecteur de src/parsers réutilisable, null si aucun). */
export interface TemplateMatch {
  template: string;
  parser: ParserId | null;
}
export const TEMPLATE_UNKNOWN = "inconnu";
export const TEMPLATE_NO_SITE = "aucun_site";

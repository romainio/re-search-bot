import type { Listing, ParserId, SourceDef } from "../types";
import { detailFnaim } from "./fnaim";
import { detailFoncia } from "./foncia";
import { detailLaforet } from "./laforet";
import { detailOrpi } from "./orpi";

/** Lecteur de fiche : champs PROUVÉS par la fiche (jamais de devinette), à fusionner avec l'annonce de la liste (mergeDetail). */
export type DetailFn = (body: string, listing: Listing, src: SourceDef) => Partial<Listing>;

export interface DetailReader {
  read: DetailFn;
  /** Octets lus au plus (défaut DETAIL_MAX_BYTES) : la lecture s'arrête au-delà. */
  maxBytes?: number;
  /** Fiches lues par ce lecteur quand une famille de parseur couvre plusieurs gabarits de fiche (défaut : toutes). */
  accepts?: (l: Listing) => boolean;
  /** Fiches lues au plus par source et par passage (défaut MAX_ENRICH_PER_SOURCE) ; 1 pour une page lourde (CPU). */
  maxPerPass?: number;
}

/**
 * Lecteurs de fiche par famille de liste : les réseaux nationaux seulement, dont la fiche a un gabarit commun à toutes les
 * agences. Sans lecteur, ou hors des gabarits acceptés, aucune fiche n'est lue.
 */
export const DETAIL_PARSERS: Partial<Record<ParserId, DetailReader>> = {
  // Orpi : data-estate finit vers 276 Ko (10 photos) ; 450 Ko laissent de la marge, une fiche par passage (CPU).
  orpi: { read: detailOrpi, maxBytes: 450_000, maxPerPass: 1 },
  fnaim: { read: detailFnaim },
  laforet: { read: detailLaforet },
  // Foncia : JSON-LD du bien fini à 64 Ko d'une page de 390 Ko : 150 Ko lus au plus (marge pour un en-tête plus long).
  foncia: {
    read: detailFoncia,
    maxBytes: 150_000,
    accepts: (l) => l.url.startsWith("https://fr.foncia.com/location/"),
  },
};

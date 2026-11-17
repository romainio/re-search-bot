import type { Listing, ParserId, SourceDef } from "../types";
import { parseBienici } from "./bienici";
import { parseOrpi } from "./orpi";
import { parseFoncia } from "./foncia";
import { parseLbi } from "./lbi";
import { parseLbi2 } from "./lbi2";
import { parseFnaim } from "./fnaim";
import { parseNestenn } from "./nestenn";
import { parseApimo } from "./apimo";
import { parseNetty } from "./netty";
import { parseLaforet } from "./laforet";
import { parseCentury21 } from "./century21";
import { parseOralia } from "./oralia";
import { parseOsl } from "./osl";
import { parseBillie } from "./billie";
import { parseOffice5 } from "./office5";
import { parseAt1605 } from "./at1605";
import { parseCaImmo } from "./caimmo";
import { parseWpapimo } from "./wpapimo";
import { parseEra } from "./era";

export type ParserFn = (body: string, src: SourceDef) => Listing[];

const asyncOnly =
  (id: string): ParserFn =>
  () => {
    throw new Error(`${id} : lecture asynchrone, pas d analyseur synchrone`);
  };

export const PARSERS = {
  bienici: parseBienici,
  orpi: parseOrpi,
  foncia: parseFoncia,
  lbi: parseLbi,
  lbi2: parseLbi2,
  fnaim: parseFnaim,
  nestenn: parseNestenn,
  apimo: parseApimo,
  netty: parseNetty,
  laforet: parseLaforet,
  century21: parseCentury21,
  oralia: parseOralia,
  osl: parseOsl,
  billie: parseBillie,
  office5: parseOffice5,
  at1605: parseAt1605,
  caimmo: parseCaImmo,
  wpapimo: parseWpapimo,
  era: parseEra,
  // Lus hors des analyseurs synchrones : universel par src/universal/ (appel modèle), mail par src/mail/.
  universal: asyncOnly("universal"),
  mail: asyncOnly("mail"),
} as Record<ParserId, ParserFn>;

import { PROSPECT_PLATFORM_DOMAINS } from "../config/prospect";
import { settings } from "../derive";
import type { Instance } from "../instance";
import type { SourceDef } from "../types";
import type { Candidate } from "./types";

/**
 * Mots sans valeur d'identification d'un nom d'agence (formes juridiques, métier), retirés avant comparaison ; les lieux de la
 * recherche s'y ajoutent (« Orpi Lyon 3 » et « Orpi » sont la même agence).
 */
const BASE_STOP = [
  "sas",
  "sarl",
  "sa",
  "sasu",
  "eurl",
  "sci",
  "snc",
  "scp",
  "de",
  "du",
  "des",
  "la",
  "le",
  "les",
  "l",
  "d",
  "et",
  "en",
  "au",
  "aux",
  "a",
  "sur",
  "immobilier",
  "immobiliere",
  "immobilieres",
  "immo",
  "agence",
  "agences",
  "groupe",
  "gestion",
  "transaction",
  "transactions",
  "conseil",
  "conseils",
  "location",
  "locations",
  "france",
  "cabinet",
  "etude",
  "societe",
  "associes",
  "and",
  "eme",
  "arrondissement",
  "arr",
];
/** Numéro d'arrondissement ou ordinal (« 3e », « 1er », « 17eme ») : un lieu, jamais un nom. */
const ORDINAL = /^\d{1,2}(e|er|eme)$/;
export const stopWordsOf = (i: Instance): Set<string> =>
  new Set([
    ...BASE_STOP,
    ...i.zones.flatMap((z) => [z.postalCode, ...normalize(z.label).split(" ")]),
    ...(i.neighborhoodLabel ? normalize(i.neighborhoodLabel).split(" ") : []),
  ]);

/** Minuscules, sans accents ni ponctuation : « Bien’ici » -> « bien ici ». */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Mots d'identification d'un nom : normalisé, sans mots vides ni mots de moins de 2 caractères. */
export function keyTokens(name: string): string[] {
  const stop = settings().prospect.stopWords;
  return normalize(name)
    .split(" ")
    .filter((t) => t.length >= 2 && !stop.has(t) && !ORDINAL.test(t));
}

/** Hôte d'une URL, sans « www. » ; null si l'URL est invalide. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Les deux derniers segments de l'hôte (« mon-agence.la-boite-immo.com » -> « la-boite-immo.com »). */
const registrable = (host: string): string => host.split(".").slice(-2).join(".");

/**
 * Même site ? Hôtes identiques, ou même domaine principal, sauf quand l'un des hôtes est sur une plateforme partagée
 * (PROSPECT_PLATFORM_DOMAINS) : alors seul l'hôte exact compte.
 */
export function sameSite(a: string | null, b: string | null): boolean {
  const ha = hostOf(a),
    hb = hostOf(b);
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  const shared = (h: string) => PROSPECT_PLATFORM_DOMAINS.includes(registrable(h));
  if (shared(ha) || shared(hb)) return false;
  return registrable(ha) === registrable(hb);
}

/** Clés d'un registre (identifiant, nom) : jeu de mots d'identification non vide, sinon la source n'est pas comparable par le nom. */
function registryKeys(src: SourceDef): string[][] {
  return [src.name, src.id.replace(/_/g, " ")].map(keyTokens).filter((k) => k.length > 0);
}

/**
 * Nom du candidat reconnu dans le registre : tous les mots d'une clé de la source sont dans un nom du candidat, ou l'inverse pour
 * un nom court. Une clé d'un seul mot de moins de 4 lettres n'est comparée que par égalité (trop de faux rapprochements).
 */
export function nameMatches(names: string[], src: SourceDef): boolean {
  const keys = registryKeys(src);
  for (const n of names) {
    const cand = keyTokens(n);
    if (!cand.length) continue;
    const set = new Set(cand);
    for (const k of keys) {
      const equal = k.length === cand.length && k.every((t) => set.has(t));
      if (equal) return true;
      if (k.length === 1 && k[0].length < 4) continue;
      if (k.every((t) => set.has(t))) return true;
    }
  }
  return false;
}

/** Une agence déjà lue (registre, sources actives ou non) n'est pas candidate : même nom normalisé ou même site. */
export function inRegistry(c: Pick<Candidate, "names" | "website">, sources: readonly SourceDef[]): SourceDef | null {
  for (const s of sources) {
    if (nameMatches(c.names, s) || sameSite(c.website, s.url)) return s;
  }
  return null;
}

/** Deux candidats (entreprises et OSM) désignent la même agence : mêmes mots d'identification, ou même site. */
export function sameAgency(a: Pick<Candidate, "names" | "website">, b: Pick<Candidate, "names" | "website">): boolean {
  if (sameSite(a.website, b.website)) return true;
  for (const x of a.names)
    for (const y of b.names) {
      const kx = keyTokens(x),
        ky = keyTokens(y);
      if (kx.length && kx.length === ky.length && kx.every((t) => ky.includes(t))) return true;
    }
  return false;
}

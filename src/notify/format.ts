import { SUMMARY_MAX } from "../config/ai";
import type { PhotoCriterion } from "../config/ai";
import { settings } from "../derive";
import { zoneOf } from "../filter";
import { geoLine } from "../geo/render";
import type { PendingAlert } from "../process";
import type { Evaluation, Listing, SourceDef } from "../types";
import type { HealthEvent } from "../health";
import type { PhotoAnalysis } from "./photo";
import { clip, num } from "../format";
import { esc } from "../html";

const CAPTION_MAX = 1024;

/** Longueur maximale de la description (tirée de la fiche) dans un message ou une carte du tableau de bord. */
export const DESCRIPTION_SHOWN = 200;

const parisTime = (iso: string): string =>
  new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));

/** Mention du loyer (CC / HC + charges / charges non connues), partagée avec le tableau de bord. */
export function rentText(l: Listing, ev: Evaluation): string {
  const flags = ev.flags ?? [];
  if (flags.includes("prix_inconnu") || (ev.rentCC == null && l.price == null)) return "Loyer non indiqué";
  if (flags.includes("charges_inconnues")) return `${num(l.price ?? ev.rentCC ?? 0)} € (charges non connues)`;
  const cc = ev.rentCC ?? l.price ?? 0;
  if (l.priceIsCC === false && l.price != null && l.charges != null) {
    return `${num(cc)} € CC (${num(l.price)} HC + ${num(l.charges)} charges)`;
  }
  return `${num(cc)} € CC`;
}

const rentLine = (a: PendingAlert): string => rentText(a.listing, a.evaluation);

/** Libellé de zone de l'annonce (tête de l'alerte) ; localisation inconnue : les zones possibles jointes par « ou ». */
export function zoneLabel(l: Listing, src: SourceDef | undefined): string {
  const s = settings();
  const zone = zoneOf(l, src, s);
  if (zone) return zone.label;
  const codes = src?.zones.length ? src.zones : s.allowedPostalCodes;
  return s.zones
    .filter((z) => codes.includes(z.postalCode))
    .map((z) => z.label)
    .join(" ou ");
}

interface Parts {
  head: string[];
  title: string | null;
  address: string | null;
  tail: string[];
  description: string | null;
}

function parts(a: PendingAlert, src: SourceDef | undefined): Parts {
  const { listing: l, evaluation: ev } = a;
  const head = [ev.flags.includes("quartier") ? `🏠 ${settings().neighborhood.label}` : `🏠 ${zoneLabel(l, src)}`];
  if (a.kind === "price_drop") head.push("🔻 Baisse de prix");
  head.push(rentLine(a));
  const dims = [
    l.surface != null ? `${num(l.surface)} m²` : null,
    l.rooms != null ? `${l.rooms} pièce${l.rooms > 1 ? "s" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (dims) head.push(dims);
  const tail: string[] = [];
  if (ev.flags.includes("localisation_non_confirmee")) tail.push("⚠️ localisation non confirmée");
  const agency = l.agency ?? src?.name ?? null;
  if (agency) tail.push(`Agence : ${agency}`);
  const phone = l.phone ?? src?.phone ?? null;
  if (phone) tail.push(`Tél : ${phone}`);
  tail.push(`Détectée à ${parisTime(a.detectedAt)}`);
  return {
    head,
    title: l.title,
    address: l.address ?? l.district,
    tail,
    description: typeof l.description === "string" && l.description ? l.description : null,
  };
}

/**
 * Bloc compact de la grille photo (non échappé), ou null. Un « oui » s'affiche, un « incertain » avec « ? », un « non » pour les
 * seuls critères `showNo` ; un critère `parent` se rattache entre parenthèses à son parent.
 */
export function gridLine(
  p: PhotoAnalysis,
  criteria: readonly PhotoCriterion[] = settings().photoCriteria,
): string | null {
  const items: string[] = [];
  for (const c of criteria) {
    const cell = p.grid[c.id];
    if (c.parent || !cell) continue;
    if (cell.answer === "non" && !c.showNo) continue;
    let s = `${c.emoji} ${c.label}`;
    if (cell.answer === "non") s += " ✗";
    else {
      const kids = criteria
        .filter((k) => k.parent === c.id)
        .map((k) => ({ k, cell: p.grid[k.id] }))
        .filter((x) => x.cell && x.cell.answer !== "non")
        .map((x) => (x.cell!.answer === "incertain" ? `${x.k.label} ?` : x.k.label));
      if (kids.length) s += ` (${kids.join(", ")})`;
      if (cell.answer === "incertain") s += " ?";
    }
    items.push(s);
  }
  return items.length ? items.join(" · ") : null;
}

/** Options du Telegram interactif : grille ordonnée par le profil et ligne de synthèse. */
export interface ProfileOpts {
  criteria?: readonly PhotoCriterion[];
  line?: string | null;
}

export function formatTelegram(
  a: PendingAlert,
  src: SourceDef | undefined,
  photo?: PhotoAnalysis | null,
  market?: string | null,
  profile?: ProfileOpts,
): { caption: string; buttonUrl: string } {
  const p = parts(a, src);
  const geo = geoLine(a.geo);
  const build = (tMax: number, aMax: number, dMax: number): string => {
    const lines = [...p.head.map(esc)];
    if (p.address) lines.push(esc(clip(p.address, aMax)));
    if (p.title) lines.push(esc(clip(p.title, tMax)));
    lines.push(...p.tail.map(esc));
    if (market) lines.push(esc(market)); // indice de marché : une ligne courte, jamais rabotée
    // Indices géographiques : une ligne courte, avant la description.
    if (geo) lines.push(esc(geo));
    // Mini description IA à la place de la description brute ; si la légende déborde, on rabote la description, puis le titre,
    // puis l'adresse.
    const desc = photo?.summary ?? p.description;
    if (desc && dMax > 0) lines.push(esc(clip(desc, dMax)));
    const grid = photo ? gridLine(photo, profile?.criteria) : null;
    if (grid) lines.push(esc(grid));
    if (profile?.line) lines.push(esc(profile.line)); // synthèse du profil (déterministe), jamais rabotée
    return lines.join("\n");
  };
  let tMax = 200,
    aMax = 150,
    dMax = photo?.summary ? SUMMARY_MAX : DESCRIPTION_SHOWN;
  let caption = build(tMax, aMax, dMax);
  while (caption.length > CAPTION_MAX && (dMax > 0 || tMax > 0 || aMax > 0)) {
    if (dMax > 0) dMax = Math.max(0, dMax - 20);
    else if (tMax > 0) tMax = Math.max(0, tMax - 20);
    else aMax = Math.max(0, aMax - 20);
    caption = build(tMax, aMax, dMax);
  }
  // Dernier recours (champs courts mais très longs une fois échappés) : jamais de balise coupée car seul du texte échappé est tronqué.
  if (caption.length > CAPTION_MAX) caption = `${caption.slice(0, CAPTION_MAX - 1).replace(/&[a-z]*$/, "")}…`;
  return { caption, buttonUrl: a.listing.url };
}

export function formatWhatsApp(a: PendingAlert, src?: SourceDef): string {
  const p = parts(a, src);
  return [...p.head, p.address, p.title, ...p.tail, a.listing.url].filter((x): x is string => !!x).join("\n");
}

export function formatHealth(e: HealthEvent, sourceName: string): string {
  return e.type === "broken"
    ? `🔴 Source en panne : ${sourceName} (${e.reason})`
    : `🟢 Source rétablie : ${sourceName}`;
}

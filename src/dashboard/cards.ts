import { settings } from "../derive";
import { MAX_ALERT_ATTEMPTS } from "../config/scan";
import { zoneOf } from "../filter";
import { clip, decimal, num } from "../format";
import type { GeoHints } from "../geo/hints";
import { geoParts } from "../geo/render";
import { attr, esc, safeUrl } from "../html";
import { marketCardHtml, marketHint } from "../market";
import type { Market } from "../market";
import { DESCRIPTION_SHOWN, rentText } from "../notify/format";
import type { FeedbackState } from "../telegram/callback";
import type { Evaluation, Listing, SourceDef } from "../types";
import { between, days, parisDateTime } from "./common";
import type { Row } from "./common";

/** Prix au m² (loyer CC, ou affiché si les charges sont inconnues, / surface), une décimale : « 32,5 €/m² » ; sinon null. */
function perM2(l: Listing, ev: Evaluation): string | null {
  const rent = ev.rentCC ?? l.price;
  if (typeof rent !== "number" || typeof l.surface !== "number" || !(l.surface > 0)) return null;
  return `${decimal(rent / l.surface)} €/m²`;
}

/** Annonce et évaluation du payload ; null si illisible, exception si sa forme est invalide. */
export function payloadOf(r: Row): { listing: Listing; evaluation: Evaluation; geo?: GeoHints } | null {
  let p: { listing: Listing; evaluation: Evaluation; geo?: GeoHints };
  try {
    p = JSON.parse(r.payload);
  } catch {
    return null;
  }
  if (
    !p ||
    typeof p !== "object" ||
    !p.listing ||
    typeof p.listing !== "object" ||
    !p.evaluation ||
    typeof p.evaluation !== "object"
  ) {
    throw new Error("payload invalide");
  }
  return p;
}

export const dimsText = (l: Listing): string =>
  [
    l.surface != null ? `${num(l.surface)} m²` : null,
    l.rooms != null ? `${l.rooms} pièce${l.rooms > 1 ? "s" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

/** Marqueur des retours d'une annonce : « 👍 · 📞 appelée · 🗓 visite » ; vide sans retour. */
function followMarks(m: FeedbackState | null): string {
  if (!m) return "";
  return [
    m.avis === "aime" ? "👍" : m.avis === "deteste" ? "👎" : "",
    m.appel ? "📞 appelée" : "",
    m.visite ? "🗓 visite" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Carte d'une annonce ; vide si le payload est illisible, ou si la vue est filtrée sur une zone et l'annonce dans une autre. */
export function card(
  r: Row,
  sources: Map<string, SourceDef>,
  now: Date,
  onlyZone: string | null = null,
  market: Market | null = null,
  marks: FeedbackState | null = null,
): string {
  const p = payloadOf(r);
  if (!p) return "";
  const { listing: l, evaluation: ev, geo } = p;
  const flags = Array.isArray(ev.flags) ? ev.flags : [];
  const src = sources.get(r.source);
  const zone = zoneOf(l, src);
  if (onlyZone && zone && zone.postalCode !== onlyZone) return "";
  const url = safeUrl(l.url);
  const photo = safeUrl(l.photo);
  const dims = [dimsText(l), perM2(l, ev)].filter(Boolean).join(" · ");
  const where = l.address ?? l.district;
  const agency = l.agency ?? src?.name ?? r.source;
  const out: string[] = ['<article class="card">'];
  if (photo)
    out.push(`<div class="ph"><img src="${attr(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`);
  out.push('<div class="body">');
  if (r.alert_status === "silent") out.push('<span class="badge">déjà en ligne au lancement</span>');
  const cfg = settings();
  if (flags.includes("quartier")) out.push(`<span class="badge">${esc(cfg.neighborhood.label)}</span>`);
  // Zone autre que la première : badge à son nom.
  if (zone && zone !== cfg.zones[0]) out.push(`<span class="badge">${esc(zone.label)}</span>`);
  out.push(`<div class="rent">${esc(rentText(l, ev))}</div>`);
  if (dims) out.push(`<div>${esc(dims)}</div>`);
  out.push(marketCardHtml(marketHint(market, l, ev, zone))); // indice de marché (src/market.ts), jamais un filtre
  if (where) out.push(`<div>${esc(where)}</div>`);
  if (l.title) out.push(`<div class="mute">${esc(l.title.length > 160 ? `${l.title.slice(0, 159)}…` : l.title)}</div>`);
  if (typeof l.description === "string" && l.description)
    out.push(`<div class="desc">${esc(clip(l.description, DESCRIPTION_SHOWN))}</div>`);
  // Indices géographiques : un badge par indice, les avertissements en couleur d'alerte.
  const hints = geoParts(geo);
  if (hints.length)
    out.push(
      `<div class="hints">${hints.map((h) => `<span class="badge${h.warn ? " warn" : ""}">${esc(h.text)}</span>`).join("")}</div>`,
    );
  if (flags.includes("localisation_non_confirmee")) out.push('<div class="pend">localisation non confirmée</div>');
  // Retours posés par les boutons Telegram : un petit marqueur (jamais un filtre sur les alertes).
  const mk = followMarks(marks);
  if (mk) out.push(`<div class="follow">${esc(mk)}</div>`);
  const when = r.alert_status === "silent" ? "vue le" : "détectée le";
  out.push(`<div class="mute">${esc(agency)} · ${when} ${esc(parisDateTime(r.first_seen))}</div>`);
  // En ligne depuis la première détection du cluster (toutes sources), sinon de cette annonce ; « ≥ » : déjà en ligne au
  // lancement (durée minimale), comme dans la section des disparues.
  if (typeof r.score === "number")
    out.push(`<div class="mute score" title="similarité avec la recherche">pertinence ${decimal(r.score, 2)}</div>`);
  out.push(
    `<div class="mute">en ligne depuis ${r.alert_status === "silent" ? "≥ " : ""}${days(between(r.since ?? r.first_seen, now))}</div>`,
  );
  if (r.alert_status === "pending") {
    out.push(
      r.alert_attempts >= MAX_ALERT_ATTEMPTS
        ? '<div class="bad">échec d’envoi</div>'
        : '<div class="pend">en attente d’envoi</div>',
    );
  }
  if (url) out.push(`<a class="btn" href="${attr(url)}" rel="noopener noreferrer" target="_blank">Voir l’annonce</a>`);
  out.push("</div></article>");
  return out.join("");
}

import { MAIL_MAX_LISTINGS } from "../config/mail";
import { UNIVERSAL_PRICE_RANGE, UNIVERSAL_SURFACE_RANGE } from "../config/universal";
import type { Listing } from "../types";
import { findPostalCode } from "../util";
import { normalizeUrl, stableId } from "../universal/schema";
import { decodeEntities, htmlToText } from "./html";
import type { MailSender } from "./senders";

// Lecteur déterministe des mails d'alerte : un lien d'annonce (MailSender.linkPattern) et le texte de sa carte. Les formats des
// portails ne sont pas publics : le lecteur est tolérant (un lien d'annonce, et à côté un prix en €) ; sans résultat, l'appelant
// retombe sur le lecteur universel.

const PRICE = /(?<!\d[\s .]?)(\d{1,2}(?:[\s .]\d{3})+|\d{3,5})\s?(?:€|eur\b|euros?\b)/i;

const num = (s: string): number => Number(s.replace(/[\s .]/g, "").replace(",", "."));

/** Champs d'une carte lus dans son texte (null quand le texte ne le dit pas). */
export function parseCardText(
  raw: string,
): Pick<Listing, "price" | "charges" | "priceIsCC" | "surface" | "rooms" | "postalCode" | "title"> | null {
  // Les liens que htmlToText laisse en « (https://...) » ne sont pas du texte de carte (ni titre, ni chiffres).
  const text = raw
    .replace(/\(https?:\/\/[^)\s]*\)/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n");
  const pm = text.match(PRICE);
  if (!pm) return null;
  const price = num(pm[1]);
  const [pMin, pMax] = UNIVERSAL_PRICE_RANGE;
  if (!(price >= pMin && price <= pMax)) return null;
  const sm = text.match(/(\d{1,3}(?:[.,]\d{1,2})?)\s?(?:m²|m2|m²)/i);
  const surface = sm ? num(sm[1]) : null;
  const [sMin, sMax] = UNIVERSAL_SURFACE_RANGE;
  const rm = text.match(/(\d{1,2})\s*pi[èe]ces?\b/i) ?? text.match(/\b[TF]([1-9])\b/);
  const rooms = rm ? Number(rm[1]) : /\bstudio\b/i.test(text) ? 1 : null;
  const around = text.slice(Math.max(0, (pm.index ?? 0) - 30), (pm.index ?? 0) + pm[0].length + 40);
  const priceIsCC = /\bCC\b|charges\s+comprises/i.test(around)
    ? true
    : /\bHC\b|hors\s+charges/i.test(around)
      ? false
      : null;
  const cm = priceIsCC === false ? around.match(/charges?\s*:?\s*(\d{1,4})\s?€/i) : null;
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 3 && !/^\(?https?:/i.test(l));
  return {
    price,
    priceIsCC,
    charges: cm ? Number(cm[1]) : null,
    surface: surface !== null && surface >= sMin && surface <= sMax ? surface : null,
    rooms: rooms !== null && rooms <= 12 ? rooms : null,
    postalCode: findPostalCode(text),
    title: first ? first.slice(0, 120) : null,
  };
}

/**
 * Annonces d'un mail pour un expéditeur au motif de lien connu : des liens consécutifs vers la même annonce forment une carte, dont
 * le texte suit le premier lien (ou le précède, bouton en dernier). Identifiant : l'URL sans paramètres (le suivi change à chaque mail).
 */
export function readMailCards(sender: MailSender, html: string): Listing[] {
  if (!sender.linkPattern || !html) return [];
  const pattern = new RegExp(sender.linkPattern, "i");
  const anchors: { index: number; end: number; url: string }[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const href = decodeEntities(m[1]);
    if (!pattern.test(href)) continue;
    const url = normalizeUrl(href, sender.home, false);
    if (url) anchors.push({ index: m.index, end: m.index + m[0].length, url });
  }
  // Cartes : liens consécutifs de même URL fusionnés.
  const cards: { url: string; start: number; end: number }[] = [];
  for (const a of anchors) {
    const last = cards[cards.length - 1];
    if (last && last.url === a.url) last.end = a.end;
    else cards.push({ url: a.url, start: a.index, end: a.end });
  }
  // Texte après le lien (A) ou avant (B, bouton en dernier) : B si rien ne suit le dernier lien et qu'un prix précède le premier.
  const textBefore = (i: number): string =>
    htmlToText(html.slice(i === 0 ? Math.max(0, cards[0].start - 1500) : cards[i - 1].end, cards[i].start));
  const textAfter = (i: number): string => htmlToText(html.slice(cards[i].start, cards[i + 1]?.start ?? html.length));
  const buttonLast =
    cards.length > 0 && parseCardText(textAfter(cards.length - 1)) === null && parseCardText(textBefore(0)) !== null;
  const out = new Map<string, Listing>();
  for (let i = 0; i < cards.length && out.size < MAIL_MAX_LISTINGS; i++) {
    const c = cards[i];
    const f = parseCardText(buttonLast ? textBefore(i) : textAfter(i));
    if (!f) continue;
    const id = stableId(c.url, f.title, f.price, f.surface);
    if (!id || out.has(id)) continue;
    out.set(id, {
      source: `mail_${sender.key}`,
      id,
      url: c.url,
      ...f,
      charges: f.priceIsCC === true ? null : f.charges,
      address: null,
      district: null,
      photo: null,
      agency: sender.name,
      phone: sender.phone ?? null,
      propertyType: null,
      publishedAt: null,
    });
  }
  return [...out.values()];
}

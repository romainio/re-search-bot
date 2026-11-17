import { DESCRIPTION_MAX, GALLERY_MAX } from "../config/fetch";
import { text } from "../parsers/html";

// Outils partagés des lecteurs de fiche. Règle commune : un indexOf trouve le repère, seule la tranche passe par des regex
// (jamais de regex sur la page entière), et seuls les champs prouvés par la fiche sont renvoyés.

/** Tranche de `body` qui commence au repère `start` (absent : null) et s'arrête au repère `end` ou après `maxLen` caractères. */
export function between(body: string, start: string, end: string | null, maxLen: number): string | null {
  const i = body.indexOf(start);
  if (i < 0) return null;
  let j = Math.min(body.length, i + maxLen);
  if (end) {
    const e = body.indexOf(end, i + start.length);
    if (e >= 0 && e < j) j = e;
  }
  return body.slice(i, j);
}

/** Texte visible d'un fragment (balises retirées, entités décodées, espaces compactés), tronqué à `max` caractères. */
export function excerpt(html: string | null | undefined, max: number = DESCRIPTION_MAX): string | null {
  const t = text(html);
  if (!t) return null;
  // Coupure en unités UTF-16 : une demi-paire (emoji coupé) en fin de tranche est retirée.
  return t.length <= max
    ? t
    : `${t
        .slice(0, max - 1)
        .replace(/[\uD800-\uDBFF]$/, "")
        .trimEnd()}…`;
}

export const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Galerie d'une fiche : URLs https, sans doublon, GALLERY_MAX au plus ; [] si rien d'exploitable. */
export function gallery(list: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(list)) return out;
  for (const u of list) {
    if (typeof u === "string" && /^https:\/\//i.test(u.trim()) && !out.includes(u.trim())) out.push(u.trim());
    if (out.length >= GALLERY_MAX) break;
  }
  return out;
}

export const isPostal = (v: unknown): v is string => typeof v === "string" && /^\d{5}$/.test(v);

import { decodeEntities } from "../util";

// Texte visible d'un fragment HTML : commentaires et balises retirés, entités décodées, espaces compactés.
export function text(html: string | null | undefined): string | null {
  if (!html) return null;
  const t = decodeEntities(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return t === "" ? null : t;
}

// Découpe `body` en cartes : chacune commence à `marker` et finit au marqueur suivant, à `endMarker` ou après `maxLen`
// caractères, au premier atteint.
export function cards(body: string, marker: string, opts: { endMarker?: string; maxLen?: number } = {}): string[] {
  const out: string[] = [];
  const maxLen = opts.maxLen ?? 20000;
  let i = body.indexOf(marker);
  while (i >= 0) {
    const from = i + marker.length;
    let end = Math.min(body.length, i + maxLen);
    const next = body.indexOf(marker, from);
    if (next >= 0 && next < end) end = next;
    if (opts.endMarker) {
      const e = body.indexOf(opts.endMarker, from);
      if (e >= 0 && e < end) end = e;
    }
    out.push(body.slice(i, end));
    i = next;
  }
  return out;
}

export const abs = (href: string, base: string): string => new URL(decodeEntities(href), base).toString();

/** Type de bien annoncé dans un titre libre (« LOCATION PARKING CENTRE », « Maison de Maître »), sinon null. */
export function titleType(title: string | null): string | null {
  const m = title?.match(
    /\b(appartement|maison|parking|box|garage|cave|local commercial|bureau|studio|duplex|loft|immeuble|terrain)\b/i,
  )?.[1];
  return m ? m.charAt(0).toUpperCase() + m.slice(1).toLowerCase() : null;
}

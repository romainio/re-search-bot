// HTML d'un mail -> texte lisible, sans dépendance : repli du lecteur universel quand la conversion Markdown de Workers AI est
// indisponible, et texte des cartes du lecteur déterministe.

const NAMED: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  euro: "€",
  sup2: "²",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  acirc: "â",
  ccedil: "ç",
  ocirc: "ô",
  icirc: "î",
  ucirc: "û",
  ugrave: "ù",
  rsquo: "'",
  lsquo: "'",
  laquo: "«",
  raquo: "»",
  hellip: "…",
  ndash: "-",
  mdash: "-",
  middot: "·",
  deg: "°",
};

/** Entités HTML usuelles (nommées de la table ci-dessus, décimales et hexadécimales). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/**
 * Texte d'un HTML : scripts, styles et commentaires retirés, fins de bloc en retours à la ligne, balises retirées, entités
 * décodées. Les liens sont gardés sous la forme « texte (url) » : le modèle et le lecteur déterministe y retrouvent les URL.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(
        /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_m, href: string, inner: string) => `${inner} (${decodeEntities(href)}) `,
      )
      .replace(/<\s*(?:br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/table|\/td)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

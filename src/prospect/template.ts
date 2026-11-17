import { TEMPLATE_UNKNOWN } from "./types";
import type { TemplateMatch } from "./types";

/**
 * Signatures du gabarit d'un site d'agence, tirées des lecteurs et des fixtures (marqueurs du gabarit, pas des annonces). Ordre
 * significatif : réseaux de marque d'abord (une agence Nestenn contient aussi « immo-facile »), puis éditeurs de sites. lbi et
 * lbi2 ne se distinguent que sur la liste des locations (« property-listing-v2/v3 ») : lbi par défaut.
 */
type Rule = { test: (h: string) => boolean; match: TemplateMatch };
const has =
  (...needles: string[]) =>
  (h: string) =>
    needles.some((n) => h.includes(n));

const RULES: Rule[] = [
  { test: has("nestenn"), match: { template: "nestenn", parser: "nestenn" } },
  { test: has("century21", "century 21"), match: { template: "century21", parser: "century21" } },
  { test: has("orpi.com", "data-estate"), match: { template: "orpi", parser: "orpi" } },
  { test: has("foncia"), match: { template: "foncia", parser: "foncia" } },
  { test: has("laforet.com", "laforet"), match: { template: "laforet", parser: "laforet" } },
  { test: has("eraimmobilier"), match: { template: "era", parser: "era" } },
  {
    test: (h) => /property-listing-v[23]/.test(h) && has("la-boite-immo", "bobcat")(h),
    match: { template: "lbi2", parser: "lbi2" },
  },
  { test: has("bobcat", "la-boite-immo"), match: { template: "lbi", parser: "lbi" } },
  { test: has("_template_data = json.parse(b64_to_utf8("), match: { template: "netty", parser: "netty" } },
  { test: has("_siteosl"), match: { template: "osl", parser: "osl" } },
  { test: has("_siteat1605"), match: { template: "at1605", parser: "at1605" } },
  { test: (h) => h.includes("apimo") && h.includes("wp-content"), match: { template: "wpapimo", parser: "wpapimo" } },
  { test: has("apimo"), match: { template: "apimo", parser: "apimo" } },
  { test: has("office5", "immo-facile"), match: { template: "office5", parser: "office5" } },
  { test: has("billie.immo", "billie"), match: { template: "billie", parser: "billie" } },
];

/** Gabarit d'une page d'agence ; « inconnu » (sans lecteur) quand aucune signature ne correspond. */
export function detectTemplate(html: string): TemplateMatch {
  const h = html.toLowerCase();
  for (const r of RULES) if (r.test(h)) return r.match;
  return { template: TEMPLATE_UNKNOWN, parser: null };
}

/** Texte brut d'une page (scripts, styles et balises retirés, espaces réduits), au plus `max` caractères : entrée du modèle. */
export function pageText(html: string, max: number): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

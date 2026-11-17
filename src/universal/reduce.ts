import { UNIVERSAL_MAX_CHARS, UNIVERSAL_MD_INPUT_MAX } from "../config/universal";

// Réduction du Markdown avant le modèle : seuls les passages qui ressemblent à des annonces (un prix près d'une surface ou d'un
// nombre de pièces) sont gardés, car le coût en neurons suit la longueur du texte. Linéaire, sans regex à retour arrière (CPU).

const PRICE = /\d\s?(?:€|&euro;|eur\b|euros?\b)/i;
const SIZE = /\d\s?(?:m²|m2|㎡)|\bpi[èe]ces?\b|\bstudio\b|\b[TFP][1-6]\b/i;
/** Lignes gardées avant et après une ligne de prix (une carte : titre, adresse, prix, surface, lien). */
const BEFORE = 3;
const AFTER = 4;
/** Une ligne plus longue (menu, JSON incrusté) est coupée : elle ne vaut pas ses jetons. */
const LINE_MAX = 400;

/** État vide explicite d'une page de liste (« Aucun bien ne correspond ») : seul cas où zéro annonce n'est pas une erreur. */
export const EMPTY_STATE =
  /\b(?:aucun(?:e)?\s+(?:bien|annonce|r[ée]sultat|offre|logement)|0\s+(?:bien|annonce|r[ée]sultat)|pas\s+de\s+(?:bien|annonce)\s+(?:disponible|[àa]\s+louer))/i;

/**
 * Texte réduit : fenêtres de lignes autour des prix accompagnés d'une surface ou de pièces, fusionnées, au plus `max` caractères
 * (fenêtres entières, sauf la première, tronquée si elle seule dépasse). "" si rien ne ressemble à une annonce.
 */
export function reduceMarkdown(md: string, max: number = UNIVERSAL_MAX_CHARS): string {
  const lines: string[] = [];
  for (const raw of md.slice(0, UNIVERSAL_MD_INPUT_MAX).split("\n")) {
    const t = raw.trim();
    if (t) lines.push(t.length > LINE_MAX ? t.slice(0, LINE_MAX) : t);
  }
  const hit = lines.map((l) => PRICE.test(l));
  const size = lines.map((l) => SIZE.test(l));
  // Lignes de prix gardées : une surface ou des pièces dans la fenêtre.
  const keep: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!hit[i]) continue;
    const from = Math.max(0, i - BEFORE),
      to = Math.min(lines.length - 1, i + AFTER);
    let near = false;
    for (let j = from; j <= to && !near; j++) near = size[j];
    if (!near) continue;
    const last = keep[keep.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else keep.push([from, to]);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  let used = 0;
  for (const [from, to] of keep) {
    const win: string[] = [];
    for (let i = from; i <= to; i++) if (!seen.has(lines[i])) win.push(lines[i]);
    const text = win.join("\n");
    if (!text) continue;
    if (used + text.length + 5 > max) {
      if (out.length > 0) break;
      let acc = "";
      for (const l of win) {
        if (acc.length + l.length + 1 > max) break;
        acc += (acc ? "\n" : "") + l;
      }
      return acc;
    }
    for (const l of win) if (l.length > 20) seen.add(l); // les lignes courtes (« Voir », « € ») ne sont pas des doublons
    out.push(text);
    used += text.length + 5;
  }
  return out.join("\n---\n");
}

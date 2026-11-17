export type DpeClass = "A" | "B" | "C" | "D" | "E" | "F" | "G";

/**
 * Mots qui annoncent la classe énergie (« DPE : F », « classe énergétique E »…), puis la lettre, MAJUSCULE isolée : « DPE en
 * cours » ne donne rien. « GES » (émissions) n'est pas lu.
 */
const DPE_RE = new RegExp(
  String.raw`(?:\bDPE|classe\s+[ée]nerg[ée]tique|classe\s+[ée]nergie|[ée]tiquette\s+[ée]nerg[ée]tique|[ée]tiquette\s+[ée]nergie|diagnostic\s+de\s+performance\s+[ée]nerg[ée]tique)` +
    String.raw`(?:\s*\((?:classe|lettre)?\)?)?\s*(?:[:=\-–]|classe|lettre)?\s*(?:classe\s*|lettre\s*)?\(?\s*([A-G])\b`,
  "gi",
);

/** Classe DPE lue dans un texte ; null si absente. La première lettre majuscule valide l'emporte. */
export function readDpe(text: string): DpeClass | null {
  DPE_RE.lastIndex = 0;
  for (let m = DPE_RE.exec(text); m; m = DPE_RE.exec(text)) {
    if (/^[A-G]$/.test(m[1])) return m[1] as DpeClass;
  }
  return null;
}

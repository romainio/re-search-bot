import type { Obj } from "../guards";

// Lecture des arguments d'un outil MCP : une erreur est rendue à l'assistant, qui peut se reprendre.

export const POSTAL = /^\d{5}$/;

export function str(a: Obj, k: string, required: true): string;
export function str(a: Obj, k: string, required?: false): string | undefined;
export function str(a: Obj, k: string, required = false): string | undefined {
  const v = a[k];
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`${k} : texte requis`);
    return undefined;
  }
  if (typeof v !== "string") throw new Error(`${k} : texte attendu`);
  return v.trim();
}
export function num(a: Obj, k: string): number | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} : nombre attendu`);
  return v;
}
export function bool(a: Obj, k: string): boolean | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new Error(`${k} : true ou false attendu`);
  return v;
}
export function list(a: Obj, k: string): unknown[] | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error(`${k} : liste attendue`);
  return v;
}
export const postalList = (a: Obj, k: string): string[] | undefined =>
  list(a, k)?.map((z) => {
    if (typeof z !== "string" || !POSTAL.test(z)) throw new Error(`${k} : codes postaux à 5 chiffres attendus`);
    return z;
  });

/** Expression qui reconnaît un nom de commune (accents et traits d'union tolérés). */
export function townRegex(name: string): string {
  const classes: Record<string, string> = {
    a: "[aàâä]",
    e: "[eéèêë]",
    i: "[iîï]",
    o: "[oôö]",
    u: "[uùûü]",
    c: "[cç]",
    y: "[yÿ]",
  };
  const bare = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .trim();
  if (!bare) throw new Error("commune : nom vide");
  const words = bare
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => [...w].map((ch) => classes[ch] ?? (ch === "'" ? "['’]" : ch)).join(""));
  return `\\b${words.join("[\\s-]+")}\\b`;
}

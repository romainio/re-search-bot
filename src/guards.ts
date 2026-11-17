/** Objet JSON (ni null, ni tableau) : clés lisibles comme des valeurs inconnues à vérifier. */
export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Message d'une exception ; `fallback` pour une valeur levée qui n'est pas une Error (jamais d'objet arbitraire dans un message). */
export const errMsg = (e: unknown, fallback = "erreur"): string => (e instanceof Error ? e.message : fallback);

/** Valeur au bout d'un chemin dans un JSON inconnu (clé d'objet ou indice de tableau) ; undefined dès qu'un maillon manque. */
export function at(v: unknown, ...path: (string | number)[]): unknown {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/** Valeur présente : ni absente, ni null, ni chaîne vide (0 et false le sont). */
export const hasValue = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

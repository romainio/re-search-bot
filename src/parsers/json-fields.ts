// Champs des API JSON des portails, pris tels quels : un nombre fini, une chaîne non vide ; tout autre type vaut null.

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

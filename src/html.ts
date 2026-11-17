/** Texte échappé pour le contenu d'un élément HTML (pages du Worker et HTML de Telegram). */
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Texte échappé pour une valeur d'attribut entre guillemets simples ou doubles. */
export const attr = (s: string): string => esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** URL http(s) normalisée, sinon null : un lien venu d'un site tiers n'ouvre jamais javascript:, data: ou autre schéma. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
  } catch {
    return null;
  }
}

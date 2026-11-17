/**
 * Adresse qu'un utilisateur peut faire lire au Worker : http(s), nom de domaine public, sans identifiants. IP et noms locaux sont
 * refusés : une configuration écrite par MCP ou POST /config ne fait pas lire une adresse interne. Lève une Error lisible.
 */
export function publicUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`adresse invalide : ${raw.slice(0, 200)}`);
  }
  const h = u.hostname.toLowerCase();
  if (!/^https?:$/.test(u.protocol)) throw new Error("adresse http(s) attendue");
  if (u.username || u.password) throw new Error("adresse avec identifiants refusée");
  if (
    !h.includes(".") ||
    h.includes(":") ||
    /^[\d.]+$/.test(h) ||
    /(^|\.)(localhost|local|internal|lan|home|test)$/.test(h)
  )
    throw new Error("nom de domaine public attendu");
  return u.toString();
}

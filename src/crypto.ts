/** Comparaison en temps constant ; une clé vide ou absente refuse tout. */
export function authorized(provided: string | null, expected: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

/**
 * HMAC-SHA256 en hexadécimal (routes internes, secret du webhook, cookie) : la clé ne voyage jamais (les en-têtes sont
 * journalisés), et une signature n'autorise que ce message.
 */
export async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message))), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

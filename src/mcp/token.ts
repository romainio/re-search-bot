import { getSetting, setSetting, setSettingIfAbsent } from "../settings";

/** Jeton de l'adresse du connecteur (/mcp/<jeton>) : 32 octets aléatoires en hexadécimal, gardés en D1, sans lien avec ADMIN_KEY. */
export const MCP_TOKEN_KEY = "mcp_token";

const randomToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Jeton en vigueur, créé au premier besoin ; null si D1 est illisible (tout est alors refusé). */
export async function mcpToken(db: D1Database): Promise<string | null> {
  const stored = await getSetting(db, MCP_TOKEN_KEY);
  if (stored) return stored;
  try {
    await setSettingIfAbsent(db, MCP_TOKEN_KEY, randomToken());
  } catch {
    return null;
  }
  return getSetting(db, MCP_TOKEN_KEY);
}

/** Nouveau jeton : l'ancienne adresse cesse de fonctionner dès cette écriture. */
export async function rotateMcpToken(db: D1Database): Promise<string> {
  const token = randomToken();
  await setSetting(db, MCP_TOKEN_KEY, token);
  return token;
}

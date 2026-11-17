import type { Env } from "../types";

/** Interrupteurs des fonctions optionnelles (`vars`) et leurs exigences, vérifiées par GET /health ; défauts : docs/fonctions.md. */
export interface FeatureSwitch {
  name: keyof Env;
  doc: string;
  bindings?: readonly (keyof Env)[];
  secrets?: readonly (keyof Env)[];
  needs?: readonly (keyof Env)[];
}
export const FEATURE_SWITCHES: readonly FeatureSwitch[] = [
  { name: "GEO_HINTS", doc: "docs/indices-geo.md" },
  { name: "MARKET_HINTS", doc: "docs/marche.md" },
  { name: "PHOTO_SCORING", doc: "docs/photo-scoring.md", bindings: ["AI"] },
  { name: "TELEGRAM_INTERACTIVE", doc: "docs/telegram-interactif.md" },
  { name: "ASSISTANT_ENABLED", doc: "docs/assistant.md", bindings: ["AI"], needs: ["TELEGRAM_INTERACTIVE"] },
  { name: "SEMANTIC_SEARCH", doc: "docs/recherche-semantique.md", bindings: ["AI", "VECTORIZE"] },
  { name: "PROSPECT_ENABLED", doc: "docs/prospection.md" },
  { name: "PROSPECT_AI", doc: "docs/prospection.md", bindings: ["AI"], needs: ["PROSPECT_ENABLED"] },
  { name: "UNIVERSAL_READER", doc: "docs/lecteur-universel.md", bindings: ["AI"] },
  { name: "BROWSER_RENDER", doc: "docs/lecteur-universel.md", bindings: ["BROWSER"], needs: ["UNIVERSAL_READER"] },
  { name: "MAIL_INGEST", doc: "docs/mail.md" },
  { name: "WHATSAPP_ENABLED", doc: "docs/fonctions.md", secrets: ["CALLMEBOT_PHONE", "CALLMEBOT_APIKEY"] },
  { name: "MCP_ENABLED", doc: "docs/mcp.md" },
];

/** Taille maximale d'une configuration (POST /config, D1), en caractères : 100 sources tiennent en ~60 Ko. */
export const CONFIG_MAX_BYTES = 300_000;

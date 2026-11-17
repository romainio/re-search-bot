-- Réglages posés par le Worker (conversation Telegram liée, configuration vivante, jeton MCP).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL    -- ISO UTC
);

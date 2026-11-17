-- Budget Workers AI (src/ai/budget.ts) : neurons dépensés par jour UTC et par fonction.
CREATE TABLE ai_usage (
  day TEXT NOT NULL,        -- AAAA-MM-JJ, jour UTC (les neurons gratuits se remettent à zéro à 00:00 UTC)
  feature TEXT NOT NULL,    -- nom de la fonction (config.AI_FEATURE_CAPS) : « photo », ...
  neurons REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, feature)
);

-- Assistant Telegram (docs/assistant.md) : historique court des échanges, purgé au-delà de 24 h.
CREATE TABLE assistant_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,           -- ISO UTC de la question
  question TEXT NOT NULL,
  answer TEXT,                -- texte du modèle (court) ; NULL tant que la question est en cours ou sans réponse
  context TEXT                -- JSON : derniers filtres utilisés (outil + arguments validés), pour les questions de suivi
);
CREATE INDEX assistant_history_at ON assistant_history (at);

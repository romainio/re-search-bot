-- Résumé du soir : une ligne par jour de Paris, posée avant l'envoi (une seule fois par jour).
CREATE TABLE daily_summary (
  date TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);

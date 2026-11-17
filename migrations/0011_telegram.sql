-- Telegram interactif (docs/telegram-interactif.md) : profil de recherche et retours, jamais des filtres.
-- Profil de recherche en langage naturel : UNE ligne (id = 1), remplacée à chaque /profil <texte>, versionnée par sa date.
CREATE TABLE search_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at TEXT NOT NULL,     -- ISO UTC de la dernière version
  source_text TEXT NOT NULL,    -- texte libre tel que saisi (borné par config.PROFILE_TEXT_MAX)
  profile TEXT NOT NULL         -- JSON validé par schéma strict (src/telegram/profile.ts)
);

-- Retours sur une annonce : dernière valeur par (annonce, type). type « avis » : value aime | deteste ; « appel » et « visite » : value « oui ».
-- Cliquer deux fois sur le même bouton retire la ligne.
CREATE TABLE feedback (
  source TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('avis', 'appel', 'visite')),
  value TEXT NOT NULL,
  at TEXT NOT NULL,             -- ISO UTC du dernier clic
  PRIMARY KEY (source, listing_id, type)
);
CREATE INDEX feedback_at ON feedback (at);

-- Lecteur universel (docs/lecteur-universel.md) : dernière lecture réussie par le modèle, réutilisée si la page n'a pas changé.
CREATE TABLE universal_state (
  source TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  listings TEXT NOT NULL,           -- JSON : annonces validées de cette lecture
  count INTEGER NOT NULL,           -- nombre d'annonces (> 0 : une lecture à zéro annonce n'est jamais réutilisée)
  neurons REAL NOT NULL DEFAULT 0,  -- neurons dépensés par cette lecture (chiffre ce qu'une page inchangée évite)
  read_at TEXT NOT NULL             -- ISO UTC de la lecture par le modèle (filet : relue au bout de UNIVERSAL_RECHECK_DAYS jours)
);

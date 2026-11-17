-- Index du tableau de bord, tentatives d'envoi des alertes, dernier passage complet de chaque source.
CREATE INDEX listings_cluster ON listings (cluster);
CREATE INDEX listings_first_seen ON listings (first_seen);

-- Alerte rejetée par Telegram (400) : tentatives comptées ; au-delà de MAX_ALERT_ATTEMPTS elle sort de la file
-- (statut laissé à 'pending' : SQLite ne peut pas modifier la contrainte CHECK ; affichée « échec d'envoi »).
ALTER TABLE listings ADD COLUMN alert_attempts INTEGER NOT NULL DEFAULT 0;

-- Dernier passage complet (lecture + traitement réussis) : détecte les invocations mortes avant d'écrire l'état.
ALTER TABLE source_state ADD COLUMN last_run TEXT;

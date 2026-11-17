-- Annonces disparues : dernière présence constatée (last_seen) et date de disparition (gone_at).
ALTER TABLE listings ADD COLUMN last_seen TEXT;
ALTER TABLE listings ADD COLUMN gone_at TEXT;
-- Une seule clé pour les deux lectures : lignes suivies d'une source (gone_at IS NULL, source = ?, alert_status IN (...) :
-- les annonces filtrées, jamais marquées, sont sautées par l'index) et disparitions récentes du tableau de bord (gone_at > ?).
CREATE INDEX listings_gone ON listings (gone_at, source, alert_status);

-- Recherche sémantique (src/search/) : suivi d'indexation dans Vectorize, cache et limite horaire des recherches.
ALTER TABLE listings ADD COLUMN embedded_at TEXT;
ALTER TABLE listings ADD COLUMN embedded_gone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN embed_redo INTEGER NOT NULL DEFAULT 0;
-- Index partiels : chaque lecture du pas de cron (une par minute) ne touche que les lignes à traiter, jamais le stock entier.
-- Les termes de leur WHERE sont repris à l'identique dans les requêtes de src/search/embed.ts (condition d'usage d'un index partiel).
CREATE INDEX listings_embed_todo ON listings (first_seen)
  WHERE embedded_at IS NULL AND alert_status IN ('silent','pending','sent') AND cluster = source || ':' || listing_id;
CREATE INDEX listings_embed_redo ON listings (first_seen) WHERE embed_redo = 1;
CREATE INDEX listings_embed_gone ON listings (source) WHERE embedded_gone = 0 AND embedded_at IS NOT NULL AND gone_at IS NOT NULL AND embed_redo = 0;
CREATE INDEX listings_embed_back ON listings (source) WHERE embedded_gone = 1 AND gone_at IS NULL AND embed_redo = 0;

-- Résultats de recherche en cache (liste de voisins Vectorize, avant filtres D1) : clé = empreinte de (requête, zone, disparues).
CREATE TABLE search_cache (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  hits TEXT NOT NULL          -- JSON [[source, listing_id, score], ...]
);
CREATE INDEX search_cache_created ON search_cache (created_at);
-- Recherches non mises en cache par heure UTC (limite SEMANTIC_MAX_PER_HOUR : le tableau de bord est public).
CREATE TABLE search_rate (
  hour TEXT PRIMARY KEY,      -- AAAA-MM-JJTHH
  n INTEGER NOT NULL DEFAULT 0
);
-- Compteurs : « vectors » = vecteurs indexés (plafond SEMANTIC_MAX_VECTORS, offre gratuite de Vectorize).
CREATE TABLE embed_state (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 0
);

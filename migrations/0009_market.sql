-- Indicateurs de marché (src/market.ts) : pièces en colonne, agrégats par zone et tranche, annonces par jour.
ALTER TABLE listings ADD COLUMN rooms INTEGER;
UPDATE listings SET rooms = CAST(json_extract(payload, '$.listing.rooms') AS INTEGER)
  WHERE alert_status <> 'filtered' AND json_valid(payload) AND json_type(payload, '$.listing.rooms') IN ('integer', 'real');
-- Lecture des annonces nouvelles (pending, sent) d'une fenêtre de dates par plages d'index, sans parcourir les filtrées.
CREATE INDEX listings_status_seen ON listings (alert_status, first_seen);

-- Une ligne par zone (code postal) et tranche de pièces ('1', '2', '3', '4' = 4 et plus, 'all' = toute la zone). Effectifs
-- stockés tels quels : le seuil d'effectif minimum s'applique à la lecture (constante MARKET_MIN_SAMPLE), pas au calcul.
-- life_median_h : NULL quand la médiane tombe sur des annonces encore en ligne (censure, voir src/market.ts).
CREATE TABLE market_stats (
  zone TEXT NOT NULL,
  bucket TEXT NOT NULL,
  life_n INTEGER NOT NULL DEFAULT 0,
  life_median_h REAL,
  m2_n INTEGER NOT NULL DEFAULT 0,
  m2_median REAL,
  PRIMARY KEY (zone, bucket)
);
-- Annonces nouvelles (gardées, hors doublons) par jour UTC (le scan ne tourne qu'entre 7h et 19h UTC : jour UTC = jour de Paris).
CREATE TABLE market_daily (
  day TEXT PRIMARY KEY,
  n INTEGER NOT NULL
);
-- Dernier calcul (une seule ligne) : fraîcheur des agrégats.
CREATE TABLE market_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  computed_at TEXT NOT NULL
);

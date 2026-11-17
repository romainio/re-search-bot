-- Schéma initial : annonces (listings) et état de lecture des sources (source_state).
CREATE TABLE listings (
  source TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  url TEXT,
  postal_code TEXT,
  surface REAL,
  rent_cc REAL,              -- loyer CC calculé, ou montant affiché si charges inconnues
  cluster TEXT NOT NULL,     -- "source:id" de la première annonce du même appartement
  first_seen TEXT NOT NULL,  -- ISO, heure de détection sur cette source
  alert_status TEXT NOT NULL CHECK (alert_status IN ('filtered','silent','pending','sent','duplicate')),
  alert_kind TEXT,           -- 'new' | 'price_drop'
  alerted_at TEXT,
  payload TEXT NOT NULL,     -- JSON { listing, evaluation }
  PRIMARY KEY (source, listing_id)
);
CREATE INDEX listings_match ON listings (postal_code, surface);
CREATE INDEX listings_status ON listings (alert_status);
CREATE TABLE source_state (
  source TEXT PRIMARY KEY,
  initialized INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_count INTEGER,
  broken INTEGER NOT NULL DEFAULT 0,
  last_ok TEXT,
  last_error TEXT
);

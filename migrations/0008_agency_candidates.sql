-- Prospection des agences (docs/prospection.md) : agences candidates et avancement de la campagne.
CREATE TABLE agency_candidates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  postal_code TEXT,
  website TEXT,
  phone TEXT,
  template TEXT,
  parser TEXT,
  rental TEXT,
  status TEXT NOT NULL DEFAULT 'nouveau',
  origin TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  checked_at TEXT
);
CREATE INDEX agency_candidates_status ON agency_candidates (status, first_seen);

-- État d'avancement de la campagne (une seule ligne, id = 1) : phase (entreprises, osm, sites, fin, repos), curseur de la phase
-- (JSON), bail du pas en cours (lease_until), échecs de suite de la phase.
CREATE TABLE prospect_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  lease_until TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);

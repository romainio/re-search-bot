-- Zones couvertes par chaque source à son dernier passage : une zone ajoutée a son propre premier passage silencieux.
ALTER TABLE source_state ADD COLUMN zones TEXT;

-- Motif d'écart des annonces filtrées dans alert_kind, repris du payload pour les lignes existantes.
UPDATE listings SET alert_kind = COALESCE(json_extract(payload, '$.evaluation.reason'), 'inconnu')
  WHERE alert_status = 'filtered' AND alert_kind IS NULL AND json_valid(payload);
-- Décompte par motif du tableau de bord sans lire les payloads (index couvrant).
CREATE INDEX listings_status_kind ON listings (alert_status, alert_kind);

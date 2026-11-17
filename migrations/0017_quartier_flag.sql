-- Drapeau de quartier des annonces existantes : « batignolles » devient « quartier ».
UPDATE listings
SET payload = json_replace(payload, '$.evaluation.flags', json((
  SELECT json_group_array(CASE WHEN f.value = 'batignolles' THEN 'quartier' ELSE f.value END)
  FROM json_each(listings.payload, '$.evaluation.flags') f
)))
WHERE json_valid(payload) AND EXISTS (SELECT 1 FROM json_each(listings.payload, '$.evaluation.flags') f WHERE f.value = 'batignolles');

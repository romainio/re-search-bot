# Données de la région Île-de-France

Les deux fichiers de ce dossier sont des **données de la région Île-de-France**, pas du code :

| Fichier       | Contenu                                                                                                                                                         | Source (licence ODbL)                                    | Zones couvertes |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------- |
| `stations.ts` | Stations de métro, RER et Transilien (nom, lignes, latitude, longitude) à moins de 800 m de Paris 17 et de Levallois-Perret                                     | Île-de-France Mobilités, jeu `emplacement-des-gares-idf` | 75017, 92300    |
| `rent-cap.ts` | Loyers de référence majorés de l'encadrement des loyers de Paris, par quartier du 17e, nombre de pièces, époque et meublé ; contours simplifiés des 4 quartiers | Ville de Paris, jeu `logement-encadrement-des-loyers`    | 75017           |

Elles alimentent seulement les **indices géographiques** (`GEO_HINTS`, `docs/indices-geo.md`) : station la plus proche, promesse
de proximité, plafond de loyer. Sans elles, ou hors de leurs zones, l'alerte part sans l'indice : rien n'est inventé.

## Où se règle leur périmètre

`instance.config.json`, bloc `geo` :

- `stationPostalCodes` : codes postaux pour lesquels `stations.ts` fait foi (par défaut `75017`, `92300`) ;
- `rentCapPostalCodes` : codes postaux soumis à l'encadrement couvert par `rent-cap.ts` (par défaut `75017`).

Une annonce dont le code postal est connu et absent de ces listes reçoit **aucun** indice de station, de promesse ni de quartier
(vérifié par `test/user-config.test.ts`). Le DPE (lu dans le texte de l'annonce) ne dépend d'aucune donnée : il reste actif partout.

## Utilisateur hors Île-de-France : trois choix

1. **Laisser `GEO_HINTS` à `"false"`** (défaut). Aucune autre action. Recommandé pour une première installation.
2. **Allumer `GEO_HINTS` en laissant les listes ci-dessus telles quelles** : seul le DPE s'affiche pour les zones hors liste.
3. **Fournir les données de sa ville** (agent de code) :
   - `stations.ts` : remplacer `STATIONS` par les arrêts de sa ville (même forme `{ name, lines, lat, lon }`). Jeux ouverts à chercher
     sur `transport.data.gouv.fr` (GTFS : `stops.txt`, arrêts de métro, tram, train) ou le portail open data de la métropole. Ne garder
     que les arrêts à moins de ~800 m des zones, pour qu'aucune station lointaine ne soit désignée.
   - ajouter ses codes postaux à `stationPostalCodes`.
   - `rent-cap.ts` : seulement si sa ville a un encadrement des loyers (Paris, Lille, Lyon, Villeurbanne, Montpellier, Bordeaux, Pays
     basque... : vérifier sur service-public.fr) ; sinon laisser `rentCapPostalCodes` vide et ne pas toucher au fichier.
   - mettre à jour les tests `test/geo.test.ts` et `test/user-config.test.ts` (valeurs par défaut).

Le géocodage de l'adresse (API Adresse de la Géoplateforme, `data.geopf.fr`) couvre toute la France : il n'a pas à changer.

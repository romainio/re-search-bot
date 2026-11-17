---
name: Source à ajouter ou en panne · New or broken source
about: Un site d'annonces sans lecteur, ou qui n'est plus lu correctement · A listing site with no reader, or no longer read correctly
labels: source
---

**Site** : adresse de la page qui liste les locations · URL of the page listing the rentals

**Ville · City** :

**Constat · Observation** : résultat de l'outil MCP `tester_source` ou de `/test?source=<id>` (0 annonce, mauvais prix, erreur)
· output of the `tester_source` MCP tool or `/test?source=<id>` (0 listings, wrong price, error)

**Attendu · Expected** : nombre d'annonces visibles sur la page · number of listings shown on the page

Un site qui bloque la lecture automatique (403, 429, défi anti-robot) ne sera pas contourné · A site that blocks automated reading
(403, 429, bot challenge) will not be bypassed.

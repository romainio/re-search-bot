# PLAYBOOK : installer RE-SEARCH pour une ville, par un assistant IA

Ce fichier est écrit pour être **exécuté par un assistant IA** (ChatGPT, Claude, ou tout assistant qui dispose d'un **connecteur GitHub**
et d'un **connecteur Cloudflare**, avec une recherche web). L'utilisateur donne ce fichier à son assistant et répond aux questions ;
l'assistant fait le reste. Un humain peut aussi le suivre. Durée : 30 à 60 minutes, coût : zéro (plan gratuit).

Résultat : un Worker Cloudflare qui lit les sites d'annonces de location de la zone de l'utilisateur toutes les 5 minutes et envoie une
alerte Telegram par annonce nouvelle (ou en baisse de prix). Toute la personnalisation tient dans **une configuration** : en base D1 par
les outils MCP, ou dans `instance.config.json`, livré **non paramétré** (aucune zone, aucune source : le Worker ne lit rien).

**Voie rapide, sans connecteur GitHub ni Cloudflare** (README, « Installer ») : bouton Deploy, puis l'assistant se connecte au serveur MCP
de l'instance (`GET <URL>/?k=<CLE>` donne l'adresse) et fait les étapes 1 à 3 et 6 par ses outils : `etat`, `definir_recherche`,
`completer_localisation`, `proposer_sources`, `ajouter_source` (qui lit la page avant d'enregistrer), `detecter_gabarit` pour une agence
locale, `lier_telegram` ([`docs/mcp.md`](mcp.md)). La configuration est alors en base D1, pas dans `instance.config.json` : rien à
redéployer. Ce fichier reste la voie complète (recherche web des agences locales, configuration versionnée dans le dépôt).

Chaque étape : **Action**, **Attendu**, **Si échec**. Conventions : `<NOM>` = nom du Worker (par défaut `re-search`, champ `name` de
`wrangler.jsonc`), `$ACCOUNT_ID` = identifiant du compte Cloudflare, `<URL>` = `https://<NOM>.<sous-domaine>.workers.dev`,
`<CLE>` = `ADMIN_KEY`. Les appels d'API sont à faire avec le connecteur Cloudflare (outils de recherche d'endpoint puis d'exécution) ou
`curl -H "Authorization: Bearer $CF_API_TOKEN"` sur `https://api.cloudflare.com/client/v4`.

## Étape 0. Règles pour l'assistant

1. **Ne rien inventer.** Une URL, un identifiant de zone, un gabarit de site ne s'écrivent dans la configuration qu'après avoir été lus sur
   le site ou renvoyés par une API. Pas de source « probable » : chaque source est vérifiée à l'étape 7.
2. **Montrer avant d'écrire.** Afficher à l'utilisateur la liste des sources retenues et le contenu de `instance.config.json` avant de le
   committer.
3. **Plan gratuit uniquement.** Aucune ressource payante, jamais de plan Workers payant. Limites : 10 ms de CPU et 50 sous-requêtes par
   invocation, 10 000 neurons Workers AI par jour, 100 000 requêtes par jour.
4. **Aucun contournement d'anti-bot.** Une source qui répond 403, 429 ou un défi anti-robot est retirée, jamais contournée (pas de proxy,
   pas de faux en-têtes : le Worker se présente avec son propre User-Agent, `re-search/1.0`, pas d'insistance).
5. **Demander confirmation avant toute action sur le compte** de l'utilisateur : création du dépôt GitHub, secrets, création du Worker ou
   d'un index, branchement du dépôt. Les secrets (jeton du bot, `ADMIN_KEY`) ne s'affichent pas dans la conversation, ne s'écrivent dans
   aucun fichier du dépôt ni dans un commit. `ADMIN_KEY` est donnée **une seule fois** à l'utilisateur (gestionnaire de mots de passe).
6. **Une étape à la fois** : vérifier l'« attendu » avant la suite ; en cas d'écart, lire « Si échec » sans improviser de contournement.
7. Aucune fonction optionnelle ne filtre une annonce : seuls les critères de `instance.config.json` en écartent.

## Étape 1. Questions à l'utilisateur

Poser en une fois :

| #   | Question                                                                                                      | Champ de `instance.config.json`             |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | Quelle(s) **ville(s)** ou quels **codes postaux** (arrondissements) surveiller ?                              | `zones`                                     |
| 2   | **Loyer** minimum et maximum, charges comprises, par mois ?                                                   | `criteria.rentMin`, `rentMax`               |
| 3   | **Surface** minimale (m²) ? **Pièces** minimales ?                                                            | `criteria.surfaceMin`, `roomsMin`           |
| 4   | Écarter les **rez-de-chaussée** ?                                                                             | `criteria.excludeGroundFloor`               |
| 5   | **Critères photo** à repérer (sol : parquet, carrelage ; baignoire ; cuisine équipée ; lumière ; balcon...) ? | `photoCriteria` (défaut : ces dix critères) |
| 6   | Des **quartiers** à signaler dans l'alerte (drapeau, jamais un filtre) ?                                      | `neighborhoodKeywords`, `keywordsZone`      |
| 7   | Nom du Worker (minuscules, chiffres, tirets) ? Défaut `re-search`.                                            | `name` de `wrangler.jsonc`                  |

Prérequis à confirmer : compte Cloudflare gratuit, compte GitHub, compte Telegram (le bot est créé à l'étape 6), application GitHub de
Cloudflare installable (étape 5).

Attendu : réponses chiffrées. Si l'utilisateur hésite : proposer des valeurs larges, elles se resserrent plus tard sans rien casser.

## Étape 2. Recherche web des sources

Objectif : une liste d'entrées `sources` (id, nom, URL de la liste des **locations d'appartements** de la zone, lecteur). Viser **15 à 40
sources** : les 2-3 agrégateurs et réseaux nationaux d'abord, puis les agences locales. Au plus 10 sources par groupe de lecture, 100 au total.

### 2.1 Agrégateur Bien'ici (une requête pour toute la zone)

Pour chaque ville : `GET https://res.bienici.com/suggest.json?q=<ville>`. La réponse est une liste ; prendre l'entrée `type: "city"` dont
`postalCodes` correspond. Champs utiles : `zoneIds` (ex. `["-59874"]` pour Nantes), `postalCodes`, `insee_code` (réutilisé plus bas),
`boundingBox` (`south`, `west`, `north`, `east` : donne le `bbox` de la zone, dans l'ordre `[south, west, north, east]`). Un arrondissement
de Paris s'obtient avec `q=paris 17`.

URL de la source (`parser: "bienici"`, `filteredToZones: true` si toutes les `zones` de la source sont couvertes par les `zoneIds`) :

```sh
node -e 'const f={size:100,from:0,showAllModels:false,filterType:"rent",propertyType:["flat"],minPrice:900,maxPrice:1700,page:1,sortBy:"publicationDate",sortOrder:"desc",onTheMarket:[true],zoneIdsByTypes:{zoneIds:["<zoneId1>","<zoneId2>"]}};console.log("https://www.bienici.com/realEstateAds.json?filters="+encodeURIComponent(JSON.stringify(f)))'
```

Élargir `minPrice`/`maxPrice` de 100 € autour des critères (le filtre exact est fait par le Worker).

### 2.2 Réseaux nationaux à URL paramétrable par ville

Gabarits exacts déjà utilisés dans `examples/paris-17-levallois.json` (copier la source de l'exemple, remplacer ville et code postal ;
`<slug>` = nom de ville en minuscules, tirets, sans accents ; `<cp>` = code postal ; `<insee>` = `insee_code` de Bien'ici) :

| Réseau                     | `parser`  | Gabarit d'URL                                                                                                                                                                   | Remarques                                                                                   |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Orpi                       | `orpi`    | `https://www.orpi.com/recherche/rent?realEstateTypes%5B0%5D=appartement&locations%5B0%5D%5Bvalue%5D=<slug>&locations%5B0%5D%5Blabel%5D=<Ville>&sort=date-down&layoutType=mixte` | Paris : `paris-17`, `Paris 17`                                                              |
| Foncia                     | `foncia`  | `https://fr.foncia.com/location/<slug>-<cp>/appartement`                                                                                                                        | `filteredToZones: true`                                                                     |
| Laforêt                    | `laforet` | `https://www.laforet.com/ville/location-appartement-<slug>-<cp>`                                                                                                                | page lourde : `"stopMarker": "id=\"nearest--area--"`                                        |
| ERA                        | `era`     | `https://api.eraimmobilier.com/api/v2/annonces/search?page=1&type_annonce=location&per_page=50&order_dir=desc&statut=0,1,11&type_bien=appartement&code_postal=<cp>`             | JSON, `filteredToZones: true`                                                               |
| Crédit Agricole Immobilier | `caimmo`  | `https://www.ca-immobilier.fr/louer/location/appartement/<insee>/<Ville>`                                                                                                       | `<Ville>` avec tirets (`Levallois-Perret`)                                                  |
| FNAIM                      | `fnaim`   | voir l'exemple (`fnaim_17`) : l'URL embarque un identifiant de localité FNAIM (`localites=[{"id":...}]`) que seule la recherche sur fnaim.fr donne                              | chercher la ville sur fnaim.fr, copier l'URL des résultats, élargir `PRIX_MIN` / `PRIX_MAX` |

Pour chaque URL construite : la récupérer une fois (avec le User-Agent du Worker, `USER_AGENT` de `src/config/fetch.ts`) et vérifier qu'elle renvoie bien des annonces de la bonne
ville ; sinon ne pas la retenir. Constats du test de Nantes (09/11/2026, `examples/nantes.json`) : Bien'ici (identifiant de zone de la
ville), Orpi, Foncia, ERA (une source par code postal) et CA Immobilier lisent tous des annonces nantaises ; la page Laforêt d'une ville
peut **rediriger vers la page du département** : garder la source avec `"filteredToZones": false` (le filtre par code postal écarte les
autres communes).

### 2.3 Agences locales (recherche web)

Rechercher « agence immobilière location <ville> », « gestion locative <ville> », « administrateur de biens <ville> », puis les pages
« nos locations » de chaque agence trouvée. Retenir l'URL de la **page de liste des locations** (pas l'accueil). Chaque agence peut avoir
plusieurs pages (`/location/1`, `/location/2` : une source par page utile).

**Reconnaître la famille de lecteur** (signatures relevées dans `src/prospect/template.ts`, à chercher dans le code source de la page, en
minuscules) :

| Signature dans le HTML                                                          | `parser`                                                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `nestenn`                                                                       | `nestenn` (domaine `*.nestenn.com`)                                          |
| `bobcat` (balise `<meta name="generator" content="bObcat">`) ou `la-boite-immo` | `lbi` ; `lbi2` si `property-listing-v2` ou `property-listing-v3` est présent |
| `apimo`                                                                         | `apimo` ; `wpapimo` si `wp-content` (site WordPress) est aussi présent       |
| `_TEMPLATE_DATA = JSON.parse(b64_to_utf8(`                                      | `netty`                                                                      |
| `_siteOSL` suivi de chiffres                                                    | `osl`                                                                        |
| `_siteAT1605`                                                                   | `at1605`                                                                     |
| `office5` ou `immo-facile` (sans `nestenn`)                                     | `office5`                                                                    |
| `billie.immo`                                                                   | `billie`                                                                     |
| `orpi.com`, `foncia`, `laforet`, `eraimmobilier`                                | `orpi`, `foncia`, `laforet`, `era`                                           |

Les autres lecteurs de `src/parsers/index.ts` sont ceux des réseaux et portails nationaux (`bienici`, `century21`, `caimmo`, `fnaim`,
`oralia`) : une URL de recherche du site (filtrée sur la ville quand le site le permet), lue par le lecteur du réseau (voir l'exemple et
l'outil MCP `proposer_sources`).

**Site sans signature connue : `parser: "universal"`** (le modèle lit la page ; au plus **15** sources `universal` actives, `"every": 15`
ou plus ; le modèle n'est appelé que si la page a changé). **Test rapide avant de choisir `universal`** : le HTML brut de la page de liste
doit contenir des prix (« 850 € », « 850 €/mois »). S'il n'en contient aucun, les annonces sont chargées par JavaScript : aucun lecteur ne
les voit (« aucune annonce dans la page » à l'étape 7). Retirer la source, ou, pour 2 sites au plus, `"render": "browser"` avec
`BROWSER_RENDER` (quota de 10 minutes par jour, `docs/lecteur-universel.md`).

Options utiles d'une source : `filteredToZones` (`true` seulement si l'URL ne renvoie QUE des annonces des `zones` de la source),
`stopMarker` (page lourde : texte après lequel la lecture s'arrête), `encoding: "windows-1252"` (accents cassés), `phone`, `note`,
`active: false` (désactivée mais gardée), `"extraPage": true` sur les pages 2 et suivantes d'une agence (`/location/2`) : une page de
pagination vide est alors normale, pas une panne (jamais sur la page 1).

### 2.4 Sources à éviter

Connues pour bloquer les machines de Cloudflare : **PAP** (HTTP 403), **Century 21** (HTTP 429), **SeLoger** et **Leboncoin** (anti-robot et
conditions d'usage). Ne pas les ajouter. Elles sont dans l'exemple avec `active: false`. Repli éventuel : alertes par mail (`docs/mail.md`,
demande un domaine).

Attendu : tableau `id | nom | URL | lecteur | zones` montré à l'utilisateur. Si une zone n'a presque aucune agence : c'est normal pour une
petite ville, Bien'ici et les réseaux nationaux couvrent l'essentiel.

## Étape 3. Écrire et valider `instance.config.json`

Action : remplacer le contenu de `instance.config.json` (racine du dépôt, à jour avec `instance.schema.json`). Les champs `zones`,
`criteria` et `sources` sont à remplir (`criteria` n'est facultatif que sans zone), le reste a des valeurs par défaut. Une
configuration enregistrée par MCP (D1) prime sur le fichier. Minimal commenté (le fichier réel ne contient pas de
commentaires, JSON strict) :

```jsonc
{
  "$schema": "./instance.schema.json",
  "zones": [
    // Code postal sur 5 chiffres ; label = nom court dans l'alerte ; town = expression (regex) du nom de la commune quand l'annonce
    // n'a pas de code postal ; bbox = [sud, ouest, nord, est] (boundingBox de Bien'ici, facultatif, sert à la prospection des agences).
    { "postalCode": "44000", "label": "Nantes", "town": "\\bnantes\\b", "bbox": [47.18, -1.64, 47.3, -1.48] }
  ],
  "criteria": { "rentMin": 700, "rentMax": 1200, "surfaceMin": 35, "roomsMin": 2, "excludeGroundFloor": false },
  "neighborhoodKeywords": ["Graslin", "Bouffay"], // facultatif : signalés, jamais filtrés
  "geo": { "stationPostalCodes": [], "rentCapPostalCodes": [] }, // laisser vide hors Île-de-France
  "sources": [
    {
      "id": "bienici", // unique : minuscules, chiffres, _
      "name": "Bien'ici",
      "url": "https://www.bienici.com/realEstateAds.json?filters=...",
      "parser": "bienici",
      "zones": ["44000"], // codes postaux couverts, tous présents dans `zones`
      "filteredToZones": true // l'URL ne renvoie que ces zones
    }
  ]
}
```

`examples/paris-17-levallois.json` est un exemple complet (60 sources, toutes les options) : le consulter, ne pas le modifier. Autres
champs : `window` (plage de lecture, 9h-20h de Paris par défaut), `ai` (plafonds de neurons), `outOfZoneTowns` (communes voisines à
écarter nommément). `group` est facultatif (réparti automatiquement). Hors Île-de-France, `GEO_HINTS` reste sans stations ni encadrement
(`src/data/README.md`) ; seul le DPE (lu dans le texte des annonces) fonctionne partout.

Valider : avec un terminal, `npx --yes ajv-cli validate -s instance.schema.json -d instance.config.json --strict=false` (forme du
fichier, attendu « valid »). Sans terminal : relire le fichier contre `instance.schema.json` (champs, types, énumérations). Dans tous les
cas, le Worker revalide la configuration au chargement : une erreur fait échouer le build et le journal énumère TOUTES les erreurs avec
leur chemin (ex. `sources[3].parser : ...`). Un éditeur donne l'autocomplétion grâce à `$schema`.

Attendu : aucune erreur. Si échec : corriger le chemin indiqué (clé inconnue, code postal pas à 5 chiffres, zone absente de `zones`,
`every` hors 5/10/15/20/30/60, identifiant dupliqué).

Montrer le fichier à l'utilisateur, puis passer à l'étape 4.

## Étape 4. Copier le dépôt et déployer une première fois

**Voie recommandée : le bouton « Deploy to Cloudflare »** (un clic de l'utilisateur, aucun jeton à créer). L'utilisateur ouvre
`https://deploy.workers.cloudflare.com/?url=https://github.com/romainio/re-search-bot`, se connecte à Cloudflare et à GitHub, choisit le nom du
Worker et du dépôt, et saisit les deux secrets demandés : `ADMIN_KEY` (générée à l'étape 5.1, à faire avant) et `TELEGRAM_BOT_TOKEN`
(étape 6.1, à faire avant). Cloudflare copie le dépôt dans son compte GitHub, crée la base D1 et branche Workers Builds : chaque `push`
sur `main` redéploie. La configuration livrée n'est pas paramétrée (aucune zone, aucune source) : rien ne tourne avant l'étape
suivante. Ensuite, avec le connecteur GitHub, committer `instance.config.json` (étape 3) dans le dépôt créé : le build repart tout seul.
Passer alors à l'étape 5.0, puis directement à l'étape 6.2 (les secrets sont posés, le dépôt est branché : 5.2 à 5.4 sont inutiles).

**Autre voie (sans le bouton)**, après confirmation :

1. Copier ce dépôt dans le compte GitHub de l'utilisateur : **fork**, ou « Use this template » si le dépôt est un modèle, ou création d'un
   dépôt (privé conseillé) puis envoi du contenu. Garder la branche `main`.
2. Si le nom du Worker change : champ `name` de `wrangler.jsonc`.
3. Committer `instance.config.json` (et `wrangler.jsonc`) sur `main` : « chore: configuration de l'instance ».

Rien d'autre à écrire : pas d'identifiant Cloudflare, pas de secret, pas de `database_id`.

Attendu : le dépôt contient `docs/playbook.md`, `wrangler.jsonc`, `instance.config.json` à jour. Si échec : droits du connecteur GitHub sur le
dépôt (le connecteur doit pouvoir écrire sur `main`).

## Étape 5. Connecteur Cloudflare : secrets et déploiement

### 5.0 Compte et adresse

`GET /accounts` : prendre `result[0].id` = `$ACCOUNT_ID` (plusieurs comptes : demander lequel). Sous-domaine de l'adresse :
`GET /accounts/$ACCOUNT_ID/workers/subdomain` → `result.subdomain`. S'il est vide : en proposer un à l'utilisateur puis
`PUT /accounts/$ACCOUNT_ID/workers/subdomain` avec `{"subdomain":"<choix>"}`. Adresse du Worker : `<URL>`.

### 5.1 Générer `ADMIN_KEY`

Chaîne aléatoire de 64 caractères hexadécimaux (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, ou tout
générateur sûr). La donner **une fois** à l'utilisateur ; elle sert aux routes d'administration (en-tête `Authorization: Bearer <CLE>` ; `?k=<CLE>` accepté sur un GET, pour le navigateur) et ouvre le tableau de bord.

### 5.2 (Sans le bouton) Créer le Worker vide (les secrets exigent un Worker existant)

`PUT /accounts/$ACCOUNT_ID/workers/scripts/<NOM>` en `multipart/form-data` : champ `metadata` =
`{"main_module":"index.js","compatibility_date":"2026-10-15"}` et fichier `index.js` (type `application/javascript+module`) =
`export default { fetch() { return new Response("RE-SEARCH : installation en cours"); } };`. Il sera remplacé par le premier build, sans
cron : rien ne tourne encore.

### 5.3 (Sans le bouton) Poser les deux secrets

Pour chacun : `PUT /accounts/$ACCOUNT_ID/workers/scripts/<NOM>/secrets` avec le corps JSON
`{"name":"ADMIN_KEY","text":"<valeur>","type":"secret_text"}`, puis `{"name":"TELEGRAM_BOT_TOKEN","text":"<jeton>","type":"secret_text"}`
(le jeton vient de l'étape 6 : faire l'étape 6.1 avant). Vérification, noms seulement :
`GET /accounts/$ACCOUNT_ID/workers/scripts/<NOM>/secrets` doit lister `ADMIN_KEY` et `TELEGRAM_BOT_TOKEN`. Les secrets survivent aux
déploiements suivants. Aucun autre secret n'est requis (`TELEGRAM_CHAT_ID` et `TELEGRAM_WEBHOOK_SECRET` sont facultatifs : la
conversation est liée par `/start <code>`, le secret du webhook est dérivé d'`ADMIN_KEY`).

### 5.4 (Sans le bouton) Brancher le dépôt (Workers Builds)

**Prérequis humain (un clic) : installer l'application GitHub de Cloudflare** sur le compte (ou l'organisation) GitHub de l'utilisateur,
avec accès au dépôt : tableau de bord Cloudflare > Workers & Pages > Create > « Import a repository » > Connect GitHub (lien
`https://dash.cloudflare.com/?to=/:account/workers-and-pages/create`). Sans cela, les appels ci-dessous échouent.

1. Jeton de build : l'utilisateur crée dans son profil Cloudflare un jeton d'API (modèle « Edit Cloudflare Workers », limité à son
   compte, plus la permission D1 : Modifier). L'identifiant du jeton : `GET /user/tokens/verify` → `result.id`. Puis
   `POST /accounts/$ACCOUNT_ID/builds/tokens` avec `{"build_token_name":"re-search","build_token_secret":"<valeur du jeton>","cloudflare_token_id":"<result.id>"}`
   → `result.build_token_uuid`.
2. Connexion du dépôt : `PUT /accounts/$ACCOUNT_ID/builds/repos/connections` avec
   `{"provider_type":"github","provider_account_id":"<identifiant GitHub du propriétaire>","provider_account_name":"<login>","repo_id":"<identifiant du dépôt>","repo_name":"<nom du dépôt>"}`
   → `result.repo_connection_uuid`. (`provider_account_id` et `repo_id` : numéros donnés par l'API GitHub, `GET /repos/<login>/<repo>` →
   `owner.id` et `id`.)
3. Déclencheur : `POST /accounts/$ACCOUNT_ID/builds/triggers` avec
   `{"external_script_id":"<tag du Worker>","repo_connection_uuid":"<uuid>","build_token_uuid":"<uuid>","trigger_name":"Deploy main","build_command":"","deploy_command":"npx wrangler deploy","root_directory":"/","branch_includes":["main"],"branch_excludes":[],"path_includes":["*"],"path_excludes":[]}`
   → `result.trigger_uuid`. Le « tag du Worker » n'est pas son nom : `GET /accounts/$ACCOUNT_ID/workers/scripts/<NOM>` ou la liste
   `GET /accounts/$ACCOUNT_ID/workers/scripts` (champ `tag`).
4. Premier build : `POST /accounts/$ACCOUNT_ID/builds/triggers/<trigger_uuid>/builds` avec `{"branch":"main"}` → `result.build_uuid`.
5. Suivre : `GET /accounts/$ACCOUNT_ID/builds/builds/<build_uuid>` jusqu'à un état terminé (`status`), puis les journaux :
   `GET /accounts/$ACCOUNT_ID/builds/builds/<build_uuid>/logs` (pagination par `cursor`).

Chaque `push` sur `main` redéploie ensuite tout seul.

Attendu : build réussi ; `GET <URL>/` répond 403 « Tableau de bord privé » (normal : privé par défaut) ; les journaux montrent la base D1
créée et le Worker déployé avec ses deux crons. La base D1 est créée par wrangler au déploiement (aucun identifiant à écrire) et le Worker
applique lui-même ses migrations au premier cron ou à la première requête.

Si échec :
- erreur de configuration d'instance dans les journaux : corriger `instance.config.json`, committer (le build repart) ;
- permission D1 manquante dans le jeton de build : l'ajouter, relancer le build ;
- l'API de branchement refuse (application GitHub absente, identifiants GitHub faux) : **repli par le tableau de bord**, l'utilisateur
  importe le dépôt lui-même (Workers & Pages > Create > Import a repository, nom du Worker identique à `name`, commande de déploiement
  `npx wrangler deploy`) ;
- **repli avec un terminal** (si l'assistant en a un) : `npm ci` puis `npx wrangler deploy` avec `CLOUDFLARE_API_TOKEN` et
  `CLOUDFLARE_ACCOUNT_ID` dans l'environnement ; l'utilisateur pourra brancher le dépôt plus tard.

### 5.5 (Facultatif) Recherche sémantique : index Vectorize

Seulement si l'utilisateur la veut (`docs/recherche-semantique.md`). **Ordre obligatoire** : index, puis index de métadonnées, puis
déclaration dans `wrangler.jsonc` (un binding vers un index inexistant fait échouer le déploiement).

1. `POST /accounts/$ACCOUNT_ID/vectorize/v2/indexes` avec `{"name":"<NOM>-annonces","description":"annonces RE-SEARCH","config":{"dimensions":1024,"metric":"cosine"}}`.
2. `POST /accounts/$ACCOUNT_ID/vectorize/v2/indexes/<NOM>-annonces/metadata_index/create` avec `{"propertyName":"zone","indexType":"string"}`,
   puis le même appel avec `{"propertyName":"gone","indexType":"number"}`.
3. Dans `wrangler.jsonc` : ajouter `"vectorize": [{ "binding": "VECTORIZE", "index_name": "<NOM>-annonces" }],` et passer
   `"SEMANTIC_SEARCH"` à `"true"` dans `vars` ; committer (le build redéploie).

Attendu : `GET <URL>/health?k=<CLE>` indique `bindings.VECTORIZE: true`. Si échec : permission Vectorize manquante au jeton ; « index
already exists » : le réutiliser après avoir vérifié ses dimensions.

## Étape 6. Bot Telegram

1. L'utilisateur ouvre **@BotFather** dans Telegram, envoie `/newbot`, choisit un nom et un identifiant se terminant par `bot`, et reçoit un
   **jeton** (`123456:ABC...`). L'assistant le pose en secret `TELEGRAM_BOT_TOKEN` (étape 5.3) : avant le premier déploiement si possible,
   sinon maintenant puis relancer un build.
2. Après le déploiement, ouvrir `<URL>/telegram/setup?k=<CLE>` : installe le webhook et les commandes chez Telegram et renvoie, tant que
   rien n'est lié, un bloc `link` avec un **code**.
3. L'utilisateur envoie à son bot `/start <code>` : le Worker répond « Conversation liée » ; cette conversation reçoit désormais les
   alertes (liaison stockée en D1, code à usage unique).

Attendu : `setWebhook.ok` et `setMyCommands.ok` à `true`, puis le message de confirmation dans Telegram. Si échec : 404 sur `/telegram/setup` →
`TELEGRAM_INTERACTIVE` n'est pas `"true"` dans `wrangler.jsonc` ; 502 avec `setWebhook.ok: false` → jeton du bot faux (le reposer) ; 403 →
`<CLE>` différente du secret ; pas de réponse au `/start` → code périmé ou déjà utilisé : rappeler `/telegram/setup?k=`.

## Étape 7. Vérification

1. `GET <URL>/health?k=<CLE>` : JSON en lecture seule (secrets : présence seulement, migrations appliquées, neurons du jour, sources, liste
   `problems`). Attendu : `ok: true` / `problems` vide. Le Worker applique ses migrations au premier cron ou à la première requête :
   réessayer après une minute si `migrations` est vide. Avec Node : `node scripts/verify.mjs <URL> <CLE> --setup`.
2. **Pour CHAQUE source** : `GET <URL>/test?source=<id>&k=<CLE>` (lecture sans écriture : annonces lues, évaluation de chacune, octets lus).
   Attendu : au moins une annonce lue, prix et surface plausibles. Une source qui répond une erreur, zéro annonce alors que la page en
   montre, ou des champs faux : la **retirer** de `sources`, ou la passer en `"parser": "universal"` (si le site est lisible), puis
   recommitter et retester après le build. Une source bloquée (403, 429, timeout) est retirée, pas contournée.
3. **Premier passage silencieux** : à sa première lecture, chaque source (et chaque zone ajoutée à une source) enregistre son stock
   **sans alerter** (« déjà en ligne au lancement » sur le tableau de bord) ; les alertes ne viennent qu'ensuite, pour les annonces
   nouvelles. L'expliquer à l'utilisateur pour qu'il n'attende pas un déluge de messages. Le cron tourne entre 9h et 20h (heure de Paris) ;
   `GET <URL>/scan?group=0&k=<CLE>` lit un groupe à la main (groupes 0 à 9).
4. Tableau de bord : `<URL>/?k=<CLE>` une première fois (un cookie prend ensuite le relais), puis `<URL>/`.

## Étape 8. Usage courant et dépannage

- **Alertes** : Telegram (boutons sous chaque alerte ; `/aide`, `/profil <texte libre>`, questions libres à l'assistant). **État** :
  tableau de bord, `/health?k=`, `/status?k=`.
- **Changer un critère, une zone, une source** : modifier `instance.config.json`, committer sur `main` ; le build redéploie. Une zone ajoutée
  à une source déjà lue a son propre premier passage silencieux.
- **Source en panne** (message Telegram après 3 échecs de suite) : `/test?source=<id>&k=` ; si le site bloque ou a changé de gabarit, la
  retirer ou `"active": false` avec une `note`. Un message annonce son rétablissement.
- **Aucune alerte** : normal les premières minutes ; vérifier la fenêtre horaire, `/status`, et les critères (`/test?source=` donne la
  raison de chaque rejet : un loyer maximum trop bas écarte tout).
- **Budget IA** : 10 000 neurons gratuits par jour, le Worker s'arrête à 8 000 (`ai.dailyNeurons`) ; consommation du jour dans `/health`
  (`ai`). Budget épuisé : l'indice IA est sauté, jamais l'alerte. Fonctions optionnelles (interrupteurs de `vars` dans `wrangler.jsonc`) :
  `docs/` (photos `PHOTO_SCORING`, assistant `ASSISTANT_ENABLED`, indices `GEO_HINTS`, marché `MARKET_HINTS`, prospection, mail).
- **Tableau de bord privé** : `DASHBOARD_PUBLIC` vaut `"false"` ; `?k=<CLE>` pose un cookie de 30 jours. `"true"` le rend public (tout ce
  qu'il montre l'est).
- **Tout arrêter** : mettre `"triggers": { "crons": [] }` dans `wrangler.jsonc` et committer. Supprimer le Worker ou la base : seulement sur
  demande expresse de l'utilisateur.
- **Limites du plan gratuit** atteintes : le signaler avec des chiffres ; ne jamais passer au plan payant.

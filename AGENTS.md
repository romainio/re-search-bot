# AGENTS.md : carte du dépôt pour un agent de code

RE-SEARCH : Worker Cloudflare (TypeScript, D1, Workers AI, **plan gratuit uniquement**) qui alerte sur Telegram des locations nouvelles,
paramétré par un assistant IA via son serveur MCP. Dépôt **public et générique** : aucune donnée d'une instance (identifiant Cloudflare,
sous-domaine, critère personnel). Installer : `README.md` (bouton Deploy), voie complète `docs/playbook.md`. Architecture :
`docs/architecture.md`. Contribuer : `.github/CONTRIBUTING.md`. Code, commentaires et commits en **français** ; un commentaire dit le pourquoi.

## Où est quoi

| Chemin | Rôle |
| --- | --- |
| `instance.config.json` | Configuration embarquée, livrée **non paramétrée** (aucune zone ni source) ; schéma `instance.schema.json`, validée par `src/instance.ts`. Une configuration enregistrée en D1 (MCP, `POST /config`) prime. **Les tests chargent `examples/paris-17-levallois.json`** (alias de `vitest.config.ts`) : modifier l'exemple impose de mettre à jour les tests de valeurs |
| `src/config/` | Constantes nommées par domaine (`scan.ts`, `fetch.ts`, `schedule.ts`, `switches.ts`...) : aucun nombre magique ailleurs, rien qui dépende de l'instance |
| `src/instance.ts`, `src/derive.ts`, `src/live-config.ts` | Validation de l'instance ; `derive(instance)` calcule une fois les réglages gelés que rend `settings()` (toute valeur tirée de l'instance s'y ajoute, jamais en variable de module) ; configuration et interrupteurs en D1 (`loadLiveConfig` au début de chaque invocation) |
| `src/index.ts`, `src/routes/`, `src/cron.ts` | Table des routes et gestionnaires (tableau de bord, administration, `/config`, `/part` et `/embed` internes) ; `cron.ts` = `scheduled` |
| `src/scan.ts`, `src/process.ts`, `src/filter.ts`, `src/enrich.ts` | Orchestrateur et sous-lots `/part` (une invocation par source) ; nouveautés, baisses, doublons, disparitions ; `evaluate` = le filtre ; fiches et indices |
| `src/sources.ts`, `src/parsers/`, `src/detail/`, `src/universal/` | Registre des sources (`settings().sources`) ; un lecteur par gabarit (`PARSERS`, `ParserId`) ; lecteurs de fiche ; lecteur universel par le modèle |
| `src/mcp/` | Serveur MCP (`server.ts`, JSON-RPC sans état), outils (`tools.ts`, `MCP_TOOLS`, test dans `test/mcp.test.ts`), sondage d'une source (`probe.ts`), propositions (`propose.ts`), communes (`communes.ts`), jeton de l'adresse (`token.ts`) |
| `src/dashboard/`, `src/listings-query.ts` | Tableau de bord (rendu, cartes, filtres, sections) ; filtres SQL partagés avec la recherche et l'assistant |
| `src/notify/`, `src/telegram/`, `src/assistant/` | Alertes Telegram et WhatsApp ; webhook, boutons, profil, liaison (`chat.ts`) ; assistant conversationnel |
| `src/geo/`, `src/data/`, `src/market.ts` | Indices géo (stations, loyer, DPE) et **données Île-de-France** (`src/data/README.md`), catalogue des réseaux nationaux ; indicateurs de marché |
| `src/ai/`, `src/search/`, `src/prospect/`, `src/mail/` | Budget et appels Workers AI (**tout appel IA passe ici**) ; recherche sémantique ; prospection d'agences ; alertes par mail |
| `src/access.ts`, `src/internal.ts`, `src/settings.ts`, `src/admin-health.ts` | Accès (`Authorization: Bearer`, cookie du tableau de bord, HMAC) ; appel interne `SELF` ou `ctx.exports` ; table `settings` ; rapport de `GET /health` |
| `src/migrate.ts`, `src/migrations.ts`, `migrations/` | Migrations embarquées, appliquées par le Worker (`d1_migrations` compatible wrangler) ; **toute nouvelle migration s'ajoute à `src/migrations.ts`** (un test le vérifie) |
| `test/`, `test/fixtures/` | Tests vitest sans réseau (`*.cpu.test.ts` : mesures de CPU à part) ; pages enregistrées des sources |
| `docs/` | Une page par fonction facultative, `fonctions.md` (défauts des interrupteurs), `mcp.md`, `architecture.md`, `playbook.md` |
| `wrangler.jsonc`, `biome.jsonc`, `scripts/verify.mjs`, `.github/` | Configuration générique du Worker ; format et lint ; vérification post-installation ; CI (Biome, `tsc`, vitest, sans secret ni déploiement) et modèles |

## Règles communes (non négociables)

1. **Plan gratuit.** 10 ms de CPU et 50 sous-requêtes par invocation, 10 000 neurons/jour, 100 000 requêtes/jour, 100 000 écritures D1/jour. Aucun service payant.
2. **Indices, pas de filtres.** Seuls les critères de l'instance (via `evaluate`) retirent une annonce. Les retours (boutons) ne masquent jamais rien.
3. **Un interrupteur par fonction, sans casse.** Chaque fonction nouvelle a un interrupteur dans `vars` de `wrangler.jsonc`, dans `FEATURE_SWITCHES`
   (`src/config/switches.ts`) et dans le type `Env` (`src/types.ts`) ; éteinte ou sans son binding, le Worker se comporte comme sans elle. Elle arrive
   `"false"` jusqu'à avoir fait ses preuves ; reste `"false"` toute fonction qui exige un binding ou un secret que le bouton Deploy ne crée pas, ou qui
   appelle des services tiers autres que les sites lus ; une fonction éprouvée qui n'exige que D1 et Workers AI peut être livrée `"true"`. Défauts :
   `docs/fonctions.md` (un test le confronte à `wrangler.jsonc`).
4. **Jamais bloquant.** Une IA, un géocodage, une source qui échoue : on continue sans l'indice, aucune exception ne remonte, toujours un `AbortSignal.timeout`.
5. **Budget IA partagé** : `src/ai/budget.ts` (`canSpend` avant, `record` après), plafond global et par fonction dans la configuration de l'instance (`ai`).
6. **Données à configurer dans l'instance ou `src/data/`**, jamais en dur dans la logique.
7. **Commits** en français (`feat(portée): ...`), petits ; `npm run lint`, `npm run typecheck`, `npm test` et `npm run test:cpu` verts avant chaque commit.

## Tester

```sh
npm run lint                      # biome check . (npm run format pour formater)
npm run typecheck                 # tsc --noEmit
npm test                          # toute la suite, sans les mesures de CPU (quelques minutes)
npm run test:cpu                  # mesures de CPU (*.cpu.test.ts), seules et un fichier à la fois
npx vitest run test/scan.test.ts  # un fichier
```

## Ajouter une source

`.github/CONTRIBUTING.md` résume la procédure. En bref (l'entrée de registre va dans `examples/paris-17-levallois.json`, que chargent les tests ; l'utilisateur d'une instance l'ajoute par MCP, `ajouter_source`) : une page enregistrée dans `test/fixtures/` (une requête, sans contournement d'anti-bot) →
lecteur de `src/parsers/` (ou réutiliser `lbi`, `apimo`, `bienici`...) → entrée dans `sources` de l'exemple (`id`, `zones`, `filteredToZones`, `group` facultatif, `stopMarker`...) →
test du lecteur, fixture déclarée dans `FIXTURE_BY_ID` de `test/source-fixtures.ts`. Au plus 10 sources par groupe, 3 pages lourdes par groupe. Pour désactiver une source : `"active": false` (et un `note` qui dit pourquoi). Un site sans lecteur : source `parser: "universal"` (`docs/lecteur-universel.md`).

## Ajouter une zone

1. `zones` de l'instance (code postal, libellé, `town` si commune, `bbox` pour la prospection) ; `outOfZoneTowns` pour les voisines à exclure
   (par MCP : `definir_recherche` puis `completer_localisation`, qui les tire de geo.api.gouv.fr). Arrondissements reconnus sans code postal : Paris, Lyon,
   Marseille (`findPostalCode`, `src/util.ts`) ; `neighborhoodLabel` nomme le quartier des `neighborhoodKeywords`.
2. Sources qui la couvrent : leur `zones` (nouvelle zone d'une source existante = premier passage silencieux de cette zone), URL propres à la zone
   (Bien'ici : `zoneIds` de l'URL, trouvés par `https://res.bienici.com/suggest.json?q=<ville>`).
3. Hors Île-de-France : ne pas allumer `GEO_HINTS` pour les stations, ou fournir ses données (`src/data/README.md`) ; ajouter ses codes à `geo.stationPostalCodes` / `geo.rentCapPostalCodes`.
4. Le sous-titre, les plafonds de prix et les surfaces du tableau de bord se tirent de la configuration ; tests de valeurs de l'exemple (`test/user-config.test.ts`, `examples/`) à mettre à jour.

## Pièges connus

- **CPU 10 ms.** Chaque source est sa propre invocation `/part` (`SELF` s'il est déclaré, sinon `ctx.exports.default`) ; tout code ajouté au chemin d'un `/part` doit rester sous la mesure CPU de
  `test/scan.cpu.test.ts` (8 ms par sous-lot). Les **mesures de CPU** (`performance.now` contre un budget) vont dans un fichier `*.cpu.test.ts` : `npm test` les exclut,
  `npm run test:cpu` les lance seules, sans parallélisme de fichiers (la CI fait les deux). **Ne jamais assouplir un seuil ni réduire un échantillon.**
- **Fixtures lues à l'octet près** : les tailles des pages enregistrées sont mesurées par les tests (lecture bornée, `stopMarker`). `.gitattributes` (`test/fixtures/** -text`) interdit la
  conversion CRLF : ne jamais ré-enregistrer, reformater ni « normaliser » une fixture ; sous Windows, `core.autocrlf` ne doit pas les toucher.
- **Worktrees** : `.claude/worktrees` est exclu de vitest (`vitest.config.ts`) et du dépôt (`.gitignore`) ; ne pas retirer cette exclusion, les copies des tests y tourneraient aussi.
- **Jamais de binding vers une ressource inexistante** (Vectorize, Browser, route mail) dans `wrangler.jsonc` : le déploiement échoue. Le code teste `env.X` ; la création de la ressource est
  documentée dans `docs/`.
- **Dépôt public** : ne jamais committer de secret, d'identifiant de compte Cloudflare, de sous-domaine `workers.dev`, de jeton, de nom ou de critère personnel (`.dev.vars` est ignoré par git). Les
  secrets requis sont `TELEGRAM_BOT_TOKEN` et `ADMIN_KEY` ; la conversation Telegram se lie par `/start <code>` (D1), `TELEGRAM_CHAT_ID` reste facultatif.
- **Aucun nouveau `wrangler d1 migrations apply`** : les migrations sont embarquées (`src/migrations.ts`) et jouées par le Worker au premier cron ou à la première requête.
- **Migrations** : jamais modifier une migration appliquée ; SQLite ne modifie pas un `CHECK` : ajouter une colonne ou une table.
- **Une zone ajoutée à une source déjà lue** a son propre premier passage silencieux ; une source jamais lue aussi.
- **`wrangler.jsonc` est générique** : aucun identifiant de compte, pas de `database_id` (provisionnement automatique), pas de binding Vectorize (commentaire dans le fichier pour l'ajouter).
- **Le tableau de bord est privé par défaut** (`DASHBOARD_PUBLIC` = `"false"` : `?k=ADMIN_KEY` puis cookie ; `"true"` : public, cache 60 s, tout ce qu'il affiche l'est) ; les routes d'administration exigent `Authorization: Bearer <ADMIN_KEY>` (`?k=` toléré sur un GET, pour le navigateur), les routes internes `/part` et `/embed` une signature HMAC.
- Fuseau fixé à `Europe/Paris` (`src/schedule.ts`) ; les crons de `wrangler.jsonc` sont en UTC.

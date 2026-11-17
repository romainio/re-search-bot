# Contribuer

Le plus utile : **un lecteur de plus** pour un gabarit de site d'agence. Règles complètes pour un agent de code : [AGENTS.md](../AGENTS.md).
Vue d'ensemble : [docs/architecture.md](../docs/architecture.md).

**EN** · Issues and pull requests in English are welcome. Code, comments and commit messages are in French (rules in
[AGENTS.md](../AGENTS.md)); the architecture overview is in English: [docs/architecture.md](../docs/architecture.md).

## Ajouter un lecteur de site

1. **Fixture** : une page de liste des locations enregistrée en UNE requête (avec le User-Agent du Worker, `USER_AGENT` de `src/config/fetch.ts`, aucun contournement d'anti-bot)
   dans `test/fixtures/<site>.html`. Ne jamais la reformater (les tests mesurent ses octets ; `.gitattributes` interdit la conversion de fin de ligne).
2. **Lecteur** : `src/parsers/<nom>.ts` (`(body, src) => Listing[]`), ajouté à `PARSERS` (`src/parsers/index.ts`) et à `ParserId` (`src/types.ts`).
   Zéro carte lève une erreur (sauf marqueur de page vide prouvé), jamais d'identifiant instable. Si le gabarit se reconnaît à une signature
   simple, l'ajouter à `src/prospect/template.ts`.
3. **Test** : `test/parsers-<nom>.test.ts` (nombre de cartes, champs d'une carte, zéro carte qui lève).
4. **Exemple** : une entrée dans `sources` de `examples/paris-17-levallois.json` (ou d'un autre exemple), et la fixture déclarée dans
   `FIXTURE_BY_ID` de `test/source-fixtures.ts`. Les tests chargent l'exemple, jamais `instance.config.json`.
5. `npm run lint` (Biome ; `npm run format` corrige le format), `npm run typecheck`, `npm test` et `npm run test:cpu` verts (les mesures de CPU, `*.cpu.test.ts`, tournent seules : `npm test` les
   exclut).

Commits en français, petits (`feat(parsers): ...`). Pas de donnée personnelle, de secret ni d'identifiant de compte dans le dépôt.

## Commentaires

Un commentaire dit ce que le code ne peut pas dire. En français, trois lignes au plus, une ligne de JSDoc pour la plupart des constantes et fonctions exportées.

- **À garder** : le pourquoi non évident ; les invariants (« toute l'analyse avant la première écriture D1 ») ; une contrainte du plan gratuit (10 ms de CPU,
  50 sous-requêtes) qui dicte un choix, dite une fois, là où elle s'applique ; l'unité et les bornes d'une constante. Dans `src/parsers/` et `src/detail/`,
  le format de la page tierce dont dépend le lecteur et la raison d'un marqueur d'arrêt ou d'une limite.
- **À ne pas écrire** : l'historique (dates, incidents, « avant », « désormais », « comme avant ») : il appartient aux messages de commit ; les mesures de
  production (le chiffre qui justifie une valeur tient en quelques mots sur la constante) ; la paraphrase du code ; une explication déjà donnée à la
  définition ; les renvois en chaîne (« voir X ») sans nécessité ; le code commenté.
- Pas de bandeaux décoratifs, sauf pour structurer un long fichier.

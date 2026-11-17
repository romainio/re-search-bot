# Serveur MCP : paramétrer l'instance avec un assistant IA

Le Worker expose un serveur MCP (Model Context Protocol) sur la route `/mcp`. Un assistant IA qui sait ajouter un connecteur MCP
distant (Claude, ChatGPT...) s'y connecte et paramètre l'instance en parlant avec l'utilisateur : zones, loyer, surface, sources,
Telegram. Rien n'est redéployé : la configuration est enregistrée en D1 (`src/live-config.ts`) et mise en vigueur aussitôt.

Il n'y a aucun serveur central : chaque instance porte le sien, dans son propre Worker, sur le plan gratuit.

Une instance tout juste déployée n'est **pas paramétrée** (`instance.config.json` livré sans zone ni source) : elle ne lit rien,
`etat` rend `parametree: false` et propose `definir_recherche` (zones et `loyer_max` au moins) comme première étape.

## Activer

Interrupteur `MCP_ENABLED` (`vars` de `wrangler.jsonc`). Éteint, `/mcp` répond 404.

## Obtenir l'adresse

```
https://<votre-worker>/mcp?k=<ADMIN_KEY>
```

Ouverte dans un navigateur, cette adresse redirige vers `https://<votre-worker>/mcp/<jeton>`, qui affiche l'adresse du connecteur
(la même que celle de la barre d'adresse) avec un bouton pour la copier. La page de démarrage (`/`, tant qu'aucune source n'est active)
et le tableau de bord privé la donnent aussi.

Le jeton est aléatoire (32 octets), créé au premier besoin et gardé en D1 (table `settings`) : ce n'est pas la clé d'administration, et
la clé n'entre jamais dans l'adresse d'un connecteur. Il permet de modifier la configuration : **ne le partagez pas**. Divulgué, demandez à
l'assistant d'appeler `regenerer_adresse` : il rend une nouvelle adresse, l'ancienne cesse de fonctionner aussitôt.

Dans l'assistant : ajouter un connecteur personnalisé (MCP distant), coller l'adresse, sans authentification. Un client qui sait
envoyer un en-tête peut aussi appeler `/mcp` avec `Authorization: Bearer <jeton>` (jamais avec `ADMIN_KEY`).

## Outils

| Outil                    | Rôle                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `etat`                   | Recherche en vigueur, fonctions, Telegram, sources en panne, prochaines étapes. À appeler en premier                                                    |
| `definir_recherche`      | Zones (codes postaux), communes exclues, loyer, surface, pièces, heures d'alerte. Seuls les champs donnés changent                                      |
| `completer_localisation` | Communes voisines à écarter (rayon autour des zones) et commune des zones, par l'API publique des communes (geo.api.gouv.fr)                            |
| `proposer_sources`       | Propose Bien'ici et les réseaux nationaux (Foncia, Laforêt, Orpi, ERA, Crédit Agricole Immobilier, Century 21) pour chaque zone ; rien n'est enregistré |
| `lister_sources`         | Sources enregistrées                                                                                                                                    |
| `detecter_gabarit`       | Lit la page d'une agence et propose le lecteur de son gabarit                                                                                           |
| `tester_source`          | Essaie une source sans rien enregistrer (annonces lues, gardées, exemples)                                                                              |
| `ajouter_source`         | Ajoute une source **après une lecture réussie** refaite par le Worker                                                                                   |
| `retirer_source`         | Retire une source                                                                                                                                       |
| `regler_fonctions`       | Allume ou éteint les fonctions facultatives                                                                                                             |
| `lier_telegram`          | Installe le webhook et rend le code `/start <code>` à envoyer au bot                                                                                    |
| `chercher_annonces`      | Annonces déjà vues, par filtres (lecture seule)                                                                                                         |
| `regenerer_adresse`      | Nouvelle adresse du connecteur ; l'ancienne cesse de fonctionner                                                                                        |

## Garde-fous

- Les arguments d'un outil sont confrontés à son schéma : propriété inconnue ou requise absente, l'appel est refusé en les nommant.
- Deux modifications simultanées ne s'écrasent pas : chaque écriture vérifie que la configuration n'a pas changé depuis sa lecture,
  sinon l'outil répond en erreur et l'assistant relit puis recommence.
- Une requête dont l'en-tête `Origin` n'est pas celui du Worker est refusée (403), contre le rebond DNS.
- Toute modification est validée en entier avant d'être écrite (mêmes règles que `instance.config.json`) ; une erreur est rendue à
  l'assistant, rien n'est enregistré à moitié.
- Une source n'est jamais ajoutée sans avoir été lue avec succès. Un site qui refuse la lecture automatique (403, 429, anti-bot)
  n'est pas ajouté : **aucun contournement**.
- `completer_localisation` interroge geo.api.gouv.fr (gratuit, sans clé) avec les seuls codes postaux des zones, au paramétrage seulement.
- Les outils ne lisent que des noms de domaine publics en http(s) (ni adresse IP ni nom local) ; la même règle vaut pour toute adresse
  de source enregistrée, par MCP comme par `POST /config` (`src/public-url.ts`).
- Aucun secret ne sort du Worker (ni `ADMIN_KEY`, ni le jeton du bot Telegram). Les secrets se posent dans le tableau de bord
  Cloudflare, pas par MCP.
- Seuls les interrupteurs de fonctions peuvent être réglés ; `DASHBOARD_PUBLIC` ne le peut pas.

## Technique

Transport « Streamable HTTP » sans état, écrit à la main dans `src/mcp/server.ts` (JSON-RPC 2.0, réponses JSON, ni session ni flux
SSE, un message par requête : les lots JSON-RPC, retirés du protocole en 2025-06-18, sont refusés) : aucune dépendance, aucun Durable Object. Les outils sont dans `src/mcp/tools.ts`. Versions du protocole
comprises : 2025-06-18, 2025-03-26, 2024-11-05.

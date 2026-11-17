# Fonctions facultatives : interrupteurs et valeurs par défaut

Chaque fonction facultative a un interrupteur dans `vars` de `wrangler.jsonc` (`FEATURE_SWITCHES`, `src/config/switches.ts`).
L'assistant les règle par MCP (`regler_fonctions`, enregistré en D1, prime sur `vars`) ; `GET /health` signale un interrupteur allumé
auquel il manque un binding, un secret ou un autre interrupteur.

Règle des valeurs livrées :

- une fonction nouvelle arrive **éteinte**, jusqu'à ce qu'elle ait fait ses preuves ;
- reste éteinte toute fonction qui exige un binding ou un secret que le bouton Deploy ne crée pas, ou qui appelle des services tiers
  autres que les sites lus ;
- une fonction éprouvée qui n'a besoin que de ce que le bouton Deploy crée (D1, Workers AI) peut être livrée **allumée**.

| Interrupteur           | Défaut  | Exige                                         | Pourquoi ce défaut                                                   | Guide                                              |
| ---------------------- | ------- | --------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------- |
| `MCP_ENABLED`          | `true`  | —                                             | l'installation passe par l'assistant et ce serveur                   | [mcp.md](mcp.md)                                   |
| `PHOTO_SCORING`        | `true`  | binding `AI`                                  | éprouvée, Workers AI fourni par le bouton                            | [photo-scoring.md](photo-scoring.md)               |
| `GEO_HINTS`            | `true`  | —                                             | éprouvée ; hors Île-de-France, seul le DPE s'affiche                 | [indices-geo.md](indices-geo.md)                   |
| `MARKET_HINTS`         | `true`  | —                                             | éprouvée, calculée en D1                                             | [marche.md](marche.md)                             |
| `TELEGRAM_INTERACTIVE` | `true`  | —                                             | éprouvée ; webhook installé par `lier_telegram`                      | [telegram-interactif.md](telegram-interactif.md)   |
| `ASSISTANT_ENABLED`    | `true`  | binding `AI`, `TELEGRAM_INTERACTIVE`          | éprouvée, Workers AI fourni par le bouton                            | [assistant.md](assistant.md)                       |
| `UNIVERSAL_READER`     | `true`  | binding `AI`                                  | éprouvée ; ne sert qu'aux sources `parser: "universal"`              | [lecteur-universel.md](lecteur-universel.md)       |
| `SEMANTIC_SEARCH`      | `false` | bindings `AI` et `VECTORIZE`                  | index Vectorize à créer à la main                                    | [recherche-semantique.md](recherche-semantique.md) |
| `BROWSER_RENDER`       | `false` | binding `BROWSER`, `UNIVERSAL_READER`         | binding Browser Rendering à ajouter à la main                        | [lecteur-universel.md](lecteur-universel.md)       |
| `MAIL_INGEST`          | `false` | route Email Routing vers le Worker            | exige un domaine sur Cloudflare                                      | [mail.md](mail.md)                                 |
| `WHATSAPP_ENABLED`     | `false` | secrets `CALLMEBOT_PHONE`, `CALLMEBOT_APIKEY` | secrets propres à l'utilisateur                                      | [ci-dessous](#whatsapp)                            |
| `PROSPECT_ENABLED`     | `false` | —                                             | appelle des services tiers (annuaire des entreprises, OpenStreetMap) | [prospection.md](prospection.md)                   |
| `PROSPECT_AI`          | `false` | binding `AI`, `PROSPECT_ENABLED`              | suit `PROSPECT_ENABLED`                                              | [prospection.md](prospection.md)                   |

`DASHBOARD_PUBLIC` (`false`) n'est pas une fonction : `false` rend le tableau de bord privé (`?k=ADMIN_KEY`, puis un cookie).

## WhatsApp

Copie de chaque alerte sur WhatsApp par CallMeBot (service gratuit tiers) : obtenir une clé auprès de CallMeBot, poser les secrets
`CALLMEBOT_PHONE` et `CALLMEBOT_APIKEY` dans le tableau de bord Cloudflare, puis allumer `WHATSAPP_ENABLED`.

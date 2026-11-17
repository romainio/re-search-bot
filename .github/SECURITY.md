# Sécurité · Security

## Signaler une faille · Reporting a vulnerability

**FR** · Ouvrir un signalement privé : onglet **Security** du dépôt, « Report a vulnerability »
([lien direct](https://github.com/romainio/re-search-bot/security/advisories/new)). Jamais en issue publique. Réponse visée sous
7 jours ; la correction et la publication de l'avis se font ensemble.

**EN** · Open a private report: repository **Security** tab, "Report a vulnerability"
([direct link](https://github.com/romainio/re-search-bot/security/advisories/new)). Never in a public issue. We aim to answer
within 7 days and to publish the advisory together with the fix.

## Périmètre · Scope

- Le Worker de ce dépôt : contrôle d'accès (`ADMIN_KEY`, cookie du tableau de bord, signature HMAC des routes internes `/part` et
  `/embed`, secret du webhook Telegram), validation de la configuration, lecture d'adresses (`src/public-url.ts`) ·
  The Worker in this repository: access control, configuration validation, outbound URL checks.
- Le serveur MCP (`/mcp`, `src/mcp/`) : jeton de l'adresse, contrôle de l'en-tête `Origin`, outils qui écrivent la configuration ·
  The MCP server: address token, `Origin` check, configuration-writing tools.

## Hors périmètre · Out of scope

- Une instance mal configurée par son propriétaire (clé faible, tableau de bord rendu public, adresse MCP partagée) · An instance
  misconfigured by its owner (weak key, dashboard made public, MCP address shared).
- Cloudflare, Telegram, CallMeBot, les sites lus et les assistants IA eux-mêmes · Cloudflare, Telegram, CallMeBot, the sites read
  and the AI assistants themselves.
- Les limites du plan gratuit (déni de service par épuisement des quotas) · Free-plan quota exhaustion (denial of service).

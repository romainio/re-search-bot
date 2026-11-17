<div align="center">

# RE-SEARCH

**Les nouvelles locations de ta ville, sur Telegram, toutes les 5 minutes.**

Gratuit, open source, pour toute la France. Installé en un clic, paramétré en discutant avec ton assistant IA.

[![CI](https://github.com/romainio/re-search-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/romainio/re-search-bot/actions/workflows/ci.yml)
[![Licence MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![MCP](https://img.shields.io/badge/MCP-compatible-6E56CF)](docs/mcp.md)

**Français** · [English](README.en.md)

</div>

---

Les bons appartements partent en quelques heures, souvent avant d'arriver sur les grands portails. RE-SEARCH lit
directement les sites des agences et des réseaux de ta ville, et t'envoie une alerte dès qu'une annonce correspond à ta
recherche : nouvelle, ou en baisse de prix.

## Ce que tu reçois

- **Une alerte Telegram par annonce** : loyer charges comprises, surface, pièces, photos, lien, téléphone de l'agence.
  Une annonce publiée par plusieurs agences n'arrive qu'une fois.
- **Des indices, jamais des filtres** : écart au loyer médian du quartier, analyse des photos (parquet, cuisine
  équipée…), classe énergie, station la plus proche et encadrement des loyers (Île-de-France).
- **Un tableau de bord privé** : annonces en ligne, disparues, délai avant disparition, état des sites lus.
- **Un assistant dans Telegram** : « les 2 pièces sous 1 200 € de la semaine ? ».

## Installer en 5 minutes

Il te faut un compte [Cloudflare](https://dash.cloudflare.com/sign-up) gratuit, un compte GitHub et Telegram. Aucune
carte bancaire.

1. **Déployer**

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/romainio/re-search-bot)

   Deux secrets sont demandés : `ADMIN_KEY`, une longue clé de ton choix à garder, et `TELEGRAM_BOT_TOKEN`, le jeton
   du bot que tu crées en une minute avec [@BotFather](https://t.me/BotFather).

2. **Ouvrir ton instance** : `https://<ton-worker>.workers.dev/?k=<ADMIN_KEY>`. La page affiche l'adresse de ton
   connecteur MCP.

3. **Connecter ton assistant** : ajoute cette adresse comme connecteur personnalisé (Claude, ChatGPT…, sans
   authentification), puis demande-lui :

   > Paramètre RE-SEARCH pour un 2 pièces à Lyon 3e, moins de 1 000 €.

   Il définit la recherche, écarte les communes voisines, propose et essaie les sites de ta ville, puis lie ton
   Telegram.

## Ensuite, tout se règle en parlant

> Ajoute Villeurbanne à ma recherche.
>
> Monte le budget à 1 100 € et exclus les rez-de-chaussée.
>
> Essaie le site de cette agence : https://…
>
> Pourquoi je n'ai rien reçu aujourd'hui ?

Aucun fichier à modifier, rien à redéployer : la configuration est enregistrée dans ton instance.

## Sites lus

| | |
| --- | --- |
| Portail | Bien'ici |
| Réseaux nationaux | Orpi, Foncia, Laforêt, Century 21, ERA, Crédit Agricole Immobilier, FNAIM, Nestenn, Oralia |
| Sites d'agences | La Boîte Immo, Apimo, Netty, Immo-facile, OSL et d'autres éditeurs utilisés partout en France |
| Le reste | un lecteur universel, par IA, pour un site sans lecteur dédié |

Il manque un site ? [Ouvre une demande](https://github.com/romainio/re-search-bot/issues/new/choose).

## Comment ça marche

Un Worker Cloudflare se déclenche chaque minute de 9 h à 20 h. Chaque site est lu dans sa propre invocation, comparé à
ce qui est déjà connu (base D1), puis les nouveautés partent sur Telegram. Le tout tient dans le plan gratuit de
Cloudflare. Détails : [architecture](docs/architecture.md) · [serveur MCP](docs/mcp.md) ·
[fonctions et réglages](docs/fonctions.md).

## Usage responsable

- Usage personnel. Chaque site est lu au plus une fois toutes les 5 minutes.
- Le bot se présente comme tel (User-Agent `re-search/1.0`), jamais comme un navigateur.
- Un site qui refuse la lecture automatique (PAP, SeLoger, Leboncoin…) est écarté, jamais contourné.

## Contribuer

Les contributions sont bienvenues, en particulier les lecteurs de nouveaux sites :
[guide de contribution](.github/CONTRIBUTING.md). Une faille de sécurité se signale en privé :
[politique de sécurité](.github/SECURITY.md).

## Licence

[MIT](LICENSE)

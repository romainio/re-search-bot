<div align="center">

# RE-SEARCH

**New rental listings in your French city, on Telegram, every 5 minutes.**

Free and open source. One-click install, set up by chatting with your AI assistant.

[![CI](https://github.com/romainio/re-search-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/romainio/re-search-bot/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![MCP](https://img.shields.io/badge/MCP-compatible-6E56CF)](docs/mcp.md)

[Français](README.md) · **English**

</div>

---

Good flats in France go within hours, often before they reach the big portals. RE-SEARCH reads the websites of the
agencies and networks of your city directly, and alerts you as soon as a listing matches your search: new, or with a
price drop.

## What you get

- **One Telegram alert per listing**: rent including charges, size, rooms, photos, link, agency phone. A flat listed
  by several agencies arrives once.
- **Hints, never filters**: gap to the local median rent, photo analysis (wooden floor, fitted kitchen…), energy
  rating, nearest station and rent cap (Paris region).
- **A private dashboard**: listings online, gone, time before they go, health of each website.
- **An assistant in Telegram**: "2-room flats under €1,200 this week?".

## Install in 5 minutes

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, a GitHub account and Telegram. No credit
card.

1. **Deploy**

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/romainio/re-search-bot)

   It asks for two secrets: `ADMIN_KEY`, a long key of your choice to keep, and `TELEGRAM_BOT_TOKEN`, the token of the
   bot you create in a minute with [@BotFather](https://t.me/BotFather).

2. **Open your instance**: `https://<your-worker>.workers.dev/?k=<ADMIN_KEY>`. The page shows your MCP connector
   address.

3. **Connect your assistant**: add that address as a custom connector (Claude, ChatGPT…, no authentication), then ask:

   > Set up RE-SEARCH for a 2-room flat in Lyon 3e under €1,000.

   It defines the search, excludes neighbouring towns, suggests and tests the websites of your city, then links your
   Telegram.

## Then, just talk to it

> Add Villeurbanne to my search.
>
> Raise the budget to €1,100 and exclude ground floors.
>
> Try this agency's website: https://…
>
> Why didn't I get anything today?

No file to edit, nothing to redeploy: the configuration is stored in your instance. The bot and its messages are in
French.

## Websites read

| | |
| --- | --- |
| Portal | Bien'ici |
| National networks | Orpi, Foncia, Laforêt, Century 21, ERA, Crédit Agricole Immobilier, FNAIM, Nestenn, Oralia |
| Agency websites | La Boîte Immo, Apimo, Netty, Immo-facile, OSL and other site builders used across France |
| Anything else | a universal AI reader for websites without a dedicated reader |

Missing a website? [Open a request](https://github.com/romainio/re-search-bot/issues/new/choose).

## How it works

A Cloudflare Worker runs every minute from 9 am to 8 pm. Each website is read in its own invocation, compared with what
is already known (D1 database), and new listings go to Telegram. Everything fits in Cloudflare's free plan. Details:
[architecture](docs/architecture.md) · [MCP server](docs/mcp.md) · [features and settings](docs/fonctions.md) (French).

## Responsible use

- Personal use. Each website is read at most once every 5 minutes.
- The bot identifies itself (User-Agent `re-search/1.0`), never as a browser.
- Websites that refuse automated reading (PAP, SeLoger, Leboncoin…) are skipped, never bypassed.

## Contributing

Contributions are welcome, especially readers for new websites: [contributing guide](.github/CONTRIBUTING.md).
Report security issues privately: [security policy](.github/SECURITY.md).

## License

[MIT](LICENSE)

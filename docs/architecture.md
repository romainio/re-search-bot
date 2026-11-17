# Architecture

RE-SEARCH is a single Cloudflare Worker (TypeScript, no framework, one runtime dependency) backed by D1. It runs entirely on the
Cloudflare **free plan**; every design choice below follows from that budget. Code and comments are in French; this page is the
English entry point.

## Data flow

```
 Cron (every minute, 7h-19h UTC)                       AI assistant (Claude, ChatGPT...)
   |                                                      |  MCP, JSON-RPC over HTTP
   v                                                      v
 onCron (src/cron.ts)                                   /mcp/<token> (src/mcp/server.ts)
   |  loadLiveConfig: one D1 read                         |  tools.ts: etat, definir_recherche,
   v                                                      |  ajouter_source (only after a successful read)...
 runScan, orchestrator (src/scan.ts)                      v
   |  minute -> one group per lane (2 lanes x 5 groups)  saveInstance / saveSwitches (src/live-config.ts)
   |                                                      |  validate whole config (src/instance.ts)
   |  one signed POST /part per source                    v
   v  (own invocation: own 10 ms CPU, own 50 subrequests) D1 table `settings`
 runPart (src/scan.ts)                                    |
   |  fetchSource: bounded read, honest User-Agent        |  next invocation: loadLiveConfig
   |  PARSERS[parser]: page -> Listing[] (src/parsers/)   v
   |  evaluate: user criteria only (src/filter.ts)      derive(instance) -> frozen Settings (src/derive.ts)
   |  enrichListings: detail pages, hints (src/enrich.ts)  read by every module through settings()
   v
 processListings (src/process.ts)
   |  D1 `listings`: new, price drop, duplicates (clusters), gone
   v
 sendPendingAlerts (src/notify/send.ts) --> Telegram (optional WhatsApp copy)
```

The dashboard (`GET /`, `src/routes/dashboard.ts`, `src/dashboard/`) and the Telegram webhook (`/telegram`, `src/telegram/`) read the
same D1 tables.

## Design decisions

- **Free plan as a hard budget.** 10 ms CPU and 50 subrequests per invocation, 10,000 Workers AI neurons and 100,000 D1 writes per
  day. CPU-sensitive paths have tests that measure them (`npm run test:cpu`); thresholds are never loosened.
- **One invocation per source.** The cron orchestrator never parses pages itself: it calls `/part` (HMAC-signed, via `ctx.exports` or
  a `SELF` binding) once per source, so each site gets a fresh CPU and subrequest budget and one slow site cannot starve the others.
- **Live configuration in D1.** The bundled `instance.config.json` ships unconfigured; the MCP tools write the instance and feature
  switches to D1, validated as a whole and applied without redeploying. Each invocation does one D1 read; `derive()` recomputes the
  frozen `Settings` only when the stored text changes, and swaps it atomically.
- **Hints, never filters.** Only the user's criteria (`evaluate`) drop a listing. Market gap, AI photo analysis, stations, rent cap
  and feedback buttons only annotate or sort.
- **Never blocking.** An AI call, geocoding or source that fails is skipped with a timeout; no exception escapes to the cron.
- **No anti-bot bypass, honest User-Agent.** Requests identify as `re-search/1.0 (+repository URL)`. A site that answers 403, 429 or a
  bot challenge is dropped, never worked around; the MCP server refuses to add a source it could not read.
- **Off until proven.** Each optional feature has a switch; defaults and the rule behind them are in [`fonctions.md`](fonctions.md).
- **Self-migrating.** D1 migrations are bundled (`src/migrations.ts`) and applied by the Worker on its first request or cron, so the
  Deploy button is the whole install.

## Repository layout

| Path                                                    | Role                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| `src/index.ts`, `src/routes/`, `src/cron.ts`            | Route table and handlers, scheduled entry point                         |
| `src/scan.ts`, `src/process.ts`, `src/filter.ts`        | Orchestrator and `/part`, listing processing, the filter                |
| `src/parsers/`, `src/detail/`, `src/universal/`         | Site readers (one per site template), detail pages, AI-based reader     |
| `src/instance.ts`, `src/derive.ts`, `src/live-config.ts` | Config validation, derived settings, D1-stored config and switches     |
| `src/mcp/`                                              | MCP server and configuration tools                                      |
| `src/notify/`, `src/telegram/`, `src/assistant/`        | Alerts, Telegram webhook and buttons, natural-language assistant       |
| `src/dashboard/`, `src/listings-query.ts`               | Dashboard rendering, shared SQL filters                                 |
| `src/geo/`, `src/market.ts`, `src/ai/`, `src/search/`   | Hints (geo, market, photos), AI budget, semantic search                 |
| `src/config/`                                           | Named constants, one file per domain                                    |
| `migrations/`, `test/`, `test/fixtures/`                | D1 schema, offline tests, recorded pages (byte-exact, never reformatted) |

## HTTP routes

| Route | Access | Purpose |
| --- | --- | --- |
| `/` | `?k=ADMIN_KEY` once, then a cookie (public if `DASHBOARD_PUBLIC`) | Dashboard; welcome page while no source is active |
| `/mcp/<token>` | the token in the URL, or `Authorization: Bearer <token>` | MCP server (`/mcp?k=ADMIN_KEY` redirects there; `regenerer_adresse` rotates it) |
| `/health`, `/config`, `/status`, `/stats`, `/test?source=<id>`, `/scan?group=N`, `/prospect`, `/telegram/setup` | `Authorization: Bearer <ADMIN_KEY>` (`?k=` accepted on GET) | Administration |
| `/telegram` | Telegram webhook secret | Telegram updates |
| `/part`, `/embed` | HMAC signature | Internal sub-invocations |

Contributor rules: [`AGENTS.md`](../AGENTS.md) and [`CONTRIBUTING.md`](../.github/CONTRIBUTING.md).

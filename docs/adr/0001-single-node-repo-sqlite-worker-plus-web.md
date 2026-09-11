# ADR 0001: One TypeScript repo, one SQLite file, a worker process and a Next.js app

- Status: Accepted
- Date: 2026-09-12
- Deciders: Gadi + Claude

## Context
Personal news digest across four lanes: `ai`, `markets` (stocks + crypto majors), `gamedev` (3D/animation/engine tech), `games` (releases, hype, big gaming news). Sources are Twitter, Reddit, RSS, Hacker News, Steam and price feeds. An LLM condenses everything into short summaries with an expandable detail tier. Two consumers: a pushed Discord digest and a live scrolling web feed.

Constraints that came out of the review:
- Single user. No multi-tenancy, no auth beyond keeping strangers out.
- Runs on an existing VPS (the bet337 box) that already hosts unrelated production services. Must be isolated and light.
- Low cost. Hosting must be zero marginal; LLM spend is the only recurring bill.
- Gadi works in TypeScript/Node; Node 24 is the target runtime.
- Live feed was chosen over static pages, so a running web server is required.

## Decision
One npm package, one `node_modules`, two entrypoints:

1. **Worker** (`worker/index.ts`, run with `tsx`, managed by whatever process manager the box already uses). In-process scheduler (`node-cron`) with three jobs:
   - `ingest` every 30 min: every source runs in parallel with a per-source timeout, new items are upserted into `items` (unique on `(source, external_id)`), article bodies are fetched and extracted for link items.
   - `enrich` every 60 min, or immediately when pending items ≥ 15: one Claude call clusters pending items into stories and writes summaries and scores (ADR 0003).
   - `digest` at 08:00 and 18:00 `TZ` (default `Australia/Sydney`, confirm): posts high-score stories to Discord (ADR 0004).
2. **Web** (Next.js App Router at repo root, `next start` on a configurable port). Reads the same SQLite file directly. Basic-auth middleware (ADR 0004).

**Store:** a single SQLite file in WAL mode via `better-sqlite3`. Tables:
- `items` — `id`, `source`, `external_id`, `lane_hint`, `url`, `title`, `body` (extracted text, capped 2000 chars), `author`, `engagement` (JSON: likes/points/upvotes/comments), `published_at`, `fetched_at`, `story_id` (nullable FK). Unique `(source, external_id)`.
- `stories` — `id`, `lane`, `title`, `summary_short` (≤ 2 sentences), `summary_detail` (markdown, 150–300 words, nullable for low-score stories), `score` (1–5), `first_seen_at`, `updated_at`, `digested_at` (nullable).
- `digests` — `id`, `sent_at`, `lane`, `story_ids` (JSON), `discord_status`.
- `price_snapshots` — `symbol`, `price`, `ts` (for move detection, ADR 0002).
- `runs` — `job`, `started_at`, `finished_at`, `ok`, `counts` (JSON), `error` (text). Every job writes a row; this is the only observability needed.

**Config:** `config/sources.ts` holds lanes, feeds, subreddits, HN keyword lists, Twitter lists/queries, and tickers. Secrets live in `.env` (`ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_URL` + optional per-lane overrides, `RETTIWT_API_KEY`, `FEED_USER`, `FEED_PASS`, `TZ`, `DB_PATH`, `PORT`, `LLM_MODEL`, `ENRICH_INTERVAL_MIN`).

**Layout:**
```
package.json            one package, one install
config/sources.ts
.env.example
lib/db/{schema.sql,client.ts,queries.ts,types.ts}
lib/sources/{types.ts,rss.ts,reddit.ts,hn.ts,steam.ts,prices.ts,twitter.ts,index.ts}
lib/fetchBody.ts
lib/enrich/{prompt.ts,schema.ts,run.ts}
lib/digest/{discord.ts,run.ts}
worker/index.ts
app/{layout.tsx,page.tsx,story/[id]/page.tsx,api/feed/route.ts}
middleware.ts
docs/adr/
```

## Rejected alternatives
- **Static generated pages + digest only.** Simplest by far, but Gadi wants a live scrolling feed.
- **Postgres / hosted DB.** Nothing here needs concurrency beyond two local processes; SQLite in WAL mode handles that.
- **Queue or separate enrichment service.** A cron tick and a `story_id IS NULL` query is the queue.
- **Separate packages for worker and web.** Two installs and two lockfiles for one developer; not worth it.
- **GitHub Actions or the Mac as the runtime.** Actions can't host the feed and is the worst place for Twitter cookies; the Mac sleeps. The VPS is always on and already paid for.
- **Managed Agents scheduled deployment for the whole pipeline.** Would remove the scheduler but adds a hosted dependency and per-session cost for what is a plain cron job with one API call.

## Consequences
- Shares a box with production services. The app must run under its own directory and process-manager entry, bind to one port, and never touch the other services' files or ports. Deployment onto that box is a separate, explicitly approved step.
- Worker and web both open the SQLite file; WAL mode plus short transactions is enough, but long-running write transactions in the worker must be avoided.
- No websockets. "Live" means up to date on refresh or scroll, not push.
- Backups are one file copy. No migration tooling; `schema.sql` is applied idempotently on startup with `CREATE TABLE IF NOT EXISTS`.

## Implementation surface
- `package.json`, `tsconfig.json`, `next.config.ts`, `.env.example`, `.gitignore` — scaffolding, owned by whoever bootstraps the repo. Everyone else depends on it being present first.
- `lib/db/*` — schema and typed query helpers. **Interface:** the exported functions in `lib/db/queries.ts` and types in `lib/db/types.ts` are the contract every other module uses. Build this first; sources, enrich, digest and web all consume it and do not write raw SQL.
- `config/sources.ts` — lane and source config. Shape defined alongside `lib/sources/types.ts`.
- `worker/index.ts` — scheduler only. Imports `ingest`, `enrich`, `digest` run functions; contains no source or LLM logic.
- `app/*`, `middleware.ts` — web only; reads via `lib/db/queries.ts`.
- Disjoint from ADRs 0002–0004 except through `lib/db/queries.ts` and `lib/sources/types.ts`.

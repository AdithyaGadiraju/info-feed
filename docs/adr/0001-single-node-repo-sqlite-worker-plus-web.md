# ADR 0001: One TypeScript repo, one Supabase Postgres database, a digest command, an optional worker and a Next.js app

- Status: Accepted
- Date: 2026-09-12
- Deciders: Gadi + Claude

## Context
Personal news digest across five lanes: `ai`, `markets` (stocks + crypto majors), `gamedev` (3D/animation/engine tech), `games` (releases, hype, big gaming news), `betting` (sports betting models, MMA/fighting betting, how to build and improve betting models). Sources are Twitter, Reddit, RSS, Hacker News, Steam and price feeds. An LLM condenses everything into short summaries with an expandable detail tier. Two consumers: a pushed Discord digest and a live scrolling web feed.

Constraints that came out of the review:
- Single user. No multi-tenancy, no auth beyond keeping strangers out.
- Runs on an existing VPS (the bet337 box) that already hosts unrelated production services. Must be isolated and light.
- Low cost. Hosting must be zero marginal; LLM spend is the only recurring bill.
- Gadi works in TypeScript/Node; Node 24 is the target runtime.
- Live feed was chosen over static pages, so a running web server is required.

## Decision
One npm package, one `node_modules`, three entrypoints:

0. **Digest on command** (`npm run digest`, `scripts/digest.ts`, run with `tsx`). The primary way the system is used: no machine is assumed to be always on. Runs the full pipeline once, lane by lane, and exits: for each lane, ingest that lane's sources → enrich pending items for that lane → post that lane's Discord message immediately. Must work on macOS and Windows (Node, `claude` CLI on PATH, no native modules, no shell-specific scripts, `cross-env` for env vars). Optional flags: `--lane <name>` and `--since <hours>` (default: since the last digest, capped at 72 h).
1. **Worker** (`worker/index.ts`, run with `tsx`, optional, for when a machine is running). In-process scheduler (`node-cron`) with three jobs:
   - `ingest` every 30 min: every source runs in parallel with a per-source timeout, new items are upserted into `items` (unique on `(source, external_id)`), article bodies are fetched and extracted for link items.
   - `enrich` every 60 min, or immediately when pending items ≥ 15: one Claude call clusters pending items into stories and writes summaries and scores (ADR 0003).
   - `digest` at 08:00 and 18:00 `TZ` (default `Australia/Sydney`, confirm): posts high-score stories to Discord (ADR 0004).
2. **Web** (Next.js App Router at repo root, `next start` on a configurable port). Reads the same Supabase database. Basic-auth middleware (ADR 0004).

**Store:** one Supabase project (Free plan) used as plain Postgres via the `postgres` npm client over `DATABASE_URL` (the Supavisor pooler string, transaction mode). No Supabase client SDK, no RLS, no auth: the DB is reached only by the digest command, the worker and the web server, all holding the connection string. Rationale: the digest runs from whichever machine is at hand, so seen-item dedup and story history must live somewhere shared. Free plan checked 2026-09-13: 500 MB database, 5 GB egress/month, unlimited API requests, 2 active projects, paused after 7 days without database activity, manual resume from the dashboard within 1 year, no data loss. At ~150 items/day with 2000-char bodies the DB grows ~15–20 MB/month, so 500 MB is over a year before pruning; `items.body` is nulled after 30 days to keep it flat. Egress is a few MB per digest run and per feed page; nowhere near 5 GB. Tables:
- `items` — `id`, `source`, `external_id`, `lane_hint`, `url`, `title`, `body` (extracted text, capped 2000 chars), `author`, `engagement` (JSON: likes/points/upvotes/comments), `published_at`, `fetched_at`, `story_id` (nullable FK). Unique `(source, external_id)`.
- `stories` — `id`, `lane`, `title`, `summary_short` (≤ 2 sentences), `summary_detail` (markdown, 150–300 words, nullable for low-score stories), `score` (1–5), `first_seen_at`, `updated_at`, `digested_at` (nullable).
- `digests` — `id`, `sent_at`, `lane`, `story_ids` (JSON), `discord_status`.
- `price_snapshots` — `symbol`, `price`, `ts` (for move detection, ADR 0002).
- `runs` — `job`, `started_at`, `finished_at`, `ok`, `counts` (JSON), `error` (text). Every job writes a row; this is the only observability needed.

**Config:** `config/sources.ts` holds lanes, feeds, subreddits, HN keyword lists, Twitter lists/queries, and tickers. Secrets live in `.env` (`ANTHROPIC_API_KEY`, `DISCORD_WEBHOOK_URL` + optional per-lane mirror URLs, `RETTIWT_API_KEY`, `FEED_USER`, `FEED_PASS`, `TZ`, `DATABASE_URL`, `PORT`, `LLM_MODEL`, `ENRICH_INTERVAL_MIN`).

**Layout:**
```
package.json            one package, one install
config/sources.ts
.env.example
lib/db/{schema.sql,client.ts,queries.ts,types.ts,migrate.ts}
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
- **SQLite file.** Was the v1 choice. Dropped 2026-09-13 once the digest became an on-command job run from more than one machine: a local file would give each machine its own history and duplicate posts. Also removes the `better-sqlite3` native build on Windows.
- **Supabase client SDK / PostgREST / RLS.** Adds a layer for a single trusted caller; plain SQL over the pooler is simpler.
- **Queue or separate enrichment service.** A cron tick and a `story_id IS NULL` query is the queue.
- **Separate packages for worker and web.** Two installs and two lockfiles for one developer; not worth it.
- **GitHub Actions or the Mac as the runtime.** Actions can't host the feed and is the worst place for Twitter cookies; the Mac sleeps. The VPS is always on and already paid for.
- **Managed Agents scheduled deployment for the whole pipeline.** Would remove the scheduler but adds a hosted dependency and per-session cost for what is a plain cron job with one API call.

## Consequences
- Shares a box with production services. The app must run under its own directory and process-manager entry, bind to one port, and never touch the other services' files or ports. Deployment onto that box is a separate, explicitly approved step.
- Every DB access is a network round trip to Supabase; batch inserts (one multi-row upsert per source per run) and keep the feed's page query to one statement.
- **Pausing.** No digest for 7 days pauses the project; the next `npm run digest` fails to connect and must print `Supabase project paused, resume it at <dashboard url>` and exit non-zero. Accepted for v1; a weekly keep-alive ping is the fix if it becomes annoying.
- Windows and Mac both need `DATABASE_URL` in their `.env`. The Mac and Windows checkouts share nothing else.
- No websockets. "Live" means up to date on refresh or scroll, not push.
- Backups are Supabase's (daily on Free plan, not restorable by the user) plus `pg_dump` on demand. No migration tooling; `lib/db/migrate.ts` applies `schema.sql` idempotently (`CREATE TABLE IF NOT EXISTS`) and is run by `npm run db:migrate` and at the start of `npm run digest`.

## Implementation surface
- `package.json`, `tsconfig.json`, `next.config.ts`, `.env.example`, `.gitignore` — scaffolding, owned by whoever bootstraps the repo. Everyone else depends on it being present first.
- `lib/db/*` — schema and typed query helpers. **Interface:** the exported functions in `lib/db/queries.ts` and types in `lib/db/types.ts` are the contract every other module uses. Build this first; sources, enrich, digest and web all consume it and do not write raw SQL.
- `config/sources.ts` — lane and source config. Shape defined alongside `lib/sources/types.ts`.
- `scripts/digest.ts` — on-command pipeline. Imports the same `ingest`, `enrich`, `digest` run functions and calls them per lane; no source or LLM logic.
- `worker/index.ts` — scheduler only. Imports `ingest`, `enrich`, `digest` run functions; contains no source or LLM logic.
- `app/*`, `middleware.ts` — web only; reads via `lib/db/queries.ts`.
- Disjoint from ADRs 0002–0004 except through `lib/db/queries.ts` and `lib/sources/types.ts`.

# info-feed

A personal news digest across five lanes: **ai**, **markets**, **betting**, **gamedev**, **games**.

It ingests free sources (RSS, Reddit, Hacker News, Steam, crypto prices, and optionally
Twitter), uses one Claude call per lane to cluster the raw items into stories with a
short summary and a 1–5 score, posts the good ones to Discord lane by lane, and serves
a live scrolling feed behind basic auth.

Design decisions live in `docs/adr/`. Read those before changing anything structural;
each one records what was rejected and why.

## How it is used

Three entrypoints, one package, one database.

| Command | What it does |
| --- | --- |
| `npm run digest` | The main one. Runs the whole pipeline once, lane by lane, and exits. |
| `npm run worker` | Optional. Same jobs on a schedule, for when a machine is left running. |
| `npm run dev` | The live feed at `http://localhost:$PORT`. |

`npm run digest` assumes no machine is always on. For each lane in turn it ingests that
lane's sources, enriches the pending items into stories, and posts that lane's Discord
message immediately, so you can start reading while later lanes are still running.

```bash
npm run digest                      # since the last digest, capped at 72h
npm run digest -- --lane ai         # one lane only
npm run digest -- --since 24        # last 24 hours
```

It works identically on macOS and Windows: no native modules, no shell-specific scripts.

## Setup

Requires **Node 24+** and, for the default LLM transport, the **`claude` CLI** logged in
on the machine that runs the digest.

```bash
git clone <repo> info-feed && cd info-feed
npm install
cp .env.example .env        # then fill it in, see below
npm run db:migrate          # applies lib/db/schema.sql, safe to run repeatedly
npm run digest -- --since 24
```

`npm run digest` runs the migration itself at startup, so `db:migrate` is only needed
when you want to apply the schema without running a digest.

### The database

One Supabase project on the Free plan, used as plain Postgres. No Supabase SDK, no RLS,
no auth: the connection string is the credential.

`DATABASE_URL` must be the **Supavisor pooler string in transaction mode** (dashboard →
Connect → Transaction pooler, port 6543), not the direct connection on 5432. The client
sets `prepare: false` because transaction-mode pooling hands each statement a different
backend and named prepared statements do not survive that.

A Free-plan project **pauses after 7 days without database activity**. When that happens
the next run prints `Supabase project paused, resume it at <dashboard url>` and exits
non-zero. Resume it from the dashboard; no data is lost.

## Environment variables

Copy `.env.example` and fill it in. Required:

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Supavisor **pooler** string, transaction mode. |
| `DISCORD_WEBHOOK_URL` | Main channel. Always receives every lane. |
| `FEED_USER`, `FEED_PASS` | Basic auth for the web feed. Only safe over HTTPS. |
| `TZ` | Digest schedule and rendered timestamps. Default `Australia/Sydney`. |

Optional:

| Variable | Notes |
| --- | --- |
| `DISCORD_WEBHOOK_URL_<LANE>` | Mirrors that lane to a second channel **in addition to** the main one, never instead of it. `<LANE>` is `AI`, `MARKETS`, `BETTING`, `GAMEDEV` or `GAMES`. |
| `FEED_BASE_URL` | Where the story links in Discord point. Defaults to `http://localhost:3005`. |
| `PORT` | Port for `next start`. |
| `RETTIWT_API_KEY` | Twitter. Leave empty to skip it entirely, which is the v1 default. |
| `ANTHROPIC_API_KEY` | Only used when `LLM_TRANSPORT=api`. |

## The two dials

**`LLM_MODEL`** — which model does the clustering, summarising and scoring.

| Value | When |
| --- | --- |
| `claude-sonnet-5` | Default. The judgement calls (what is a duplicate, what is actually big) are the product. |
| `claude-haiku-4-5` | Roughly half the cost, weaker judgement. |
| `claude-opus-5` | Better, about 2.5× Sonnet's cost for a job Sonnet handles. |

These are exact model ids. **Never append a date suffix.**

**`ENRICH_INTERVAL_MIN`** — how often the worker enriches, in minutes. Default 60. The
worker also enriches immediately when 15+ items are pending. Set it to `999` during
development so the worker never spends tokens on its own, and trigger runs by hand:

```bash
npm run enrich:once -- --lane ai --max 20
```

Two more dials that are not env vars but matter as much: the **engagement thresholds**
in `config/sources.ts` decide how many items reach the model at all, and the **prompt
rubric** in `lib/enrich/prompt.ts` decides what scores a 4 or 5. If the feed is noisy,
raise the score threshold and tighten the rubric rather than changing the UI.

## LLM transport

`LLM_TRANSPORT=cli` (default) spawns the local `claude` CLI in headless mode, using
Gadi's Claude subscription. No API key, no bill. It ties the digest to a machine where
`claude` is logged in, and shares the subscription's rate-limit window with interactive
Claude Code sessions.

`LLM_TRANSPORT=api` uses `@anthropic-ai/sdk` with `ANTHROPIC_API_KEY`. **This is required
before deploying to a server**, because the CLI transport only works where someone has
logged in interactively. Tracked as T1 in `TODO.md`.

## Tests

```bash
npm test
```

Vitest. Source tests hit the **live** endpoints on purpose (ADR 0002): mocking a feed
proves nothing about whether the feed still exists. Tests that need a credential skip
themselves when it is absent, so Twitter's live test always skips until a key is set.

## Layout

```
config/sources.ts      lanes, feeds, subreddits, HN queries, watchlist, thresholds
lib/db/                schema.sql, client, migrate, typed queries  <- the only raw SQL
lib/sources/           one file per source, plus index.ts (runner + pre-filter)
lib/fetchBody.ts       readable-text extraction for link items
lib/enrich/            prompt, schema, transport, run  <- the one model call
lib/digest/            Discord formatting and sending
scripts/digest.ts      the on-command pipeline
worker/index.ts        the optional scheduler
app/, components/      the Next.js feed
docs/adr/              why everything is the way it is
```

Everything reads and writes through `lib/db/queries.ts`. Nothing else writes SQL.

## Deploying to the VPS

**Nothing has been deployed.** These are the steps for a separate, explicitly approved
session. Read the blocker first.

### Blocker: the LLM transport

The default `LLM_TRANSPORT=cli` **cannot work on the server**. It shells out to the
`claude` CLI and relies on an interactive subscription login, which a headless box does
not have. Before deploying, resolve `TODO.md` T1:

```bash
LLM_TRANSPORT=api
ANTHROPIC_API_KEY=sk-ant-...
```

Budget roughly US$10–25/month on Sonnet 5 at the default cadence. Until that switch is
made, deploying gets you ingestion and a feed with no enrichment, which is not the product.

### The box is shared

The VPS already runs unrelated production services. The app must stay inside its own
directory, run under its own process-manager entry, bind to one port, and never touch
another service's files, ports or config.

1. **Own directory and own user.**
   ```bash
   sudo mkdir -p /opt/info-feed && sudo chown $USER /opt/info-feed
   git clone <repo> /opt/info-feed && cd /opt/info-feed
   npm ci
   ```
2. **Environment.** Copy `.env.example` to `.env` and fill it in. Set `LLM_TRANSPORT=api`,
   a real `FEED_PASS`, `FEED_BASE_URL` to the public HTTPS URL, and a `PORT` that nothing
   else on the box is using. Check first:
   ```bash
   ss -tlnp | grep -w <port>     # must print nothing
   ```
3. **Schema.** `npm run db:migrate`
4. **Build.** `npm run build`
5. **Two process-manager entries**, named so they cannot be confused with the existing
   services. Whatever the box already uses (systemd or pm2), match it rather than
   introducing a second supervisor:
   - `info-feed-web` → `npm run start`, bound to `PORT`, restart on failure.
   - `info-feed-worker` → `npm run worker`. Optional. Skip it if you would rather trigger
     `npm run digest` from cron or by hand.
6. **Reverse proxy.** Add one server block to the box's existing proxy pointing a
   hostname at `127.0.0.1:$PORT`. Do not change the proxy's other blocks.
7. **TLS is mandatory.** The feed's only lock is HTTP basic auth, which sends the
   password in base64 on every request. Over plain HTTP it is not a lock at all. Either
   terminate TLS at the proxy with a real certificate, or bind the app to `127.0.0.1`
   and reach it through an SSH tunnel. Never expose it on port 80.
8. **Verify.** `curl -I https://<host>/` returns 401, and with `-u "$FEED_USER:$FEED_PASS"`
   returns 200. Then run one `npm run digest -- --since 6` and confirm the Discord post.

### Operating it

`runs` is the whole observability story. To see what happened:

```sql
select job, started_at, ok, counts, error from runs order by started_at desc limit 20;
```

# Task manifest: info-feed v1

Source ADRs: 0001 (docs/adr/0001-single-node-repo-sqlite-worker-plus-web.md), 0002 (docs/adr/0002-free-first-sources-behind-one-interface.md), 0003 (docs/adr/0003-single-sonnet-call-cluster-summarise-score.md), 0004 (docs/adr/0004-discord-digest-plus-live-feed-web-app.md)
Generated: 2026-09-13

## Execution plan
- Wave 0 (single agent): T0 — scaffold, db layer, source contract, seed config. Everything else builds on it.
- Wave 1 (parallel, 9 agents): T1 rss, T2 reddit, T3 hn, T4 steam, T5 prices, T6 fetchBody, T7 enrich, T8 digest, T9 web
- Wave 2 (parallel, 4 agents): T10 source runner + pre-filter, T11 digest script, T12 worker scheduler, T13 twitter
- Wave 3 (single agent): T14 — live end-to-end run, README, code review, commit

Run each wave's tasks concurrently; wait for the wave to finish before starting the next.

## Shared-file notes
- `package.json` is the classic conflict generator. **T0 declares every dependency and every script up front** (including ones only used in waves 1–2: `rss-parser`, `@mozilla/readability`, `linkedom`, `node-cron`, `rettiwt-api`, `vitest`, `tsx`, `cross-env`, `next`, `react`, `tailwindcss`, `@anthropic-ai/sdk`). No wave 1–2 task edits `package.json`.
- `config/sources.ts` is read by every source but **written only by T0**. Wave 1 source tasks consume the seeded config shape and must not add fields to it. If a source needs a new config field, it goes in its own module constant instead.
- `lib/sources/index.ts` (barrel + runner) is owned solely by T10 in wave 2, after all source modules exist. Wave 1 sources export a default `Source` object and are imported by T10; no source edits the barrel.
- `.env.example` is written by T0 with every variable the four ADRs name, so no later task edits it.

---

### T0 — Scaffold the repo, db layer, source contract and seed config
- Wave: 0
- Depends on: none
- ADR: 0001, 0002
- Owns: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `.env.example`, `.gitignore`, `lib/db/schema.sql`, `lib/db/client.ts`, `lib/db/types.ts`, `lib/db/queries.ts`, `lib/db/migrate.ts`, `lib/sources/types.ts`, `config/sources.ts`, `lib/env.ts`, `tests/db/queries.test.ts`
- Context: One npm package, one Supabase Postgres database, three entrypoints (digest command, optional worker, Next.js app). The `postgres` npm client over `DATABASE_URL` (Supavisor pooler, transaction mode) is the only store; no Supabase SDK, no RLS, no ORM, no second database. `lib/db/queries.ts` is the contract every other module uses — nothing else writes raw SQL. Node 24, TypeScript, must run on macOS and Windows (no native modules, `cross-env` for env vars).
- Interfaces:
  - Exposes from `lib/db/types.ts`: `Lane = 'ai'|'markets'|'gamedev'|'games'|'betting'`, `Item`, `Story`, `Digest`, `PriceSnapshot`, `Run`.
  - Exposes from `lib/db/queries.ts`: `upsertItems(items: NewItem[]): Promise<number>`, `getPendingItems(lane: Lane, limit: number): Promise<Item[]>`, `getOpenStories(lane: Lane, hours: number, max: number): Promise<Story[]>`, `applyAssignments(lane, result): Promise<{created,updated,dropped}>` (one transaction), `markItemsFiltered(ids: number[])`, `getDigestStories(lane: Lane, minScore: number, limit: number)`, `markDigested(storyIds: number[], lane, status)`, `insertDigest(...)`, `getFeedPage({lanes,minScore,cursor,limit})`, `getStoryWithItems(id)`, `insertPriceSnapshots(...)`, `getLastPrice(symbol, sinceHours)`, `startRun(job)`, `finishRun(id, ok, counts, error?)`, `getLastDigestAt()`, `pruneOldBodies(days)`.
  - Exposes from `lib/sources/types.ts`: `Source { name: string; fetch(ctx: SourceCtx): Promise<RawItem[]> }`, `RawItem`, `SourceCtx { since: Date; config: SourcesConfig }`, `SourcesConfig`.
  - Exposes from `config/sources.ts`: `sourcesConfig: SourcesConfig` with the ADR 0002 seeds, crypto-only watchlist (BTC, ETH, SOL), empty stock list, and engagement thresholds.
  - Consumes: none.
- Steps:
  1. `npm init`, TypeScript config, Next.js App Router + Tailwind at repo root, Vitest.
  2. Declare every dependency and script the manifest names, including `db:migrate`, `digest`, `enrich:once`, `worker`, `dev`, `build`, `start`, `test`.
  3. Write `lib/db/schema.sql` with `items`, `stories`, `digests`, `price_snapshots`, `runs` exactly as ADR 0001 lists, all `CREATE TABLE IF NOT EXISTS`, unique `(source, external_id)`.
  4. `lib/db/migrate.ts` applies the schema idempotently; `npm run db:migrate` runs it against Gadi's Supabase project.
  5. Typed query helpers; a paused-project connection error must print `Supabase project paused, resume it at <dashboard url>` and exit non-zero.
  6. Source contract and seed config.
- Acceptance: `npm run db:migrate` succeeds against the live `DATABASE_URL` and is safe to run twice. `npm test` passes a round-trip test that upserts two items, re-upserts them and asserts no duplicates. `npx tsc --noEmit` is clean.

### T1 — RSS source
- Wave: 1
- Depends on: T0
- ADR: 0002
- Owns: `lib/sources/rss.ts`, `tests/sources/rss.test.ts`
- Context: Generic per-lane RSS ingestion with `rss-parser`, feed lists from `config/sources.ts`. Curated RSS passes the engagement pre-filter unfiltered because the curation is the filter. News APIs were rejected; RSS from primary sources is the free, stable path.
- Interfaces: Exposes `default: Source` named `rss` from `lib/sources/rss.ts`. Consumes `Source`/`RawItem` from `lib/sources/types.ts`.
- Steps: parse each feed with a per-feed timeout, map to `RawItem` with `externalId` = guid or link, `laneHint` from the feed's lane, filter to `publishedAt >= since`, never let one dead feed fail the source.
- Acceptance: `tests/sources/rss.test.ts` hits the live feeds and asserts ≥ 1 item with all required `RawItem` fields, and that a bad feed URL yields items from the others rather than throwing.

### T2 — Reddit source
- Wave: 1
- Depends on: T0
- ADR: 0002
- Owns: `lib/sources/reddit.ts`, `tests/sources/reddit.test.ts`
- Context: Public JSON at `/r/<sub>/hot.json?limit=50` with a descriptive User-Agent. Body is selftext. If the host gets 403/429, the known follow-up is a free Reddit script app with OAuth at 100 req/min; keep the module shape ready for that but do not build OAuth now.
- Interfaces: Exposes `default: Source` named `reddit`. Consumes `lib/sources/types.ts`.
- Steps: per-sub fetch with descriptive UA, map to `RawItem` with `engagement.upvotes` and `engagement.comments`, `externalId` = reddit id, skip stickied posts, tolerate per-sub failure.
- Acceptance: live test asserts ≥ 1 item with upvotes present; a 403 from one sub does not fail the whole fetch.

### T3 — Hacker News source
- Wave: 1
- Depends on: T0
- ADR: 0002
- Owns: `lib/sources/hn.ts`, `tests/sources/hn.test.ts`
- Context: Algolia HN API, `tags=front_page` plus per-lane keyword searches from config, with a points threshold applied later by the pre-filter.
- Interfaces: Exposes `default: Source` named `hn`.
- Steps: front page query plus one keyword query per lane, dedupe by objectID across queries, map `points` and `num_comments` into `engagement`, `laneHint` from which query matched (front page items get a best-effort lane from keywords, default `ai`).
- Acceptance: live test asserts ≥ 1 item with `engagement.points` a number and no duplicate `externalId`.

### T4 — Steam source
- Wave: 1
- Depends on: T0
- ADR: 0002
- Owns: `lib/sources/steam.ts`, `tests/sources/steam.test.ts`
- Context: `store.steampowered.com/api/featuredcategories` for new releases and top sellers, emitted as `games` lane items, deduped by appid.
- Interfaces: Exposes `default: Source` named `steam`.
- Steps: fetch the endpoint, take new releases and top sellers, dedupe by appid, `url` = store page, `publishedAt` = now when the endpoint gives no date.
- Acceptance: live test asserts ≥ 1 `games` item and unique appids.

### T5 — Prices source
- Wave: 1
- Depends on: T0
- ADR: 0002
- Owns: `lib/sources/prices.ts`, `tests/sources/prices.test.ts`
- Context: Crypto via CoinGecko free `/simple/price`; stocks via the unofficial Yahoo Finance chart endpoint (Finnhub free tier is the fallback if it breaks). Writes `price_snapshots` and emits a synthetic `RawItem` only when a watchlist symbol's 24 h move exceeds the configured threshold (default 5 %). v1 watchlist is crypto only: BTC, ETH, SOL. The stock list is empty by decision, so the Yahoo path must be a no-op when the list is empty rather than an error.
- Interfaces: Exposes `default: Source` named `prices`. Consumes `insertPriceSnapshots` and `getLastPrice` from `lib/db/queries.ts`.
- Steps: fetch crypto prices with 24 h change, snapshot them, emit a `markets` `RawItem` per symbol over threshold with the move in the title, isolate the Yahoo call so a change there cannot break crypto.
- Acceptance: live test asserts CoinGecko returns all three symbols and that a snapshot row is written; asserts no throw when the stock list is empty.

### T6 — Article body fetch and extraction
- Wave: 1
- Depends on: T0
- ADR: 0002
- Owns: `lib/fetchBody.ts`, `tests/fetchBody.test.ts`
- Context: For link items with no body, fetch the URL with an 8 s timeout and extract readable text with `@mozilla/readability` + `linkedom`, capped at 2000 chars. Failure leaves `body` null and must never block or fail the ingest run.
- Interfaces: Exposes `fetchBody(url: string, timeoutMs?: number): Promise<string | null>` and `fetchBodies(urls: string[], concurrency?: number): Promise<Map<string,string|null>>`.
- Steps: bounded-concurrency fetch, skip non-HTML content types, extract, collapse whitespace, cap length, return null on any failure.
- Acceptance: live test extracts > 200 chars from a stable article URL and returns null for an unreachable host without throwing.

### T7 — Enrichment: schema, prompt, transport, run
- Wave: 1
- Depends on: T0
- ADR: 0003
- Owns: `lib/enrich/schema.ts`, `lib/enrich/prompt.ts`, `lib/enrich/transport.ts`, `lib/enrich/run.ts`, `scripts/enrich-once.ts`, `tests/enrich/prompt.test.ts`, `tests/enrich/schema.test.ts`
- Context: One Claude call per lane per run, chunked at 60 pending items, that clusters pending items into stories and writes summaries and scores. v1 transport is the local `claude` CLI headless (`claude -p`, `--output-format json`, tools disabled, model from `LLM_MODEL`, default `claude-sonnet-5` exactly, never with a date suffix); the `@anthropic-ai/sdk` path sits behind `LLM_TRANSPORT=api`. Rejected: per-item summarisation, embeddings clustering, batch API, Haiku or Opus as the default. Detail summaries exist only for `score >= 3`. Every pending item is assigned or dropped exactly once; dropped items get `story_id = -1`. Failure leaves items pending and is logged to `runs`, max 2 retries.
- Interfaces:
  - Exposes `enrichLane(lane: Lane, opts?: {maxItems?: number}): Promise<{stories: number, dropped: number, usage?: TokenUsage}>` from `lib/enrich/run.ts`.
  - Exposes `complete(prompt, schema): Promise<{text: string, usage?: TokenUsage}>` from `lib/enrich/transport.ts`.
  - Consumes `getPendingItems`, `getOpenStories`, `applyAssignments`, `startRun`, `finishRun` from `lib/db/queries.ts`.
- Steps: schema and TS types first, then the pure prompt builder, then the two transports, then the run loop and transaction write. Validate the parsed JSON against the schema before any write.
- Acceptance: unit tests cover serialisation and schema validation with fixture items, including rejection of a response that drops an item id. One live test gated on `claude` being on PATH. `npm run enrich:once -- --lane ai --max 20` performs a real capped run.

### T8 — Discord digest
- Wave: 1
- Depends on: T0
- ADR: 0004
- Owns: `lib/digest/discord.ts`, `lib/digest/run.ts`, `tests/digest/discord.test.ts`
- Context: Selects stories with `score >= 4` where `digested_at IS NULL OR updated_at > digested_at`, grouped by lane, ordered by score then `updated_at`, capped 8 per lane. One webhook message per lane, skipping empty lanes. `DISCORD_WEBHOOK_URL` always receives every lane; `DISCORD_WEBHOOK_URL_<LANE>` mirrors that lane in addition, never instead. Marks `digested_at` only after a 2xx. Respects Discord's 2000 char and 10 embed limits by splitting. Telegram and email were rejected.
- Interfaces:
  - Exposes `postLane(lane, stories): Promise<{ok: boolean, status: number}>`, `postHeader(text)`, `postFooter(text)` from `lib/digest/discord.ts`, plus the pure `buildLaneEmbed(lane, stories, baseUrl)`.
  - Exposes `digestLane(lane): Promise<{sent: number, ok: boolean}>` from `lib/digest/run.ts`.
- Steps: pure embed formatting first so it is unit-testable, then the webhook client with splitting, then selection and marking through `lib/db/queries.ts`.
- Acceptance: unit tests on fixtures assert an embed never exceeds Discord limits and that a 12-story lane splits into two messages. Mirror logic is asserted to post to both URLs when the lane variable is set.

### T9 — Next.js live feed behind basic auth
- Wave: 1
- Depends on: T0
- ADR: 0004
- Owns: `middleware.ts`, `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `app/story/[id]/page.tsx`, `app/api/feed/route.ts`, `components/StoryCard.tsx`, `components/Feed.tsx`, `tests/web/feed.test.ts`
- Context: HTTP basic auth against `FEED_USER`/`FEED_PASS` on every route, no sessions and no user table. Feed with lane filter chips, a min-score toggle defaulting to >= 3, infinite scroll with a cursor on `(updated_at, id)` at page size 30, and expand-in-place detail showing rendered markdown or, when `summary_detail` is null, the source list. Tailwind, dark by default, mobile-first, a reading surface rather than a dashboard. Real auth and websockets were both rejected.
- Interfaces: Consumes `getFeedPage` and `getStoryWithItems` from `lib/db/queries.ts`. Exposes `GET /api/feed?lanes=&minScore=&cursor=&limit=`.
- Steps: middleware, layout and Tailwind, server-rendered first page, client component for scroll and expansion, story permalink page pre-expanded.
- Acceptance: `npm run build` succeeds. A test asserts the middleware returns 401 with a `WWW-Authenticate` header for no credentials and passes with correct ones, and that the feed route returns a cursor that pages without repeats.

### T10 — Source runner, pre-filter and barrel
- Wave: 2
- Depends on: T1, T2, T3, T4, T5, T6
- ADR: 0002
- Owns: `lib/sources/index.ts`, `tests/sources/index.test.ts`
- Context: Runs all sources with `Promise.allSettled` and a 20 s timeout each, logs failures into `runs`, and never lets one source fail the run. The engagement pre-filter is the main cost control: Reddit min upvotes, HN min points, tweets min likes, thresholds from `config/sources.ts`, curated RSS unfiltered. Filtered items are still stored but get `story_id = -1` so enrichment skips them.
- Interfaces: Exposes `ingest(opts: {lanes?: Lane[]; since: Date}): Promise<{bySource: Record<string, number>; stored: number; filtered: number}>`. Consumes every source's default export, `fetchBody`, and `upsertItems`/`markItemsFiltered`/`startRun`/`finishRun`.
- Steps: gather sources, run with timeout and `allSettled`, apply the pre-filter, fetch bodies for passing link items only, one multi-row upsert per source, log counts to `runs`.
- Acceptance: live test runs ingest for one lane and asserts rows land in `items`, that a deliberately broken source does not fail the run, and that a below-threshold Reddit item is stored with `story_id = -1`.

### T11 — `npm run digest` on-command pipeline
- Wave: 2
- Depends on: T7, T8, T10
- ADR: 0001, 0004
- Owns: `scripts/digest.ts`
- Context: The primary way the system is used, because no machine is assumed to be always on. Runs the full pipeline once, lane by lane, then exits: for each lane, ingest, enrich, then post that lane's Discord message immediately so reading can start while later lanes are still running. Lane order ai, markets, betting, gamedev, games. Flags `--lane <name>` and `--since <hours>`, defaulting to since the last digest capped at 72 h. Must work on macOS and Windows: no native modules, no shell-specific scripts. Runs the migration at start. Contains no source or LLM logic of its own.
- Interfaces: Consumes `ingest`, `enrichLane`, `digestLane`, `getLastDigestAt`, `migrate`.
- Steps: parse flags, migrate, post the run header, loop lanes calling ingest then enrich then digest, collect per-lane outcomes, post the footer naming quiet and failed lanes, exit non-zero if every lane failed.
- Acceptance: `npm run digest -- --lane ai --since 24` completes end to end and posts to Discord; a lane that throws is reported in the footer rather than aborting the run.

### T12 — Worker scheduler
- Wave: 2
- Depends on: T7, T8, T10
- ADR: 0001
- Owns: `worker/index.ts`
- Context: Optional entrypoint for when a machine is left running. In-process `node-cron` scheduler only, with no source or LLM logic: ingest every 30 min, enrich every `ENRICH_INTERVAL_MIN` (default 60) or immediately when pending items reach 15, digest at 08:00 and 18:00 in `TZ` (default `Australia/Sydney`). A separate queue or enrichment service was rejected; a cron tick plus a `story_id IS NULL` query is the queue.
- Interfaces: Consumes `ingest`, `enrichLane`, `digestLane`, `pruneOldBodies`.
- Steps: schedule the three jobs in `TZ`, guard against overlapping runs of the same job, add the daily body prune at 30 days, log every job to `runs`, handle SIGINT cleanly.
- Acceptance: starting the worker with `ENRICH_INTERVAL_MIN=999` registers the jobs and logs the next fire times without running enrichment, then exits cleanly on SIGINT.

### T13 — Twitter source
- Wave: 2
- Depends on: T10
- ADR: 0002
- Owns: `lib/sources/twitter.ts`, `tests/sources/twitter.test.ts`
- Context: `rettiwt-api` v7 with a cookie-derived key from a dedicated throwaway account, never Gadi's main account. Per lane, one List timeline plus one search query with `min_faves`, at most 10 requests per run. Twitter must not be load-bearing: on any auth or lockout error, log to `runs`, return `[]`, and do not retry within the run. For v1 the key is absent, so the source must be a silent no-op.
- Interfaces: Exposes `default: Source` named `twitter`. Registered in `lib/sources/index.ts` by T10, which must tolerate it returning `[]`.
- Steps: return `[]` immediately when `RETTIWT_API_KEY` is unset, otherwise read List ids and queries from config, cap requests, map to `RawItem` with `engagement.likes`, swallow auth errors into `[]`.
- Acceptance: with no key set the source returns `[]` and the ingest run still succeeds; the live test is skipped when the key is absent.

### T14 — Live end-to-end run, README and review
- Wave: 3
- Depends on: T11, T12, T13, T9
- ADR: 0001, 0002, 0003, 0004
- Owns: `README.md`, `TODO.md`, `docs/adr/*` (Deviations sections only), any fix-up edits from the review
- Context: Definition of done for v1. One real `npm run digest` on this Mac against live sources that posts lane by lane to the webhook, the feed checked in a browser, and a README covering setup, env vars, the two dials `LLM_MODEL` and `ENRICH_INTERVAL_MIN`, and the VPS deploy steps. Nothing is deployed: the VPS is out of scope and blocked until TODO T1 is resolved. Deploy notes must cover its own directory, its own process-manager entry, a single port, the reverse-proxy note and the TLS requirement for basic auth.
- Interfaces: none.
- Steps: full live run, capture token usage from the CLI JSON result, browser check of the feed, README, record any ADR deviations under a `## Deviations` heading, run `/code-review` over the whole diff and fix findings, commit.
- Acceptance: the digest run posts to Discord, the feed renders stories behind basic auth, `npm test` passes, `npm run build` succeeds, and the README documents deploy without any VPS access having occurred.

# Goal: build "infofeed" v1 end to end

You are running as the lead agent on a fresh repo at `/Users/gadi/Documents/infofeed`.
The design is already settled and recorded. Do not re-litigate it. Read these first, in order:

- `docs/adr/0001-single-node-repo-sqlite-worker-plus-web.md` — system shape, data model, layout, config
- `docs/adr/0002-free-first-sources-behind-one-interface.md` — Source interface, the six sources, pre-filter, body fetching
- `docs/adr/0003-single-sonnet-call-cluster-summarise-score.md` — the one LLM call, schema, rubric, cost dials
- `docs/adr/0004-discord-digest-plus-live-feed-web-app.md` — digest and the Next.js feed

## Definition of done
Running `npm run worker` on this Mac ingests from RSS, Reddit, HN, Steam and prices across five lanes (ai, markets, gamedev, games, betting) (Twitter too if the key is present), enriches pending items into stories with Sonnet 5, and can post a digest to Gadi's Discord. Running `npm run dev` shows the live feed behind basic auth with lane filters, score toggle, infinite scroll and expand-in-place detail. Every module has the tests named in its ADR and they pass. `README.md` explains setup, env vars, the two dials (`LLM_MODEL`, `ENRICH_INTERVAL_MIN`) and how to deploy. Nothing has been deployed to the VPS.

## How to work
1. **LLM transport is the local `claude` CLI** (`LLM_TRANSPORT=cli`, default), per ADR 0003. Spawn `claude -p` with tools disabled and JSON output, model id `claude-sonnet-5` exactly. Load `/claude-api` before writing the optional SDK transport (`@anthropic-ai/sdk`, `output_config.format`, adaptive thinking, `effort: "low"`, `cache_control` on the system prompt). Never append date suffixes to model ids.
2. **Generate the task manifest with `/adr-to-tasks`** on the four ADRs, then execute it wave by wave with parallel subagents. Each ADR's "Implementation surface" section already states file ownership; keep it disjoint. Expected shape:
   - Wave 0 (single agent): `git init`, scaffold (`package.json`, `tsconfig`, Next.js App Router with Tailwind, `.env.example`, `.gitignore`), `lib/db/*` (schema, client, typed queries), `lib/sources/types.ts`, `config/sources.ts` seed. This is the contract everything else builds on; get it reviewed before fanning out.
   - Wave 1 (parallel, one agent each): `rss.ts`, `reddit.ts`, `hn.ts`, `steam.ts`, `prices.ts`, `fetchBody.ts`, `lib/enrich/*`, `lib/digest/*`, the web app (`app/*`, `components/*`, `middleware.ts`). Each with its tests.
   - Wave 2 (parallel): `lib/sources/index.ts` runner + pre-filter, `worker/index.ts` scheduler, `twitter.ts` (last; must degrade to `[]` on any auth error).
   - Wave 3 (single agent): end-to-end run on the Mac against live sources, one real enrichment call, one real Discord post to the webhook, feed check in the browser, README, `/code-review` of the whole diff, fix findings, commit.
3. **Run tests as you go.** Vitest. Live-endpoint smoke tests are skipped when the relevant env var is absent; do not mock the free sources, hit them.
4. **Cost guard.** During development set `ENRICH_INTERVAL_MIN=999` and trigger enrichment manually with `npm run enrich:once` on a capped batch. Do not leave the worker running unattended today.
5. **Commit on main** in this repo (it is the root checkout, not a worktree). Small commits per wave.

## Guardrails
- Do **not** deploy to, ssh into, or configure the bet337 VPS. Deployment is a separate session with explicit approval and is blocked until `TODO.md` T1 is resolved (the CLI transport only works on this Mac). Write the deploy steps into `README.md` instead (own directory, own process-manager entry, single port, reverse-proxy note, TLS required for basic auth).
- Do not use Gadi's main Twitter account. `RETTIWT_API_KEY` comes only from the throwaway account. If the key is missing, skip Twitter entirely and say so in the final report.
- Do not add a database, queue, or hosted service beyond what the ADRs name.
- Do not swap Sonnet 5 for Opus or Haiku by default. They are env overrides only.
- If an ADR turns out to be wrong in practice (an endpoint is dead, a library is broken), fix it the simplest way, note the deviation in the ADR under a `## Deviations` heading, and continue. Do not stop to ask unless the deviation changes cost or scope materially.

## Inputs Gadi provides (check `.env` before starting; report any that are missing)
- A logged-in `claude` CLI on this Mac (`claude --version` works). `ANTHROPIC_API_KEY` only if `LLM_TRANSPORT=api`.
- `DISCORD_WEBHOOK_URL` (plus optional `DISCORD_WEBHOOK_URL_AI|MARKETS|GAMEDEV|GAMES|BETTING`, each mirrors that lane in addition to the main channel)
- `RETTIWT_API_KEY` from the throwaway account (optional for v1)
- `FEED_USER`, `FEED_PASS`
- `TZ` (default `Australia/Sydney`; confirm)
- Stock tickers for the watchlist in `config/sources.ts` (crypto defaults to BTC, ETH, SOL)
- Twitter List ids per lane and any extra accounts, RSS feeds or subreddits beyond the seeds in ADR 0002

## Final report must include
- What runs, what was verified live (which sources returned items, the enrichment result, the Discord post), and what was skipped and why.
- The measured token usage of the real enrichment call (from the CLI JSON result), extrapolated to a monthly estimate at the default cadence, priced as if on the API.
- Any ADR deviations.
- Open items in `TODO.md` unchanged or updated.
- The exact deploy steps for the VPS session.

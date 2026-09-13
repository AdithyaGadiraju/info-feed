# ADR 0002: Free sources first, behind one Source interface; Twitter via a throwaway cookie-scraped account, wired last

- Status: Accepted
- Date: 2026-09-12
- Deciders: Gadi + Claude

## Context
The original idea led with Twitter (hyped posts per category + followed accounts) and Reddit. Twitter's free API tier is write-only; read access starts around US$200/month and category search is the most expensive call. Gadi chose to cookie-scrape his own session rather than pay. That is free but violates Twitter's terms, breaks unpredictably, and gets flagged faster from a datacenter IP (the VPS).

Nearly all the wanted news also lands on free, stable, structured sources within hours. The value Twitter adds is speed and hype signal, not facts. So Twitter must not be load-bearing.

Markets lane: Gadi wants news plus price-move alerts on a watchlist.

## Decision
Every source implements one interface in `lib/sources/types.ts`:

```ts
interface Source {
  name: string;                       // 'rss' | 'reddit' | 'hn' | 'steam' | 'prices' | 'twitter'
  fetch(ctx: { since: Date; config: SourcesConfig }): Promise<RawItem[]>;
}
interface RawItem {
  source: string; externalId: string; laneHint: Lane; url: string;
  title: string; body?: string; author?: string;
  engagement?: { likes?: number; points?: number; upvotes?: number; comments?: number };
  publishedAt: Date;
}
```
`lib/sources/index.ts` runs all sources with `Promise.allSettled`, a 20 s timeout each, logs failures into `runs`, and never lets one source fail the run.

**Engagement pre-filter** (in `index.ts`, thresholds in `config/sources.ts`): Reddit min upvotes, HN min points, tweets min likes. Curated RSS passes through unfiltered. This is the main cost control: items that fail the filter are stored but never sent to the model (`story_id` set to a sentinel `-1` so enrich skips them).

**Sources, in build order:**
1. `rss.ts` — generic, `rss-parser`. Per-lane feed lists in config. Seed: OpenAI, Anthropic, Google DeepMind, Hugging Face blog (ai); Godot, Unreal, Unity, Blender, 80.lv, GameDeveloper.com (gamedev); Eurogamer, Rock Paper Shotgun, IGN (games); CoinDesk, CNBC markets (markets); Pinnacle betting resources, Unabated blog, MMA Junkie, Bloody Elbow (betting). Gadi edits the list.
2. `reddit.ts` — public JSON (`/r/<sub>/hot.json?limit=50`) with a descriptive `User-Agent`. Seed subs: MachineLearning, LocalLLaMA, artificial (ai); gamedev, godot, unrealengine, blender (gamedev); Games, pcgaming (games); CryptoCurrency, stocks (markets); sportsbook, algobetting, MMA, MMAbetting (betting). Body = selftext. **If the VPS gets 403/429**, register a free Reddit script app and switch to OAuth (100 req/min); keep the same module shape.
3. `hn.ts` — Algolia HN API, `tags=front_page` plus per-lane keyword searches, `points` threshold.
4. `steam.ts` — `store.steampowered.com/api/featuredcategories` (new releases, top sellers) as `games` items, deduped by appid.
5. `prices.ts` — crypto via CoinGecko free `/simple/price`; stocks via Yahoo Finance chart endpoint (unofficial, free; Finnhub free tier as fallback if it breaks). Writes `price_snapshots`; emits a synthetic `RawItem` when 24 h move on a watchlist symbol exceeds the configured threshold (default 5 %). Default watchlist BTC, ETH, SOL; stock tickers supplied by Gadi.
6. `twitter.ts` — `rettiwt-api` (v7, cookie-derived API key from a **dedicated throwaway account**, never Gadi's main). Per lane: one Twitter List timeline (the throwaway follows the accounts Gadi cares about, grouped into Lists) plus one search query with `min_faves` for "hyped posts". ≤ 10 requests per run. On auth or lockout error: log to `runs`, return `[]`, do not retry within the run. Wired last; the feed must be useful without it.

**Body fetching** (`lib/fetchBody.ts`): for link items with no body, fetch the URL with an 8 s timeout and extract readable text (`@mozilla/readability` + `linkedom`), cap 2000 chars. Failure leaves `body` null; never blocks the run.

## Rejected alternatives
- **Official Twitter API.** ~US$200/month for the one source with the least unique information.
- **Pay-per-use Twitter scraper services.** Cheap, but a third party proxying reads; Gadi chose cookies.
- **Scraping Gadi's main account.** A lockout would cost a real account. Throwaway account holds all the risk.
- **Twitter first, everything else later.** Inverts the risk: the fragile source would gate the whole build.
- **Nitter / RSS bridges for Twitter.** Effectively dead in 2026.
- **News APIs (NewsAPI, GNews).** Free tiers are delayed or capped; RSS from the primary sources is better and free.

## Consequences
- Twitter will break periodically. When it does, the feed keeps working and `runs` shows why.
- Reddit public JSON from a datacenter IP may be blocked; the OAuth fallback is a known follow-up, not a surprise.
- Yahoo's unofficial endpoint can change; `prices.ts` isolates it.
- Feed and subreddit lists are curation work for Gadi, not code. Expect to tune them for the first two weeks.
- Engagement thresholds trade recall for cost; too high and the feed goes quiet, too low and the bill grows.

## Implementation surface
- `lib/sources/types.ts` — the `Source`/`RawItem` contract plus `SourcesConfig` type. Must exist before any source is written; everything in this ADR depends on it.
- `lib/sources/rss.ts`, `reddit.ts`, `hn.ts`, `steam.ts`, `prices.ts`, `twitter.ts` — one file each, fully independent of each other. Parallel-safe.
- `lib/sources/index.ts` — runner, pre-filter, upsert via `lib/db/queries.ts`. Depends on `types.ts` and the db layer.
- `lib/fetchBody.ts` — standalone; called by `index.ts`.
- `config/sources.ts` — seed config; shape from `types.ts`.
- Each source gets a smoke test under `tests/sources/<name>.test.ts` that runs against the live endpoint and asserts ≥ 1 item with required fields (skipped when creds are absent for twitter).

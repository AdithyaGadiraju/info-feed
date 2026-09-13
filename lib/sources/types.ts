/**
 * The one interface every source implements (ADR 0002). A source knows how to talk
 * to exactly one upstream and returns RawItems; it does not touch the database, does
 * not apply the engagement pre-filter and does not fetch article bodies. All three of
 * those belong to the runner in `lib/sources/index.ts`.
 */
import type { Engagement, Lane } from '../db/types';

export type { Engagement, Lane };

export interface RawItem {
  /** Matches the owning source's `name`. Half of the dedupe key. */
  source: string;
  /** Stable id from the upstream. The other half of the dedupe key. */
  externalId: string;
  laneHint: Lane;
  url: string;
  title: string;
  /** Selftext, tweet text or extracted article text. Capped at 2000 chars on write. */
  body?: string;
  author?: string;
  engagement?: Engagement;
  publishedAt: Date;
}

export interface SourceCtx {
  /** Ignore anything published before this. */
  since: Date;
  config: SourcesConfig;
  /** When set, only fetch for these lanes. Undefined means all lanes. */
  lanes?: Lane[];
}

export interface Source {
  name: 'rss' | 'reddit' | 'hn' | 'steam' | 'prices' | 'twitter';
  fetch(ctx: SourceCtx): Promise<RawItem[]>;
}

// ---- config shape ----

export interface FeedSpec {
  lane: Lane;
  url: string;
  /** Shown in logs and used as a fallback author. */
  name: string;
}

export interface SubredditSpec {
  lane: Lane;
  sub: string;
}

export interface HnQuerySpec {
  lane: Lane;
  /** Passed to the Algolia `query` parameter. */
  query: string;
}

export interface TwitterListSpec {
  lane: Lane;
  /** Twitter List id owned by the throwaway account. */
  listId: string;
}

export interface TwitterQuerySpec {
  lane: Lane;
  query: string;
  minFaves: number;
}

/**
 * The engagement pre-filter. This is the main cost control (ADR 0002): items below
 * these thresholds are still stored, but are marked excluded and never sent to the
 * model. Curated RSS has no threshold because the curation is the filter.
 */
export interface Thresholds {
  /**
   * How many posts to keep from each subreddit's "hot" listing. This is Reddit's
   * cost control, because the .rss endpoint the source is forced to use carries no
   * vote counts (the JSON API 403s unauthenticated clients).
   */
  redditTopN: number;
  /** Kept for the OAuth follow-up, when vote counts become available again. */
  redditMinUpvotes: number;
  hnMinPoints: number;
  twitterMinLikes: number;
}

export interface SourcesConfig {
  lanes: readonly Lane[];
  /** Digest posting order (ADR 0004). */
  laneOrder: readonly Lane[];
  feeds: FeedSpec[];
  subreddits: SubredditSpec[];
  /** Algolia HN front-page fetch plus these per-lane keyword searches. */
  hnQueries: HnQuerySpec[];
  /** Keywords that route an HN front-page story into a lane. First match wins. */
  hnFrontPageLaneKeywords: Array<{ lane: Lane; keywords: string[] }>;
  /** CoinGecko ids keyed by the ticker shown in the feed. */
  crypto: Array<{ symbol: string; coingeckoId: string }>;
  /** Empty for v1 by decision (crypto-only watchlist). */
  stocks: string[];
  /** Percent 24h move that makes a price worth an item. */
  priceMovePct: number;
  thresholds: Thresholds;
  twitterLists: TwitterListSpec[];
  twitterQueries: TwitterQuerySpec[];
  /** Per-source wall-clock budget inside the runner. */
  sourceTimeoutMs: number;
  /** Per-URL budget for article body extraction. */
  bodyTimeoutMs: number;
}

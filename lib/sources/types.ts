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
  name: 'rss' | 'reddit' | 'hn' | 'steam' | 'prices' | 'twitter' | 'docs' | 'huggingface' | 'github' | 'devpost';
  fetch(ctx: SourceCtx): Promise<RawItem[]>;
  /**
   * The source returns its whole current listing every run rather than what is new
   * since `ctx.since`. The runner then stores only ids it has never seen, and
   * stores the first listing of each `author` as excluded, so adding a watch seeds
   * it silently instead of sending every existing page to the model.
   */
  snapshot?: boolean;
  /**
   * For a snapshot source whose current listing is itself the news. Set to false,
   * the first listing of an `author` is sent to the model like any later one
   * instead of being stored as already seen: a hackathon that is open today is
   * worth a story on the day the watch is added.
   */
  seedFirstListing?: boolean;
  /** Overrides `sourceTimeoutMs` for a source that must pace itself, e.g. Reddit. */
  timeoutMs?: number;
}

// ---- config shape ----

export interface FeedSpec {
  lane: Lane;
  url: string;
  /** Shown in logs and used as a fallback author. */
  name: string;
  /** When set, only items whose title matches are kept. */
  include?: RegExp;
  /** Items whose title matches are skipped, e.g. a feed's glossary stubs. */
  exclude?: RegExp;
}

/**
 * A docs site watched for new pages. Docs sites publish no feed, and their
 * sitemaps carry no usable lastmod (platform.claude.com has none, code.claude.com
 * restamps pages daily), so a new URL appearing in the listing is the signal.
 */
export interface DocsWatchSpec {
  lane: Lane;
  /** Stored as the item's author; the runner seeds each name once. */
  name: string;
  url: string;
  /**
   * `llms` reads `- [Title](url): description` lines; `sitemap` reads `<loc>` URLs;
   * `html` reads same-site `<a href>` links off an index page, for a section whose
   * posts share a path with other content and so cannot be told apart in a sitemap.
   */
  format: 'llms' | 'sitemap' | 'html';
  /** URL path prefixes to keep, e.g. `/docs/en/build-with-claude/`. */
  prefixes: string[];
  /** URL path prefixes to drop even when they match `prefixes`, e.g. nav links. */
  excludePrefixes?: string[];
}

export interface SubredditSpec {
  lane: Lane;
  sub: string;
  /** When set, only posts whose title matches count towards `redditTopN`. */
  include?: RegExp;
  /**
   * Fetch on its own rather than in the lane's combined listing. For a small
   * subreddit that the lane's big ones would crowd out of the 100 shared slots.
   */
  solo?: boolean;
}

export interface HnQuerySpec {
  lane: Lane;
  /** Passed to the Algolia `query` parameter. */
  query: string;
  /**
   * Require every word. By default a query is an OR of its terms, so "godot mcp"
   * would match any story mentioning Godot; a phrase query needs all of them.
   */
  allWords?: boolean;
  /** Search Show HN posts by title only: where new plugins and agent tools launch. */
  showHn?: boolean;
}

/**
 * A Hugging Face Hub model listing, ranked by trending score. Each model created in
 * the last few weeks with at least `minLikes` becomes an item: a new model that is
 * getting traction, which is how open 3D, texture and audio models arrive.
 */
export interface HfModelSpec {
  lane: Lane;
  /** Shown in logs. */
  name: string;
  /** e.g. `image-to-3d`. At least one of `pipelineTag` and `search` must be set. */
  pipelineTag?: string;
  /** Passed to the Hub's `search` parameter, which matches model ids only. */
  search?: string;
  minLikes: number;
}

/** A title gate over Hugging Face Daily Papers, the community-upvoted arXiv digest. */
export interface HfPapersSpec {
  lane: Lane;
  /** Shown in logs. */
  name: string;
  /** Matched against the title only; abstracts mention 3D and audio in passing. */
  include: RegExp;
  /** Titles that match are skipped, e.g. robotics papers that say "3D" or "motion". */
  exclude?: RegExp;
  minUpvotes: number;
}

export interface HuggingFaceConfig {
  models: HfModelSpec[];
  papers: HfPapersSpec[];
}

/**
 * A GitHub repository search. Only repositories created in the last few weeks are
 * searched, ranked by stars, so a new add-on or MCP server taking off is caught.
 */
export interface GithubSearchSpec {
  lane: Lane;
  /** Shown in logs. */
  name: string;
  /** GitHub search syntax, e.g. `blender mcp` or `topic:blender-addon ai`. */
  query: string;
  minStars: number;
}

/**
 * A Devpost hackathon search (lib/sources/devpost.ts). Devpost is where most
 * online hackathons with prize money are listed, and its listing API states the
 * dates, place and prize of each one.
 */
export interface DevpostSpec {
  lane: Lane;
  /** Stored as the item's author, and shown in logs. */
  name: string;
  /** Devpost theme names, e.g. `Gaming`. A hackathon must carry every one. */
  themes?: string[];
  /** Free-text search, matched by Devpost against the title and description. */
  search?: string;
  /** Minimum total prize, in whatever currency the listing states. 0 keeps all. */
  minPrize: number;
  /** Keep only hackathons whose location is "Online". */
  onlineOnly?: boolean;
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
 * One X account followed directly. Its own posts and quote posts are fetched
 * (plain retweets and replies are skipped), the likes threshold is bypassed, and
 * enrichment gets `note` as guidance. A kept story with one of its posts is never
 * scored below `minScore`; posts with no use are still dropped.
 */
export interface TwitterUserSpec {
  /** Starting lane; the model may move it within the lane group (ai/ai_dev/ai_gamedev). */
  lane: Lane;
  /** Handle without the @. Matched case-insensitively against item.author. */
  userName: string;
  /** Numeric X user id; saves a lookup request per run. */
  userId: string;
  /** Who this is and what counts as high value from them, for the model. */
  note: string;
  minScore: 3 | 4 | 5;
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
  /** Lanes whose Hacker News stories pass at a lower bar than `hnMinPoints`. */
  hnMinPointsByLane?: Partial<Record<Lane, number>>;
  twitterMinLikes: number;
}

export interface SourcesConfig {
  lanes: readonly Lane[];
  /** Digest posting order (ADR 0004). */
  laneOrder: readonly Lane[];
  feeds: FeedSpec[];
  docs: DocsWatchSpec[];
  subreddits: SubredditSpec[];
  /** Algolia HN front-page fetch plus these per-lane keyword searches. */
  hnQueries: HnQuerySpec[];
  /** Keywords that route an HN front-page story into a lane. First match wins. */
  hnFrontPageLaneKeywords: Array<{ lane: Lane; keywords: string[] }>;
  /** CoinGecko ids keyed by the ticker shown in the feed. */
  crypto: Array<{ symbol: string; coingeckoId: string }>;
  /** Yahoo Finance symbols: indices, region and sector ETFs (whole-market view). */
  stocks: string[];
  /** Default percent 24h move that makes a price worth an item. */
  priceMovePct: number;
  /** Per-symbol override of `priceMovePct`, e.g. 2 for an index, 10 for a small coin. */
  priceMovePctBySymbol?: Record<string, number>;
  /** Plain name shown with a symbol, e.g. `XLK` -> "US tech sector". */
  priceNames?: Record<string, string>;
  /**
   * Single stocks that moved a lot today, from Yahoo's day gainers and losers
   * screens. Only companies worth at least `minMarketCapB` billion USD count, so a
   * big move is news and not a penny stock.
   */
  stockMovers?: { minMarketCapB: number; minMovePct: number };
  thresholds: Thresholds;
  /** New models by pipeline tag or name, and gated Daily Papers. */
  huggingface: HuggingFaceConfig;
  /** At most 10 searches: the unauthenticated search limit is 10 a minute. */
  github: GithubSearchSpec[];
  /** Hackathon searches for the events lane. */
  devpost: DevpostSpec[];
  twitterLists: TwitterListSpec[];
  twitterQueries: TwitterQuerySpec[];
  twitterUsers: TwitterUserSpec[];
  /** Per-source wall-clock budget inside the runner. */
  sourceTimeoutMs: number;
  /** Per-URL budget for article body extraction. */
  bodyTimeoutMs: number;
}

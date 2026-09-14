/** The six lanes. Order here is the digest posting order (ADR 0004). */
export const LANES = ['ai', 'ai_dev', 'markets', 'betting', 'gamedev', 'games'] as const;
export type Lane = (typeof LANES)[number];

/**
 * Human labels for the web chips, story badges and Discord embed titles. The lane
 * id is also a Postgres value, a URL token, a CSS token and an env-var suffix, so
 * it never changes once data exists; this map is the only place a lane is renamed.
 */
export const LANE_LABELS: Record<Lane, string> = {
  ai: 'AI News',
  ai_dev: 'AI Dev',
  markets: 'Markets',
  betting: 'Betting',
  gamedev: 'Gamedev',
  games: 'Games',
};

export function isLane(v: string): v is Lane {
  return (LANES as readonly string[]).includes(v);
}

export type Score = 1 | 2 | 3 | 4 | 5;

/** `items.story_id` sentinel for items that must never reach the model. */
export const EXCLUDED_STORY_ID = -1;

export interface Engagement {
  likes?: number;
  points?: number;
  upvotes?: number;
  comments?: number;
}

export interface Item {
  id: number;
  source: string;
  externalId: string;
  laneHint: Lane;
  url: string;
  title: string;
  body: string | null;
  author: string | null;
  engagement: Engagement;
  publishedAt: Date;
  fetchedAt: Date;
  /** null = pending, -1 = excluded, >0 = assigned to that story. */
  storyId: number | null;
}

/** An item on its way into the database, before it has an id. */
export interface NewItem {
  source: string;
  externalId: string;
  laneHint: Lane;
  url: string;
  title: string;
  body?: string | null;
  author?: string | null;
  engagement?: Engagement;
  publishedAt: Date;
  /** Set to EXCLUDED_STORY_ID by the pre-filter so enrichment skips the item. */
  storyId?: number | null;
}

export interface Story {
  id: number;
  lane: Lane;
  title: string;
  summaryShort: string;
  summaryDetail: string | null;
  score: Score;
  firstSeenAt: Date;
  updatedAt: Date;
  digestedAt: Date | null;
}

/** A story plus the count of items behind it, for feed cards. */
export interface StoryWithCount extends Story {
  itemCount: number;
}

/** A story plus its sources, for the expanded card and the permalink page. */
export interface StoryWithItems extends Story {
  items: Array<Pick<Item, 'id' | 'source' | 'url' | 'title' | 'author' | 'engagement' | 'publishedAt'>>;
}

export interface DigestRow {
  id: number;
  sentAt: Date;
  lane: Lane;
  storyIds: number[];
  discordStatus: number;
}

export interface PriceSnapshot {
  id: number;
  symbol: string;
  price: number;
  ts: Date;
}

export interface RunRow {
  id: number;
  job: string;
  startedAt: Date;
  finishedAt: Date | null;
  ok: boolean | null;
  counts: Record<string, unknown>;
  error: string | null;
}

/** Cursor for the feed's infinite scroll: keyset on (updated_at, id). */
export interface FeedCursor {
  updatedAt: string;
  id: number;
}

export interface FeedPage {
  stories: StoryWithCount[];
  nextCursor: FeedCursor | null;
}

// ---- Enrichment write contract (ADR 0003) ----
// The shape lib/enrich produces and lib/db/queries.applyAssignments consumes.
// Lives here so the db layer never imports from lib/enrich.

export interface NewStoryInput {
  lane: Lane;
  title: string;
  summaryShort: string;
  summaryDetail: string | null;
  score: Score;
}

export type Assignment =
  | {
      itemIds: number[];
      storyId: number;
      updatedShort?: string;
      updatedDetail?: string | null;
      updatedScore?: Score;
    }
  | { itemIds: number[]; newStory: NewStoryInput };

export function isNewStoryAssignment(
  a: Assignment,
): a is { itemIds: number[]; newStory: NewStoryInput } {
  return 'newStory' in a;
}

export interface EnrichResult {
  assignments: Assignment[];
  /** Item ids judged noise. Written with story_id = EXCLUDED_STORY_ID. */
  dropped: number[];
}

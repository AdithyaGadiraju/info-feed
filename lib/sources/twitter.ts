/**
 * Twitter source (ADR 0002, TODO T3). Deliberately not load-bearing: v1 ships with
 * `RETTIWT_API_KEY` unset, and the rest of the feed must work without this file
 * doing anything at all.
 *
 * Written against `rettiwt-api` v7 (as the ADR specifies): the list timeline is
 * `ListService.tweets(listId, count, cursor)` and search takes a plain
 * `ITweetFilter` object (`includePhrase`, `minLikes`) on `TweetService.search`.
 */
import type { RawItem, Source, SourceCtx, TwitterListSpec, TwitterQuerySpec, TwitterUserSpec } from './types';
import { env } from '../env';

/** ADR 0002: request volume is what gets the throwaway account locked. */
const MAX_REQUESTS_PER_RUN = 10;

/** Twitter list/search timelines return newest-first at up to 100/20 per call; one page is plenty for a digest run. */
const LIST_COUNT = 20;
const SEARCH_COUNT = 20;

/**
 * Pacing so the throwaway account's traffic looks like a person checking X, not
 * a script. One "session" = one visit: it opens on the first call, stays open for
 * SESSION_MS so every lane of a `npm run digest` (which ingests lane by lane, one
 * fetch() per lane) can use it, and shares ONE request budget across those lanes.
 * Calls inside a session are sequential with a random human-scale pause. After a
 * session closes, the next one can open only after MIN_GAP + random jitter -- this
 * matters for the long-running worker, whose ingest cron fires every 30 min; a
 * manual digest is a new process, so its timing is already human.
 */
const SESSION_MS = 30 * 60 * 1000;
const MIN_GAP_MS = 3 * 60 * 60 * 1000;
const GAP_JITTER_MS = 60 * 60 * 1000;
const PAUSE_MIN_MS = 3_000;
const PAUSE_MAX_MS = 9_000;

interface Budget { remaining: number; used: number }
let session: { endsAt: number; nextOpenAt: number; budget: Budget } | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const humanPause = () => sleep(PAUSE_MIN_MS + Math.random() * (PAUSE_MAX_MS - PAUSE_MIN_MS));

/** The current session's shared budget, a new session, or a reason to skip. */
function acquireSession(now: number): Budget | string {
  if (session && now < session.endsAt) return session.budget;
  if (session && now < session.nextOpenAt) {
    return `next X visit after ${new Date(session.nextOpenAt).toLocaleTimeString()}`;
  }
  session = {
    endsAt: now + SESSION_MS,
    nextOpenAt: now + SESSION_MS + MIN_GAP_MS + Math.random() * GAP_JITTER_MS,
    budget: { remaining: MAX_REQUESTS_PER_RUN, used: 0 },
  };
  return session.budget;
}

// Structural subset of what we need from a `rettiwt-api` `Tweet`. Declared locally
// instead of importing the class so the dynamic-import boundary below stays the
// only place that touches the library's types.
interface RettiwtTweetLike {
  id: string;
  fullText: string;
  createdAt: string;
  likeCount?: number;
  replyCount?: number;
  tweetBy: { userName: string };
  retweetedTweet?: unknown;
  replyTo?: string;
  quoted?: { fullText?: string; tweetBy?: { userName?: string } };
}

const USER_COUNT = 20;

/** Tweets have no titles; the first line (or first ~120 chars) stands in for one. */
function deriveTitle(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  const source = firstLine || text.trim();
  return source.length > 120 ? `${source.slice(0, 120)}…` : source;
}

function toRawItem(tweet: RettiwtTweetLike, lane: TwitterListSpec['lane']): RawItem {
  const text = tweet.fullText ?? '';
  // A quote post's own text is often one line ("This is a new paradigm..."); the
  // quoted post is what it is about, so the model needs both.
  const quoted = tweet.quoted?.fullText
    ? `\n\nQuoting @${tweet.quoted.tweetBy?.userName ?? 'unknown'}: ${tweet.quoted.fullText}`
    : '';
  return {
    source: 'twitter',
    externalId: tweet.id,
    laneHint: lane,
    url: `https://x.com/${tweet.tweetBy.userName}/status/${tweet.id}`,
    title: deriveTitle(text),
    body: text + quoted,
    author: tweet.tweetBy.userName,
    engagement: { likes: tweet.likeCount, comments: tweet.replyCount },
    publishedAt: new Date(tweet.createdAt),
  };
}

/** Followed accounts: own posts and quote posts only; retweets and replies are skipped. */
async function fetchUsers(
  rettiwt: InstanceType<typeof import('rettiwt-api').Rettiwt>,
  users: TwitterUserSpec[],
  ctx: SourceCtx,
  budget: Budget,
): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for (const spec of users) {
    if (budget.remaining <= 0) break;
    if (budget.used++ > 0) await humanPause();
    budget.remaining -= 1;
    try {
      const page = await rettiwt.user.timeline(spec.userId, USER_COUNT);
      for (const tweet of page.list as unknown as RettiwtTweetLike[]) {
        if (tweet.retweetedTweet || tweet.replyTo) continue;
        const publishedAt = new Date(tweet.createdAt);
        if (publishedAt < ctx.since) continue;
        items.push(toRawItem(tweet, spec.lane));
      }
    } catch (err) {
      console.warn(`[twitter] user @${spec.userName} (${spec.lane}) failed: ${(err as Error).message}`);
    }
  }
  return items;
}

async function fetchLists(
  rettiwt: InstanceType<typeof import('rettiwt-api').Rettiwt>,
  lists: TwitterListSpec[],
  ctx: SourceCtx,
  budget: Budget,
): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for (const spec of lists) {
    if (budget.remaining <= 0) break;
    if (budget.used++ > 0) await humanPause();
    budget.remaining -= 1;
    try {
      const page = await rettiwt.list.tweets(spec.listId, LIST_COUNT);
      for (const tweet of page.list as unknown as RettiwtTweetLike[]) {
        const publishedAt = new Date(tweet.createdAt);
        if (publishedAt < ctx.since) continue;
        items.push(toRawItem(tweet, spec.lane));
      }
    } catch (err) {
      // One bad List (deleted, private, rate-limited) must not sink the run.
      console.warn(`[twitter] list ${spec.listId} (${spec.lane}) failed: ${(err as Error).message}`);
    }
  }
  return items;
}

async function fetchQueries(
  rettiwt: InstanceType<typeof import('rettiwt-api').Rettiwt>,
  queries: TwitterQuerySpec[],
  ctx: SourceCtx,
  budget: Budget,
): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for (const spec of queries) {
    if (budget.remaining <= 0) break;
    if (budget.used++ > 0) await humanPause();
    budget.remaining -= 1;
    try {
      const page = await rettiwt.tweet.search(
        // Original English posts only: retweets and replies repeat or fragment the
        // post that matters, and the model would only drop them.
        { includePhrase: spec.query, minLikes: spec.minFaves, onlyOriginal: true, language: 'en' },
        SEARCH_COUNT,
      );
      for (const tweet of page.list as unknown as RettiwtTweetLike[]) {
        const publishedAt = new Date(tweet.createdAt);
        if (publishedAt < ctx.since) continue;
        items.push(toRawItem(tweet, spec.lane));
      }
    } catch (err) {
      console.warn(`[twitter] query "${spec.query}" (${spec.lane}) failed: ${(err as Error).message}`);
    }
  }
  return items;
}

export const twitter: Source = {
  name: 'twitter',
  // The human-scale pauses between calls do not fit the default 20 s source budget.
  timeoutMs: 120_000,
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    const apiKey = env.rettiwtApiKey;
    if (!apiKey) {
      // Silent no-op by design (ADR 0002, TODO T3): Twitter is not built yet for
      // v1 and must never be the reason an ingest run fails or slows down.
      console.info('[twitter] RETTIWT_API_KEY not set, skipping (expected for v1)');
      return [];
    }

    const lists = ctx.lanes
      ? ctx.config.twitterLists.filter((l) => ctx.lanes!.includes(l.lane))
      : ctx.config.twitterLists;
    const queries = ctx.lanes
      ? ctx.config.twitterQueries.filter((q) => ctx.lanes!.includes(q.lane))
      : ctx.config.twitterQueries;
    const allUsers = ctx.config.twitterUsers ?? [];
    const users = ctx.lanes ? allUsers.filter((u) => ctx.lanes!.includes(u.lane)) : allUsers;

    if (lists.length === 0 && queries.length === 0 && users.length === 0) {
      // Seed config ships both arrays empty until Gadi creates Lists on the
      // throwaway account (TODO T3); nothing to do yet.
      return [];
    }

    // Loaded lazily and only once a key is actually present: a broken or
    // unloadable scraping dependency must never break module load for the whole
    // ingest run (ADR 0002 -- Twitter is explicitly not load-bearing).
    let Rettiwt: typeof import('rettiwt-api').Rettiwt;
    try {
      ({ Rettiwt } = await import('rettiwt-api'));
    } catch (err) {
      console.warn(`[twitter] failed to load rettiwt-api: ${(err as Error).message}`);
      return [];
    }

    const budget = acquireSession(Date.now());
    if (typeof budget === 'string') {
      console.info(`[twitter] paced, skipping: ${budget}`);
      return [];
    }

    try {
      // Sequential, not concurrent: request volume is the thing that gets the
      // throwaway account locked, so this deliberately avoids bursting Twitter.
      const rettiwt = new Rettiwt({ apiKey });
      // Followed accounts first: they are the highest-value calls if the budget runs out.
      const userItems = await fetchUsers(rettiwt, users, ctx, budget);
      const listItems = await fetchLists(rettiwt, lists, ctx, budget);
      const queryItems = await fetchQueries(rettiwt, queries, ctx, budget);
      return [...userItems, ...listItems, ...queryItems];
    } catch (err) {
      // Auth failure / lockout / anything unexpected: one log line, empty
      // result, no retry within this run (ADR 0002).
      console.warn(`[twitter] run failed: ${(err as Error).message}`);
      return [];
    }
  },
};

export default twitter;

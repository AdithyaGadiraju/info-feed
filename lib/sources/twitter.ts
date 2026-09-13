/**
 * Twitter source (ADR 0002, TODO T3). Deliberately not load-bearing: v1 ships with
 * `RETTIWT_API_KEY` unset, and the rest of the feed must work without this file
 * doing anything at all.
 *
 * The ADR's implementation surface says "rettiwt-api v7", but the version actually
 * installed (see package.json) is v4.2.0. Its API differs from what v7 would offer:
 * there is no dedicated "list timeline" call on `ListService` -- the list timeline
 * lives on `TweetService.list(listId, count, cursor)` instead, and search takes a
 * `TweetFilter` object (with `minLikes`) rather than a raw query string. This file
 * is written against the v4.2.0 surface actually present in node_modules.
 */
import type { RawItem, Source, SourceCtx, TwitterListSpec, TwitterQuerySpec } from './types';
import { env } from '../env';

/** ADR 0002: request volume is what gets the throwaway account locked. */
const MAX_REQUESTS_PER_RUN = 10;

/** Twitter list/search timelines return newest-first at up to 100/20 per call; one page is plenty for a digest run. */
const LIST_COUNT = 20;
const SEARCH_COUNT = 20;

// Structural subset of what we need from a `rettiwt-api` `Tweet`. Declared locally
// instead of importing the class so the dynamic-import boundary below stays the
// only place that touches the library's types.
interface RettiwtTweetLike {
  id: string;
  fullText: string;
  createdAt: string;
  likeCount: number;
  replyCount: number;
  tweetBy: { userName: string };
}

/** Tweets have no titles; the first line (or first ~120 chars) stands in for one. */
function deriveTitle(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  const source = firstLine || text.trim();
  return source.length > 120 ? `${source.slice(0, 120)}…` : source;
}

function toRawItem(tweet: RettiwtTweetLike, lane: TwitterListSpec['lane']): RawItem {
  const text = tweet.fullText ?? '';
  return {
    source: 'twitter',
    externalId: tweet.id,
    laneHint: lane,
    url: `https://x.com/${tweet.tweetBy.userName}/status/${tweet.id}`,
    title: deriveTitle(text),
    body: text,
    author: tweet.tweetBy.userName,
    engagement: { likes: tweet.likeCount, comments: tweet.replyCount },
    publishedAt: new Date(tweet.createdAt),
  };
}

async function fetchLists(
  rettiwt: InstanceType<typeof import('rettiwt-api').Rettiwt>,
  lists: TwitterListSpec[],
  ctx: SourceCtx,
  budget: { remaining: number },
): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for (const spec of lists) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    try {
      const page = await rettiwt.tweet.list(spec.listId, LIST_COUNT);
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
  budget: { remaining: number },
): Promise<RawItem[]> {
  const items: RawItem[] = [];
  for (const spec of queries) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    try {
      const filter = new (await import('rettiwt-core')).TweetFilter({
        includePhrase: spec.query,
        minLikes: spec.minFaves,
      });
      const page = await rettiwt.tweet.search(filter, SEARCH_COUNT);
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

    if (lists.length === 0 && queries.length === 0) {
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

    const budget = { remaining: MAX_REQUESTS_PER_RUN };

    try {
      // Sequential, not concurrent: request volume is the thing that gets the
      // throwaway account locked, so this deliberately avoids bursting Twitter.
      const rettiwt = new Rettiwt({ apiKey });
      const listItems = await fetchLists(rettiwt, lists, ctx, budget);
      const queryItems = await fetchQueries(rettiwt, queries, ctx, budget);
      return [...listItems, ...queryItems];
    } catch (err) {
      // Auth failure / lockout / anything unexpected: one log line, empty
      // result, no retry within this run (ADR 0002).
      console.warn(`[twitter] run failed: ${(err as Error).message}`);
      return [];
    }
  },
};

export default twitter;

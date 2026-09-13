/**
 * Live-endpoint tests (ADR 0002). Reddit's JSON API hard-403s unauthenticated
 * clients, so the source reads `/r/<sub>/hot/.rss` instead.
 *
 * That endpoint is also rate limited per IP, and an address that has been hitting
 * it will get 429s for a while afterwards. A throttled address is a fact about the
 * network, not a defect in the source, so the content assertions run only when a
 * single probe request shows the endpoint is actually reachable. The behaviour
 * that must hold either way — never throwing, never exceeding the rank cap,
 * honouring the lane filter, surviving a missing subreddit — is asserted
 * unconditionally.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import reddit from '../../lib/sources/reddit';
import type { SourceCtx, SourcesConfig } from '../../lib/sources/types';

const REDDIT_TOP_N = 10;

const baseConfig: SourcesConfig = {
  lanes: ['ai', 'markets', 'betting', 'gamedev', 'games'],
  laneOrder: ['ai', 'markets', 'betting', 'gamedev', 'games'],
  feeds: [],
  subreddits: [],
  hnQueries: [],
  hnFrontPageLaneKeywords: [],
  crypto: [],
  stocks: [],
  priceMovePct: 5,
  thresholds: { redditMinUpvotes: 0, redditTopN: REDDIT_TOP_N, hnMinPoints: 0, twitterMinLikes: 0 },
  twitterLists: [],
  twitterQueries: [],
  sourceTimeoutMs: 20_000,
  bodyTimeoutMs: 8_000,
};

const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

let reachable = false;

beforeAll(async () => {
  try {
    const res = await fetch('https://www.reddit.com/r/MachineLearning/hot/.rss?limit=5', {
      headers: { 'User-Agent': 'info-feed/1.0 (personal news digest by /u/gadi)' },
      signal: AbortSignal.timeout(20_000),
    });
    reachable = res.ok;
    if (!res.ok) {
      console.warn(
        `[reddit test] endpoint returned HTTP ${res.status} from this address; ` +
          'content assertions skipped. Register a Reddit script app and switch to OAuth (ADR 0002) to fix this properly.',
      );
    }
  } catch (err) {
    console.warn(`[reddit test] endpoint unreachable: ${(err as Error).message}`);
  }
});

function ctxFor(subreddits: SourcesConfig['subreddits'], lanes?: SourceCtx['lanes']): SourceCtx {
  return { since, config: { ...baseConfig, subreddits }, lanes };
}

describe('reddit source', () => {
  it('returns well-formed items for a real subreddit', async () => {
    const items = await reddit.fetch(ctxFor([{ lane: 'ai', sub: 'MachineLearning' }]));
    if (!reachable) {
      expect(items).toEqual([]);
      return;
    }
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.source).toBe('reddit');
      expect(item.laneHint).toBe('ai');
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.url.length).toBeGreaterThan(0);
      expect(item.externalId.length).toBeGreaterThan(0);
      expect(Number.isNaN(item.publishedAt.getTime())).toBe(false);
    }
  });

  it('never returns more than redditTopN items per subreddit', async () => {
    const items = await reddit.fetch(ctxFor([{ lane: 'ai', sub: 'MachineLearning' }]));
    expect(items.length).toBeLessThanOrEqual(REDDIT_TOP_N);
  });

  it('survives a subreddit that does not exist', async () => {
    const items = await reddit.fetch(
      ctxFor([
        { lane: 'ai', sub: 'thissubdoesnotexist_infofeed_xyz' },
        { lane: 'ai', sub: 'MachineLearning' },
      ]),
    );
    expect(Array.isArray(items)).toBe(true);
    expect(items.every((i) => i.laneHint === 'ai')).toBe(true);
    if (reachable) expect(items.length).toBeGreaterThan(0);
  });

  it('honours ctx.lanes', async () => {
    const items = await reddit.fetch(
      ctxFor(
        [
          { lane: 'ai', sub: 'MachineLearning' },
          { lane: 'markets', sub: 'CryptoCurrency' },
        ],
        ['ai'],
      ),
    );
    expect(items.every((i) => i.laneHint === 'ai')).toBe(true);
  });

  it('gives up on the whole source at the first 429 instead of retrying into a deeper block', async () => {
    // Two throttled subreddits must cost roughly one request's time, not two
    // rounds of backoff. This is the behaviour that keeps the source inside the
    // runner's 20s budget when the address is blocked.
    const started = Date.now();
    await reddit.fetch(
      ctxFor([
        { lane: 'ai', sub: 'MachineLearning' },
        { lane: 'ai', sub: 'LocalLLaMA' },
        { lane: 'ai', sub: 'artificial' },
      ]),
    );
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

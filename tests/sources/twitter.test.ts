/**
 * Twitter is deliberately not wired for v1 (ADR 0002, TODO T3): the meaningful
 * assertion here is the no-key path, since that's what every real ingest run on
 * this machine exercises today. The live test is a placeholder for when a
 * throwaway account's key lands in `.env`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import twitter from '../../lib/sources/twitter';
import type { Source, SourceCtx, SourcesConfig } from '../../lib/sources/types';

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
  thresholds: { redditTopN: 50, redditMinUpvotes: 0, hnMinPoints: 0, twitterMinLikes: 0 },
  twitterLists: [{ lane: 'ai', listId: '123' }],
  twitterQueries: [{ lane: 'ai', query: 'agi', minFaves: 50 }],
  sourceTimeoutMs: 20_000,
  bodyTimeoutMs: 8_000,
};

const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

const originalKey = process.env.RETTIWT_API_KEY;

describe('twitter source', () => {
  beforeEach(() => {
    delete process.env.RETTIWT_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.RETTIWT_API_KEY;
    else process.env.RETTIWT_API_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('resolves to [] and makes no network request when RETTIWT_API_KEY is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const ctx: SourceCtx = { since, config: baseConfig };

    const items = await twitter.fetch(ctx);

    expect(items).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not throw when there are Lists/queries configured but still no key', async () => {
    const ctx: SourceCtx = { since, config: baseConfig, lanes: ['ai'] };
    await expect(twitter.fetch(ctx)).resolves.toEqual([]);
  });

  it('satisfies the Source interface', () => {
    const source: Source = twitter;
    expect(source.name).toBe('twitter');
    expect(typeof source.fetch).toBe('function');
  });

  // Live test, skipped on this machine by design (ADR 0002 / TODO T3): v1 ships
  // without a throwaway-account key, so RETTIWT_API_KEY is unset in this env.
  const hasLiveKey = !!process.env.RETTIWT_API_KEY;
  it.skipIf(!hasLiveKey)('fetches real tweets when a live key is configured', async () => {
    if (!hasLiveKey) {
      console.warn('[twitter.test] SKIP: RETTIWT_API_KEY not set, no throwaway account wired yet.');
      return;
    }
    const ctx: SourceCtx = { since, config: baseConfig };
    const items = await twitter.fetch(ctx);
    expect(Array.isArray(items)).toBe(true);
  });
});

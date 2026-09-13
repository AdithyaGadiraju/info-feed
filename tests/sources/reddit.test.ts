/**
 * Reddit source tests (ADR 0002).
 *
 * Reddit's JSON API hard-403s unauthenticated clients, so the source reads
 * `/r/<sub>/hot/.rss`. That endpoint is rate limited to roughly one request per
 * 15 s per address, and an address that has been hitting it stays throttled for
 * minutes afterwards. That makes "assert the live endpoint returned content" a
 * coin flip, and a warm-up probe is worse than useless because the probe itself
 * spends the one request the real call needed.
 *
 * So the split is: the PARSING rules are pinned deterministically against a
 * fixture through the pure `mapEntries`, and the LIVE tests assert only what must
 * hold whether or not the address is throttled -- never throwing, never exceeding
 * the rank cap, honouring the lane filter, and failing fast instead of retrying
 * into a deeper block. When the live call does return items, they are checked in
 * full.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import reddit, { mapEntries, type RedditEntry } from '../../lib/sources/reddit';
import type { RawItem, SourceCtx, SourcesConfig } from '../../lib/sources/types';

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

function ctxFor(subreddits: SourcesConfig['subreddits'], lanes?: SourceCtx['lanes']): SourceCtx {
  return { since, config: { ...baseConfig, subreddits }, lanes };
}

let mlItems: RawItem[] = [];
let reachable = false;

beforeAll(async () => {
  mlItems = await reddit.fetch(ctxFor([{ lane: 'ai', sub: 'MachineLearning' }]));
  reachable = mlItems.length > 0;
  if (!reachable) {
    console.warn(
      '[reddit test] r/MachineLearning came back empty, most likely this address is rate-limited ' +
        'right now (ADR 0002). Content assertions are skipped; behavioural assertions still run.',
    );
  }
});

describe('reddit source', () => {
  it('returns well-formed items for a real subreddit', () => {
    if (!reachable) return;
    for (const item of mlItems) {
      expect(item.source).toBe('reddit');
      expect(item.laneHint).toBe('ai');
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.url.length).toBeGreaterThan(0);
      expect(item.externalId.length).toBeGreaterThan(0);
      expect(Number.isNaN(item.publishedAt.getTime())).toBe(false);
    }
  });

  it('never returns more than redditTopN items per subreddit', () => {
    expect(mlItems.length).toBeLessThanOrEqual(REDDIT_TOP_N);
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

const ATOM_ENTRIES: RedditEntry[] = [
  {
    id: 't3_selftext',
    link: 'https://www.reddit.com/r/MachineLearning/comments/abc/a_self_post/',
    title: '[D] A self post',
    author: '/u/someone',
    content: '<!-- SC_OFF --><div class="md"><p>Body text here.</p></div><!-- SC_ON --> submitted by <a href="https://www.reddit.com/user/someone">/u/someone</a> <a href="https://www.reddit.com/r/MachineLearning/comments/abc/a_self_post/">[link]</a> <a href="https://www.reddit.com/r/MachineLearning/comments/abc/a_self_post/">[comments]</a>',
    isoDate: '2026-09-13T00:00:00.000Z',
  },
  {
    id: 't3_linkpost',
    link: 'https://www.reddit.com/r/MachineLearning/comments/def/a_link_post/',
    title: '[N] A link post',
    author: '/u/other',
    content: '<table><tr><td><a href="https://example.com/article">thumbnail</a></td></tr></table> submitted by <a href="https://www.reddit.com/user/other">/u/other</a> <a href="https://example.com/article">[link]</a> <a href="https://www.reddit.com/r/MachineLearning/comments/def/a_link_post/">[comments]</a>',
    isoDate: '2026-09-13T01:00:00.000Z',
  },
  { id: 't3_nodate', link: 'https://www.reddit.com/r/x/comments/ghi/', title: 'No date' },
  { id: 't3_nolink', title: 'No link', isoDate: '2026-09-13T02:00:00.000Z' },
];

describe('reddit entry mapping (fixture, no network)', () => {
  const spec = { lane: 'ai' as const, sub: 'MachineLearning' };
  const ctx = ctxFor([spec]);

  it('maps a self post, keeping the discussion permalink and the body text', () => {
    const [item] = mapEntries([ATOM_ENTRIES[0]], spec, ctx);
    expect(item.source).toBe('reddit');
    expect(item.externalId).toBe('t3_selftext');
    expect(item.laneHint).toBe('ai');
    expect(item.url).toContain('/r/MachineLearning/comments/abc/');
    expect(item.title).toBe('[D] A self post');
    expect(item.author).toBe('/u/someone');
    expect(item.body).toContain('Body text here.');
    // The HTML must be gone, not merely escaped.
    expect(item.body).not.toContain('<div');
    expect(item.publishedAt.toISOString()).toBe('2026-09-13T00:00:00.000Z');
  });

  it('surfaces the outbound article URL for a link post', () => {
    const [item] = mapEntries([ATOM_ENTRIES[1]], spec, ctx);
    expect(item.body).toContain('https://example.com/article');
  });

  it('never invents engagement numbers, because a fake count would corrupt the pre-filter', () => {
    const items = mapEntries(ATOM_ENTRIES.slice(0, 2), spec, ctx);
    expect(items.every((i) => Object.keys(i.engagement ?? {}).length === 0)).toBe(true);
  });

  it('drops entries with no date or no link rather than guessing', () => {
    const items = mapEntries(ATOM_ENTRIES, spec, ctx);
    expect(items.map((i) => i.externalId)).toEqual(['t3_selftext', 't3_linkpost']);
  });

  it('drops entries published before ctx.since', () => {
    const recent = { ...ctxFor([spec]), since: new Date('2026-09-13T00:30:00.000Z') };
    const items = mapEntries(ATOM_ENTRIES, spec, recent);
    expect(items.map((i) => i.externalId)).toEqual(['t3_linkpost']);
  });

  it('applies redditTopN as the rank cutoff that replaces the upvote threshold', () => {
    const many: RedditEntry[] = Array.from({ length: 25 }, (_, i) => ({
      id: `t3_${i}`,
      link: `https://www.reddit.com/r/MachineLearning/comments/${i}/`,
      title: `Post ${i}`,
      isoDate: '2026-09-13T00:00:00.000Z',
    }));
    expect(mapEntries(many, spec, ctx)).toHaveLength(REDDIT_TOP_N);
  });
});

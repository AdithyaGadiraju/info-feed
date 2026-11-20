/**
 * Reddit source tests (ADR 0002).
 *
 * Reddit's JSON API hard-403s unauthenticated clients, so the source reads
 * `/r/<sub>/hot/.rss`, which allows about one request per minute per address.
 * No test touches the real endpoint: each live request would spend the budget a
 * real digest run needs. Parsing is pinned through the pure `mapEntries`, and the
 * fetch/pacing/429 behaviour through a stubbed global fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import reddit, { blockMsAfter429, groupBySubreddit, resetRedditState, mapEntries, nextRequestDelayMs, type RedditEntry } from '../../lib/sources/reddit';
import type { SourceCtx, SourcesConfig } from '../../lib/sources/types';

const REDDIT_TOP_N = 10;

const baseConfig: SourcesConfig = {
  lanes: ['ai', 'markets', 'betting', 'gamedev', 'games'],
  laneOrder: ['ai', 'markets', 'betting', 'gamedev', 'games'],
  feeds: [],
  docs: [],
  subreddits: [],
  hnQueries: [],
  hnFrontPageLaneKeywords: [],
  crypto: [],
  stocks: [],
  priceMovePct: 5,
  thresholds: { redditMinUpvotes: 0, redditTopN: REDDIT_TOP_N, hnMinPoints: 0, twitterMinLikes: 0 },
  huggingface: { models: [], papers: [] },
  github: [],
  devpost: [],
  twitterLists: [],
  twitterQueries: [],
  twitterUsers: [],
  sourceTimeoutMs: 20_000,
  bodyTimeoutMs: 8_000,
};

const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

function ctxFor(subreddits: SourcesConfig['subreddits'], lanes?: SourceCtx['lanes']): SourceCtx {
  return { since, config: { ...baseConfig, subreddits }, lanes };
}

const FEED = (subs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${subs
    .map(
      (sub, i) =>
        `<entry><id>t3_${sub}${i}</id><title>${sub} post ${i}</title><author><name>/u/a</name></author>` +
        `<link href="https://www.reddit.com/r/${sub}/comments/${i}/x/"/><updated>${new Date().toISOString()}</updated>` +
        `<content type="html">body</content></entry>`,
    )
    .join('')}</feed>`;

type Reply = { status: number; headers?: Record<string, string>; subs?: string[] };

/** Stubs global fetch with queued replies and records each request URL and the sleeps before it. */
function stubReddit(replies: Reply[]) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  resetRedditState({ sleep: async (ms) => void sleeps.push(ms) });
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const r = replies.shift() ?? { status: 200 };
    return new Response(r.status === 200 ? FEED(r.subs ?? []) : 'Too Many Requests', {
      status: r.status,
      headers: { 'x-ratelimit-remaining': '0.0', 'x-ratelimit-reset': '40', ...r.headers },
    });
  });
  return { calls, sleeps };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetRedditState();
});

describe('reddit source (stubbed network)', () => {
  it('fetches one combined listing per lane and splits it back by subreddit', async () => {
    const { calls } = stubReddit([{ status: 200, subs: ['MachineLearning', 'LocalLLaMA', 'MachineLearning'] }]);
    const items = await reddit.fetch(
      ctxFor([
        { lane: 'ai', sub: 'MachineLearning' },
        { lane: 'ai', sub: 'LocalLLaMA' },
      ]),
    );
    expect(calls).toEqual(['https://www.reddit.com/r/MachineLearning+LocalLLaMA/hot/.rss?limit=100']);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.source === 'reddit' && i.laneHint === 'ai')).toBe(true);
  });

  it('honours ctx.lanes', async () => {
    const { calls } = stubReddit([{ status: 200, subs: ['MachineLearning'] }]);
    await reddit.fetch(
      ctxFor(
        [
          { lane: 'ai', sub: 'MachineLearning' },
          { lane: 'markets', sub: 'CryptoCurrency' },
        ],
        ['ai'],
      ),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/r/MachineLearning/');
  });

  it('paces requests across separate fetch() calls, as the per-lane digest makes them', async () => {
    const { calls, sleeps } = stubReddit([{ status: 200 }, { status: 200 }]);
    await reddit.fetch(ctxFor([{ lane: 'ai', sub: 'MachineLearning' }]));
    await reddit.fetch(ctxFor([{ lane: 'markets', sub: 'stocks' }]));
    expect(calls).toHaveLength(2);
    // The second call waits out the window the first response announced (reset 40 s).
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(40_000);
    expect(sleeps[0]).toBeLessThanOrEqual(41_000);
  });

  it('after a 429, skips every later lane, including those of later fetch() calls', async () => {
    const { calls } = stubReddit([{ status: 429 }]);
    // Nothing worked, so the source fails: the runner records it under failedSources.
    await expect(
      reddit.fetch(
        ctxFor([
          { lane: 'ai', sub: 'MachineLearning' },
          { lane: 'gamedev', sub: 'godot' },
        ]),
      ),
    ).rejects.toThrow(/ai: HTTP 429; gamedev skipped, rate limited/);
    await expect(reddit.fetch(ctxFor([{ lane: 'games', sub: 'Games' }]))).rejects.toThrow(/games skipped/);
    expect(calls).toHaveLength(1);
  });

  it('after a 404, benches Reddit like a 429 instead of pacing every lane into the same answer', async () => {
    const { calls, sleeps } = stubReddit([{ status: 404 }]);
    await expect(reddit.fetch(ctxFor([{ lane: 'ai', sub: 'MachineLearning' }]))).rejects.toThrow(/ai: HTTP 404/);
    await expect(reddit.fetch(ctxFor([{ lane: 'games', sub: 'Games' }]))).rejects.toThrow(/HTTP 404 \(needs OAuth/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('degrades a 403 to an empty lane and carries on with the next', async () => {
    const { calls } = stubReddit([{ status: 403 }, { status: 200, subs: ['godot'] }]);
    const items = await reddit.fetch(
      ctxFor([
        { lane: 'ai', sub: 'MachineLearning' },
        { lane: 'gamedev', sub: 'godot' },
      ]),
    );
    expect(calls).toHaveLength(2);
    expect(items.map((i) => i.laneHint)).toEqual(['gamedev']);
  });

  it('blocks for Retry-After when Reddit asks for longer than the default', () => {
    expect(blockMsAfter429(null, null)).toBe(15 * 60_000);
    expect(blockMsAfter429('3600', null)).toBe(3_600_000);
    expect(blockMsAfter429('junk', '30')).toBe(15 * 60_000);
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
  // Pinned before the fixture dates: a rolling "30 days ago" aged them out on 2026-10-13.
  const ctx = { ...ctxFor([spec]), since: new Date('2026-09-01T00:00:00.000Z') };

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

  it('links a link post at the article, keeping the thread in the body', () => {
    const [item] = mapEntries([ATOM_ENTRIES[1]], spec, ctx);
    // `url` is what the feed and the digest link to, so it has to be the article.
    expect(item.url).toBe('https://example.com/article');
    expect(item.body).toContain('/r/MachineLearning/comments/def/a_link_post/');
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

  it("waits out Reddit's rate-limit window once the budget is spent", () => {
    expect(nextRequestDelayMs('0.0', '8')).toBe(30_000);
    expect(nextRequestDelayMs('0.0', '44')).toBe(45_000);
    expect(nextRequestDelayMs('0.0', '600')).toBe(60_000);
    expect(nextRequestDelayMs('3.0', '8')).toBe(30_000);
    expect(nextRequestDelayMs(null, null)).toBe(30_000);
  });

  it('splits a combined listing by the subreddit in each permalink, keeping hot order', () => {
    const groups = groupBySubreddit([
      { id: 'a', link: 'https://www.reddit.com/r/ClaudeCode/comments/a/x/' },
      { id: 'b', link: 'https://www.reddit.com/r/codex/comments/b/y/' },
      { id: 'c', link: 'https://www.reddit.com/r/ClaudeCode/comments/c/z/' },
      { id: 'd' },
    ]);
    expect([...groups.keys()]).toEqual(['claudecode', 'codex']);
    expect(groups.get('claudecode')?.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('applies a title gate before the rank cutoff', () => {
    const many: RedditEntry[] = Array.from({ length: 25 }, (_, i) => ({
      id: `t3_${i}`,
      link: `https://www.reddit.com/r/ClaudeAI/comments/${i}/`,
      title: i % 2 === 0 ? `My skill number ${i}` : `Meme ${i}`,
      isoDate: '2026-09-13T00:00:00.000Z',
    }));
    const items = mapEntries(many, { ...spec, include: /skill/i }, ctx);
    expect(items).toHaveLength(REDDIT_TOP_N);
    expect(items.every((i) => i.title.includes('skill'))).toBe(true);
  });
});

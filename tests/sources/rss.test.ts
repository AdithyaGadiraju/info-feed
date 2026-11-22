import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetRssState, retryAfterMs, rss } from '../../lib/sources/rss';
import { sourcesConfig } from '../../config/sources';
import type { SourcesConfig } from '../../lib/sources/types';

// Live-endpoint smoke tests per ADR 0002: no mocking the real feeds. Some seed
// URLs will rot over time; that is expected and is exactly what test 2 guards.
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe('rss source', () => {
  it('fetches items across the configured feed list', async () => {
    const since = new Date(Date.now() - SEVEN_DAYS_MS);
    const items = await rss.fetch({ since, config: sourcesConfig });

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.source).toBe('rss');
      expect(item.externalId).toBeTruthy();
      expect(item.laneHint).toBeTruthy();
      expect(item.url).toBeTruthy();
      expect(item.title).toBeTruthy();
      expect(item.publishedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(item.publishedAt.getTime())).toBe(false);
    }

    const lanes = new Set(items.map((i) => i.laneHint));
    expect(lanes.size).toBeGreaterThan(1);
  });

  it('survives a dead feed alongside a live one', async () => {
    const since = new Date(Date.now() - SEVEN_DAYS_MS);
    const config: SourcesConfig = {
      ...sourcesConfig,
      feeds: [
        { lane: 'ai', name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
        { lane: 'ai', name: 'Dead Host', url: 'https://this-host-does-not-exist.invalid/feed' },
      ],
    };

    const items = await rss.fetch({ since, config });

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.laneHint === 'ai')).toBe(true);
  });

  it('honours ctx.lanes to restrict fetched feeds', async () => {
    const since = new Date(Date.now() - SEVEN_DAYS_MS);
    const items = await rss.fetch({ since, config: sourcesConfig, lanes: ['ai'] });

    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.laneHint === 'ai')).toBe(true);
  });
});

// Pacing, 429 and not-a-feed behaviour through a stubbed global fetch, as in
// reddit.test.ts: a live host cannot be made to rate limit on demand.
const ITEM_FEED = (title: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>` +
  `<item><title>${title}</title><link>https://example.com/${encodeURIComponent(title)}</link>` +
  `<pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;

type Reply = { status?: number; headers?: Record<string, string>; body?: string };

/** Stubs global fetch with per-URL queued replies; records request order, sleeps and overlap per host. */
function stubFeeds(replies: Record<string, Reply[]>) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const inFlight = new Map<string, number>();
  let maxPerHost = 0;
  resetRssState({ sleep: async (ms) => void sleeps.push(ms) });
  vi.stubGlobal('fetch', async (url: string) => {
    const host = new URL(url).host;
    calls.push(url);
    inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
    maxPerHost = Math.max(maxPerHost, inFlight.get(host)!);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight.set(host, inFlight.get(host)! - 1);
    const r = replies[url]?.shift() ?? {};
    return new Response(r.body ?? ITEM_FEED(url), { status: r.status ?? 200, headers: r.headers });
  });
  return { calls, sleeps, maxPerHost: () => maxPerHost };
}

function ctxForFeeds(urls: string[]) {
  const config: SourcesConfig = {
    ...sourcesConfig,
    feeds: urls.map((url, i) => ({ lane: 'ai' as const, name: `feed ${i}`, url })),
  };
  return { since: new Date(Date.now() - SEVEN_DAYS_MS), config };
}

describe('rss source (stubbed network)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetRssState();
  });

  it('sends the feeds of one host one at a time, spaced, while other hosts go alongside', async () => {
    const urls = ['https://itch.example/a.xml', 'https://itch.example/b.xml', 'https://itch.example/c.xml', 'https://other.example/feed'];
    const { calls, sleeps, maxPerHost } = stubFeeds({});
    const items = await rss.fetch(ctxForFeeds(urls));

    expect(items).toHaveLength(4);
    expect(maxPerHost()).toBe(1);
    expect(calls.filter((u) => u.includes('itch.example'))).toEqual(urls.slice(0, 3));
    // Two waits, before the second and third itch.example feeds; none for the other host.
    expect(sleeps).toHaveLength(2);
    for (const ms of sleeps) {
      expect(ms).toBeGreaterThan(400);
      expect(ms).toBeLessThanOrEqual(500);
    }
  });

  it('retries a 429 once after a short Retry-After', async () => {
    const url = 'https://itch.example/a.xml';
    const { calls, sleeps } = stubFeeds({ [url]: [{ status: 429, headers: { 'retry-after': '2' } }] });
    const items = await rss.fetch(ctxForFeeds([url]));

    expect(calls).toEqual([url, url]);
    expect(items).toHaveLength(1);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(1900);
    expect(sleeps[0]).toBeLessThanOrEqual(2000);
  });

  it('after a 429 with no Retry-After, leaves the host alone and keeps the other hosts', async () => {
    const urls = ['https://itch.example/a.xml', 'https://itch.example/b.xml', 'https://other.example/feed'];
    const { calls } = stubFeeds({ [urls[0]]: [{ status: 429 }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await rss.fetch(ctxForFeeds(urls));

    // No retry and no second knock on the host that said stop.
    expect(calls.filter((u) => u.includes('itch.example'))).toEqual([urls[0]]);
    expect(items.map((i) => i.title)).toEqual([urls[2]]);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringMatching(/a\.xml\) failed: HTTP 429$/),
      expect.stringMatching(/b\.xml\) failed: skipped, itch\.example is rate limiting this address$/),
    ]);
  });

  it('reports a web page served in place of a feed as that, not as an XML error', async () => {
    const url = 'https://private.example/rss/';
    stubFeeds({ [url]: [{ body: '<!DOCTYPE html>\n<html><head><title>Private</title></head><body></p></body></html>' }] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await rss.fetch(ctxForFeeds([url]));

    expect(items).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/failed: not a feed: got an HTML page$/);
  });

  it('reads Retry-After as seconds or as a date', () => {
    const now = Date.parse('2026-11-21T00:00:00Z');
    expect(retryAfterMs('3', now)).toBe(3000);
    expect(retryAfterMs('Sat, 21 Nov 2026 00:00:07 GMT', now)).toBe(7000);
    expect(retryAfterMs('junk', now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
  });
});

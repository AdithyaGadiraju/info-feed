/**
 * GitHub source tests (ADR 0002). The threshold rules are pinned against a fixture
 * through the pure `mapRepos`, the pacing and rate-limit behaviour against a mocked
 * `fetch` with fake timers (ten real searches take a minute), and one live search
 * checks the real API still answers in the shape the mapper expects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import github, { mapRepos, requestSpacingMs, searchUrl, type GithubRepo } from '../../lib/sources/github';
import type { GithubSearchSpec, SourceCtx } from '../../lib/sources/types';
import { sourcesConfig } from '../../config/sources';

const blenderMcp: GithubSearchSpec = { lane: 'ai_dev', name: 'Blender MCP', query: 'blender mcp', minStars: 20 };

function repo(fullName: string, stars: number, over: Partial<GithubRepo> = {}): GithubRepo {
  return {
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: `${fullName} does things`,
    stargazers_count: stars,
    created_at: '2026-10-01T10:00:00Z',
    owner: { login: fullName.split('/')[0] },
    ...over,
  };
}

function ctxWith(specs: GithubSearchSpec[], lanes?: SourceCtx['lanes']): SourceCtx {
  return { since: new Date(Date.now() - 6 * 3600_000), config: { ...sourcesConfig, github: specs }, lanes };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('searchUrl', () => {
  it('searches repositories created since the window start, most stars first', () => {
    const url = new URL(searchUrl(blenderMcp, new Date('2026-09-14T12:00:00Z')));
    expect(url.origin + url.pathname).toBe('https://api.github.com/search/repositories');
    expect(url.searchParams.get('q')).toBe('blender mcp created:>=2026-09-14');
    expect(url.searchParams.get('sort')).toBe('stars');
    expect(url.searchParams.get('order')).toBe('desc');
  });
});

describe('requestSpacingMs', () => {
  it('stays under 10 searches a minute without a token and 30 with one', () => {
    expect(requestSpacingMs(false) * 10).toBeGreaterThanOrEqual(60_000);
    expect(requestSpacingMs(true) * 30).toBeGreaterThanOrEqual(60_000);
  });
});

describe('mapRepos', () => {
  it('keeps repos at or above minStars and skips forks', () => {
    const items = mapRepos(
      [repo('S4US/Roqer', 138), repo('acme/exactly', 20), repo('acme/quiet', 19), repo('acme/fork', 500, { fork: true })],
      blenderMcp,
    );
    expect(items.map((i) => i.externalId)).toEqual(['S4US/Roqer', 'acme/exactly']);
  });

  it('fills every RawItem field, with the description in the title and stars as likes', () => {
    const [item] = mapRepos([repo('S4US/Roqer', 138, { description: 'An open-source  AI agent\nfor Roblox Studio.' })], blenderMcp);
    expect(item).toEqual({
      source: 'github',
      externalId: 'S4US/Roqer',
      laneHint: 'ai_dev',
      url: 'https://github.com/S4US/Roqer',
      title: 'S4US/Roqer: An open-source AI agent for Roblox Studio.',
      author: 'S4US',
      engagement: { likes: 138 },
      publishedAt: new Date('2026-10-01T10:00:00Z'),
    });
  });

  it('titles a repo with no description by its name alone', () => {
    const [item] = mapRepos([repo('acme/bare', 50, { description: null })], blenderMcp);
    expect(item.title).toBe('acme/bare');
  });
});

describe('github source (mocked fetch)', () => {
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Runs a fetch to completion, letting the spacing sleeps elapse instantly. */
  async function run(ctx: SourceCtx) {
    const pending = github.fetch(ctx);
    await vi.runAllTimersAsync();
    return pending;
  }

  it('runs every search unauthenticated and dedupes a repo two searches share', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => json({ items: [repo('S4US/Roqer', 138)] }));

    const items = await run(ctxWith([blenderMcp, { ...blenderMcp, name: 'Roblox', query: 'roblox ai' }]));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['User-Agent']).toBeTruthy();
    expect(items.map((i) => i.externalId)).toEqual(['S4US/Roqer']);
  });

  it('waits out the spacing before the next search', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ items: [] }));

    const pending = github.fetch(ctxWith([blenderMcp, { ...blenderMcp, name: 'second', query: 'second' }]));
    await vi.advanceTimersByTimeAsync(requestSpacingMs(false) - 1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await pending;
  });

  it('sends GITHUB_TOKEN as a bearer token when it is set', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ items: [] }));

    await run(ctxWith([blenderMcp]));

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
  });

  it('stops at the first rate-limit response and keeps what it already has', async () => {
    let calls = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? json({ items: [repo('S4US/Roqer', 138)] }) : json({ message: 'rate limit' }, 403);
    });

    const specs = ['a', 'b', 'c', 'd'].map((q) => ({ ...blenderMcp, name: q, query: q }));
    const items = await run(ctxWith(specs));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(items.map((i) => i.externalId)).toEqual(['S4US/Roqer']);
  });

  it('carries on past a search that fails for any other reason', async () => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? json({ message: 'Validation Failed' }, 422) : json({ items: [repo('acme/ok', 30)] });
    });

    const items = await run(ctxWith([blenderMcp, { ...blenderMcp, name: 'second', query: 'second' }]));
    expect(items.map((i) => i.externalId)).toEqual(['acme/ok']);
  });

  it('never runs more than ten searches in one run', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ items: [] }));
    const specs = Array.from({ length: 12 }, (_, i) => ({ ...blenderMcp, name: `q${i}`, query: `q${i}` }));

    await run(ctxWith(specs));
    expect(fetchSpy).toHaveBeenCalledTimes(10);
  });

  it('makes no request for a lane that was not asked for', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const items = await run(ctxWith([blenderMcp], ['markets']));
    expect(items).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Live, like the other source tests: one search, well inside the unauthenticated
// budget. minStars 0, so a quiet month cannot fail it.
describe('github source (live)', () => {
  it('returns new repositories with required fields', async () => {
    const items = await github.fetch(ctxWith([{ ...blenderMcp, minStars: 0 }]));

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.source).toBe('github');
      expect(item.externalId).toMatch(/^[^/]+\/[^/]+$/);
      expect(item.url).toBe(`https://github.com/${item.externalId}`);
      expect(typeof item.engagement?.likes).toBe('number');
      expect(Number.isNaN(item.publishedAt.getTime())).toBe(false);
    }
  }, 30_000);
});

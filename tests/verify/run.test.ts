/**
 * `lib/env.ts` and the query layer are mocked and the model call is injected, so
 * nothing here spawns the CLI, searches the web or touches the database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoryWithLink, Verification } from '../../lib/db/types';

const mockEnv = vi.hoisted(() => ({ verifyStories: true }));

vi.mock('../../lib/env.js', () => ({
  env: {
    get verifyStories() {
      return mockEnv.verifyStories;
    },
  },
}));

const mockQueries = vi.hoisted(() => ({
  getStorySources: vi.fn(),
  setVerification: vi.fn(),
  startRun: vi.fn(),
  finishRun: vi.fn(),
}));

vi.mock('../../lib/db/queries.js', () => mockQueries);

const { needsCheck, verifyStories } = await import('../../lib/verify/run');

const UPDATED = new Date('2026-10-06T12:00:00Z');
const NOW = new Date('2026-10-07T00:00:00Z');

function story(overrides: Partial<StoryWithLink> = {}): StoryWithLink {
  return {
    id: 1,
    primaryUrl: 'https://outlet.test/report',
    lane: 'games',
    title: 'Xbox secures GTA 6 streaming rights',
    summaryShort: 'Microsoft reportedly bought exclusive streaming rights.',
    summaryDetail: null,
    score: 4,
    firstSeenAt: UPDATED,
    updatedAt: UPDATED,
    digestedAt: null,
    verification: null,
    ...overrides,
  };
}

function verdict(overrides: Partial<Verification> = {}): Verification {
  return { verdict: 'confirmed', note: 'Announced.', sources: [], checkedAt: NOW, ...overrides };
}

function answer(body: unknown, costUsd = 0.1) {
  return {
    text: JSON.stringify(body),
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    costUsd,
  };
}

const DISPUTED = {
  verdict: 'disputed',
  note: 'Xbox says the game will not be streaming exclusively.',
  sources: [{ title: 'Exec clarifies', url: 'https://news.test/denial' }],
};

beforeEach(() => {
  mockEnv.verifyStories = true;
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockQueries.startRun.mockResolvedValue(1);
  mockQueries.finishRun.mockResolvedValue(undefined);
  mockQueries.getStorySources.mockResolvedValue(new Map());
  mockQueries.setVerification.mockImplementation(async (_id: number, v: object) => ({ ...v, checkedAt: NOW }));
});

describe('needsCheck', () => {
  it('is true for a story that has never been checked', () => {
    expect(needsCheck(story())).toBe(true);
  });

  it('is false while the verdict is newer than the story', () => {
    expect(needsCheck(story({ verification: verdict({ checkedAt: NOW }) }))).toBe(false);
  });

  it('is true again once the story has changed since the check', () => {
    const checkedBefore = new Date(UPDATED.getTime() - 60_000);
    expect(needsCheck(story({ verification: verdict({ checkedAt: checkedBefore }) }))).toBe(true);
  });
});

describe('verifyStories', () => {
  it('stores the verdict and returns the story carrying it', async () => {
    const completer = vi.fn().mockResolvedValue(answer(DISPUTED));

    const result = await verifyStories('games', [story({ id: 7 })], { completer, now: NOW });

    expect(mockQueries.setVerification).toHaveBeenCalledWith(7, DISPUTED);
    expect(result.stories[0].verification).toEqual({ ...DISPUTED, checkedAt: NOW });
    expect(result).toMatchObject({ checked: 1, failed: 0, costUsd: 0.1 });
    // Web search on, and the fact-check schema rather than the enrichment default.
    const opts = completer.mock.calls[0][2];
    expect(opts.webSearch).toBe(true);
    expect(opts.schema.properties).toHaveProperty('verdict');
  });

  it('puts the story and its source items in the prompt', async () => {
    mockQueries.getStorySources.mockResolvedValue(
      new Map([[7, [{ source: 'rss', url: 'https://outlet.test/report', title: 'The original report', publishedAt: UPDATED }]]]),
    );
    const completer = vi.fn().mockResolvedValue(answer(DISPUTED));

    await verifyStories('games', [story({ id: 7 })], { completer, now: NOW });

    const user = completer.mock.calls[0][1] as string;
    expect(user).toContain('Xbox secures GTA 6 streaming rights');
    expect(user).toContain('https://outlet.test/report');
    expect(user).toContain('The original report');
    expect(user).toContain('Now: 2026-10-07 00:00 UTC');
  });

  it('only checks stories without a current verdict', async () => {
    const current = story({ id: 1, verification: verdict() });
    const completer = vi.fn().mockResolvedValue(answer(DISPUTED));

    const result = await verifyStories('games', [current, story({ id: 2 })], { completer, now: NOW });

    expect(completer).toHaveBeenCalledTimes(1);
    expect(result.stories[0]).toBe(current);
    expect(result.stories[1].verification?.verdict).toBe('disputed');
  });

  it('makes no call and opens no run when every verdict is current', async () => {
    const completer = vi.fn();

    const result = await verifyStories('games', [story({ verification: verdict() })], { completer });

    expect(completer).not.toHaveBeenCalled();
    expect(mockQueries.startRun).not.toHaveBeenCalled();
    expect(result.checked).toBe(0);
  });

  it('leaves a story unchecked when its call fails, and still checks the others', async () => {
    const completer = vi
      .fn()
      .mockRejectedValueOnce(new Error('claude CLI timed out'))
      .mockResolvedValueOnce(answer(DISPUTED));

    const result = await verifyStories('games', [story({ id: 1 }), story({ id: 2 })], { completer, now: NOW });

    expect(result.stories[0].verification).toBeNull();
    expect(result.stories[1].verification?.verdict).toBe('disputed');
    expect(result).toMatchObject({ checked: 1, failed: 1 });
    const [, ok, counts] = mockQueries.finishRun.mock.calls[0];
    expect(ok).toBe(false);
    expect(counts).toMatchObject({ due: 2, checked: 1, failed: 1, disputed: 1 });
  });

  it('drops the old verdict of a changed story when the re-check fails', async () => {
    // The old verdict was about the story before it changed.
    const stale = story({ verification: verdict({ checkedAt: new Date(UPDATED.getTime() - 60_000) }) });
    const completer = vi.fn().mockRejectedValue(new Error('boom'));

    const result = await verifyStories('games', [stale], { completer, now: NOW });

    expect(result.stories[0].verification).toBeNull();
  });

  it('rejects an answer the validator refuses and writes nothing', async () => {
    const completer = vi.fn().mockResolvedValue(answer({ verdict: 'false', note: 'Not found anywhere.', sources: [] }));

    const result = await verifyStories('games', [story()], { completer, now: NOW });

    expect(mockQueries.setVerification).not.toHaveBeenCalled();
    expect(result.stories[0].verification).toBeNull();
  });

  it('still checks when the runs table is unreachable', async () => {
    mockQueries.startRun.mockRejectedValue(new Error('db down'));
    const completer = vi.fn().mockResolvedValue(answer(DISPUTED));

    const result = await verifyStories('games', [story()], { completer, now: NOW });

    expect(result.checked).toBe(1);
    expect(mockQueries.finishRun).not.toHaveBeenCalled();
  });

  it('does nothing when verification is switched off', async () => {
    mockEnv.verifyStories = false;
    const completer = vi.fn();
    const stories = [story()];

    const result = await verifyStories('games', stories, { completer });

    expect(completer).not.toHaveBeenCalled();
    expect(result.stories).toBe(stories);
  });
});

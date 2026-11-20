/**
 * The digest picks a lane's best new stories, fact-checks them and marks them.
 * Queries are mocked and the fact-check is off, so nothing here touches the
 * database, the network or a model.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { StoryWithLink } from '../../lib/db/types';

vi.mock('../../lib/env.js', () => ({
  env: {
    tz: 'Australia/Sydney',
    // Off, so digestLane's default verifier is a no-op and no test starts a model call.
    verifyStories: false,
  },
}));

const mockQueries = vi.hoisted(() => ({
  getDigestStories: vi.fn(),
  recordDigest: vi.fn(),
  startRun: vi.fn(),
  finishRun: vi.fn(),
  remindUpcomingEvents: vi.fn(async () => [] as number[]),
}));

vi.mock('../../lib/db/queries.js', () => mockQueries);

const { digestLane } = await import('../../lib/digest/run');

function story(overrides: Partial<StoryWithLink> = {}): StoryWithLink {
  return {
    id: 1,
    primaryUrl: 'https://anthropic.test/blog/new-thing',
    lane: 'ai',
    title: 'Anthropic ships a new thing',
    summaryShort: 'A short summary of the thing.',
    glossary: [],
    products: [],
    event: null,
    summaryDetail: null,
    score: 4,
    firstSeenAt: new Date('2026-09-13T00:00:00Z'),
    updatedAt: new Date('2026-09-13T00:00:00Z'),
    digestedAt: null,
    verification: null,
    doneAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueries.startRun.mockResolvedValue(1);
  mockQueries.finishRun.mockResolvedValue(undefined);
  mockQueries.recordDigest.mockResolvedValue(undefined);
});

describe('digestLane', () => {
  it('never makes a network request', async () => {
    mockQueries.getDigestStories.mockResolvedValue([story({ id: 7 })]);
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no network in tests');
    });

    await digestLane('ai');

    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('marks the selected stories and writes an ok runs row', async () => {
    mockQueries.getDigestStories.mockResolvedValue([story({ id: 5 }), story({ id: 6 })]);

    const result = await digestLane('markets');

    expect(result).toEqual({ digested: 2 });
    expect(mockQueries.recordDigest).toHaveBeenCalledWith('markets', [5, 6]);
    expect(mockQueries.startRun).toHaveBeenCalledWith('digest:markets');
    const [runId, ok, counts] = mockQueries.finishRun.mock.calls[0];
    expect(runId).toBe(1);
    expect(ok).toBe(true);
    expect(counts).toMatchObject({ lane: 'markets', selected: 2, digested: 2 });
  });

  it('writes a failed runs row and rethrows when marking fails', async () => {
    mockQueries.getDigestStories.mockResolvedValue([story({ id: 7 })]);
    mockQueries.recordDigest.mockRejectedValue(new Error('db down'));

    await expect(digestLane('ai')).rejects.toThrow('db down');

    const [, ok, counts, errorText] = mockQueries.finishRun.mock.calls[0];
    expect(ok).toBe(false);
    expect(counts).toMatchObject({ lane: 'ai', selected: 1, digested: 0 });
    expect(String(errorText)).toContain('db down');
  });

  it('still digests when the runs table is unreachable', async () => {
    mockQueries.startRun.mockRejectedValue(new Error('db down'));
    mockQueries.getDigestStories.mockResolvedValue([story({ id: 9 })]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await digestLane('ai');

    expect(result).toEqual({ digested: 1 });
    expect(mockQueries.recordDigest).toHaveBeenCalledWith('ai', [9]);
    expect(mockQueries.finishRun).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('marks the stories as the fact-check returned them', async () => {
    const selected = [story({ id: 5 })];
    const checked = [story({ id: 5, verification: { verdict: 'confirmed', note: 'Announced.', sources: [], checkedAt: new Date() } })];
    mockQueries.getDigestStories.mockResolvedValue(selected);
    const verifier = vi.fn().mockResolvedValue({ stories: checked, checked: 1, failed: 0, costUsd: 0.1 });

    await digestLane('ai', { verifier });

    expect(verifier).toHaveBeenCalledWith('ai', selected);
    expect(mockQueries.recordDigest).toHaveBeenCalledWith('ai', [5]);
  });

  it('marks prepared stories without selecting or checking again', async () => {
    const verifier = vi.fn();

    const result = await digestLane('ai', { verifier, prepared: [story({ id: 11 })] });

    expect(result).toEqual({ digested: 1 });
    expect(mockQueries.getDigestStories).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
    expect(mockQueries.recordDigest).toHaveBeenCalledWith('ai', [11]);
  });

  it('fires the deadline reminder before selecting the events lane, and for no other lane', async () => {
    mockQueries.getDigestStories.mockResolvedValue([]);

    await digestLane('ai');
    expect(mockQueries.remindUpcomingEvents).not.toHaveBeenCalled();

    await digestLane('events');
    expect(mockQueries.remindUpcomingEvents).toHaveBeenCalledOnce();
    expect(mockQueries.remindUpcomingEvents.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueries.getDigestStories.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('still digests the events lane when the reminder fails', async () => {
    mockQueries.getDigestStories.mockResolvedValue([story({ id: 12, lane: 'events' })]);
    mockQueries.remindUpcomingEvents.mockRejectedValueOnce(new Error('connection lost'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await digestLane('events')).toEqual({ digested: 1 });
    warn.mockRestore();
  });

  it('writes no digest row for an empty lane', async () => {
    mockQueries.getDigestStories.mockResolvedValue([]);

    expect(await digestLane('ai')).toEqual({ digested: 0 });
    expect(mockQueries.recordDigest).not.toHaveBeenCalled();
  });
});

/**
 * `lib/env.ts` is mocked everywhere here so tests never see the real
 * DISCORD_WEBHOOK_URL* values from .env, and every fetch is injected so nothing
 * ever leaves the process. No live Discord traffic from this file, ever.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Story } from '../../lib/db/types';

const mockEnv = vi.hoisted(() => ({
  discordWebhook: 'https://discord.test/main' as string | undefined,
  laneWebhooks: {} as Record<string, string | undefined>,
  feedBaseUrl: 'https://feed.test',
  tz: 'Australia/Sydney',
}));

vi.mock('../../lib/env.js', () => ({
  env: {
    get discordWebhook() {
      return mockEnv.discordWebhook;
    },
    discordLaneWebhook: (lane: string) => mockEnv.laneWebhooks[lane],
    get feedBaseUrl() {
      return mockEnv.feedBaseUrl;
    },
    get tz() {
      return mockEnv.tz;
    },
  },
}));

const mockQueries = vi.hoisted(() => ({
  getDigestStories: vi.fn(),
  recordDigest: vi.fn(),
  startRun: vi.fn(),
  finishRun: vi.fn(),
}));

vi.mock('../../lib/db/queries.js', () => mockQueries);

const { buildLaneEmbed, postLane, DISCORD_LIMITS, NOT_SENT_STATUS } = await import(
  '../../lib/digest/discord'
);
const { digestLane } = await import('../../lib/digest/run');

function story(overrides: Partial<Story> = {}): Story {
  return {
    id: 1,
    lane: 'ai',
    title: 'Anthropic ships a new thing',
    summaryShort: 'A short summary of the thing.',
    summaryDetail: null,
    score: 4,
    firstSeenAt: new Date('2026-09-13T00:00:00Z'),
    updatedAt: new Date('2026-09-13T00:00:00Z'),
    digestedAt: null,
    ...overrides,
  };
}

const NOW = new Date('2026-09-13T03:00:00Z'); // 13:00 AEST -> "13 Sep PM"
const BASE_URL = 'https://feed.test';

beforeEach(() => {
  mockEnv.discordWebhook = 'https://discord.test/main';
  mockEnv.laneWebhooks = {};
  vi.clearAllMocks();
  mockQueries.startRun.mockResolvedValue(1);
  mockQueries.finishRun.mockResolvedValue(undefined);
});

describe('buildLaneEmbed', () => {
  it('formats a small lane as a single message with links and titles', () => {
    const stories = [
      story({ id: 1, title: 'Story One' }),
      story({ id: 2, title: 'Story Two' }),
      story({ id: 3, title: 'Story Three' }),
    ];

    const messages = buildLaneEmbed('ai', stories, BASE_URL, NOW, 'Australia/Sydney');

    expect(messages).toHaveLength(1);
    const embed = messages[0].embeds![0];
    expect(embed.title).toMatch(/^AI · 13 Sep (AM|PM)$/);
    expect(embed.description.length).toBeLessThan(DISCORD_LIMITS.embedDescription);
    for (const s of stories) {
      expect(embed.description).toContain(s.title);
      expect(embed.description).toContain(`${BASE_URL}/story/${s.id}`);
    }
  });

  it('produces no messages for an empty lane', () => {
    expect(buildLaneEmbed('ai', [], BASE_URL, NOW, 'Australia/Sydney')).toEqual([]);
  });

  it('truncates a single runaway summary instead of emitting a payload Discord rejects', () => {
    // Nothing caps summary_short on the way in, so a 6000-char one is reachable;
    // before the fix this line was emitted whole and wedged the lane on a 400.
    const runaway = story({ id: 42, summaryShort: 'y'.repeat(6000) });

    const messages = buildLaneEmbed('ai', [runaway], BASE_URL, NOW, 'Australia/Sydney');

    expect(messages).toHaveLength(1);
    const embed = messages[0].embeds![0];
    expect(embed.description.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedDescription);
    expect(embed.title.length + embed.description.length).toBeLessThanOrEqual(
      DISCORD_LIMITS.totalPerMessage,
    );
    // Truncation must be visible, and must never cost the reader the way out.
    expect(embed.description).toContain('…');
    expect(embed.description).toContain(`${BASE_URL}/story/42`);
    expect(embed.description.endsWith(`${BASE_URL}/story/42`)).toBe(true);
    expect(embed.description).toContain(runaway.title);
  });

  it('keeps a runaway story packed with its neighbours under the limit', () => {
    const stories = [
      story({ id: 1, title: 'Normal One' }),
      story({ id: 2, title: 'Runaway', summaryShort: 'z'.repeat(6000) }),
      story({ id: 3, title: 'Normal Two' }),
    ];

    const messages = buildLaneEmbed('markets', stories, BASE_URL, NOW, 'Australia/Sydney');

    for (const message of messages) {
      for (const embed of message.embeds!) {
        expect(embed.description.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedDescription);
      }
    }
    const allText = messages.map((m) => m.embeds!.map((e) => e.description).join('\n')).join('\n');
    for (const s of stories) expect(allText).toContain(`${BASE_URL}/story/${s.id}`);
  });

  it('splits a lane of many long stories into multiple messages, each within every limit', () => {
    const longSummary = 'x'.repeat(300);
    const stories = Array.from({ length: 12 }, (_, i) =>
      story({ id: i + 1, title: `Long Story Number ${i + 1}`.repeat(3), summaryShort: longSummary }),
    );

    const messages = buildLaneEmbed('markets', stories, BASE_URL, NOW, 'Australia/Sydney');

    expect(messages.length).toBeGreaterThan(1);

    // Every story must survive somewhere, unsplit, unsplit and untruncated.
    const allText = messages.map((m) => m.embeds!.map((e) => e.description).join('\n')).join('\n');
    for (const s of stories) {
      expect(allText).toContain(s.title);
      expect(allText).toContain(s.summaryShort);
    }

    for (const message of messages) {
      const contentLen = message.content?.length ?? 0;
      expect(contentLen).toBeLessThanOrEqual(DISCORD_LIMITS.content);
      expect(message.embeds!.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedsPerMessage);

      let total = contentLen;
      for (const embed of message.embeds!) {
        expect(embed.description.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedDescription);
        total += embed.title.length + embed.description.length;
      }
      expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.totalPerMessage);
    }
  });
});

describe('postLane', () => {
  it('mirrors to both the main and the per-lane webhook when a lane URL is set', async () => {
    mockEnv.laneWebhooks.ai = 'https://discord.test/lane-ai';
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await postLane('ai', [story()], { fetchImpl, now: NOW });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calledUrls = fetchImpl.mock.calls.map((c) => c[0]);
    expect(calledUrls).toContain('https://discord.test/main');
    expect(calledUrls).toContain('https://discord.test/lane-ai');
    for (const call of fetchImpl.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.embeds[0].description).toContain('Anthropic ships a new thing');
    }
  });

  it('posts once when no per-lane webhook is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await postLane('gamedev', [story({ lane: 'gamedev' })], { fetchImpl, now: NOW });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://discord.test/main', expect.anything());
  });

  it('fails the lane when the main webhook is unset, without making a request', async () => {
    mockEnv.discordWebhook = undefined;
    const fetchImpl = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await postLane('ai', [story()], { fetchImpl, now: NOW });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(NOT_SENT_STATUS);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('DISCORD_WEBHOOK_URL');
    error.mockRestore();
  });

  it('stays ok but warns when only the per-lane mirror fails', async () => {
    mockEnv.laneWebhooks.ai = 'https://discord.test/lane-ai';
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('lane-ai')
        ? new Response('nope', { status: 500 })
        : new Response('{}', { status: 200 }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await postLane('ai', [story()], { fetchImpl, now: NOW });

    // ADR 0004: the mirror is never an override — the main channel decides.
    expect(result).toEqual({ ok: true, status: 200 });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('ai');
    expect(line).toContain('500');
    warn.mockRestore();
  });
});

describe('digestLane', () => {
  it('does not record a digest when no main webhook is configured', async () => {
    // The regression that mattered: postLane made no request, reported success,
    // and every selected story was marked digested and lost for good.
    mockEnv.discordWebhook = undefined;
    mockQueries.getDigestStories.mockResolvedValue([story({ id: 7 }), story({ id: 8 })]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Guarantees this path can never reach the network, mocked env or not.
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('no network in tests');
    });

    const result = await digestLane('ai', { now: NOW });

    expect(result.ok).toBe(false);
    expect(mockQueries.recordDigest).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
    error.mockRestore();
  });

  it('writes a failed runs row when the lane does not post', async () => {
    mockQueries.getDigestStories.mockResolvedValue([story({ id: 7 })]);
    const poster = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    await digestLane('ai', { poster, now: NOW });

    expect(mockQueries.startRun).toHaveBeenCalledWith('digest:ai');
    const [runId, ok, counts, errorText] = mockQueries.finishRun.mock.calls[0];
    expect(runId).toBe(1);
    expect(ok).toBe(false);
    expect(counts).toMatchObject({ lane: 'ai', selected: 1, sent: 0, discordStatus: 500 });
    expect(String(errorText)).toContain('500');
  });

  it('writes an ok runs row with counts after a successful lane', async () => {
    mockQueries.getDigestStories.mockResolvedValue([story({ id: 5 }), story({ id: 6 })]);
    const poster = vi.fn().mockResolvedValue({ ok: true, status: 204 });

    await digestLane('markets', { poster, now: NOW });

    expect(mockQueries.startRun).toHaveBeenCalledWith('digest:markets');
    const [, ok, counts] = mockQueries.finishRun.mock.calls[0];
    expect(ok).toBe(true);
    expect(counts).toMatchObject({ selected: 2, sent: 2, discordStatus: 204 });
  });

  it('still digests when the runs table is unreachable', async () => {
    mockQueries.startRun.mockRejectedValue(new Error('db down'));
    mockQueries.getDigestStories.mockResolvedValue([story({ id: 9 })]);
    const poster = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await digestLane('ai', { poster, now: NOW });

    expect(result).toEqual({ sent: 1, ok: true, status: 204 });
    expect(mockQueries.recordDigest).toHaveBeenCalledWith('ai', [9], 204);
    expect(mockQueries.finishRun).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not record a digest when the webhook post fails', async () => {
    mockQueries.getDigestStories.mockResolvedValue([story()]);
    const poster = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const result = await digestLane('ai', { poster, now: NOW });

    expect(result).toEqual({ sent: 1, ok: false, status: 500 });
    expect(mockQueries.recordDigest).not.toHaveBeenCalled();
  });

  it('records the digest with story ids after a 2xx', async () => {
    const stories = [story({ id: 5 }), story({ id: 6 })];
    mockQueries.getDigestStories.mockResolvedValue(stories);
    const poster = vi.fn().mockResolvedValue({ ok: true, status: 204 });

    const result = await digestLane('ai', { poster, now: NOW });

    expect(result).toEqual({ sent: 2, ok: true, status: 204 });
    expect(mockQueries.recordDigest).toHaveBeenCalledWith('ai', [5, 6], 204);
  });

  it('skips posting entirely for an empty lane', async () => {
    mockQueries.getDigestStories.mockResolvedValue([]);
    const poster = vi.fn();

    const result = await digestLane('ai', { poster, now: NOW });

    expect(result).toEqual({ sent: 0, ok: true, status: 0 });
    expect(poster).not.toHaveBeenCalled();
    expect(mockQueries.recordDigest).not.toHaveBeenCalled();
  });
});

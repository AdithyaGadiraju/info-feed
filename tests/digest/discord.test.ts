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
}));

vi.mock('../../lib/db/queries.js', () => mockQueries);

const { buildLaneEmbed, postLane, DISCORD_LIMITS } = await import('../../lib/digest/discord');
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
});

describe('digestLane', () => {
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

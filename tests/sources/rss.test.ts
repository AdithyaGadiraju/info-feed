import { describe, expect, it } from 'vitest';
import { rss } from '../../lib/sources/rss.js';
import { sourcesConfig } from '../../config/sources.js';
import type { SourcesConfig } from '../../lib/sources/types.js';

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

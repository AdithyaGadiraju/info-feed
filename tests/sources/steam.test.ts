/**
 * Live smoke test for the Steam source (ADR 0002): hits the real endpoint, no mocks.
 */
import { describe, expect, it } from 'vitest';
import { steam } from '../../lib/sources/steam';
import type { SourcesConfig } from '../../lib/sources/types';

const config = {
  sourceTimeoutMs: 20_000,
} as SourcesConfig;

describe('steam source', () => {
  it('fetches at least one item with valid required fields', async () => {
    const items = await steam.fetch({ since: new Date(0), config });

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.laneHint).toBe('games');
      expect(item.externalId).toBeTruthy();
      expect(item.url).toBeTruthy();
      expect(item.title).toBeTruthy();
      expect(item.body).toBeTruthy();
      expect(item.publishedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(item.publishedAt.getTime())).toBe(false);
    }
  });

  it('dedupes by appid: externalId is unique across the result', async () => {
    const items = await steam.fetch({ since: new Date(0), config });
    const ids = items.map((i) => i.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns empty and makes no request when games lane is excluded', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      called = true;
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      const items = await steam.fetch({ since: new Date(0), config, lanes: ['ai'] });
      expect(items).toEqual([]);
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

import { describe, expect, it } from 'vitest';
import { LANES } from '../../lib/db/types';
import { hn, routeFrontPageLane } from '../../lib/sources/hn';
import { sourcesConfig } from '../../config/sources';

// Live endpoint per ADR 0002: these hit the real Algolia HN API.
describe('hn source (live)', () => {
  it('returns items with required fields, numeric points and a valid date', async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const items = await hn.fetch({ since, config: sourcesConfig });

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(typeof item.engagement?.points).toBe('number');
      expect(item.publishedAt instanceof Date).toBe(true);
      expect(Number.isNaN(item.publishedAt.getTime())).toBe(false);
      expect(item.externalId.length).toBeGreaterThan(0);
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.url.length).toBeGreaterThan(0);
      expect(item.source).toBe('hn');
    }
  }, 30_000);

  it('has no duplicate externalId across front page and keyword queries', async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const items = await hn.fetch({ since, config: sourcesConfig });

    const ids = items.map((i) => i.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  }, 30_000);

  it('only ever assigns one of the five known lanes', async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const items = await hn.fetch({ since, config: sourcesConfig });

    for (const item of items) {
      expect(LANES).toContain(item.laneHint);
    }
  }, 30_000);
});

describe('routeFrontPageLane (unit)', () => {
  it('routes an AI-flavoured title to the ai lane', () => {
    const lane = routeFrontPageLane(
      'Anthropic releases a new model card',
      sourcesConfig.hnFrontPageLaneKeywords,
    );
    expect(lane).toBe('ai');
  });

  it('drops a title matching no configured keywords', () => {
    const lane = routeFrontPageLane(
      'A recipe for grandma\'s lentil soup',
      sourcesConfig.hnFrontPageLaneKeywords,
    );
    expect(lane).toBeNull();
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../../lib/db/client';
import { getPendingItems } from '../../lib/db/queries';
import { EXCLUDED_STORY_ID, type Lane } from '../../lib/db/types';
import { ingest, shouldExclude } from '../../lib/sources/index';
import type { RawItem, Source, SourcesConfig } from '../../lib/sources/types';
import { sourcesConfig } from '../../config/sources';

/** Everything this file writes carries one of these, so cleanup is exact. */
const TEST_SOURCE = '__test_ingest__';
const TEST_JOB = '__test_ingest__';

const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function testConfig(over: Partial<SourcesConfig> = {}): SourcesConfig {
  return { ...sourcesConfig, ...over };
}

function fakeItem(externalId: string, over: Partial<RawItem> = {}): RawItem {
  return {
    source: TEST_SOURCE,
    externalId: `${RUN_ID}-${externalId}`,
    laneHint: 'ai',
    url: `https://example.invalid/${RUN_ID}/${externalId}`,
    title: `ingest runner test ${externalId}`,
    // A body up front keeps the runner from trying to fetch example.invalid.
    body: 'synthetic body, so the runner never tries to fetch this url',
    publishedAt: new Date(),
    ...over,
  };
}

function fakeSource(name: Source['name'], items: RawItem[]): Source {
  return { name, fetch: async () => items };
}

async function storyIdOf(externalId: string): Promise<number | null | undefined> {
  const sql = db();
  const rows = await sql`
    SELECT story_id::int AS story_id FROM items
    WHERE source = ${TEST_SOURCE} AND external_id = ${`${RUN_ID}-${externalId}`}
  `;
  if (rows.length === 0) return undefined;
  return rows[0].story_id === null ? null : Number(rows[0].story_id);
}

afterAll(async () => {
  const sql = db();
  await sql`DELETE FROM items WHERE source = ${TEST_SOURCE}`;
  await sql`DELETE FROM runs WHERE job = ${TEST_JOB}`;
  await closeDb();
});

describe('ingest (live)', () => {
  it('ingests one lane over the last 24h and returns self-consistent counts', async () => {
    const since = new Date(Date.now() - 24 * 3600_000);
    // Bodies are the slow part and are covered by tests/fetchBody.test.ts; a
    // handful is enough to prove the wiring without a two minute test.
    const result = await ingest({ lanes: ['ai'], since, maxBodies: 3, job: TEST_JOB });

    expect(result.runId).toBeGreaterThan(0);
    expect(result.sources.length).toBe(6);
    expect(result.fetched).toBeGreaterThan(0);
    expect(result.stored).toBeGreaterThan(0);

    expect(result.stored).toBe(result.sources.reduce((n, s) => n + s.stored, 0));
    expect(result.fetched).toBe(result.sources.reduce((n, s) => n + s.fetched, 0));
    expect(result.filtered).toBe(result.sources.reduce((n, s) => n + s.filtered, 0));
    expect(result.bodiesFetched).toBe(result.sources.reduce((n, s) => n + s.bodiesFetched, 0));
    expect(result.bodiesFetched).toBeLessThanOrEqual(3);

    for (const s of result.sources) {
      expect(s.stored).toBeLessThanOrEqual(s.fetched);
      expect(s.filtered).toBeLessThanOrEqual(s.fetched);
      // The lane filter is the runner's job, not the source's.
      expect(s.outOfLane).toBeGreaterThanOrEqual(0);
    }

    // Assert the lane has rows, not that this particular run inserted any.
    // `items` is unique on (source, external_id) and `fetched_at` is only set on
    // insert, so a second ingest inside the same window correctly stores nothing
    // new -- which is dedupe working, not a failure.
    const sql = db();
    const [row] = await sql`SELECT count(*)::int AS n FROM items WHERE lane_hint = 'ai'`;
    expect(Number(row.n)).toBeGreaterThan(0);

    const [runRow] = await sql`SELECT ok, counts FROM runs WHERE id = ${result.runId!}`;
    expect(runRow.ok).toBe(true);
    expect((runRow.counts as Record<string, unknown>).bySource).toBeTruthy();
  }, 120_000);

  it('records a throwing source as failed without failing the run', async () => {
    const since = new Date(Date.now() - 3600_000);
    const broken: Source = {
      name: 'twitter',
      fetch: async () => {
        throw new Error('deliberate explosion');
      },
    };
    const healthy = fakeSource('rss', [fakeItem('healthy-alongside-broken')]);

    const result = await ingest({
      since,
      sources: [broken, healthy],
      config: testConfig(),
      job: TEST_JOB,
    });

    expect(result.failed.map((f) => f.source)).toEqual(['twitter']);
    expect(result.failed[0].error).toContain('deliberate explosion');
    expect(result.sources.find((s) => s.source === 'twitter')?.ok).toBe(false);
    // The healthy source alongside it still landed.
    expect(result.sources.find((s) => s.source === 'rss')?.stored).toBe(1);
    expect(result.stored).toBe(1);
  });

  it('times a hanging source out and still completes the run', async () => {
    const since = new Date(Date.now() - 3600_000);
    const hanging: Source = {
      // Never settles: the runner must be the thing that gives up, not the source.
      name: 'steam',
      fetch: () => new Promise<RawItem[]>(() => {}),
    };
    const healthy = fakeSource('rss', [fakeItem('healthy-alongside-hang')]);

    const started = Date.now();
    const result = await ingest({
      since,
      sources: [hanging, healthy],
      config: testConfig({ sourceTimeoutMs: 250 }),
      job: TEST_JOB,
    });
    const elapsed = Date.now() - started;

    expect(result.failed.map((f) => f.source)).toEqual(['steam']);
    expect(result.failed[0].error).toContain('timed out');
    expect(result.sources.find((s) => s.source === 'rss')?.stored).toBe(1);
    // Proves the timeout is what ended it, not the source's own 20s budget.
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it('marks a run failed only when every source fails', async () => {
    const since = new Date(Date.now() - 3600_000);
    const boom = (name: Source['name']): Source => ({
      name,
      fetch: async () => {
        throw new Error('everything is broken');
      },
    });

    const result = await ingest({
      since,
      sources: [boom('rss'), boom('hn')],
      config: testConfig(),
      job: TEST_JOB,
    });

    expect(result.failed.length).toBe(2);
    const sql = db();
    const [runRow] = await sql`SELECT ok FROM runs WHERE id = ${result.runId!}`;
    expect(runRow.ok).toBe(false);
  });
});

describe('engagement pre-filter', () => {
  it('stores a below-threshold HN item with the excluded sentinel and hides it from the queue', async () => {
    const since = new Date(Date.now() - 3600_000);
    const config = testConfig({
      thresholds: { ...sourcesConfig.thresholds, hnMinPoints: 50 },
    });

    const low = fakeItem('hn-low', { engagement: { points: 3 } });
    const high = fakeItem('hn-high', { engagement: { points: 500 } });

    const result = await ingest({
      since,
      lanes: ['ai'],
      sources: [fakeSource('hn', [low, high])],
      config,
      job: TEST_JOB,
    });

    expect(result.filtered).toBe(1);
    expect(result.stored).toBe(2);
    expect(await storyIdOf('hn-low')).toBe(EXCLUDED_STORY_ID);
    expect(await storyIdOf('hn-high')).toBeNull();

    const pending = await getPendingItems('ai' as Lane, 500);
    const pendingIds = pending.map((i) => i.externalId);
    expect(pendingIds).not.toContain(low.externalId);
    expect(pendingIds).toContain(high.externalId);
  });

  it('does not filter a reddit item that carries no upvote count at all', async () => {
    const since = new Date(Date.now() - 3600_000);
    const config = testConfig({
      thresholds: { ...sourcesConfig.thresholds, redditMinUpvotes: 50 },
    });

    // What reddit.ts actually produces: the .rss endpoint has no vote counts, so
    // `upvotes` is simply absent. Absent must not read as zero.
    const noCount = fakeItem('reddit-nocount', { engagement: { comments: 4 } });
    const noEngagement = fakeItem('reddit-noengagement');
    const belowThreshold = fakeItem('reddit-low', { engagement: { upvotes: 2 } });

    const result = await ingest({
      since,
      lanes: ['ai'],
      sources: [fakeSource('reddit', [noCount, noEngagement, belowThreshold])],
      config,
      job: TEST_JOB,
    });

    expect(result.stored).toBe(3);
    expect(result.filtered).toBe(1);
    expect(await storyIdOf('reddit-nocount')).toBeNull();
    expect(await storyIdOf('reddit-noengagement')).toBeNull();
    expect(await storyIdOf('reddit-low')).toBe(EXCLUDED_STORY_ID);
  });

  it('passes rss, steam and prices through unfiltered whatever their engagement', async () => {
    const thresholds = sourcesConfig.thresholds;
    for (const name of ['rss', 'steam', 'prices'] as const) {
      const item = fakeItem(`${name}-zero`, { engagement: { points: 0, upvotes: 0, likes: 0 } });
      expect(shouldExclude(name, item, thresholds)).toBe(false);
    }
  });

  it('applies the twitter like threshold only when a like count is present', () => {
    const thresholds = { ...sourcesConfig.thresholds, twitterMinLikes: 100 };
    expect(shouldExclude('twitter', fakeItem('t1', { engagement: { likes: 5 } }), thresholds)).toBe(
      true,
    );
    expect(
      shouldExclude('twitter', fakeItem('t2', { engagement: { likes: 500 } }), thresholds),
    ).toBe(false);
    expect(shouldExclude('twitter', fakeItem('t3'), thresholds)).toBe(false);
  });
});

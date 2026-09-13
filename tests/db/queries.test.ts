import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, closeDb } from '../../lib/db/client.js';
import { migrate } from '../../lib/db/migrate.js';
import {
  applyAssignments,
  countPendingItems,
  getFeedPage,
  getPendingItems,
  getStoryWithItems,
  insertPriceSnapshots,
  markItemsFiltered,
  upsertItems,
  finishRun,
  startRun,
} from '../../lib/db/queries.js';
import { EXCLUDED_STORY_ID, type NewItem } from '../../lib/db/types.js';

const TEST_SOURCE = '__test_queries__';
const hasDb = Boolean(process.env.DATABASE_URL);

function item(externalId: string, over: Partial<NewItem> = {}): NewItem {
  return {
    source: TEST_SOURCE,
    externalId,
    laneHint: 'ai',
    url: `https://example.invalid/${externalId}`,
    title: `Test item ${externalId}`,
    publishedAt: new Date(),
    engagement: { points: 10 },
    ...over,
  };
}

async function cleanup() {
  const sql = db();
  await sql`DELETE FROM stories WHERE title LIKE '__test_queries__%'`;
  await sql`DELETE FROM items WHERE source = ${TEST_SOURCE}`;
  await sql`DELETE FROM price_snapshots WHERE symbol = '__TESTSYM__'`;
  await sql`DELETE FROM runs WHERE job = '__test_queries__'`;
}

describe.skipIf(!hasDb)('db queries round trip', () => {
  beforeAll(async () => {
    await migrate();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it('upserts items and dedupes on (source, external_id)', async () => {
    const first = await upsertItems([item('a'), item('b')]);
    expect(first.inserted).toHaveLength(2);
    expect(first.total).toBe(2);

    // Re-upserting the same external ids must update, not duplicate.
    const second = await upsertItems([item('a', { title: 'Updated title' }), item('b')]);
    expect(second.inserted).toHaveLength(0);
    expect(second.total).toBe(2);

    const sql = db();
    const rows = await sql`SELECT count(*)::int AS n FROM items WHERE source = ${TEST_SOURCE}`;
    expect(Number(rows[0].n)).toBe(2);

    const pending = await getPendingItems('ai', 100);
    const mine = pending.filter((p) => p.source === TEST_SOURCE);
    expect(mine.map((m) => m.title)).toContain('Updated title');
  });

  it('re-upsert does not clear an existing body or reattach a story', async () => {
    await upsertItems([item('c', { body: 'original body' })]);
    await upsertItems([item('c', { body: null })]);
    const sql = db();
    const [row] = await sql`SELECT body FROM items WHERE source = ${TEST_SOURCE} AND external_id = 'c'`;
    expect(row.body).toBe('original body');
  });

  it('marks pre-filtered items excluded so they leave the pending queue', async () => {
    const res = await upsertItems([item('filtered')]);
    const id = res.inserted[0].id;
    const before = await countPendingItems('ai');
    expect(await markItemsFiltered([id])).toBe(1);
    expect(await countPendingItems('ai')).toBe(before - 1);

    const sql = db();
    const [row] = await sql`SELECT story_id::int AS story_id FROM items WHERE id = ${id}`;
    expect(Number(row.story_id)).toBe(EXCLUDED_STORY_ID);
  });

  it('applies assignments in one transaction: creates a story, attaches items, drops noise', async () => {
    const res = await upsertItems([item('s1'), item('s2'), item('noise')]);
    const [i1, i2, noise] = res.inserted.map((r) => r.id);

    const applied = await applyAssignments('ai', {
      assignments: [
        {
          itemIds: [i1, i2],
          newStory: {
            lane: 'ai',
            title: '__test_queries__ clustered story',
            summaryShort: 'Two items became one story.',
            summaryDetail: null,
            score: 4,
          },
        },
      ],
      dropped: [noise],
    });

    expect(applied.created).toBe(1);
    expect(applied.attached).toBe(2);
    expect(applied.dropped).toBe(1);

    const sql = db();
    const [story] = await sql`
      SELECT id::int AS id FROM stories WHERE title = '__test_queries__ clustered story'
    `;
    const full = await getStoryWithItems(Number(story.id));
    expect(full?.items).toHaveLength(2);
    expect(full?.score).toBe(4);

    const [dropped] = await sql`SELECT story_id::int AS story_id FROM items WHERE id = ${noise}`;
    expect(Number(dropped.story_id)).toBe(EXCLUDED_STORY_ID);
  });

  it('pages the feed on a keyset cursor without repeats', async () => {
    const page1 = await getFeedPage({ minScore: 1, limit: 1 });
    expect(page1.stories.length).toBeLessThanOrEqual(1);
    if (page1.nextCursor) {
      const page2 = await getFeedPage({ minScore: 1, limit: 1, cursor: page1.nextCursor });
      const ids = new Set([...page1.stories, ...page2.stories].map((s) => s.id));
      expect(ids.size).toBe(page1.stories.length + page2.stories.length);
    }
  });

  it('writes price snapshots and run rows', async () => {
    expect(await insertPriceSnapshots([{ symbol: '__TESTSYM__', price: 1.5 }])).toBe(1);
    const runId = await startRun('__test_queries__');
    await finishRun(runId, true, { items: 3 });
    const sql = db();
    const [run] = await sql`SELECT ok, counts FROM runs WHERE id = ${runId}`;
    expect(run.ok).toBe(true);
    expect((run.counts as { items: number }).items).toBe(3);
  });
});

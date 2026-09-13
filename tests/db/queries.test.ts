import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, closeDb } from '../../lib/db/client';
import { migrate } from '../../lib/db/migrate';
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
} from '../../lib/db/queries';
import { EXCLUDED_STORY_ID, type NewItem } from '../../lib/db/types';

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


  it('lets a pre-filtered item back into the queue once its engagement grows', async () => {
    // A Hacker News story first seen at 12 points is stored excluded. When it
    // reaches the front page the upsert must return it to the pending queue,
    // otherwise the stories that grow are exactly the ones never enriched.
    const low = item('grower', { engagement: { points: 12 }, storyId: EXCLUDED_STORY_ID });
    const res = await upsertItems([low]);
    const id = res.inserted[0].id;

    const sql = db();
    const [before] = await sql`SELECT story_id::int AS story_id FROM items WHERE id = ${id}`;
    expect(Number(before.story_id)).toBe(EXCLUDED_STORY_ID);

    // Same item, now passing the pre-filter: storyId omitted means "pending".
    await upsertItems([item('grower', { engagement: { points: 600 } })]);
    const [after] = await sql`SELECT story_id::int AS story_id, engagement FROM items WHERE id = ${id}`;
    expect(after.story_id).toBeNull();
    expect((after.engagement as { points: number }).points).toBe(600);
  });

  it('does not detach an item that is already attached to a story', async () => {
    const res = await upsertItems([item('attached')]);
    const id = res.inserted[0].id;
    const sql = db();
    const [story] = await sql`
      INSERT INTO stories (lane, title, summary_short, score)
      VALUES ('ai', '__test_queries__ attachment guard', 'x', 3) RETURNING id::int AS id`;
    await sql`UPDATE items SET story_id = ${Number(story.id)} WHERE id = ${id}`;

    // Re-ingesting the same item, even as a pre-filter reject, must not orphan it.
    await upsertItems([item('attached', { storyId: EXCLUDED_STORY_ID })]);
    const [after] = await sql`SELECT story_id::int AS story_id FROM items WHERE id = ${id}`;
    expect(Number(after.story_id)).toBe(Number(story.id));
  });

  it('pages through stories that share an updated_at without skipping any', async () => {
    // applyAssignments writes a whole chunk inside one transaction, so every story
    // it creates shares a single now(). A cursor built from a millisecond-truncated
    // JS Date excluded the rest of the tie group, silently losing them from the feed.
    const sql = db();
    await sql`
      INSERT INTO stories (lane, title, summary_short, score)
      SELECT 'ai', '__test_queries__ tie ' || g, 'tied', 5
      FROM generate_series(1, 5) g`;

    const seen: number[] = [];
    let cursor = null as Awaited<ReturnType<typeof getFeedPage>>['nextCursor'];
    for (let page = 0; page < 12; page += 1) {
      const res = await getFeedPage({ lanes: ['ai'], minScore: 5, limit: 2, cursor });
      seen.push(...res.stories.map((st) => st.id));
      cursor = res.nextCursor;
      if (!cursor) break;
    }

    const [{ n }] = await sql`
      SELECT count(*)::int AS n FROM stories WHERE lane = 'ai' AND score >= 5`;
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(Number(n));
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

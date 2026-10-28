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
  setStoryDone,
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
            glossary: [],
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

  it("files a new story in the model's lane within the run's lane group, and the run's lane outside it", async () => {
    const res = await upsertItems([item('grp-dev'), item('grp-other')]);
    const [dev, other] = res.inserted.map((r) => r.id);
    const newStory = (lane: 'ai_dev' | 'betting', title: string) => ({
      lane,
      title,
      summaryShort: 'Lane routing.',
      summaryDetail: null,
      score: 2 as const,
      glossary: [],
    });

    await applyAssignments('ai', {
      assignments: [
        { itemIds: [dev], newStory: newStory('ai_dev', '__test_queries__ group lane') },
        { itemIds: [other], newStory: newStory('betting', '__test_queries__ foreign lane') },
      ],
      dropped: [],
    });

    const sql = db();
    const rows = await sql`
      SELECT title, lane FROM stories WHERE title IN ('__test_queries__ group lane', '__test_queries__ foreign lane')
    `;
    const laneOf = Object.fromEntries(rows.map((r) => [r.title, r.lane]));
    expect(laneOf['__test_queries__ group lane']).toBe('ai_dev');
    expect(laneOf['__test_queries__ foreign lane']).toBe('ai');
  });

  it('counts an attach-only assignment as extended, and a revision as updated', async () => {
    const res = await upsertItems([item('x1'), item('x2'), item('x3')]);
    const [x1, x2, x3] = res.inserted.map((r) => r.id);

    await applyAssignments('ai', {
      assignments: [
        {
          itemIds: [x1],
          newStory: {
            lane: 'ai',
            title: '__test_queries__ extended story',
            summaryShort: 'One item.',
            summaryDetail: null,
            score: 2,
            glossary: [],
          },
        },
      ],
      dropped: [],
    });
    const sql = db();
    const [story] = await sql`
      SELECT id::int AS id FROM stories WHERE title = '__test_queries__ extended story'
    `;
    const storyId = Number(story.id);

    // More coverage of the same fact: not a material update.
    const attachOnly = await applyAssignments('ai', {
      assignments: [{ itemIds: [x2], storyId }],
      dropped: [],
    });
    expect(attachOnly.updated).toBe(0);
    expect(attachOnly.extended).toBe(1);

    const revised = await applyAssignments('ai', {
      assignments: [{ itemIds: [x3], storyId, updatedShort: 'Now two facts.' }],
      dropped: [],
    });
    expect(revised.updated).toBe(1);
    expect(revised.extended).toBe(0);
  });

  it('links a story to the article behind it, not to the thread about it', async () => {
    // The HN thread is the earliest of the three, so it wins on recency alone —
    // it must still lose to a real article, and the article must beat the repost
    // that followed it an hour later.
    const { inserted } = await upsertItems([
      item('link-thread', {
        url: 'https://news.ycombinator.com/item?id=44444444',
        publishedAt: new Date('2026-09-10T00:00:00Z'),
      }),
      item('link-article', {
        url: 'https://example.invalid/the-article',
        publishedAt: new Date('2026-09-10T02:00:00Z'),
      }),
      item('link-repost', {
        url: 'https://example.invalid/the-repost',
        publishedAt: new Date('2026-09-10T03:00:00Z'),
      }),
    ]);
    expect(inserted).toHaveLength(3);

    await applyAssignments('ai', {
      assignments: [
        {
          itemIds: inserted.map((i) => i.id),
          newStory: {
            lane: 'ai',
            title: '__test_queries__ linked story',
            summaryShort: 'One story, three items, one article.',
            summaryDetail: null,
            score: 5,
            glossary: [],
          },
        },
      ],
      dropped: [],
    });

    const sql = db();
    const [row] = await sql`
      SELECT id::int AS id FROM stories WHERE title = '__test_queries__ linked story'
    `;
    const storyId = Number(row.id);

    const full = await getStoryWithItems(storyId);
    expect(full?.primaryUrl).toBe('https://example.invalid/the-article');

    // The feed builds the link in a different statement (one lateral, aggregated),
    // so it gets its own assertion. The story was just written, so it sorts first.
    const page = await getFeedPage({ lanes: ['ai'], minScore: 5, limit: 5 });
    expect(page.stories.find((s) => s.id === storyId)?.primaryUrl).toBe(
      'https://example.invalid/the-article',
    );
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

  it('marks a story done idempotently and clears it only on a material update', async () => {
    const res = await upsertItems([item('d1'), item('d2'), item('d3')]);
    const [d1, d2, d3] = res.inserted.map((r) => r.id);
    await applyAssignments('ai', {
      assignments: [
        {
          itemIds: [d1],
          newStory: {
            lane: 'ai',
            title: '__test_queries__ done story',
            summaryShort: 'Read me.',
            summaryDetail: null,
            score: 3,
            glossary: [],
          },
        },
      ],
      dropped: [],
    });
    const sql = db();
    const [story] = await sql`SELECT id::int AS id FROM stories WHERE title = '__test_queries__ done story'`;
    const storyId = Number(story.id);

    expect(await setStoryDone(storyId + 1_000_000, true)).toBeNull();

    const first = await setStoryDone(storyId, true);
    expect(first?.doneAt).toBeInstanceOf(Date);
    const again = await setStoryDone(storyId, true);
    expect(again?.doneAt?.getTime()).toBe(first?.doneAt?.getTime());
    expect((await getStoryWithItems(storyId))?.doneAt?.getTime()).toBe(first?.doneAt?.getTime());

    // More sources behind the same summary, or new definitions for it: still done.
    await applyAssignments('ai', { assignments: [{ itemIds: [d2], storyId }], dropped: [] });
    expect((await getStoryWithItems(storyId))?.doneAt).not.toBeNull();
    await applyAssignments('ai', {
      assignments: [{ itemIds: [], storyId, updatedGlossary: [{ term: 'TTS', definition: 'Text to speech.' }] }],
      dropped: [],
    });
    expect((await getStoryWithItems(storyId))?.doneAt).not.toBeNull();

    // A rewritten summary is a new story to read.
    await applyAssignments('ai', {
      assignments: [{ itemIds: [d3], storyId, updatedShort: 'Read me again.' }],
      dropped: [],
    });
    expect((await getStoryWithItems(storyId))?.doneAt).toBeNull();

    expect((await setStoryDone(storyId, false))?.doneAt).toBeNull();
  });

  it('splits the feed into to-read and done, and filters by day window and search', async () => {
    const sql = db();
    const [a] = await sql`
      INSERT INTO stories (lane, title, summary_short, summary_detail, score)
      VALUES ('ai', '__test_queries__ search alpha', 'Gaussian splats land in Godot.', 'A 100% win.', 5)
      RETURNING id::int AS id`;
    const [b] = await sql`
      INSERT INTO stories (lane, title, summary_short, score, done_at, updated_at)
      VALUES ('ai', '__test_queries__ search beta', 'Splats everywhere.', 5, now(), '2020-01-15T12:00:00Z')
      RETURNING id::int AS id`;
    const alpha = Number(a.id);
    const beta = Number(b.id);
    const idsOf = (p: Awaited<ReturnType<typeof getFeedPage>>) => p.stories.map((s) => s.id);

    const toRead = await getFeedPage({ lanes: ['ai'], minScore: 5, q: 'splats', limit: 50 });
    expect(idsOf(toRead)).toContain(alpha);
    expect(idsOf(toRead)).not.toContain(beta);

    const done = await getFeedPage({ lanes: ['ai'], minScore: 5, q: 'splats', done: true, limit: 50 });
    expect(idsOf(done)).toContain(beta);
    expect(idsOf(done)).not.toContain(alpha);

    // Every word must match, across title and both summaries, regardless of case.
    expect(idsOf(await getFeedPage({ lanes: ['ai'], minScore: 5, q: 'GODOT alpha', limit: 50 }))).toContain(alpha);
    expect(idsOf(await getFeedPage({ lanes: ['ai'], minScore: 5, q: 'godot beta', limit: 50 }))).toEqual([]);
    // Pattern characters are literal: "100%" must not become a wildcard match for "100".
    expect(idsOf(await getFeedPage({ lanes: ['ai'], minScore: 5, q: '100%', limit: 50 }))).toContain(alpha);
    expect(idsOf(await getFeedPage({ lanes: ['ai'], minScore: 5, q: '100_', limit: 50 }))).toEqual([]);

    // A window on updated_at: beta sits in January 2020, alpha is now.
    const jan2020 = await getFeedPage({
      lanes: ['ai'],
      minScore: 5,
      done: true,
      since: new Date('2020-01-15T00:00:00Z'),
      until: new Date('2020-01-16T00:00:00Z'),
      limit: 50,
    });
    expect(idsOf(jan2020)).toEqual([beta]);
    const before2020 = await getFeedPage({
      lanes: ['ai'],
      minScore: 5,
      done: true,
      until: new Date('2020-01-01T00:00:00Z'),
      limit: 50,
    });
    expect(idsOf(before2020)).not.toContain(beta);
    const recent = await getFeedPage({ lanes: ['ai'], minScore: 5, since: new Date(Date.now() - 60_000), limit: 50 });
    expect(idsOf(recent)).toContain(alpha);
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

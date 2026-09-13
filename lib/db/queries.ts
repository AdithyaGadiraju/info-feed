/**
 * The database contract. Every other module in info-feed reads and writes through
 * these functions; nothing else writes raw SQL (ADR 0001 Implementation surface).
 *
 * Ids are cast to `int` in every select list because `postgres.js` returns bigint
 * columns as strings by default and a personal feed will never exceed 2^31 rows.
 */
import type { Row } from 'postgres';
import { db } from './client.js';
import {
  EXCLUDED_STORY_ID,
  isNewStoryAssignment,
  type EnrichResult,
  type FeedCursor,
  type FeedPage,
  type Item,
  type Lane,
  type NewItem,
  type Score,
  type Story,
  type StoryWithCount,
  type StoryWithItems,
} from './types.js';

// ---- row mappers ----

function toItem(r: Row): Item {
  return {
    id: Number(r.id),
    source: r.source as string,
    externalId: r.external_id as string,
    laneHint: r.lane_hint as Lane,
    url: r.url as string,
    title: r.title as string,
    body: (r.body as string | null) ?? null,
    author: (r.author as string | null) ?? null,
    engagement: (r.engagement as Item['engagement']) ?? {},
    publishedAt: r.published_at as Date,
    fetchedAt: r.fetched_at as Date,
    storyId: r.story_id === null || r.story_id === undefined ? null : Number(r.story_id),
  };
}

function toStory(r: Row): Story {
  return {
    id: Number(r.id),
    lane: r.lane as Lane,
    title: r.title as string,
    summaryShort: r.summary_short as string,
    summaryDetail: (r.summary_detail as string | null) ?? null,
    score: Number(r.score) as Score,
    firstSeenAt: r.first_seen_at as Date,
    updatedAt: r.updated_at as Date,
    digestedAt: (r.digested_at as Date | null) ?? null,
  };
}

// ---- items ----

export interface UpsertResult {
  /** Rows that did not exist before this call. */
  inserted: Array<{ id: number; source: string; externalId: string; url: string; hasBody: boolean }>;
  /** Total rows touched, inserted plus updated. */
  total: number;
}

/**
 * One multi-row upsert per call (ADR 0001: batch, every statement is a network hop).
 * Conflicts refresh the mutable fields — engagement moves, titles get edited — but
 * never touch `story_id`, so an already-enriched item stays attached to its story.
 */
export async function upsertItems(items: NewItem[]): Promise<UpsertResult> {
  if (items.length === 0) return { inserted: [], total: 0 };
  const sql = db();

  const rows = items.map((i) => ({
    source: i.source,
    external_id: i.externalId,
    lane_hint: i.laneHint,
    url: i.url,
    title: i.title.slice(0, 500),
    body: i.body ?? null,
    author: i.author ?? null,
    engagement: sql.json((i.engagement ?? {}) as never),
    published_at: i.publishedAt,
    story_id: i.storyId ?? null,
  }));

  const result = await sql`
    INSERT INTO items ${sql(
      rows,
      'source',
      'external_id',
      'lane_hint',
      'url',
      'title',
      'body',
      'author',
      'engagement',
      'published_at',
      'story_id',
    )}
    ON CONFLICT (source, external_id) DO UPDATE SET
      title      = EXCLUDED.title,
      url        = EXCLUDED.url,
      body       = COALESCE(EXCLUDED.body, items.body),
      author     = COALESCE(EXCLUDED.author, items.author),
      engagement = EXCLUDED.engagement
    RETURNING id::int AS id, source, external_id, url, (body IS NOT NULL) AS has_body,
              (xmax = 0) AS was_inserted
  `;

  const inserted = result
    .filter((r) => r.was_inserted)
    .map((r) => ({
      id: Number(r.id),
      source: r.source as string,
      externalId: r.external_id as string,
      url: r.url as string,
      hasBody: Boolean(r.has_body),
    }));

  return { inserted, total: result.length };
}

/** Attach an extracted article body to an already-stored item. */
export async function setItemBodies(bodies: Array<{ id: number; body: string }>): Promise<number> {
  if (bodies.length === 0) return 0;
  const sql = db();
  const ids = bodies.map((b) => b.id);
  const texts = bodies.map((b) => b.body.slice(0, 2000));
  const res = await sql`
    UPDATE items SET body = v.body
    FROM unnest(${sql.array(ids)}::bigint[], ${sql.array(texts)}::text[]) AS v(id, body)
    WHERE items.id = v.id
  `;
  return res.count;
}

/**
 * The enrichment queue. `story_id IS NULL` is the whole queue implementation
 * (ADR 0001: a cron tick and this query replace a job queue).
 */
export async function getPendingItems(lane: Lane, limit = 60): Promise<Item[]> {
  const sql = db();
  const rows = await sql`
    SELECT id::int AS id, source, external_id, lane_hint, url, title, body, author,
           engagement, published_at, fetched_at, story_id::int AS story_id
    FROM items
    WHERE story_id IS NULL AND lane_hint = ${lane}
    ORDER BY published_at DESC
    LIMIT ${limit}
  `;
  return rows.map(toItem);
}

export async function countPendingItems(lane?: Lane): Promise<number> {
  const sql = db();
  const rows = lane
    ? await sql`SELECT count(*)::int AS n FROM items WHERE story_id IS NULL AND lane_hint = ${lane}`
    : await sql`SELECT count(*)::int AS n FROM items WHERE story_id IS NULL`;
  return Number(rows[0].n);
}

/** Pre-filter rejects: stored for the record, never shown to the model. */
export async function markItemsFiltered(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const sql = db();
  const res = await sql`
    UPDATE items SET story_id = ${EXCLUDED_STORY_ID}
    WHERE id = ANY(${sql.array(ids)}::bigint[]) AND story_id IS NULL
  `;
  return res.count;
}

/** `items.body` is nulled after N days to keep the Free-plan database flat (ADR 0001). */
export async function pruneOldBodies(days = 30): Promise<number> {
  const sql = db();
  const res = await sql`
    UPDATE items SET body = NULL
    WHERE body IS NOT NULL AND published_at < now() - ${`${days} days`}::interval
  `;
  return res.count;
}

// ---- stories ----

/**
 * Context for the clustering call: stories still open in this lane, so an item
 * arriving at 11:00 can join a story created at 09:00 (ADR 0003). Highest score
 * first, because the cap is there to bound input tokens.
 */
export async function getOpenStories(lane: Lane, hours = 48, max = 150): Promise<Story[]> {
  const sql = db();
  const rows = await sql`
    SELECT id::int AS id, lane, title, summary_short, summary_detail, score,
           first_seen_at, updated_at, digested_at
    FROM stories
    WHERE lane = ${lane} AND updated_at > now() - ${`${hours} hours`}::interval
    ORDER BY score DESC, updated_at DESC
    LIMIT ${max}
  `;
  return rows.map(toStory);
}

export interface ApplyResult {
  created: number;
  updated: number;
  attached: number;
  dropped: number;
}

/**
 * The enrichment write path: one transaction per model response (ADR 0003).
 *
 * Only material updates bump `stories.updated_at`, because that column is what
 * makes the digest re-include a story and what orders the feed.
 */
export async function applyAssignments(lane: Lane, result: EnrichResult): Promise<ApplyResult> {
  const sql = db();
  const out: ApplyResult = { created: 0, updated: 0, attached: 0, dropped: 0 };

  await sql.begin(async (tx) => {
    for (const a of result.assignments) {
      let storyId: number;

      if (isNewStoryAssignment(a)) {
        const s = a.newStory;
        const [row] = await tx`
          INSERT INTO stories (lane, title, summary_short, summary_detail, score)
          VALUES (${s.lane ?? lane}, ${s.title}, ${s.summaryShort}, ${s.summaryDetail}, ${s.score})
          RETURNING id::int AS id
        `;
        storyId = Number(row.id);
        out.created += 1;
      } else {
        storyId = a.storyId;
        const sets: string[] = [];
        if (a.updatedShort !== undefined) sets.push('short');
        if (a.updatedDetail !== undefined) sets.push('detail');
        if (a.updatedScore !== undefined) sets.push('score');

        if (sets.length > 0) {
          const res = await tx`
            UPDATE stories SET
              summary_short  = COALESCE(${a.updatedShort ?? null}, summary_short),
              summary_detail = CASE WHEN ${a.updatedDetail !== undefined}
                                    THEN ${a.updatedDetail ?? null} ELSE summary_detail END,
              score          = COALESCE(${a.updatedScore ?? null}, score),
              updated_at     = now()
            WHERE id = ${storyId}
          `;
          out.updated += res.count;
        } else if (a.itemIds.length > 0) {
          // New sources on an unchanged story still count as movement.
          const res = await tx`UPDATE stories SET updated_at = now() WHERE id = ${storyId}`;
          out.updated += res.count;
        }
      }

      if (a.itemIds.length > 0) {
        const res = await tx`
          UPDATE items SET story_id = ${storyId}
          WHERE id = ANY(${tx.array(a.itemIds)}::bigint[]) AND lane_hint = ${lane}
        `;
        out.attached += res.count;
      }
    }

    if (result.dropped.length > 0) {
      const res = await tx`
        UPDATE items SET story_id = ${EXCLUDED_STORY_ID}
        WHERE id = ANY(${tx.array(result.dropped)}::bigint[]) AND story_id IS NULL
      `;
      out.dropped += res.count;
    }
  });

  return out;
}

/**
 * Digest selection (ADR 0004): score >= 4, never digested or changed since the
 * last digest, best first, capped per lane.
 */
export async function getDigestStories(lane: Lane, minScore = 4, limit = 8): Promise<Story[]> {
  const sql = db();
  const rows = await sql`
    SELECT id::int AS id, lane, title, summary_short, summary_detail, score,
           first_seen_at, updated_at, digested_at
    FROM stories
    WHERE lane = ${lane}
      AND score >= ${minScore}
      AND (digested_at IS NULL OR updated_at > digested_at)
    ORDER BY score DESC, updated_at DESC
    LIMIT ${limit}
  `;
  return rows.map(toStory);
}

/**
 * Called only after a 2xx from Discord. Marking and recording are one transaction
 * so a story can never be marked digested without a `digests` row explaining it.
 */
export async function recordDigest(
  lane: Lane,
  storyIds: number[],
  discordStatus: number,
): Promise<void> {
  const sql = db();
  await sql.begin(async (tx) => {
    if (storyIds.length > 0) {
      await tx`
        UPDATE stories SET digested_at = now()
        WHERE id = ANY(${tx.array(storyIds)}::bigint[])
      `;
    }
    await tx`
      INSERT INTO digests (lane, story_ids, discord_status)
      VALUES (${lane}, ${tx.json(storyIds as never)}, ${discordStatus})
    `;
  });
}

/** Default `--since` for `npm run digest`: the last successful digest, capped at 72 h. */
export async function getLastDigestAt(maxHours = 72): Promise<Date> {
  const sql = db();
  const rows = await sql`
    SELECT max(sent_at) AS last FROM digests WHERE discord_status BETWEEN 200 AND 299
  `;
  const cap = new Date(Date.now() - maxHours * 3600_000);
  const last = rows[0]?.last as Date | null;
  return last && last > cap ? last : cap;
}

// ---- feed ----

/**
 * One statement per feed page (ADR 0001). Keyset pagination on `(updated_at, id)`
 * so scrolling never skips or repeats a story when new ones land mid-scroll.
 */
export async function getFeedPage(opts: {
  lanes?: Lane[];
  minScore?: number;
  cursor?: FeedCursor | null;
  limit?: number;
}): Promise<FeedPage> {
  const sql = db();
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const minScore = opts.minScore ?? 3;
  const lanes = opts.lanes && opts.lanes.length > 0 ? opts.lanes : null;
  const cursor = opts.cursor ?? null;

  const rows = await sql`
    SELECT s.id::int AS id, s.lane, s.title, s.summary_short, s.summary_detail, s.score,
           s.first_seen_at, s.updated_at, s.digested_at, cnt.item_count
    FROM stories s
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS item_count FROM items i WHERE i.story_id = s.id
    ) cnt ON true
    WHERE s.score >= ${minScore}
      ${lanes ? sql`AND s.lane = ANY(${sql.array(lanes)}::text[])` : sql``}
      ${
        cursor
          ? sql`AND (s.updated_at, s.id) < (${cursor.updatedAt}::timestamptz, ${cursor.id}::bigint)`
          : sql``
      }
    ORDER BY s.updated_at DESC, s.id DESC
    LIMIT ${limit + 1}
  `;

  const page = rows.slice(0, limit);
  const stories: StoryWithCount[] = page.map((r) => ({
    ...toStory(r),
    itemCount: Number(r.item_count ?? 0),
  }));
  const last = stories[stories.length - 1];
  const nextCursor =
    rows.length > limit && last ? { updatedAt: last.updatedAt.toISOString(), id: last.id } : null;

  return { stories, nextCursor };
}

/** The expanded card and the `/story/[id]` permalink. */
export async function getStoryWithItems(id: number): Promise<StoryWithItems | null> {
  const sql = db();
  const [row] = await sql`
    SELECT id::int AS id, lane, title, summary_short, summary_detail, score,
           first_seen_at, updated_at, digested_at
    FROM stories WHERE id = ${id}
  `;
  if (!row) return null;

  const items = await sql`
    SELECT id::int AS id, source, url, title, author, engagement, published_at
    FROM items WHERE story_id = ${id}
    ORDER BY published_at DESC
    LIMIT 50
  `;

  return {
    ...toStory(row),
    items: items.map((r) => ({
      id: Number(r.id),
      source: r.source as string,
      url: r.url as string,
      title: r.title as string,
      author: (r.author as string | null) ?? null,
      engagement: (r.engagement as Item['engagement']) ?? {},
      publishedAt: r.published_at as Date,
    })),
  };
}

// ---- prices ----

export async function insertPriceSnapshots(
  snaps: Array<{ symbol: string; price: number; ts?: Date }>,
): Promise<number> {
  if (snaps.length === 0) return 0;
  const sql = db();
  const rows = snaps.map((s) => ({ symbol: s.symbol, price: s.price, ts: s.ts ?? new Date() }));
  const res = await sql`INSERT INTO price_snapshots ${sql(rows, 'symbol', 'price', 'ts')}`;
  return res.count;
}

/** Oldest snapshot inside the window, for 24 h move detection when the API omits it. */
export async function getPriceAt(symbol: string, hoursAgo: number): Promise<number | null> {
  const sql = db();
  const rows = await sql`
    SELECT price FROM price_snapshots
    WHERE symbol = ${symbol} AND ts <= now() - ${`${hoursAgo} hours`}::interval
    ORDER BY ts DESC LIMIT 1
  `;
  return rows[0] ? Number(rows[0].price) : null;
}

// ---- runs (the only observability, ADR 0001) ----

export async function startRun(job: string): Promise<number> {
  const sql = db();
  const [row] = await sql`INSERT INTO runs (job) VALUES (${job}) RETURNING id::int AS id`;
  return Number(row.id);
}

export async function finishRun(
  id: number,
  ok: boolean,
  counts: Record<string, unknown> = {},
  error?: string | null,
): Promise<void> {
  const sql = db();
  await sql`
    UPDATE runs
    SET finished_at = now(), ok = ${ok}, counts = ${sql.json(counts as never)},
        error = ${error ? String(error).slice(0, 4000) : null}
    WHERE id = ${id}
  `;
}

/** Convenience wrapper: start a run row, time the work, always close the row out. */
export async function withRun<T>(
  job: string,
  fn: () => Promise<{ result: T; counts?: Record<string, unknown> }>,
): Promise<T> {
  const runId = await startRun(job);
  try {
    const { result, counts } = await fn();
    await finishRun(runId, true, counts ?? {});
    return result;
  } catch (err) {
    await finishRun(runId, false, {}, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

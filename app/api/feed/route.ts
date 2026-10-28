import { NextResponse, type NextRequest } from 'next/server';
// Relative rather than `@/`: this module is unit-tested by vitest, which resolves
// no tsconfig `paths` alias, and vitest.config.ts is owned elsewhere.
import { getFeedPage, getStoryWithItems } from '../../../lib/db/queries';
import type { FeedCursor } from '../../../lib/db/types';
import {
  dayRange,
  isDay,
  parseDone,
  parseLanes,
  parseMinScore,
  parseSearch,
} from '../../../lib/feed/params';

// `postgres` is a node driver, and the feed is never cacheable.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

/**
 * `Date.parse` is far looser than Postgres' `timestamptz` parser — `Date.parse("5")`
 * and `Date.parse("2020")` both succeed, but `'5'::timestamptz` throws in Postgres,
 * which is what turned a bad cursor into a 500 instead of a 400. This matches the two
 * shapes a cursor can actually carry: JS `Date#toISOString()` (`T`-separated,
 * millisecond, `Z`) and Postgres' own `timestamptz::text` output (space-separated,
 * up to microsecond precision, `+00`/`+05:30`-style offset).
 */
const CURSOR_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/;

/**
 * Nothing from the query string is trusted: a bad lane would otherwise reach
 * Postgres as a text comparison and a bad cursor as a timestamptz cast, and the
 * cast is the one that turns a typo into a 500. The shared parsers in
 * lib/feed/params.ts do the reading; this route decides what is a 400.
 */
function parseIntIn(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function parseCursor(raw: string | null): FeedCursor | null | { error: string } {
  if (raw === null || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(atob(raw));
    if (typeof parsed !== 'object' || parsed === null) return { error: 'malformed cursor' };
    const { updatedAt, id } = parsed as { updatedAt?: unknown; id?: unknown };
    if (typeof updatedAt !== 'string' || !CURSOR_TIMESTAMP_RE.test(updatedAt)) {
      return { error: 'malformed cursor' };
    }
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
      return { error: 'malformed cursor' };
    }
    return { updatedAt, id };
  } catch {
    return { error: 'malformed cursor' };
  }
}

/** A day param is either absent, empty, or a real `YYYY-MM-DD`; anything else is a 400. */
function parseDay(raw: string | null, name: string): string | { error: string } {
  if (raw === null || raw.trim() === '') return '';
  const v = raw.trim();
  return isDay(v) ? v : { error: `${name} must be a date, YYYY-MM-DD` };
}

function isError(v: unknown): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in v;
}

/**
 * The regex above is the primary guard, but it is not the only way a query can
 * reach Postgres and fail (a transient connection drop, say). Whatever the cause,
 * a stack trace is not a response body: log it here, where the real error and
 * request still exist, and hand the client something that reveals nothing.
 */
function serverError(context: string, err: unknown): NextResponse {
  console.error(`[api/feed] ${context}:`, err);
  return NextResponse.json({ error: 'internal error' }, { status: 500 });
}

/**
 * Two modes on one handler.
 *
 * `?storyId=N` returns a single story with its items. It lives here rather than in
 * its own route file because the expanded card needs exactly one extra shape and a
 * second route module would add a file for four lines of handler.
 *
 * Otherwise: a keyset-paginated feed page, filtered by `lanes`, `minScore`, `done`,
 * a `from`..`to` window of calendar days and a `q` search (lib/feed/params.ts).
 * The cursor travels as base64 JSON, one opaque param the client hands straight back.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;

  const storyIdRaw = q.get('storyId');
  if (storyIdRaw !== null) {
    if (!/^\d+$/.test(storyIdRaw)) return badRequest('storyId must be a positive integer');
    const storyId = Number.parseInt(storyIdRaw, 10);
    if (!Number.isSafeInteger(storyId) || storyId <= 0) {
      return badRequest('storyId must be a positive integer');
    }
    let story;
    try {
      story = await getStoryWithItems(storyId);
    } catch (err) {
      return serverError(`getStoryWithItems(${storyId})`, err);
    }
    if (!story) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ story }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const { lanes, unknown } = parseLanes(q.get('lanes'));
  if (unknown.length > 0) return badRequest(`unknown lane: ${unknown.join(', ')}`);

  const cursor = parseCursor(q.get('cursor'));
  if (isError(cursor)) return badRequest(cursor.error);

  const from = parseDay(q.get('from'), 'from');
  if (isError(from)) return badRequest(from.error);
  const to = parseDay(q.get('to'), 'to');
  if (isError(to)) return badRequest(to.error);
  if (from && to && from > to) return badRequest('from must not be after to');
  const { since, until } = dayRange(from, to);

  const minScore = parseMinScore(q.get('minScore'));
  const limit = parseIntIn(q.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const done = parseDone(q.get('done'));
  const search = parseSearch(q.get('q'));

  let page;
  try {
    page = await getFeedPage({ lanes, minScore, cursor, limit, done, since, until, q: search });
  } catch (err) {
    return serverError('getFeedPage', err);
  }
  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } });
}

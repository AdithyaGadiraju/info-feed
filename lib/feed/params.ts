/**
 * The feed's query-string contract, shared by `/api/feed` (strict: a bad value is
 * a 400) and the home page (lenient: a bad value falls back to its default, so a
 * stale link still renders). The client omits every param at its default, so `/`
 * and `/api/feed` with no params are the same view: score 4+ plus the day's
 * picks, every lane, still to read, any time, no search.
 *
 * Pure functions with no Next or database imports, so vitest covers them without
 * either.
 */
import { isLane, type Lane } from '../db/types';
import { feedDayOf, feedDayStart, feedToday, isCalendarDay } from './time';

export const DEFAULT_MIN_SCORE = 4;
/** Longer than any query a person types; keeps a pasted novel out of the ILIKE. */
export const MAX_SEARCH_LENGTH = 200;
/** Each word becomes one ILIKE pattern; eight is plenty and bounds the statement. */
export const MAX_SEARCH_WORDS = 8;

/** `lanes=ai,markets`. Unknown names are reported, not silently dropped: the route 400s on them. */
export function parseLanes(raw: string | null): { lanes: Lane[]; unknown: string[] } {
  if (raw === null || raw.trim() === '') return { lanes: [], unknown: [] };
  const parts = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
  return { lanes: parts.filter(isLane), unknown: parts.filter((s) => !isLane(s)) };
}

/** `minScore=4`, clamped into 1..5; anything unreadable is the default. */
export function parseMinScore(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_MIN_SCORE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_MIN_SCORE;
  return Math.min(Math.max(n, 1), 5);
}

/**
 * `picks=0` (or `false`) hides the day's picks, the best score-3 stories that
 * the default view shows beside the 4+ ones. Anything else means show them.
 */
export function parsePicks(raw: string | null): boolean {
  if (raw === null) return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false');
}

/**
 * `done=1` (or `true`) is the done side of the feed. Anything else, including an
 * absent param, is the default: stories still to read. There is no "both" view,
 * so the two spellings of yes are all this accepts.
 */
export function parseDone(raw: string | null): boolean {
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * `from` and `to` travel as calendar days, `YYYY-MM-DD`, because that is what a
 * person picks and what reads well in a link. A day is real only if it survives a
 * round trip through Date: `2026-02-30` rolls over to March and is rejected.
 */
export function isDay(raw: string): boolean {
  return isCalendarDay(raw);
}

/** An instant as its feed (Sydney) calendar day `YYYY-MM-DD`, the inverse of `dayStart`. */
export function formatDay(d: Date): string {
  return feedDayOf(d);
}

/** Today in the feed's timezone (Sydney), whatever the server's or browser's zone. */
export function today(): string {
  return feedToday();
}

/**
 * Sydney midnight at the start of `day`, plus `plusDays` (FEED_TIME_ZONE), the
 * same zone the database groups days in and the page names today in, so
 * `from=today` means the same day on every end. Postgres is not asked to do
 * this: the pooler session runs in UTC, so a bare `::date` cast there would start
 * the day eleven hours late.
 */
export function dayStart(day: string, plusDays = 0): Date {
  return feedDayStart(day, plusDays);
}

/** The inclusive `from`..`to` days as a half-open timestamp range for the query. */
export function dayRange(from: string, to: string): { since: Date | null; until: Date | null } {
  return {
    since: from ? dayStart(from) : null,
    until: to ? dayStart(to, 1) : null,
  };
}

/** `q=godot splats`: trimmed, inner whitespace collapsed, capped. Empty means no search. */
export function parseSearch(raw: string | null): string {
  if (raw === null) return '';
  // The cap can split an emoji's surrogate pair; a lone half would match nothing.
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_LENGTH).replace(/[\uD800-\uDBFF]$/, '');
}

/**
 * The words a search must all match, each wrapped as an ILIKE pattern with the
 * pattern characters escaped, so a query for `100%` finds the literal text.
 */
export function searchPatterns(q: string): string[] {
  return q
    .split(' ')
    .filter((w) => w !== '')
    .slice(0, MAX_SEARCH_WORDS)
    .map((w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`);
}

/**
 * The feed's query-string contract, shared by `/api/feed` (strict: a bad value is
 * a 400) and the home page (lenient: a bad value falls back to its default, so a
 * stale link still renders). The client omits every param at its default, so `/`
 * and `/api/feed` with no params are the same view: score 3+, every lane, still
 * to read, any time, no search.
 *
 * Pure functions with no Next or database imports, so vitest covers them without
 * either.
 */
import { isLane, type Lane } from '../db/types';

export const DEFAULT_MIN_SCORE = 3;
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
 * `done=1` (or `true`) is the done side of the feed. Anything else, including an
 * absent param, is the default: stories still to read. There is no "both" view,
 * so the two spellings of yes are all this accepts.
 */
export function parseDone(raw: string | null): boolean {
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `from` and `to` travel as calendar days, `YYYY-MM-DD`, because that is what a
 * person picks and what reads well in a link. A day is real only if it survives a
 * round trip through Date: `2026-02-30` rolls over to March and is rejected.
 */
export function isDay(raw: string): boolean {
  const m = DAY_RE.exec(raw);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = localDate(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

/**
 * `new Date(y, m, d)` reads a year below 100 as 19xx, and a date input being typed
 * passes through exactly those years (`0002-10-29`, `0020-10-29`), so the pieces
 * are set explicitly. Rolls over like Date does: month 12 or day 0 are fine.
 */
function localDate(y: number, monthIndex: number, d: number): Date {
  const date = new Date(0);
  date.setFullYear(y, monthIndex, d);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** A Date as the local calendar day `YYYY-MM-DD`, the inverse of `dayStart`. */
export function formatDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today in the process timezone. The page computes it once so the client and server agree on it. */
export function today(): string {
  return formatDay(new Date());
}

/**
 * Local midnight at the start of `day`, plus `plusDays`. "Local" is the process
 * timezone (`TZ` in .env, the reader's own), which is also what the browser uses
 * to name today, so `from=today` means the same day on both ends. Postgres is not
 * asked to do this: the pooler session runs in UTC, so a bare `::date` cast there
 * would start the day eleven hours early.
 */
export function dayStart(day: string, plusDays = 0): Date {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`not a day: ${day}`);
  return localDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plusDays);
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
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_LENGTH);
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

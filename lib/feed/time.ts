/**
 * The feed's day is a Sydney day, everywhere: the server's date filters, the
 * "today" the page hands the browser, the day the database groups stories by
 * (`env.tz` defaults to this), and the event countdowns on the cards. The
 * process or browser timezone never decides which day an instant falls on.
 *
 * Pure functions with no Next, database or env imports, so client components
 * and vitest can use them. Only `Intl`, which carries the IANA tz database, so
 * daylight saving is handled without a dependency.
 */

export const FEED_TIME_ZONE = 'Australia/Sydney';

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad2 = (n: number) => String(n).padStart(2, '0');

/** A UTC Date for a calendar date, without `Date.UTC` reading years below 100 as 19xx. */
function utcDate(y: number, monthIndex: number, d: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(y, monthIndex, d);
  return date;
}

function dayOf(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function parse(day: string): { y: number; m: number; d: number } {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`not a day: ${day}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** `YYYY-MM-DD` that is a real calendar day: `2026-02-30` is not. No timezone involved. */
export function isCalendarDay(raw: string): boolean {
  const m = DAY_RE.exec(raw);
  if (!m) return false;
  return dayOf(utcDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) === raw;
}

/** Calendar arithmetic on a `YYYY-MM-DD`: `shiftDay('2026-03-01', -1)` is `2026-02-28`. */
export function shiftDay(day: string, days: number): string {
  const { y, m, d } = parse(day);
  return dayOf(utcDate(y, m - 1, d + days));
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock fields of an instant in `timeZone`. */
function wallClock(instant: Date, timeZone: string) {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) parts[p.type] = p.value;
  const year = Number(parts.year);
  return {
    // Intl names year 0 as "1 BC"; astronomical numbering keeps the arithmetic simple.
    y: parts.era === 'BC' || parts.era === 'B' ? 1 - year : year,
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour) % 24,
    mi: Number(parts.minute),
    s: Number(parts.second),
  };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in ms (Sydney: +10 h or +11 h). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = utcDate(w.y, w.mo - 1, w.d);
  asUtc.setUTCHours(w.h, w.mi, w.s, 0);
  const whole = new Date(instant.getTime());
  whole.setUTCMilliseconds(0);
  return asUtc.getTime() - whole.getTime();
}

/** The calendar day `YYYY-MM-DD` that `instant` falls on in the feed's timezone. */
export function feedDayOf(instant: Date, timeZone: string = FEED_TIME_ZONE): string {
  const w = wallClock(instant, timeZone);
  return `${String(w.y).padStart(4, '0')}-${pad2(w.mo)}-${pad2(w.d)}`;
}

/** Today in the feed's timezone. */
export function feedToday(now: Date = new Date(), timeZone: string = FEED_TIME_ZONE): string {
  return feedDayOf(now, timeZone);
}

/**
 * The real instant of midnight at the start of `day` (plus `plusDays`) in the
 * feed's timezone. Across a daylight-saving change the day is 23 or 25 hours
 * long, so the next day's start is computed, never added as 24 hours. Sydney
 * changes its clocks at 02:00/03:00, so midnight always exists exactly once.
 */
export function feedDayStart(day: string, plusDays = 0, timeZone: string = FEED_TIME_ZONE): Date {
  const { y, m, d } = parse(shiftDay(day, plusDays));
  const wallAsUtc = utcDate(y, m - 1, d).getTime();
  // Guess with the offset at the UTC midnight, then correct once with the offset
  // at the guess, which differs only when a clock change falls between them.
  let t = wallAsUtc - zoneOffsetMs(new Date(wallAsUtc), timeZone);
  t = wallAsUtc - zoneOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

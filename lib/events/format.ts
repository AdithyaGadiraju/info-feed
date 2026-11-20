/**
 * How an events story's facts are shown on the web card. Pure: no env, no database and no clock, so it
 * is safe in a client component and the tests control the date.
 *
 * Every date here is a calendar day, `YYYY-MM-DD`, as the organiser states it. No
 * time zone is applied to the day itself; `tz` is only used to find today's day
 * for the reader.
 */
import { eventActionDay, type EventFacts } from '../db/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The reminder window, in days. A countdown is shown only inside it. */
export const EVENT_SOON_DAYS = 3;

/** `2026-11-19` as "19 Nov 2026". */
export function formatEventDay(day: string, withYear = true): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1] ?? ''}${withYear ? ` ${y}` : ''}`;
}

/** "12-19 Nov 2026", "28 Nov - 2 Dec 2026", or one day. Null when no start is known. */
export function formatEventWhen(e: EventFacts): string | null {
  if (!e.starts) return null;
  if (!e.ends) return formatEventDay(e.starts);
  const [sy, sm] = e.starts.split('-');
  const [ey, em] = e.ends.split('-');
  if (sy === ey && sm === em) return `${Number(e.starts.slice(8))}-${formatEventDay(e.ends)}`;
  return `${formatEventDay(e.starts, sy !== ey)} - ${formatEventDay(e.ends)}`;
}

/** "Submit by 19 Nov 2026". Null when the event has no deadline. */
export function formatEventDeadline(e: EventFacts): string | null {
  return e.deadline ? `${e.deadlineLabel ?? 'Deadline'} ${formatEventDay(e.deadline)}` : null;
}

/**
 * Whole days from today in `tz` to the event's deadline, or to its start when it
 * has no deadline. Negative once the day has passed; null when it has neither.
 */
export function eventDaysLeft(e: EventFacts, now: Date, tz?: string): number | null {
  const day = eventActionDay(e);
  if (!day) return null;
  // en-CA formats a date as YYYY-MM-DD.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/** "Closes today", "Closes in 2 days", "Starts tomorrow", "Closed". Null when there is no date. */
export function eventCountdown(e: EventFacts, now: Date, tz?: string): string | null {
  const left = eventDaysLeft(e, now, tz);
  if (left === null) return null;
  const verb = e.deadline ? 'Closes' : 'Starts';
  if (left < 0) return e.deadline ? 'Closed' : 'Started';
  if (left === 0) return `${verb} today`;
  if (left === 1) return `${verb} tomorrow`;
  return `${verb} in ${left} days`;
}

/** True from `EVENT_SOON_DAYS` before the deadline (or start) until the day itself. */
export function eventIsSoon(e: EventFacts, now: Date, tz?: string): boolean {
  const left = eventDaysLeft(e, now, tz);
  return left !== null && left >= 0 && left <= EVENT_SOON_DAYS;
}


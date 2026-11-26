import { describe, expect, it } from 'vitest';
import { FEED_TIME_ZONE, feedDayOf, feedDayStart, feedToday, isCalendarDay, shiftDay } from '../../lib/feed/time';
import { dayRange, dayStart, formatDay, today } from '../../lib/feed/params';

/** Expected instants are written as UTC ISO strings, so these hold whatever TZ the process runs in. */
const iso = (d: Date) => d.toISOString();
const HOUR = 3_600_000;

describe('feed time zone', () => {
  it('is Sydney', () => {
    expect(FEED_TIME_ZONE).toBe('Australia/Sydney');
  });

  it('starts a standard-time day at 00:00 +10:00 and a summer day at 00:00 +11:00', () => {
    expect(iso(feedDayStart('2026-07-15'))).toBe('2026-07-14T14:00:00.000Z');
    expect(iso(feedDayStart('2026-01-15'))).toBe('2026-01-14T13:00:00.000Z');
  });

  it('makes the April DST change day 25 hours long', () => {
    // Sydney leaves daylight saving at 03:00 on Sunday 5 April 2026.
    const start = feedDayStart('2026-04-05');
    const end = feedDayStart('2026-04-05', 1);
    expect(iso(start)).toBe('2026-04-04T13:00:00.000Z');
    expect(iso(end)).toBe('2026-04-05T14:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(25 * HOUR);
  });

  it('makes the October DST change day 23 hours long', () => {
    // Sydney enters daylight saving at 02:00 on Sunday 4 October 2026.
    const start = feedDayStart('2026-10-04');
    const end = feedDayStart('2026-10-05');
    expect(iso(start)).toBe('2026-10-03T14:00:00.000Z');
    expect(iso(end)).toBe('2026-10-04T13:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR);
  });

  it('names the Sydney day of a UTC instant, which can be the next day', () => {
    // 20:00 UTC on 25 Nov is 07:00 on 26 Nov in Sydney (AEDT, +11).
    const instant = new Date('2026-11-25T20:00:00Z');
    expect(feedDayOf(instant)).toBe('2026-11-26');
    expect(feedToday(instant)).toBe('2026-11-26');
    expect(feedDayOf(new Date('2026-11-25T12:59:59.999Z'))).toBe('2026-11-25');
    expect(feedDayOf(new Date('2026-11-25T13:00:00Z'))).toBe('2026-11-26');
    expect(feedDayOf(instant, 'UTC')).toBe('2026-11-25');
  });

  it('round-trips a day through its start instant, DST days included', () => {
    for (const day of ['2026-04-05', '2026-04-06', '2026-10-04', '2026-10-05', '2026-12-31', '0020-01-01']) {
      expect(feedDayOf(feedDayStart(day))).toBe(day);
      expect(feedDayOf(new Date(feedDayStart(day, 1).getTime() - 1))).toBe(day);
    }
  });

  it('does calendar arithmetic and validation without a timezone', () => {
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-10-04', 1)).toBe('2026-10-05');
    expect(isCalendarDay('2024-02-29')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('0002-10-29')).toBe(true);
  });

  it('is what the feed params use for the date filter and today', () => {
    const { since, until } = dayRange('2026-04-05', '2026-04-05');
    expect(iso(since!)).toBe('2026-04-04T13:00:00.000Z');
    expect(iso(until!)).toBe('2026-04-05T14:00:00.000Z');
    expect(dayStart('2026-10-04', 1)).toEqual(feedDayStart('2026-10-05'));
    expect(formatDay(new Date('2026-11-25T20:00:00Z'))).toBe('2026-11-26');
    expect(today()).toBe(feedDayOf(new Date()));
  });
});

/**
 * How an events story's dates are shown in the digest and on the card. Pure
 * functions, so the clock and the time zone are arguments.
 */
import { describe, expect, it } from 'vitest';
import type { EventFacts } from '../../lib/db/types';
import {
  eventCountdown,
  eventDaysLeft,
  eventIsSoon,
  formatEventDay,
  formatEventDeadline,
  formatEventWhen,
} from '../../lib/events/format';

const TZ = 'Australia/Sydney';

function facts(over: Partial<EventFacts> = {}): EventFacts {
  return {
    kind: 'jam',
    starts: '2026-11-12',
    ends: '2026-11-19',
    deadline: '2026-11-19',
    deadlineLabel: 'Submit by',
    where: 'Online + San Francisco',
    cost: 'Free',
    prize: 'US$50k pool',
    ...over,
  };
}

/** Midday in Sydney on the given day. */
function sydney(day: string): Date {
  return new Date(`${day}T01:00:00Z`);
}

describe('formatting a day and a range', () => {
  it('writes a day as day, month, year', () => {
    expect(formatEventDay('2026-11-09')).toBe('9 Nov 2026');
  });

  it('shortens a range inside one month, and spells out one across months or years', () => {
    expect(formatEventWhen(facts())).toBe('12-19 Nov 2026');
    expect(formatEventWhen(facts({ starts: '2026-11-28', ends: '2026-12-02' }))).toBe('28 Nov - 2 Dec 2026');
    expect(formatEventWhen(facts({ starts: '2026-12-30', ends: '2027-01-02' }))).toBe('30 Dec 2026 - 2 Jan 2027');
  });

  it('shows one day for a one-day event and nothing when the start is unknown', () => {
    expect(formatEventWhen(facts({ ends: null }))).toBe('12 Nov 2026');
    expect(formatEventWhen(facts({ starts: null, ends: null }))).toBeNull();
  });

  it('labels the deadline, with a plain word when the label is missing', () => {
    expect(formatEventDeadline(facts())).toBe('Submit by 19 Nov 2026');
    expect(formatEventDeadline(facts({ deadlineLabel: null }))).toBe('Deadline 19 Nov 2026');
    expect(formatEventDeadline(facts({ deadline: null }))).toBeNull();
  });
});

describe('counting down', () => {
  it('counts whole days to the deadline in the reader time zone', () => {
    expect(eventDaysLeft(facts(), sydney('2026-11-17'), TZ)).toBe(2);
    // 13:30 UTC on the 18th is already the 19th in Sydney.
    expect(eventDaysLeft(facts(), new Date('2026-11-18T13:30:00Z'), TZ)).toBe(0);
    expect(eventDaysLeft(facts(), new Date('2026-11-18T13:30:00Z'), 'UTC')).toBe(1);
  });

  it('counts to the start when there is no deadline', () => {
    const talk = facts({ kind: 'talk', deadline: null, deadlineLabel: null, ends: null });
    expect(eventDaysLeft(talk, sydney('2026-11-11'), TZ)).toBe(1);
    expect(eventCountdown(talk, sydney('2026-11-11'), TZ)).toBe('Starts tomorrow');
    expect(eventCountdown(talk, sydney('2026-11-13'), TZ)).toBe('Started');
  });

  it('says closes in N days, tomorrow, today, then closed', () => {
    expect(eventCountdown(facts(), sydney('2026-11-10'), TZ)).toBe('Closes in 9 days');
    expect(eventCountdown(facts(), sydney('2026-11-18'), TZ)).toBe('Closes tomorrow');
    expect(eventCountdown(facts(), sydney('2026-11-19'), TZ)).toBe('Closes today');
    expect(eventCountdown(facts(), sydney('2026-11-20'), TZ)).toBe('Closed');
  });

  it('has no countdown without a date', () => {
    const open = facts({ starts: null, ends: null, deadline: null });
    expect(eventDaysLeft(open, sydney('2026-11-17'), TZ)).toBeNull();
    expect(eventCountdown(open, sydney('2026-11-17'), TZ)).toBeNull();
    expect(eventIsSoon(open, sydney('2026-11-17'), TZ)).toBe(false);
  });

  it('is soon from three days out until the day itself', () => {
    expect(eventIsSoon(facts(), sydney('2026-11-15'), TZ)).toBe(false);
    expect(eventIsSoon(facts(), sydney('2026-11-16'), TZ)).toBe(true);
    expect(eventIsSoon(facts(), sydney('2026-11-19'), TZ)).toBe(true);
    expect(eventIsSoon(facts(), sydney('2026-11-20'), TZ)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  dayRange,
  dayStart,
  formatDay,
  isDay,
  parseDone,
  parseLanes,
  parseMinScore,
  parseSearch,
  searchPatterns,
} from '../../lib/feed/params';

describe('feed query-string parsers', () => {
  it('reads lanes and reports the unknown ones instead of dropping them silently', () => {
    expect(parseLanes(null)).toEqual({ lanes: [], unknown: [] });
    expect(parseLanes(' ')).toEqual({ lanes: [], unknown: [] });
    expect(parseLanes('AI, markets')).toEqual({ lanes: ['ai', 'markets'], unknown: [] });
    expect(parseLanes('ai,wrestling,')).toEqual({ lanes: ['ai'], unknown: ['wrestling'] });
  });

  it('clamps minScore into 1..5 and falls back to 3', () => {
    expect(parseMinScore(null)).toBe(3);
    expect(parseMinScore('abc')).toBe(3);
    expect(parseMinScore('0')).toBe(1);
    expect(parseMinScore('99')).toBe(5);
    expect(parseMinScore('4')).toBe(4);
  });

  it('accepts only 1 and true as the done side', () => {
    expect(parseDone(null)).toBe(false);
    expect(parseDone('1')).toBe(true);
    expect(parseDone('TRUE')).toBe(true);
    expect(parseDone('0')).toBe(false);
    expect(parseDone('yes')).toBe(false);
  });

  it('accepts only real calendar days', () => {
    expect(isDay('2026-10-29')).toBe(true);
    expect(isDay('2024-02-29')).toBe(true);
    // Rolls over to March in Date, so it is not the day the link claims.
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-13-01')).toBe(false);
    expect(isDay('2026-1-1')).toBe(false);
    expect(isDay('2026-10-29T00:00:00Z')).toBe(false);
    expect(isDay('')).toBe(false);
    // A date input being typed passes through these; Date(y, m, d) would read them as 19xx.
    expect(isDay('0002-10-29')).toBe(true);
    expect(dayStart('0020-01-01').getFullYear()).toBe(20);
    expect(formatDay(dayStart('0020-01-01'))).toBe('0020-01-01');
    expect(formatDay(dayStart('2026-03-01', -1))).toBe('2026-02-28');
  });

  it('turns a day into local midnight, in the process timezone', () => {
    // vitest.config.ts pins TZ to Australia/Sydney; the test says so in the assertion
    // rather than assuming it, so a changed config fails here with a clear message.
    const start = dayStart('2026-10-29');
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(9);
    expect(start.getDate()).toBe(29);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getTimezoneOffset()).toBe(new Date(2026, 9, 29).getTimezoneOffset());

    const next = dayStart('2026-10-31', 1);
    expect(next.getMonth()).toBe(10);
    expect(next.getDate()).toBe(1);
  });

  it('builds a half-open range from inclusive from and to days', () => {
    expect(dayRange('', '')).toEqual({ since: null, until: null });
    const { since, until } = dayRange('2026-10-01', '2026-10-01');
    expect(since).toEqual(dayStart('2026-10-01'));
    // The whole of the "to" day is inside the window.
    expect(until).toEqual(dayStart('2026-10-02'));
    expect(dayRange('2026-10-01', '').until).toBeNull();
    expect(dayRange('', '2026-10-01').since).toBeNull();
  });

  it('normalises the search text and caps its length', () => {
    expect(parseSearch(null)).toBe('');
    expect(parseSearch('  godot   splats \n')).toBe('godot splats');
    expect(parseSearch('x'.repeat(500))).toHaveLength(200);
  });

  it('makes one ILIKE pattern per word with the pattern characters escaped', () => {
    expect(searchPatterns('')).toEqual([]);
    expect(searchPatterns('godot splats')).toEqual(['%godot%', '%splats%']);
    expect(searchPatterns('100% a_b c\\d')).toEqual(['%100\\%%', '%a\\_b%', '%c\\\\d%']);
    expect(searchPatterns(Array.from({ length: 12 }, (_, i) => `w${i}`).join(' '))).toHaveLength(8);
  });
});

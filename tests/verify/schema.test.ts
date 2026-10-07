import { describe, expect, it } from 'vitest';
import { MAX_NOTE_CHARS, MAX_SOURCES, validateVerdict } from '../../lib/verify/schema';

const source = (n: number) => ({ title: `Source ${n}`, url: `https://news.test/${n}` });

describe('validateVerdict', () => {
  it('accepts a well-formed verdict', () => {
    const result = validateVerdict({ verdict: 'confirmed', note: '  Announced on the lab blog. ', sources: [source(1)] });

    expect(result).toEqual({
      ok: true,
      value: { verdict: 'confirmed', note: 'Announced on the lab blog.', sources: [source(1)] },
    });
  });

  it('rejects a verdict outside the four', () => {
    const result = validateVerdict({ verdict: 'likely', note: 'x', sources: [] });

    expect(result.ok).toBe(false);
  });

  it('rejects an empty note', () => {
    expect(validateVerdict({ verdict: 'confirmed', note: '   ', sources: [] }).ok).toBe(false);
  });

  it('rejects a disputed or false verdict that cites nothing', () => {
    // Telling the reader a story is wrong has to come with the page that says so.
    expect(validateVerdict({ verdict: 'disputed', note: 'Denied.', sources: [] }).ok).toBe(false);
    expect(
      validateVerdict({ verdict: 'false', note: 'Retracted.', sources: [{ title: 'x', url: 'not a url' }] }).ok,
    ).toBe(false);
  });

  it('allows an unconfirmed verdict with no sources', () => {
    expect(validateVerdict({ verdict: 'unconfirmed', note: 'Single report.', sources: [] }).ok).toBe(true);
  });

  it('drops unusable sources, duplicates and anything past the cap', () => {
    const result = validateVerdict({
      verdict: 'confirmed',
      note: 'ok',
      sources: [
        { title: 'script', url: 'javascript:alert(1)' },
        source(1),
        source(1),
        'nonsense',
        source(2),
        source(3),
        source(4),
      ],
    });

    expect(result.ok && result.value.sources).toEqual([source(1), source(2), source(3)]);
    expect(MAX_SOURCES).toBe(3);
  });

  it('labels a source with its host when the title is missing', () => {
    const result = validateVerdict({ verdict: 'confirmed', note: 'ok', sources: [{ url: 'https://news.test/a' }] });

    expect(result.ok && result.value.sources).toEqual([{ title: 'news.test', url: 'https://news.test/a' }]);
  });

  it('clips a runaway note instead of rejecting it', () => {
    const result = validateVerdict({ verdict: 'unconfirmed', note: 'n'.repeat(1000), sources: [] });

    expect(result.ok && result.value.note.length).toBe(MAX_NOTE_CHARS);
    expect(result.ok && result.value.note.endsWith('…')).toBe(true);
  });
});

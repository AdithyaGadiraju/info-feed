import { describe, expect, it } from 'vitest';
import type { Story } from '../../lib/db/types';
import {
  buildGlossarySystemPrompt,
  buildGlossaryUserPrompt,
  mergeGlossary,
  parseGlossaryBackfill,
} from '../../lib/enrich/glossary';
import { buildSystemPrompt, GLOSSARY_RULES } from '../../lib/enrich/prompt';

function story(over: Partial<Story> = {}): Story {
  return {
    id: 7,
    lane: 'ai_gamedev',
    title: 'KittenTTS 2 released',
    summaryShort: 'KittenTTS 2 is an open-weight speech model.',
    summaryDetail: 'It converts text to audio via S3 codec tokens and a vocoder.',
    score: 4,
    glossary: [],
    products: [],
    firstSeenAt: new Date('2026-10-20T00:00:00Z'),
    updatedAt: new Date('2026-10-20T00:00:00Z'),
    digestedAt: null,
    verification: null,
    doneAt: null,
    ...over,
  };
}

describe('glossary prompts', () => {
  it('shares one set of term rules between enrichment and the backfill', () => {
    expect(buildSystemPrompt()).toContain(GLOSSARY_RULES);
    expect(buildGlossarySystemPrompt()).toContain(GLOSSARY_RULES);
  });

  it('shows each story with its id and both summaries', () => {
    const user = buildGlossaryUserPrompt([story(), story({ id: 8, summaryDetail: null })]);
    expect(user).toContain('STORIES (2)');
    expect(user).toContain('#7\nt: KittenTTS 2 released');
    expect(user).toContain('d: It converts text');
    expect(user).not.toMatch(/#8\n[^#]*d: /);
  });

  it('lists only the terms that still need a full definition', () => {
    const user = buildGlossaryUserPrompt([
      story({
        glossary: [
          { term: 'Vocoder', definition: 'Simple.' },
          { term: 'LoRA', definition: 'Simple.', full: 'Full.' },
        ],
      }),
    ]);
    expect(user).toContain('g: Vocoder\n');
    expect(buildGlossaryUserPrompt([story()])).not.toContain('g: ');
  });
});

describe('mergeGlossary', () => {
  const fresh = [{ term: 'vocoder', definition: 'New.', full: 'New full.' }];

  it('takes the fresh glossary when the story has none', () => {
    expect(mergeGlossary([], fresh)).toEqual(fresh);
  });

  it('never replaces a term that has a full definition', () => {
    const mine = { term: 'Vocoder', definition: 'Mine.', full: 'Mine in full.' };
    expect(mergeGlossary([mine], fresh)).toEqual([mine]);
  });

  it('fills a term without one, keeps its place, and ignores terms it never asked for', () => {
    const existing = [
      { term: 'Vocoder', definition: 'Old.' },
      { term: 'LoRA', definition: 'Old.' },
    ];
    const extra = { term: 'Codec', definition: 'Extra.', full: 'Extra.' };
    expect(mergeGlossary(existing, [...fresh, extra])).toEqual([fresh[0], existing[1]]);
  });
});

describe('parseGlossaryBackfill', () => {
  it('keeps only ids from the batch, first answer wins, and leaves skipped stories out', () => {
    const parsed = {
      stories: [
        { id: 7, glossary: [{ term: 'Vocoder', definition: 'Turns acoustic features into audio.' }] },
        { id: 7, glossary: [] },
        { id: 99, glossary: [] },
        { id: 8, glossary: 'bad' },
      ],
    };
    const out = parseGlossaryBackfill(parsed, [7, 8, 9]);
    expect([...out.keys()]).toEqual([7]);
    expect(out.get(7)).toEqual([{ term: 'Vocoder', definition: 'Turns acoustic features into audio.' }]);
  });

  it('returns nothing for a malformed response', () => {
    expect(parseGlossaryBackfill(null, [1]).size).toBe(0);
    expect(parseGlossaryBackfill({ stories: 'x' }, [1]).size).toBe(0);
  });
});

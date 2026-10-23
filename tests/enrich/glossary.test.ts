import { describe, expect, it } from 'vitest';
import type { Story } from '../../lib/db/types';
import {
  buildGlossarySystemPrompt,
  buildGlossaryUserPrompt,
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
    firstSeenAt: new Date('2026-10-20T00:00:00Z'),
    updatedAt: new Date('2026-10-20T00:00:00Z'),
    digestedAt: null,
    verification: null,
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

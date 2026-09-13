import { describe, expect, it } from 'vitest';
import type { Item, Story } from '../../lib/db/types';
import {
  buildSystemPrompt,
  buildUserPrompt,
  capBody,
  MAX_BODY_CHARS,
  PROMPT_VERSION,
  serialiseItems,
  serialiseStories,
} from '../../lib/enrich/prompt';

function item(over: Partial<Item> = {}): Item {
  return {
    id: 1,
    source: 'hn',
    externalId: 'x1',
    laneHint: 'ai',
    url: 'https://www.example.com/a/b?c=d',
    title: 'Acme Labs releases Nimbus 3',
    body: 'Acme Labs released Nimbus 3 today.',
    author: 'dang',
    engagement: { points: 340, comments: 87 },
    publishedAt: new Date('2026-09-13T04:12:00Z'),
    fetchedAt: new Date('2026-09-13T04:30:00Z'),
    storyId: null,
    ...over,
  };
}

function story(over: Partial<Story> = {}): Story {
  return {
    id: 45,
    lane: 'ai',
    title: 'Nimbus 3 rollout',
    summaryShort: 'Acme Labs started rolling out Nimbus 3.',
    summaryDetail: null,
    score: 4,
    firstSeenAt: new Date('2026-09-12T09:00:00Z'),
    updatedAt: new Date('2026-09-13T01:00:00Z'),
    digestedAt: null,
    ...over,
  };
}

describe('buildSystemPrompt', () => {
  const system = buildSystemPrompt();

  it('is byte-stable across calls, so the prompt cache can hit', () => {
    expect(buildSystemPrompt()).toBe(system);
    expect(buildSystemPrompt()).toBe(buildSystemPrompt());
  });

  it('carries no timestamp or other per-run content', () => {
    expect(system).not.toMatch(/20\d\d-\d\d-\d\d/);
  });

  it('states the assign-or-drop-exactly-once rule', () => {
    expect(system).toContain('assigned or dropped exactly once');
  });

  it('states the score rubric', () => {
    expect(system).toContain('frontier model release');
    expect(system).toContain('worth a line');
    for (const n of [1, 2, 3, 4, 5]) expect(system).toContain(`${n} =`);
  });

  it('states the summary rules', () => {
    expect(system).toContain('at most two sentences');
    expect(system).toContain('150-300 words');
    expect(system).toContain('score of 3, 4 or 5');
    expect(system).toContain('summaryDetail is exactly null');
  });

  it('asks for one JSON object and nothing else', () => {
    expect(system).toContain('Return ONE JSON object and nothing else');
  });

  it('is tracked by a version number', () => {
    expect(PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('serialiseItems', () => {
  it('is stable for the same input', () => {
    const items = [item(), item({ id: 2, title: 'Second' })];
    expect(serialiseItems(items)).toBe(serialiseItems(items));
  });

  it('leads with the id and stays compact', () => {
    const text = serialiseItems([item()]);
    expect(text.startsWith('#1 | hn | 2026-09-13 04:12 | example.com | pts=340 cmts=87')).toBe(true);
    expect(text).toContain('t: Acme Labs releases Nimbus 3');
    expect(text).toContain('b: Acme Labs released Nimbus 3 today.');
    // Four lines of labelled text, not a JSON object with repeated key names.
    expect(text.split('\n')).toHaveLength(3);
  });

  it('omits the body line when there is no body', () => {
    expect(serialiseItems([item({ body: null })])).not.toContain('b:');
  });

  it('omits engagement when the source reports none', () => {
    expect(serialiseItems([item({ engagement: {} })])).toContain('#1 | hn | 2026-09-13 04:12 | example.com\n');
  });

  it('caps bodies at 2000 characters', () => {
    const text = serialiseItems([item({ body: 'x'.repeat(9000) })]);
    const body = text.split('b: ')[1];
    expect(body.length).toBe(MAX_BODY_CHARS);
    expect(body.endsWith('…')).toBe(true);
  });

  it('collapses whitespace before capping so the cap buys real text', () => {
    expect(capBody('  a\n\n  b   c  ')).toBe('a b c');
    expect(capBody('y'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('serialiseStories', () => {
  it('gives the model the id, score, age, title and one-liner and nothing else', () => {
    const text = serialiseStories([story()]);
    expect(text).toBe(
      '#45 | score 4 | updated 2026-09-13 01:00\nt: Nimbus 3 rollout\ns: Acme Labs started rolling out Nimbus 3.',
    );
  });

  it('is stable for the same input', () => {
    const stories = [story(), story({ id: 46 })];
    expect(serialiseStories(stories)).toBe(serialiseStories(stories));
  });
});

describe('buildUserPrompt', () => {
  const items = [item({ id: 7 }), item({ id: 8 }), item({ id: 9 })];

  it('includes every pending item id', () => {
    const text = buildUserPrompt('ai', [story()], items);
    for (const i of items) expect(text).toContain(`#${i.id} |`);
    expect(text).toContain('NEW ITEMS (3)');
  });

  it('names the lane and the open stories', () => {
    const text = buildUserPrompt('betting', [story({ id: 45 })], items);
    expect(text).toContain('Lane: betting');
    expect(text).toContain('OPEN STORIES IN THIS LANE (1, last 48h)');
    expect(text).toContain('#45 | score 4');
  });

  it('says so plainly when the lane has no open stories', () => {
    const text = buildUserPrompt('ai', [], items);
    expect(text).toContain('OPEN STORIES IN THIS LANE: none');
  });

  it('is stable for the same input', () => {
    expect(buildUserPrompt('ai', [story()], items)).toBe(buildUserPrompt('ai', [story()], items));
  });
});

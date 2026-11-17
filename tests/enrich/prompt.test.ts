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
    glossary: [],
    products: [],
    event: null,
    summaryDetail: null,
    score: 4,
    firstSeenAt: new Date('2026-09-12T09:00:00Z'),
    updatedAt: new Date('2026-09-13T01:00:00Z'),
    digestedAt: null,
    verification: null,
    doneAt: null,
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
    const text = buildUserPrompt('betting', [], items);
    expect(text).toContain('OPEN STORIES IN THIS LANE: none');
  });

  it('offers every lane of a lane group and tags each open story with its lane', () => {
    const text = buildUserPrompt('ai_dev', [story({ id: 45 }), story({ id: 46, lane: 'ai_dev' })], items);
    expect(text).toContain('New stories go in ai_dev, ai, ai_gamedev or events by content');
    expect(text).toContain('- events: events and opportunities the reader could take part in');
    expect(text).toContain('- ai: AI news');
    expect(text).toContain('- ai_dev: making a developer');
    expect(text).toContain('- ai_gamedev: AI tools and models for making games');
    expect(text).toContain('OPEN STORIES IN LANES ai_dev, ai, ai_gamedev, events (2, last 48h');
    expect(text).toContain('#45 | ai | score 4');
    expect(text).toContain('#46 | ai_dev | score 4');
  });

  it('lets a gamedev batch file into events, and shows an open event with its facts', () => {
    const megajam = story({
      id: 77,
      lane: 'events',
      title: 'Epic AI MegaJam 2026',
      event: {
        kind: 'jam',
        starts: '2026-11-12',
        ends: '2026-11-19',
        deadline: '2026-11-19',
        deadlineLabel: 'Submit by',
        where: 'Online + San Francisco',
        cost: 'Free',
        prize: 'US$50k pool',
      },
    });
    const text = buildUserPrompt('gamedev', [megajam], items);
    expect(text).toContain('New stories go in gamedev or events by content');
    expect(text).toContain('#77 | events | score 4');
    expect(text).toContain(
      'e: jam | starts 2026-11-12 | ends 2026-11-19 | deadline 2026-11-19 (Submit by) | where Online + San Francisco | cost Free | prize US$50k pool',
    );
  });

  it('tells a batch that can file into events what day it is, and no other batch', () => {
    const line = 'Today is 2026-11-17.';
    expect(buildUserPrompt('gamedev', [], items, [], '2026-11-17')).toContain(line);
    expect(buildUserPrompt('events', [], items, [], '2026-11-17')).toContain(line);
    expect(buildUserPrompt('markets', [], items, [], '2026-11-17')).not.toContain(line);
    expect(buildUserPrompt('gamedev', [], items)).not.toContain('Today is');
  });

  it('keeps events out of a lane that does not feed it', () => {
    const text = buildUserPrompt('markets', [story({ lane: 'markets' })], items);
    expect(text).toContain('Lane: markets');
    expect(text).not.toContain('events');
  });

  it('is stable for the same input', () => {
    expect(buildUserPrompt('ai', [story()], items)).toBe(buildUserPrompt('ai', [story()], items));
  });
});

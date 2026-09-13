import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { EnrichResult, Item, Lane } from '../../lib/db/types';
import { buildSystemPrompt, buildUserPrompt } from '../../lib/enrich/prompt';
import { extractJsonObject, validateEnrichResult } from '../../lib/enrich/schema';
import { completeViaCli } from '../../lib/enrich/transport';

const PENDING = [1, 2, 3, 4];
const OPEN = [10, 11];

/** A response that satisfies every rule, used as the base for the negative cases. */
function validResponse(): Record<string, unknown> {
  return {
    assignments: [
      {
        itemIds: [1, 2],
        newStory: {
          lane: 'ai',
          title: 'Lab ships a new frontier model',
          summaryShort: 'A lab released a new frontier model. Pricing and limits are published.',
          summaryDetail: '**What happened.** A lab released a new model, per "Lab ships model".',
          score: 4,
        },
      },
      { itemIds: [3], storyId: 10, updatedShort: 'The rollout now covers every region.' },
    ],
    dropped: [4],
  };
}

function validate(body: unknown) {
  return validateEnrichResult(body, PENDING, OPEN);
}

describe('validateEnrichResult', () => {
  it('accepts a well-formed response', () => {
    const result = validate(validResponse());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.leftover).toEqual([]);
    expect(result.value.dropped).toEqual([4]);
    expect(result.value.assignments).toHaveLength(2);
  });

  it('rejects an item id that was not in the batch', () => {
    const body = validResponse();
    (body.assignments as Array<{ itemIds: number[] }>)[0].itemIds = [1, 99];
    const result = validate(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('99 was not in this batch');
  });

  it('rejects an item id assigned twice', () => {
    const body = validResponse();
    (body.assignments as Array<{ itemIds: number[] }>)[1].itemIds = [1, 3];
    const result = validate(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('already claimed');
  });

  it('rejects an item id both assigned and dropped', () => {
    const body = validResponse();
    body.dropped = [3, 4];
    const result = validate(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('already claimed');
  });

  it('rejects a detail summary on a score-2 story', () => {
    const body = validResponse();
    const story = (body.assignments as Array<{ newStory: Record<string, unknown> }>)[0].newStory;
    story.score = 2;
    const result = validate(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('must have summaryDetail null');
  });

  it('rejects a missing detail summary on a score-4 story', () => {
    const body = validResponse();
    const story = (body.assignments as Array<{ newStory: Record<string, unknown> }>)[0].newStory;
    story.summaryDetail = null;
    const result = validate(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('requires a summaryDetail');
  });

  it('rejects a storyId that is not open in this lane', () => {
    const body = validResponse();
    (body.assignments as Array<{ storyId?: number }>)[1].storyId = 77;
    const result = validate(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('77 is not an open story');
  });

  it('rejects a score outside 1..5 and a missing summaryShort', () => {
    const body = validResponse();
    const story = (body.assignments as Array<{ newStory: Record<string, unknown> }>)[0].newStory;
    story.score = 7;
    story.summaryShort = '';
    const result = validate(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('summaryShort is missing');
    expect(result.errors.join(' ')).toContain('is not 1-5');
  });

  it('rejects an updatedScore sent without an updatedDetail', () => {
    const body = validResponse();
    (body.assignments as Array<Record<string, unknown>>)[1].updatedScore = 4;
    const result = validate(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('without updatedDetail');
  });

  it('passes, and reports, item ids the model never mentioned', () => {
    const body = validResponse();
    body.dropped = [];
    const result = validate(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.leftover).toEqual([4]);
  });
});

describe('extractJsonObject', () => {
  const answer = { assignments: [], dropped: [1] };

  it('reads bare JSON', () => {
    expect(extractJsonObject(JSON.stringify(answer))).toEqual(answer);
  });

  it('reads a fenced block', () => {
    expect(extractJsonObject('```json\n' + JSON.stringify(answer) + '\n```')).toEqual(answer);
  });

  it('reads an object buried in prose with braces in its strings', () => {
    const text = `Here you go:\n{"assignments":[],"dropped":[1],"note":"a } brace"}\nDone.`;
    expect(extractJsonObject(text)).toMatchObject(answer);
  });

  it('throws when there is no object at all', () => {
    expect(() => extractJsonObject('sorry, I cannot do that')).toThrow(/no JSON object/);
  });
});

// ---- one live call, on Gadi's subscription ----

function claudeOnPath(): boolean {
  try {
    execFileSync('which', ['claude'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function liveItem(id: number, title: string, body: string): Item {
  return {
    id,
    source: 'hn',
    externalId: `live-${id}`,
    laneHint: 'ai' as Lane,
    url: `https://example.com/${id}`,
    title,
    body,
    author: null,
    engagement: { points: 120, comments: 30 },
    publishedAt: new Date('2026-09-13T02:00:00Z'),
    fetchedAt: new Date('2026-09-13T02:10:00Z'),
    storyId: null,
  };
}

/**
 * The only test that spends Gadi's subscription. Three tiny items, one call, one
 * assertion: the real CLI transport produces something this pipeline can write.
 * Do not add a second one and do not loop it.
 */
describe.skipIf(!claudeOnPath())('live claude CLI transport', () => {
  it(
    'returns JSON that parses and validates',
    async () => {
      const items = [
        liveItem(1, 'Acme Labs releases Nimbus 3, its new flagship model', 'Acme Labs today released Nimbus 3, a new flagship language model, priced at $2 per million input tokens.'),
        liveItem(2, 'Nimbus 3 is out', 'Discussion thread about the Acme Labs Nimbus 3 release and its pricing.'),
        liveItem(3, 'FREE CRYPTO GIVEAWAY click here now', 'Join our airdrop and claim 5000 tokens instantly, no strings attached.'),
      ];

      const completion = await completeViaCli(
        buildSystemPrompt(),
        buildUserPrompt('ai', [], items),
      );

      // stderr, not console.log: vitest swallows console output from a passing test
      // and this number is the whole point of running a live call.
      process.stderr.write(
        `\nlive call usage: in=${completion.usage.inputTokens} ` +
          `cacheWrite=${completion.usage.cacheCreationTokens} ` +
          `cacheRead=${completion.usage.cacheReadTokens} ` +
          `out=${completion.usage.outputTokens} cost=$${completion.costUsd ?? 0}\n`,
      );

      const parsed = extractJsonObject(completion.text);
      const result = validateEnrichResult(parsed, [1, 2, 3], []);
      if (!result.ok) throw new Error(`model broke the schema: ${result.errors.join('; ')}`);

      const value: EnrichResult = result.value;
      expect(value.assignments.length + value.dropped.length).toBeGreaterThan(0);
    },
    180_000,
  );
});

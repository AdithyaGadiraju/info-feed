import { describe, expect, it } from 'vitest';
import { applyScoreFloors } from '../../lib/enrich/floors';
import { buildUserPrompt } from '../../lib/enrich/prompt';
import { shouldExclude } from '../../lib/sources/index';
import type { EnrichResult, Item, NewStoryInput, Score } from '../../lib/db/types';
import type { RawItem, TwitterUserSpec } from '../../lib/sources/types';

const KARPATHY: TwitterUserSpec = {
  lane: 'ai_dev',
  userName: 'karpathy',
  userId: '33836629',
  note: 'productivity is high value',
  minScore: 4,
};

function item(id: number, author: string | null, source = 'twitter'): Item {
  return {
    id,
    source,
    externalId: `x${id}`,
    laneHint: 'ai_dev',
    url: `https://x.com/a/status/${id}`,
    title: `t${id}`,
    body: `b${id}`,
    author,
    engagement: { likes: 10 },
    publishedAt: new Date('2026-11-12T10:00:00Z'),
    fetchedAt: new Date('2026-11-12T10:05:00Z'),
    storyId: null,
  };
}

function story(score: Score): NewStoryInput {
  return {
    lane: 'ai_dev',
    title: 'T',
    summaryShort: 'S',
    summaryDetail: score >= 3 ? 'D' : null,
    score,
    glossary: [],
  };
}

describe('applyScoreFloors', () => {
  const items = [item(1, 'Karpathy'), item(2, 'someone'), item(3, 'karpathy')];

  it('raises a kept followed story scored 3 to the floor', () => {
    const r: EnrichResult = { assignments: [{ itemIds: [1], newStory: story(3) }], dropped: [] };
    const out = applyScoreFloors(r, items, [KARPATHY]);
    expect(out.result.assignments[0]).toMatchObject({ newStory: { score: 4, summaryDetail: 'D' } });
    expect(out.report.raised).toBe(1);
  });

  it('keeps a 5 at 5', () => {
    const r: EnrichResult = { assignments: [{ itemIds: [1], newStory: story(5) }], dropped: [] };
    expect(applyScoreFloors(r, items, [KARPATHY]).result.assignments[0]).toMatchObject({ newStory: { score: 5 } });
  });

  it('drops a followed-only story the model scored as noise', () => {
    const r: EnrichResult = { assignments: [{ itemIds: [1, 3], newStory: story(2) }], dropped: [9] };
    const out = applyScoreFloors(r, items, [KARPATHY]);
    expect(out.result.assignments).toEqual([]);
    expect(out.result.dropped).toEqual([9, 1, 3]);
    expect(out.report.droppedAsNoise).toBe(2);
  });

  it('leaves a mixed low story alone', () => {
    const r: EnrichResult = { assignments: [{ itemIds: [1, 2], newStory: story(2) }], dropped: [] };
    expect(applyScoreFloors(r, items, [KARPATHY]).result).toEqual(r);
  });

  it('raises a rescored update but leaves a plain attach alone', () => {
    const r: EnrichResult = {
      assignments: [
        { itemIds: [1], storyId: 50, updatedScore: 3, updatedDetail: 'D' },
        { itemIds: [3], storyId: 51 },
      ],
      dropped: [],
    };
    const out = applyScoreFloors(r, items, [KARPATHY]).result.assignments;
    expect(out[0]).toMatchObject({ updatedScore: 4 });
    expect(out[1]).toEqual({ itemIds: [3], storyId: 51 });
  });

  it('ignores non-twitter items with the same author', () => {
    const r: EnrichResult = { assignments: [{ itemIds: [4], newStory: story(3) }], dropped: [] };
    const out = applyScoreFloors(r, [item(4, 'karpathy', 'hn')], [KARPATHY]);
    expect(out.result).toEqual(r);
  });
});

describe('followed accounts in the prompt and pre-filter', () => {
  it('marks followed items and lists the account note only when present', () => {
    const withK = buildUserPrompt('ai_dev', [], [item(1, 'karpathy'), item(2, 'x')], [KARPATHY]);
    expect(withK).toContain('#1 | twitter | followed @karpathy');
    expect(withK).not.toContain('#2 | twitter | followed');
    expect(withK).toContain('- @karpathy (floor 4): productivity is high value');
    const without = buildUserPrompt('ai_dev', [], [item(2, 'x')], [KARPATHY]);
    expect(without).not.toContain('FOLLOWED ACCOUNTS IN THIS BATCH');
  });

  it('lets a followed account skip the likes threshold', () => {
    const raw = (author: string): RawItem => ({
      source: 'twitter',
      externalId: author,
      laneHint: 'ai_dev',
      url: 'https://x.com',
      title: 't',
      author,
      engagement: { likes: 5 },
      publishedAt: new Date(),
    });
    const thresholds = { redditTopN: 50, redditMinUpvotes: 0, hnMinPoints: 0, twitterMinLikes: 100 };
    expect(shouldExclude('twitter', raw('karpathy'), thresholds, [KARPATHY])).toBe(false);
    expect(shouldExclude('twitter', raw('nobody'), thresholds, [KARPATHY])).toBe(true);
  });
});

describe('retryPrompt', () => {
  it('appends the validator errors to the original prompt', async () => {
    const { retryPrompt } = await import('../../lib/enrich/run');
    const out = retryPrompt('ORIGINAL', ['a bad', 'b bad']);
    expect(out.startsWith('ORIGINAL\n\nYOUR PREVIOUS ANSWER WAS REJECTED')).toBe(true);
    expect(out).toContain('- a bad\n- b bad');
  });
});

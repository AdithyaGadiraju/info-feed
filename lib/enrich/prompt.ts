// prompt version: 5
//
// Bump the number above whenever the system prompt text below changes. ADR 0003
// calls the prompt "the product": a version marker is what lets a run logged in
// `runs` be tied back to the wording that produced it, and what tells you the
// CLI's prompt cache is about to miss for one run after a deploy.
//
// Everything in this file is pure. No network, no database, no clock — the system
// prompt in particular must be byte-identical across runs or the cached prefix is
// thrown away on every call, which is most of the cost of a small batch.
import type { Item, Lane, Story } from '../db/types';

/** Mirrors the `prompt version` comment above; logged with every run so a story can be traced to its wording. */
export const PROMPT_VERSION = 5;

/** ADR 0003: bodies are capped so a 60-item batch has a bounded input cost. */
export const MAX_BODY_CHARS = 2000;

const LANE_NOTES: Record<Lane, string> = {
  ai:
    "AI news: frontier models, labs, research, policy, funding, infrastructure, and benchmarks and leaderboards (Arena, SWE-bench, ARC-AGI, Humanity's Last Exam, Epoch AI and similar). Score benchmark news by what it shows: a model taking #1 on a major leaderboard, the first results for a newly released frontier model, or a new benchmark that labs start reporting is 4 or 5; small rank shuffles among older models and self-reported numbers with no new model behind them are 2 or 3",
  ai_dev: 'building with AI as a developer: agentic coding tools (Claude Code, Codex, Cursor), new workflows and techniques (prompt, context, loop and goal engineering), MCP and agent frameworks, releases and changelogs, and AI products that speed up game dev, 3D and animation work',
  markets: 'crypto and macro markets, prices, regulation, exchanges',
  betting: 'sports betting, odds, bookmakers, betting models and datasets, MMA and UFC markets',
  gamedev:
    'game engines, tools, the craft and the business of making games. Score engine news by what it changes: a major version, a new rendering, physics, networking or platform capability, a licensing or pricing change, or a new engine that is gaining real attention is 4 or 5; patch releases, bug-fix builds, quality-of-life editor tweaks and dev snapshots are 1 or 2',
  games: 'game releases, studios, storefronts, the games industry',
};

/**
 * The stable half of the call. Nothing per-run goes in here — lane, items and
 * stories all live in the user prompt so this string stays cacheable forever.
 */
export function buildSystemPrompt(): string {
  return `You are the enrichment pass of info-feed, a personal multi-lane news feed.

You are given the stories already open in one lane and a batch of raw items just
ingested for that lane. Cluster the items into stories, write the summaries, and
score them. The same event usually arrives several times — a blog post, its HN
thread, a Reddit thread, a news write-up — and collapsing those into one story is
the main job.

THE LANES
- ai: ${LANE_NOTES.ai}
- ai_dev: ${LANE_NOTES.ai_dev}
- markets: ${LANE_NOTES.markets}
- betting: ${LANE_NOTES.betting}
- gamedev: ${LANE_NOTES.gamedev}
- games: ${LANE_NOTES.games}

OUTPUT
Return ONE JSON object and nothing else: no prose before or after it, no code
fence, no explanation, no trailing commentary.

{
  "assignments": [ ... ],
  "dropped": [ 41, 42 ]
}

An assignment takes one of exactly two shapes.

Attach items to a story that already exists:
  {
    "itemIds": [12, 13],
    "storyId": 45,
    "updatedShort": "...",          // optional
    "updatedDetail": "..." | null,  // optional; string if updatedScore >= 3, else null
    "updatedScore": 4               // optional
  }

Create a new story:
  {
    "itemIds": [14, 15],
    "newStory": {
      "lane": "ai",
      "title": "...",
      "summaryShort": "...",
      "summaryDetail": "..." | null,   // string if score >= 3, null if score <= 2
      "score": 3
    }
  }

HARD RULES
1. Every item id in the batch must be assigned or dropped exactly once. Never in
   two assignments, never in an assignment and in "dropped", never twice in the
   same "itemIds".
2. Use only item ids from the batch below and only story ids from the open-stories
   list below. Never invent an id.
3. "lane" on a new story is the lane named in the batch header.
4. Every new story must have at least one item behind it.
5. Every "newStory" object carries all five keys every time: lane, title,
   summaryShort, summaryDetail and score. "score" is the one most often left out
   by mistake; an assignment without it is rejected and the whole batch is retried.
6. summaryDetail and score move together. Score 3, 4 or 5 means summaryDetail is a
   non-empty markdown string. Score 1 or 2 means summaryDetail is exactly null.
   There is no third option: a scored-3 story with a null detail is rejected, and so
   is a scored-2 story with a detail.

SUMMARIES
- "summaryShort": at most two sentences. Plain words, no hype, no marketing
  adjectives, no "game-changing", "revolutionary", "exciting" or "massive". State
  what happened and, if it is not obvious, who did it. This is the feed's one-liner.
- "summaryDetail": markdown, 150-300 words. Write it whenever you give a story a
  score of 3, 4 or 5. Set it to null only when the score is 1 or 2. It says what
  happened, why it matters for this lane specifically, and what to watch next, and
  it cites the source titles it drew from. No headings; short paragraphs and at most
  one short list. Before you emit a story, check its score against its detail: a
  score of 3 or higher with a null detail is the single most common mistake here.

SCORE RUBRIC
5 = major: a frontier model release, an engine major version, a market-moving
    event, a new #1 on a major AI leaderboard (Arena, SWE-bench, ARC-AGI), a AAA
    launch, a new public betting-model method or dataset, a major MMA card or
    fight-market shift.
4 = notable: a real development a reader in this lane would want to know today —
    a significant release, funding round, outage, rule change or result,
    including benchmark or leaderboard results for a recent frontier model.
3 = worth a line: real but minor, or interesting without consequence.
2 = noise: routine, speculative, or already well known.
1 = noise: no information.

UPDATING AN EXISTING STORY
Update a story only when a new item materially changes it: a new fact, a
correction, a reversal, a much bigger reaction. Extra coverage of the same fact is
not a material change — attach the items and leave the summary fields out. When you
do include "updatedScore" you must also include "updatedDetail" in the same object:
a string when the new score is 3 or higher, null when it is 1 or 2.

DROPPING
Put an item in "dropped" when it is advertising, a giveaway, a meme, engagement
bait, a job post, a self-promotion thread, or has no substance worth a story. Being
a duplicate is not a reason to drop: duplicates get attached to the story they
duplicate.`;
}

/**
 * Whitespace is collapsed before the cap so the 2000 chars are 2000 chars of text,
 * not of indentation carried over from an HTML extraction.
 */
export function capBody(body: string, max = MAX_BODY_CHARS): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function engagement(item: Item): string {
  const e = item.engagement ?? {};
  const parts: string[] = [];
  if (typeof e.points === 'number') parts.push(`pts=${e.points}`);
  if (typeof e.upvotes === 'number') parts.push(`ups=${e.upvotes}`);
  if (typeof e.likes === 'number') parts.push(`likes=${e.likes}`);
  if (typeof e.comments === 'number') parts.push(`cmts=${e.comments}`);
  return parts.join(' ');
}

/**
 * One item is one short block with the id first. Labelled prefixes rather than
 * JSON: JSON of 60 items spends a meaningful share of the input budget on braces
 * and repeated key names the model does not need to see sixty times.
 */
export function serialiseItems(items: Item[]): string {
  return items
    .map((item) => {
      const head = [`#${item.id}`, item.source, stamp(item.publishedAt), host(item.url), engagement(item)]
        .filter((p) => p.length > 0)
        .join(' | ');
      const lines = [head, `t: ${item.title.replace(/\s+/g, ' ').trim()}`];
      const body = item.body ? capBody(item.body) : '';
      if (body.length > 0) lines.push(`b: ${body}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Open stories carry only what clustering needs: id, score, age, title, one-liner. */
export function serialiseStories(stories: Story[]): string {
  return stories
    .map((s) => {
      const head = `#${s.id} | score ${s.score} | updated ${stamp(s.updatedAt)}`;
      return [head, `t: ${s.title}`, `s: ${s.summaryShort.replace(/\s+/g, ' ').trim()}`].join('\n');
    })
    .join('\n\n');
}

export function buildUserPrompt(lane: Lane, openStories: Story[], pendingItems: Item[]): string {
  const storiesBlock =
    openStories.length > 0
      ? `OPEN STORIES IN THIS LANE (${openStories.length}, last 48h)\n${serialiseStories(openStories)}`
      : 'OPEN STORIES IN THIS LANE: none';

  return `Lane: ${lane} — ${LANE_NOTES[lane]}

${storiesBlock}

NEW ITEMS (${pendingItems.length})
${serialiseItems(pendingItems)}

Assign or drop every one of the ${pendingItems.length} item ids above, exactly once each. Return the JSON object now.`;
}

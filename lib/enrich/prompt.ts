// prompt version: 6
//
// Bump the number above whenever the system prompt text below changes. ADR 0003
// calls the prompt "the product": a version marker is what lets a run logged in
// `runs` be tied back to the wording that produced it, and what tells you the
// CLI's prompt cache is about to miss for one run after a deploy.
//
// Everything in this file is pure. No network, no database, no clock — the system
// prompt in particular must be byte-identical across runs or the cached prefix is
// thrown away on every call, which is most of the cost of a small batch.
import { laneGroup, type Item, type Lane, type Story } from '../db/types';

/** Mirrors the `prompt version` comment above; logged with every run so a story can be traced to its wording. */
export const PROMPT_VERSION = 6;

/** ADR 0003: bodies are capped so a 60-item batch has a bounded input cost. */
export const MAX_BODY_CHARS = 2000;

const LANE_NOTES: Record<Lane, string> = {
  ai:
    "AI news, meaning everything about AI that does not help the reader get better results from AI tools: labs and the industry, funding and acquisitions, policy and regulation, AI security incidents and vulnerabilities (including ones in coding tools), hardware and infrastructure, models with no coding use, general research, and benchmarks and leaderboards (Arena, SWE-bench, ARC-AGI, Humanity's Last Exam, Epoch AI and similar). Score benchmark news by what it shows: a model taking #1 on a major leaderboard, the first results for a newly released frontier model, or a new benchmark that labs start reporting is 4 or 5; small rank shuffles among older models and self-reported numbers with no new model behind them are 2 or 3",
  ai_dev:
    "making a developer or game developer better and faster with AI. It covers how to get better results from a model or coding agent: official prompting and best-practice guides, and workflow and technique write-ups on CLAUDE.md and AGENTS.md, skills, subagents, hooks, context management, planning, verification loops and parallel agents. It covers ways to cut tokens, cost or latency. It covers plugins, skills, MCP servers and tools that raise code quality or throughput. It covers models a developer could code with: releases, availability in Claude Code, Codex, Copilot or Cursor, price and limit changes, and hands-on coding comparisons. It covers technical research on how an LLM feature behaves when that changes how to use it. It covers AI game development: coding agents and MCP servers for game engines (Godot, Unity, Unreal, Roblox), engine vendors' own AI features, and AI asset generation for games (3D models, textures, sprites and pixel art, rigging and animation, audio and voice, levels and worlds). Judge game asset tools by whether the output is usable in a shipped game: clean topology, rigging, PBR materials, an engine export path, a licence that allows commercial use, and evidence from real tests. A demo with no export path or a showcase with no method is 1 or 2. Score by how much the story would change how the reader works this week: an official prompting or best-practices guide for a current model, a coding-capable frontier model release, or a tool or technique with evidence that it cuts tokens or raises quality is 4 or 5; a solid practitioner technique or a useful new tool is 3 or 4; routine changelog versions, minor integrations, tool launches with no evidence, community anecdotes and opinion about the future of coding are 1 or 2",
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
3. "lane" on a new story is the lane named in the batch header, with one
   exception: in an ai or ai_dev batch, choose ai or ai_dev by what the story is
   about, not by where the item came from. A story that helps the reader get better
   results from AI tools goes in ai_dev; everything else about AI goes in ai. A
   security incident in a coding tool, an acquisition or a policy fight is ai even
   when it arrived from a coding-tool feed. Items in these batches may also attach
   to an open story in either lane.
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
- In an ai_dev story, the detail ends with a line that starts "**Try this:**" and
  names the one concrete thing to apply: the setting, prompt pattern, file, command,
  plugin or model to use, and where. If you cannot name one, the story either
  belongs in ai or deserves a lower score.

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
duplicate. Never create a placeholder story: an item you cannot summarise from its
title and body is dropped.`;
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

/**
 * Open stories carry only what clustering needs: id, score, age, title, one-liner.
 * `showLane` adds each story's lane, for a lane group whose stories span lanes.
 */
export function serialiseStories(stories: Story[], showLane = false): string {
  return stories
    .map((s) => {
      const head = `#${s.id}${showLane ? ` | ${s.lane}` : ''} | score ${s.score} | updated ${stamp(s.updatedAt)}`;
      return [head, `t: ${s.title}`, `s: ${s.summaryShort.replace(/\s+/g, ' ').trim()}`].join('\n');
    })
    .join('\n\n');
}

export function buildUserPrompt(lane: Lane, openStories: Story[], pendingItems: Item[]): string {
  const group = laneGroup(lane);
  const grouped = group.length > 1;
  const where = grouped ? `IN LANES ${group.join(', ')}` : 'IN THIS LANE';
  const storiesBlock =
    openStories.length > 0
      ? `OPEN STORIES ${where} (${openStories.length}, last 48h)\n${serialiseStories(openStories, grouped)}`
      : `OPEN STORIES ${where}: none`;
  const laneLine = grouped
    ? `Lane: ${lane}. New stories go in ${group.join(' or ')} by content (hard rule 3).\n` +
      group.map((l) => `- ${l}: ${LANE_NOTES[l]}`).join('\n')
    : `Lane: ${lane} — ${LANE_NOTES[lane]}`;

  return `${laneLine}

${storiesBlock}

NEW ITEMS (${pendingItems.length})
${serialiseItems(pendingItems)}

Assign or drop every one of the ${pendingItems.length} item ids above, exactly once each. Return the JSON object now.`;
}

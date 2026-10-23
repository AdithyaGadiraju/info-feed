// prompt version: 8
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
export const PROMPT_VERSION = 8;

/** ADR 0003: bodies are capped so a 60-item batch has a bounded input cost. */
export const MAX_BODY_CHARS = 2000;

const LANE_NOTES: Record<Lane, string> = {
  ai:
    "AI news, meaning everything about AI that does not help the reader get better results from AI tools: labs and the industry, funding and acquisitions, policy and regulation, AI security incidents and vulnerabilities (including ones in coding tools), hardware and infrastructure, models with no coding use, general research, and benchmarks and leaderboards (Arena, SWE-bench, ARC-AGI, Humanity's Last Exam, Epoch AI and similar). Score benchmark news by what it shows: a model taking #1 on a major leaderboard, the first results for a newly released frontier model, or a new benchmark that labs start reporting is 4 or 5; small rank shuffles among older models and self-reported numbers with no new model behind them are 2 or 3",
  ai_dev:
    "making a developer better and faster with AI coding tools. It covers how to get better results from a model or coding agent: official prompting and best-practice guides, and workflow and technique write-ups on CLAUDE.md and AGENTS.md, skills, subagents, hooks, context management, planning, verification loops and parallel agents. It covers ways to cut tokens, cost or latency. It covers plugins, skills, MCP servers and tools that raise code quality or throughput. It covers models a developer could code with: releases, availability in Claude Code, Codex, Copilot or Cursor, price and limit changes, and hands-on coding comparisons. It covers technical research on how an LLM feature behaves when that changes how to use it. AI tools for game engines and game assets go in ai_gamedev. Score by how much the story would change how the reader works this week: an official prompting or best-practices guide for a current model, a coding-capable frontier model release, or a tool or technique with evidence that it cuts tokens or raises quality is 4 or 5; a solid practitioner technique or a useful new tool is 3 or 4; routine changelog versions, minor integrations, tool launches with no evidence, community anecdotes and opinion about the future of coding are 1 or 2",
  ai_gamedev:
    "AI tools and models for making games. The reader is a solo developer who builds in Godot 4 with C# and models in Blender. It covers models and tools that generate game assets: text-to-3D and image-to-3D (Hunyuan3D, TRELLIS, Tripo, Rodin, Meshy and new open-weights models), textures and PBR materials, concept art, 2D art, sprites, pixel art and tilesets, rigging, animation, motion capture and retargeting, sound effects, music and voice, skyboxes, levels and worlds, gaussian splatting and world models. It covers Blender add-ons and MCP servers that let a model build, rig, texture or script in Blender; coding agents, MCP servers and assistants for game engines (Godot, Unity, Unreal, Roblox) and engine vendors' own AI features; runtime AI for games (NPCs, dialogue, AI-driven procedural generation) when it ships as a tool or SDK; and papers that release code or weights for any of these. The reader wants every new tool and model here, including niche ones from small teams and solo developers, so never drop or mark down a release for being obscure or new. Judge an asset tool by whether its output could go in a shipped game: an export path (GLB, FBX, OBJ, PNG sheets, WAV), clean topology, rigging, PBR maps, consistent style across sprites, a licence that allows commercial use, and evidence from real tests. Score by how much it could change how the reader makes a game: a new model or major version that beats the previous best for an asset type, or a Blender or engine integration that turns a prompt into a usable asset, is 5; any new tool, model, add-on or MCP server that produces something usable in a game, even a niche one, is 4; a paper with code or weights, a notable update to an existing tool, or a hands-on comparison or workflow write-up is 3; a showcase with no tool or method behind it, a demo nobody can use, funding with no product, and opinion about AI in games are 1 or 2. Lawsuits, layoffs, policy and platform rules about AI in games go in ai",
  markets: 'crypto and macro markets, prices, regulation, exchanges',
  betting: 'sports betting, odds, bookmakers, betting models and datasets, MMA and UFC markets',
  gamedev:
    'game engines, tools, the craft and the business of making games. Score engine news by what it changes: a major version, a new rendering, physics, networking or platform capability, a licensing or pricing change, or a new engine that is gaining real attention is 4 or 5; patch releases, bug-fix builds, quality-of-life editor tweaks and dev snapshots are 1 or 2',
  games: 'game releases, studios, storefronts, the games industry',
};

/**
 * How to pick and define glossary terms. Shared with scripts/glossary-backfill.ts
 * so a backfilled story's terms are chosen by the same rules as a fresh one's.
 */
export const GLOSSARY_RULES = `- "glossary": the jargon in the story's summaries, so a reader can look a term up
  without leaving the feed. The reader is a software developer: skip everyday
  developer words (API, repo, open source, pip, GPU, LLM, benchmark, SDK, CLI) and
  plain product or company names. Do define domain jargon from machine learning,
  audio, graphics, finance, betting, game engines and the like, such as "vocoder",
  "open-weight model", "codec tokens", "zero-shot cloning", "LoRA", "PBR",
  "funding rate" or "closing line value".
- Use only terms that appear in summaryShort or summaryDetail, written as they
  appear there, in the order they first appear. At most 6 terms; [] when there
  is no jargon, which is normal for many stories.
- Each "definition" is one plain sentence of at most 20 words that says what the
  thing is or does in general, not what this story says about it. No "refers to",
  no restating the term, no examples.
    {"term": "Vocoder", "definition": "Turns acoustic features such as a spectrogram into an audible waveform."}`;

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
- ai_gamedev: ${LANE_NOTES.ai_gamedev}
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
    "updatedScore": 4,              // optional
    "updatedGlossary": [ ... ]      // optional; required with updatedShort or updatedDetail
  }

Create a new story:
  {
    "itemIds": [14, 15],
    "newStory": {
      "lane": "ai",
      "title": "...",
      "summaryShort": "...",
      "summaryDetail": "..." | null,   // string if score >= 3, null if score <= 2
      "score": 3,
      "glossary": [ { "term": "...", "definition": "..." } ]   // may be []
    }
  }

HARD RULES
1. Every item id in the batch must be assigned or dropped exactly once. Never in
   two assignments, never in an assignment and in "dropped", never twice in the
   same "itemIds".
2. Use only item ids from the batch below and only story ids from the open-stories
   list below. Never invent an id.
3. "lane" on a new story is the lane named in the batch header, with one
   exception: in an ai, ai_dev or ai_gamedev batch, choose among those three by
   what the story is about, not by where the item came from. AI tools, models and
   techniques for making games and game assets go in ai_gamedev; a story that
   helps the reader get better results from AI coding tools goes in ai_dev;
   everything else about AI goes in ai. A security incident in a coding tool, an
   acquisition or a policy fight is ai even when it arrived from a coding-tool
   feed, and a Blender MCP server is ai_gamedev even when it arrived from an AI
   news feed. Items in these batches may also attach to an open story in any of
   the three lanes.
4. Every new story must have at least one item behind it.
5. Every "newStory" object carries all six keys every time: lane, title,
   summaryShort, summaryDetail, score and glossary. "score" is the one most often left out
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
- In an ai_gamedev story, the detail says how to get the tool (open weights, API,
  paid app, add-on, repo), what it costs if the items say, and what it exports.
  It ends with a "**Try this:**" line naming where to try it (a Hugging Face
  space, an API page, a repo, an add-on) and one asset to test it on.

GLOSSARY
${GLOSSARY_RULES}

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
a string when the new score is 3 or higher, null when it is 1 or 2. When you
include "updatedShort" or "updatedDetail", also include "updatedGlossary": the
complete glossary for the summaries as you have now written them. It replaces the
old one.

DROPPING
Put an item in "dropped" when it is advertising, a giveaway, a meme, engagement
bait, a job post, a self-promotion thread, or has no substance worth a story. One
exception: in ai_gamedev, a developer announcing a tool, model or add-on they
built is a release, not self-promotion; keep it when people can use the tool. Being
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
    ? `Lane: ${lane}. New stories go in ${group.slice(0, -1).join(', ')} or ${group.at(-1)} by content (hard rule 3).\n` +
      group.map((l) => `- ${l}: ${LANE_NOTES[l]}`).join('\n')
    : `Lane: ${lane} — ${LANE_NOTES[lane]}`;

  return `${laneLine}

${storiesBlock}

NEW ITEMS (${pendingItems.length})
${serialiseItems(pendingItems)}

Assign or drop every one of the ${pendingItems.length} item ids above, exactly once each. Return the JSON object now.`;
}

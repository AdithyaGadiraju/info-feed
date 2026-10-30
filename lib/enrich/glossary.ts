// prompt version: 2
//
// The glossary backfill: defines the jargon in stories written before enrichment
// produced a glossary, and writes full definitions for terms that only have a
// simple one. New stories never come through here; enrichment writes their
// glossary in the same call as the summary (lib/enrich/prompt.ts). The term rules
// are shared with that prompt so both paths pick the same kind of term.
//
// Pure, like the other prompt files: no network, no database, no clock.
import type { GlossaryTerm, Story } from '../db/types';
import { GLOSSARY_RULES } from './prompt';
import { GLOSSARY_SCHEMA, sanitizeGlossary } from './schema';

export const GLOSSARY_PROMPT_VERSION = 2;

export const GLOSSARY_BACKFILL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          glossary: GLOSSARY_SCHEMA,
        },
        required: ['id', 'glossary'],
        additionalProperties: false,
      },
    },
  },
  required: ['stories'],
  additionalProperties: false,
} as const;

export function buildGlossarySystemPrompt(): string {
  return `You write the glossary for stories in info-feed, a personal news feed.

You get a batch of stories, each with an id, a title and its summaries. For every
story, list the jargon in its summaries with a simple and a full definition of
each term.

RULES
${GLOSSARY_RULES}
- When a story has a "g:" line, its terms are already chosen: define exactly those
  terms, spelled as given, and no others.

OUTPUT
Return ONE JSON object and nothing else: no prose before or after it, no code
fence. Give every story in the batch exactly one entry, using the ids you were
given, including the stories whose glossary is [].

{
  "stories": [
    { "id": 12, "glossary": [ { "term": "...", "definition": "...", "full": "..." } ] },
    { "id": 13, "glossary": [] }
  ]
}`;
}

export function buildGlossaryUserPrompt(stories: Story[]): string {
  const blocks = stories.map((s) => {
    const lines = [`#${s.id}`, `t: ${s.title}`, `s: ${s.summaryShort.replace(/\s+/g, ' ').trim()}`];
    if (s.summaryDetail) lines.push(`d: ${s.summaryDetail.trim()}`);
    const missing = s.glossary.filter((t) => !t.full).map((t) => t.term);
    if (missing.length > 0) lines.push(`g: ${missing.join('; ')}`);
    return lines.join('\n');
  });
  return `STORIES (${stories.length})\n\n${blocks.join('\n\n')}\n\nReturn the JSON object now.`;
}

/**
 * The glossary to store for a story. A story with no glossary takes the fresh one.
 * A story with one keeps its terms and order, and only a term without a full
 * definition is replaced, so a hand-written definition survives every re-run.
 */
export function mergeGlossary(existing: GlossaryTerm[], fresh: GlossaryTerm[]): GlossaryTerm[] {
  if (existing.length === 0) return fresh;
  const byTerm = new Map(fresh.map((t) => [t.term.toLowerCase(), t]));
  return existing.map((t) => (t.full ? t : (byTerm.get(t.term.toLowerCase()) ?? t)));
}

/**
 * Glossaries by story id, for ids from this batch only. A story the model skipped
 * is simply absent, so its glossary stays NULL and the next backfill run retries it.
 */
export function parseGlossaryBackfill(parsed: unknown, batchIds: number[]): Map<number, GlossaryTerm[]> {
  const out = new Map<number, GlossaryTerm[]>();
  if (typeof parsed !== 'object' || parsed === null) return out;
  const stories = (parsed as { stories?: unknown }).stories;
  if (!Array.isArray(stories)) return out;

  const wanted = new Set(batchIds);
  for (const entry of stories) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, glossary } = entry as { id?: unknown; glossary?: unknown };
    if (typeof id !== 'number' || !wanted.has(id) || out.has(id) || !Array.isArray(glossary)) continue;
    out.set(id, sanitizeGlossary(glossary));
  }
  return out;
}

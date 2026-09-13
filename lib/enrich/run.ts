/**
 * The enrichment run: pending items in, stories out, one model call per chunk
 * (ADR 0003).
 *
 * Everything here is arranged around one rule — a failed run must leave the queue
 * exactly as it found it. `story_id IS NULL` is the queue, so doing nothing on
 * failure is the correct recovery: the next run picks the same items up again.
 */
import {
  applyAssignments,
  countPendingItems,
  finishRun,
  getOpenStories,
  getPendingItems,
  startRun,
} from '../db/queries';
import type { Item, Lane, Story } from '../db/types';
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from './prompt';
import { extractJsonObject, validateEnrichResult } from './schema';
import { addUsage, complete, EMPTY_USAGE, formatUsage, sumUsage, type TokenUsage } from './transport';

/** ADR 0003: one call per lane per run, chunked at 60 pending items. */
export const CHUNK_SIZE = 60;
const OPEN_STORY_HOURS = 48;
const OPEN_STORY_MAX = 150;
/** Three attempts total per chunk: the call, then two retries (ADR 0003). */
const MAX_ATTEMPTS = 3;

export interface EnrichLaneResult {
  created: number;
  updated: number;
  dropped: number;
  /** One entry per model call, so a multi-chunk run can be read call by call. */
  usage: TokenUsage[];
  costUsd: number;
}

export interface EnrichLaneOptions {
  /** Hard cap on items sent to the model this run. Undefined means "the whole queue". */
  maxItems?: number;
  chunkSize?: number;
}

function emptyResult(): EnrichLaneResult {
  return { created: 0, updated: 0, dropped: 0, usage: [], costUsd: 0 };
}

/**
 * One chunk: build the prompt, call, parse, validate. Retries live here rather than
 * around the write so a retry never re-applies a partially written batch.
 */
async function enrichChunk(
  lane: Lane,
  items: Item[],
  stories: Story[],
): Promise<{ usage: TokenUsage[]; costUsd: number } & (
  | { ok: true; applied: { created: number; updated: number; dropped: number }; leftover: number[] }
  | { ok: false; error: string }
)> {
  const system = buildSystemPrompt();
  const user = buildUserPrompt(lane, stories, items);
  const pendingIds = items.map((i) => i.id);
  const openIds = stories.map((s) => s.id);

  const usage: TokenUsage[] = [];
  let costUsd = 0;
  let lastError = 'no attempt was made';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const completion = await complete(system, user);
      usage.push(completion.usage);
      costUsd += completion.costUsd ?? 0;

      const parsed = extractJsonObject(completion.text);
      const validated = validateEnrichResult(parsed, pendingIds, openIds);
      if (!validated.ok) {
        lastError = `schema mismatch: ${validated.errors.slice(0, 5).join('; ')}`;
        console.warn(`enrich ${lane}: attempt ${attempt} rejected — ${lastError}`);
        continue;
      }

      if (validated.leftover.length > 0) {
        // Not a failure: these ids keep story_id NULL and the next run sees them.
        console.warn(
          `enrich ${lane}: ${validated.leftover.length} item(s) left pending — ${validated.leftover.join(', ')}`,
        );
      }

      const applied = await applyAssignments(lane, validated.value);
      return {
        ok: true,
        usage,
        costUsd,
        applied: { created: applied.created, updated: applied.updated, dropped: applied.dropped },
        leftover: validated.leftover,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn(`enrich ${lane}: attempt ${attempt} failed — ${lastError}`);
    }
  }

  return { ok: false, usage, costUsd, error: lastError };
}

/**
 * Enrich one lane. Never calls the model when the lane's queue is empty — an empty
 * call still costs the ~14k-token system-prompt overhead and returns nothing.
 */
export async function enrichLane(
  lane: Lane,
  opts: EnrichLaneOptions = {},
): Promise<EnrichLaneResult> {
  const chunkSize = Math.min(Math.max(opts.chunkSize ?? CHUNK_SIZE, 1), CHUNK_SIZE);
  const cap = opts.maxItems ?? Number.POSITIVE_INFINITY;

  if (cap < 1) return emptyResult();
  if ((await countPendingItems(lane)) === 0) return emptyResult();

  const runId = await startRun(`enrich:${lane}`);
  const out = emptyResult();
  let itemsIn = 0;
  let error: string | null = null;

  try {
    let remaining = cap;
    while (remaining >= 1) {
      const take = Math.min(chunkSize, remaining);
      const items = await getPendingItems(lane, take);
      if (items.length === 0) break;

      const stories = await getOpenStories(lane, OPEN_STORY_HOURS, OPEN_STORY_MAX);
      const chunk = await enrichChunk(lane, items, stories);
      out.usage.push(...chunk.usage);
      out.costUsd += chunk.costUsd;

      if (!chunk.ok) {
        // Items stay pending for the next run; stop rather than burn the same
        // failure on the next chunk of the same lane.
        error = chunk.error;
        break;
      }

      itemsIn += items.length;
      out.created += chunk.applied.created;
      out.updated += chunk.applied.updated;
      out.dropped += chunk.applied.dropped;
      remaining -= items.length;

      // A leftover id is still pending, so refetching would hand it back forever.
      if (chunk.leftover.length > 0) break;
      if (items.length < take) break;
    }

    const total = sumUsage(out.usage);
    await finishRun(runId, error === null, {
      lane,
      itemsIn,
      calls: out.usage.length,
      storiesCreated: out.created,
      storiesUpdated: out.updated,
      itemsDropped: out.dropped,
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      cacheCreationTokens: total.cacheCreationTokens,
      cacheReadTokens: total.cacheReadTokens,
      costUsd: Number(out.costUsd.toFixed(6)),
      promptVersion: PROMPT_VERSION,
    }, error);

    console.log(
      `enrich ${lane}: ${itemsIn} items in, ${out.created} created, ${out.updated} updated, ` +
        `${out.dropped} dropped, ${out.usage.length} call(s) | ${formatUsage(total, out.costUsd)}`,
    );
    if (error) console.error(`enrich ${lane}: FAILED — ${error} (items stay pending)`);

    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRun(runId, false, { lane, itemsIn }, message);
    throw err;
  }
}

export { EMPTY_USAGE, addUsage, formatUsage, sumUsage };
export type { TokenUsage };

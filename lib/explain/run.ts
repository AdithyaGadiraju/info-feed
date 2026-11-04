/**
 * The products & tech pass: explains the niche products and technologies stories
 * name, a batch of stories per web-search model call.
 *
 * It is separate from enrichment because it searches the web, and most of what it
 * explains is too new to be in the model's training data. Batching keeps the fixed
 * per-call overhead to one call per BATCH_SIZE stories; the model only searches for
 * the names it does not know.
 *
 * `products IS NULL` is the queue, like `story_id IS NULL` for enrichment: a batch
 * that fails writes nothing and its stories are picked up again next time.
 */
import { finishRun, getStoriesWithoutProducts, getStorySources, setProducts, startRun } from '../db/queries';
import type { Story, StorySource } from '../db/types';
import { extractJsonObject } from '../enrich/schema';
import {
  complete,
  sumUsage,
  type CompletionOptions,
  type CompletionResult,
  type TokenUsage,
} from '../enrich/transport';
import { buildExplainSystemPrompt, buildExplainUserPrompt, EXPLAIN_PROMPT_VERSION } from './prompt';
import { EXPLAIN_JSON_SCHEMA, parseExplainResult } from './schema';

/** Stories per model call. Small enough that a batch's searches fit in the timeout. */
export const BATCH_SIZE = 6;
/** A batch may run several searches and page reads, so it gets the CLI's full ceiling. */
const EXPLAIN_TIMEOUT_MS = 300_000;

export interface ExplainResult {
  /** Stories whose section was written, including the ones written as []. */
  written: number;
  /** Stories left NULL, because their batch failed or the model skipped them. */
  skipped: number;
  /** Entries written across all stories. */
  entries: number;
  calls: number;
  usage: TokenUsage;
  costUsd: number;
}

export interface ExplainDeps {
  /** Injectable so tests never spawn the CLI or touch the network. */
  completer?: (system: string, user: string, opts: CompletionOptions) => Promise<CompletionResult>;
  loadSources?: (ids: number[]) => Promise<Map<number, StorySource[]>>;
  write?: typeof setProducts;
  log?: (line: string) => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Explains the given stories and writes the results. Never throws for a failed batch. */
export async function explainStories(stories: Story[], deps: ExplainDeps = {}): Promise<ExplainResult> {
  const completer = deps.completer ?? complete;
  const write = deps.write ?? setProducts;
  const log = deps.log ?? console.log;
  const result: ExplainResult = { written: 0, skipped: 0, entries: 0, calls: 0, usage: sumUsage([]), costUsd: 0 };
  if (stories.length === 0) return result;

  let sources = new Map<number, StorySource[]>();
  try {
    sources = await (deps.loadSources ?? getStorySources)(stories.map((s) => s.id));
  } catch (err) {
    // The summaries are enough to search on; the links only help.
    log(`explain: could not load source items: ${errorText(err)}`);
  }

  const batches: Story[][] = [];
  for (let i = 0; i < stories.length; i += BATCH_SIZE) batches.push(stories.slice(i, i + BATCH_SIZE));

  const system = buildExplainSystemPrompt();
  const usage: TokenUsage[] = [];

  // The transport's LLM_CONCURRENCY slot is what bounds how many run at once.
  await Promise.all(
    batches.map(async (batch, n) => {
      const ids = batch.map((s) => s.id);
      try {
        const completion = await completer(system, buildExplainUserPrompt(batch, sources), {
          schema: EXPLAIN_JSON_SCHEMA,
          webSearch: true,
          effort: 'low',
          timeoutMs: EXPLAIN_TIMEOUT_MS,
        });
        result.calls += 1;
        usage.push(completion.usage);
        result.costUsd += completion.costUsd ?? 0;

        const text = new Map(
          batch.map((s) => [s.id, [s.title, s.summaryShort, s.summaryDetail ?? ''].join('\n')]),
        );
        const byId = parseExplainResult(extractJsonObject(completion.text), ids, text);
        const rows = [...byId].map(([id, products]) => ({ id, products }));
        // Awaited first: `written += await ...` reads `written` before the await,
        // so batches finishing in parallel would overwrite each other's count.
        const count = await write(rows);
        result.written += count;
        result.entries += rows.reduce((sum, r) => sum + r.products.length, 0);
        const missed = ids.length - byId.size;
        log(`explain batch ${n + 1}/${batches.length}: ${byId.size} written` + (missed > 0 ? `, ${missed} skipped` : ''));
      } catch (err) {
        log(`explain batch ${n + 1}/${batches.length} failed: ${errorText(err)}`);
      }
    }),
  );

  result.skipped = stories.length - result.written;
  result.usage = sumUsage(usage);
  return result;
}

/**
 * Picks stories without a products section and explains them, recording a `runs`
 * row. The worker calls this after enrichment with `since`, so it only takes new
 * stories; the backfill script calls it without.
 */
export async function explainPending(opts: {
  minScore: number;
  max: number;
  since?: Date | null;
  job?: string;
}): Promise<ExplainResult & { picked: number }> {
  const stories = await getStoriesWithoutProducts(opts.minScore, opts.max, opts.since ?? null);
  if (stories.length === 0) {
    return { picked: 0, written: 0, skipped: 0, entries: 0, calls: 0, usage: sumUsage([]), costUsd: 0 };
  }

  // The run row records the work and must never be the reason it does not happen.
  let runId: number | null = null;
  try {
    runId = await startRun(opts.job ?? 'explain');
  } catch (err) {
    console.warn(`explain: could not open a runs row: ${errorText(err)}`);
  }

  const result = await explainStories(stories);

  if (runId !== null) {
    try {
      await finishRun(
        runId,
        result.skipped === 0,
        {
          picked: stories.length,
          written: result.written,
          skipped: result.skipped,
          entries: result.entries,
          calls: result.calls,
          costUsd: Number(result.costUsd.toFixed(6)),
          promptVersion: EXPLAIN_PROMPT_VERSION,
        },
        result.skipped > 0 ? `${result.skipped} of ${stories.length} stories not written` : null,
      );
    } catch (err) {
      console.warn(`explain: could not close runs row ${runId}: ${errorText(err)}`);
    }
  }

  return { picked: stories.length, ...result };
}

/**
 * Only stories first seen in this window, so the digest and the worker never
 * wander into the backlog (scripts/products-backfill.ts is for that), and at most
 * this many per run, so one busy run stays bounded.
 */
const NEW_STORY_WINDOW_MS = 3 * 86_400_000;
const NEW_STORY_MAX = 40;
/** The feed's default score filter: nothing below it is shown unless asked for. */
const NEW_STORY_MIN_SCORE = 3;

/** The pass `npm run digest` and the worker run after enrichment. */
export function explainNewStories(now = new Date()): Promise<ExplainResult & { picked: number }> {
  return explainPending({
    minScore: NEW_STORY_MIN_SCORE,
    max: NEW_STORY_MAX,
    since: new Date(now.getTime() - NEW_STORY_WINDOW_MS),
  });
}

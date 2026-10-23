/**
 * One-off glossary backfill for stories written before enrichment produced one.
 *
 * Picks stories whose glossary is NULL, newest first, and defines their jargon in
 * batches. Safe to re-run: a written glossary (even an empty one) is never picked
 * again, and a story the model skipped stays NULL for the next run. `--max` caps
 * the spend, as in enrich-once.
 *
 *   npx tsx scripts/glossary-backfill.ts                 # 50 newest, score >= 3
 *   npx tsx scripts/glossary-backfill.ts --max 500 --min-score 1
 */
import { closeDb, withDb } from '../lib/db/client';
import { getStoriesWithoutGlossary, setGlossaries } from '../lib/db/queries';
import {
  buildGlossarySystemPrompt,
  buildGlossaryUserPrompt,
  GLOSSARY_BACKFILL_JSON_SCHEMA,
  parseGlossaryBackfill,
} from '../lib/enrich/glossary';
import { extractJsonObject } from '../lib/enrich/schema';
import { complete, formatUsage, sumUsage, type TokenUsage } from '../lib/enrich/transport';
import { env } from '../lib/env';

const DEFAULT_MAX = 50;
/** The feed's default score filter: stories below it are not shown unless asked for. */
const DEFAULT_MIN_SCORE = 3;
const BATCH_SIZE = 20;

function parseArgs(argv: string[]): { max: number; minScore: number } {
  let max = DEFAULT_MAX;
  let minScore = DEFAULT_MIN_SCORE;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = Number(argv[i + 1]);
    i += 1;
    if (arg === '--max') {
      if (!Number.isInteger(value) || value < 1) throw new Error('--max needs a positive integer');
      max = value;
    } else if (arg === '--min-score') {
      if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error('--min-score needs 1-5');
      minScore = value;
    } else {
      throw new Error(`unknown flag ${arg}. Usage: --max <n> --min-score <1-5>`);
    }
  }

  return { max, minScore };
}

async function main(): Promise<void> {
  const { max, minScore } = parseArgs(process.argv.slice(2));
  const stories = await getStoriesWithoutGlossary(minScore, max);

  console.log(
    `glossary-backfill — transport ${env.llmTransport}, model ${env.llmModel}, ` +
      `${stories.length} story(ies) without a glossary at score >= ${minScore}`,
  );
  if (stories.length === 0) return;

  const batches: (typeof stories)[] = [];
  for (let i = 0; i < stories.length; i += BATCH_SIZE) batches.push(stories.slice(i, i + BATCH_SIZE));

  const system = buildGlossarySystemPrompt();
  const usage: TokenUsage[] = [];
  let costUsd = 0;
  let written = 0;
  let terms = 0;

  // The transport's LLM_CONCURRENCY slot is what bounds how many run at once.
  await Promise.all(
    batches.map(async (batch, n) => {
      const ids = batch.map((s) => s.id);
      try {
        const completion = await complete(system, buildGlossaryUserPrompt(batch), {
          schema: GLOSSARY_BACKFILL_JSON_SCHEMA,
          effort: 'low',
        });
        usage.push(completion.usage);
        costUsd += completion.costUsd ?? 0;

        const byId = parseGlossaryBackfill(extractJsonObject(completion.text), ids);
        const entries = [...byId].map(([id, glossary]) => ({ id, glossary }));
        written += await setGlossaries(entries);
        terms += entries.reduce((sum, e) => sum + e.glossary.length, 0);
        const skipped = ids.length - byId.size;
        console.log(
          `batch ${n + 1}/${batches.length}: ${byId.size} written` + (skipped > 0 ? `, ${skipped} skipped` : ''),
        );
      } catch (err) {
        console.warn(`batch ${n + 1}/${batches.length} failed: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  console.log(
    `\nTOTAL: ${written} of ${stories.length} stories written, ${terms} terms, ` +
      `${usage.length} model call(s)\n${formatUsage(sumUsage(usage), costUsd)}`,
  );
}

await withDb(main)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);

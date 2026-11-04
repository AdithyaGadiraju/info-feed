/**
 * Products & tech backfill for stories written before the section existed.
 *
 * Picks stories whose products section is NULL, newest first, and explains them in
 * web-search batches (lib/explain). Safe to re-run: a written section (even an
 * empty one) is never picked again, and a story in a failed batch stays NULL for
 * the next run. `--max` caps the spend; `--days` limits it to recent stories.
 *
 *   npx tsx scripts/products-backfill.ts                       # 50 newest, score >= 3
 *   npx tsx scripts/products-backfill.ts --max 300 --days 7
 *   npx tsx scripts/products-backfill.ts --max 500 --min-score 1
 */
import { closeDb, withDb } from '../lib/db/client';
import { formatUsage } from '../lib/enrich/transport';
import { env } from '../lib/env';
import { explainPending } from '../lib/explain/run';

const DEFAULT_MAX = 50;
/** The feed's default score filter: stories below it are not shown unless asked for. */
const DEFAULT_MIN_SCORE = 3;

function parseArgs(argv: string[]): { max: number; minScore: number; days: number | null } {
  let max = DEFAULT_MAX;
  let minScore = DEFAULT_MIN_SCORE;
  let days: number | null = null;

  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i];
    const value = Number(argv[i + 1]);
    if (arg === '--max') {
      if (!Number.isInteger(value) || value < 1) throw new Error('--max needs a positive integer');
      max = value;
    } else if (arg === '--min-score') {
      if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error('--min-score needs 1-5');
      minScore = value;
    } else if (arg === '--days') {
      if (!Number.isFinite(value) || value <= 0) throw new Error('--days needs a positive number');
      days = value;
    } else {
      throw new Error(`unknown flag ${arg}. Usage: --max <n> --min-score <1-5> --days <n>`);
    }
  }

  return { max, minScore, days };
}

async function main(): Promise<void> {
  const { max, minScore, days } = parseArgs(process.argv.slice(2));
  const since = days === null ? null : new Date(Date.now() - days * 86_400_000);

  console.log(
    `products-backfill — transport ${env.llmTransport}, model ${env.llmModel}, ` +
      `up to ${max} story(ies) at score >= ${minScore}${days === null ? '' : ` from the last ${days} day(s)`}`,
  );

  const r = await explainPending({ minScore, max, since, job: 'explain:backfill' });
  console.log(
    `\nTOTAL: ${r.written} of ${r.picked} stories written, ${r.entries} entries, ` +
      `${r.calls} model call(s)\n${formatUsage(r.usage, r.costUsd)}`,
  );
}

await withDb(main)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);

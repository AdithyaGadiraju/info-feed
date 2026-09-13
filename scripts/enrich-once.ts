/**
 * Manual, cost-capped enrichment trigger.
 *
 * ENRICH_INTERVAL_MIN is 999 during development so the worker never spends tokens
 * on its own. This script is the only way enrichment happens, and `--max` defaults
 * low on purpose: a mistyped command should cost a few cents, not a batch of sixty.
 *
 *   npx tsx scripts/enrich-once.ts --lane ai --max 20
 *   npx tsx scripts/enrich-once.ts            # every lane, 20 items each
 */
import { closeDb, withDb } from '../lib/db/client';
import { countPendingItems } from '../lib/db/queries';
import { isLane, LANES, type Lane } from '../lib/db/types';
import { enrichLane } from '../lib/enrich/run';
import { formatUsage, sumUsage, type TokenUsage } from '../lib/enrich/transport';
import { env } from '../lib/env';

const DEFAULT_MAX = 20;

function parseArgs(argv: string[]): { lanes: Lane[]; max: number } {
  const lanes: Lane[] = [];
  let max = DEFAULT_MAX;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lane') {
      const value = argv[i + 1];
      i += 1;
      if (!value || !isLane(value)) {
        throw new Error(`--lane needs one of: ${LANES.join(', ')}`);
      }
      lanes.push(value);
    } else if (arg === '--max') {
      const value = Number(argv[i + 1]);
      i += 1;
      if (!Number.isInteger(value) || value < 1) throw new Error('--max needs a positive integer');
      max = value;
    } else {
      throw new Error(`unknown flag ${arg}. Usage: --lane <name> --max <n>`);
    }
  }

  return { lanes: lanes.length > 0 ? lanes : [...LANES], max };
}

async function main(): Promise<void> {
  const { lanes, max } = parseArgs(process.argv.slice(2));

  console.log(
    `enrich:once — transport ${env.llmTransport}, model ${env.llmModel}, max ${max} item(s) per lane`,
  );

  const usage: TokenUsage[] = [];
  let costUsd = 0;
  let created = 0;
  let updated = 0;
  let dropped = 0;

  for (const lane of lanes) {
    const pending = await countPendingItems(lane);
    if (pending === 0) {
      console.log(`enrich ${lane}: nothing pending, skipped`);
      continue;
    }
    console.log(`enrich ${lane}: ${pending} pending, sending up to ${max}`);

    const result = await enrichLane(lane, { maxItems: max });
    usage.push(...result.usage);
    costUsd += result.costUsd;
    created += result.created;
    updated += result.updated;
    dropped += result.dropped;
  }

  const total = sumUsage(usage);
  console.log(
    `\nTOTAL: ${created} stories created, ${updated} updated, ${dropped} items dropped, ` +
      `${usage.length} model call(s)\n${formatUsage(total, costUsd)}`,
  );
}

await withDb(main)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closeDb);

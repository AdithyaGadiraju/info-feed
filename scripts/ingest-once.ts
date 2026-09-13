/**
 * Run one ingest by hand: `npm run ingest:once -- --lane ai --since 12`.
 * The scheduled path is the worker; this exists for tuning feed lists and for
 * checking a source after it broke.
 */
import { closeDb } from '../lib/db/client';
import { isLane, type Lane } from '../lib/db/types';
import { ingest, type IngestResult } from '../lib/sources/index';

const USAGE = `Usage: npm run ingest:once -- [--lane <name>]... [--since <hours>]

  --lane   ai | markets | betting | gamedev | games. Repeatable, or comma
           separated. Omit for every lane.
  --since  How many hours back to ingest. Default 24.`;

interface Args {
  lanes: Lane[];
  sinceHours: number;
}

function parseArgs(argv: string[]): Args {
  const lanes: Lane[] = [];
  let sinceHours = 24;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--lane') {
      const value = argv[++i];
      if (!value) throw new Error('--lane needs a value');
      for (const name of value.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!isLane(name)) throw new Error(`unknown lane "${name}"`);
        if (!lanes.includes(name)) lanes.push(name);
      }
    } else if (arg === '--since') {
      const value = argv[++i];
      const hours = Number(value);
      if (!Number.isFinite(hours) || hours <= 0) {
        throw new Error(`--since needs a positive number of hours, got "${value}"`);
      }
      sinceHours = hours;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }

  return { lanes, sinceHours };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function print(result: IngestResult): void {
  const lanes = result.lanes ? result.lanes.join(', ') : 'all lanes';
  console.log(
    `ingest run ${result.runId} - ${lanes} since ${result.since.toISOString()} ` +
      `(${(result.durationMs / 1000).toFixed(1)}s)`,
  );
  console.log(
    `  ${pad('source', 9)}${pad('fetched', 9)}${pad('stored', 8)}${pad('new', 6)}` +
      `${pad('filtered', 10)}${pad('bodies', 8)}${pad('ms', 8)}status`,
  );

  for (const s of result.sources) {
    console.log(
      `  ${pad(s.source, 9)}${pad(String(s.fetched), 9)}${pad(String(s.stored), 8)}` +
        `${pad(String(s.inserted), 6)}${pad(String(s.filtered), 10)}` +
        `${pad(String(s.bodiesFetched), 8)}${pad(String(s.durationMs), 8)}` +
        (s.ok ? 'ok' : `FAILED - ${s.error ?? 'unknown error'}`),
    );
  }

  console.log(
    `  totals: fetched ${result.fetched}, stored ${result.stored}, ` +
      `filtered ${result.filtered}, bodies ${result.bodiesFetched}, ` +
      `failed ${result.failed.length}/${result.sources.length}`,
  );

  for (const f of result.failed) {
    console.error(`  ! ${f.source}: ${f.error}`);
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const since = new Date(Date.now() - args.sinceHours * 3600_000);

  try {
    const result = await ingest({ lanes: args.lanes, since });
    print(result);
    // A partial run is still a good run (ADR 0002): only a total wipeout is a
    // non-zero exit, so cron does not alert every time Twitter locks us out.
    if (result.sources.length > 0 && result.failed.length === result.sources.length) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`ingest failed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

await main();

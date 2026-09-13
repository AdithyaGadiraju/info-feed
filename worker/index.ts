/**
 * `npm run worker` — the optional entrypoint, for when a machine is left running
 * (ADR 0001). It is a scheduler and nothing else: no source logic, no LLM logic.
 * Everything it calls is the same code `npm run digest` calls.
 *
 * There is no queue and no job table. A cron tick plus `story_id IS NULL` is the
 * queue, which is the whole point of the design.
 */
import cron, { type ScheduledTask } from 'node-cron';
import { closeDb, dashboardUrl, isProjectPausedError } from '../lib/db/client';
import { migrate } from '../lib/db/migrate';
import { countPendingItems, pruneOldBodies } from '../lib/db/queries';
import { env } from '../lib/env';
import type { Lane } from '../lib/db/types';
import { sourcesConfig } from '../config/sources';
import { ingest } from '../lib/sources/index';
import { enrichLane } from '../lib/enrich/run';
import { digestFooter, digestHeader, digestLane } from '../lib/digest/run';
import { postFooter, postHeader } from '../lib/digest/discord';

const INGEST_CRON = '*/30 * * * *';
const DIGEST_CRON = '0 8,18 * * *';
const PRUNE_CRON = '15 4 * * *';
/** Enrich early when the queue builds up rather than waiting out the interval (ADR 0001). */
const PENDING_TRIGGER = 15;
const BODY_RETENTION_DAYS = 30;

const lanes: readonly Lane[] = sourcesConfig.laneOrder;

/**
 * One guard per job name. Jobs are minutes long and the ingest tick is every 30,
 * so a slow run must skip its next tick rather than stack a second copy on top of
 * it and double every source's request volume.
 */
const running = new Set<string>();

async function once(job: string, fn: () => Promise<void>): Promise<void> {
  if (running.has(job)) {
    console.warn(`[${new Date().toISOString()}] ${job}: previous run still going, skipping this tick`);
    return;
  }
  running.add(job);
  const started = Date.now();
  try {
    await fn();
    console.log(`[${new Date().toISOString()}] ${job}: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    if (isProjectPausedError(err)) {
      console.error(`Supabase project paused, resume it at ${dashboardUrl()}`);
    } else {
      console.error(`[${new Date().toISOString()}] ${job} failed:`, err instanceof Error ? err.message : err);
    }
  } finally {
    running.delete(job);
  }
}

async function runIngest(): Promise<void> {
  const result = await ingest({ since: new Date(Date.now() - 6 * 3600_000), job: 'ingest' });
  console.log(
    `  ingest: ${result.fetched} fetched, ${result.stored} stored, ${result.filtered} filtered, ` +
      `${result.bodiesFetched} bodies` +
      (result.failed.length ? `, failed: ${result.failed.map((f) => f.source).join(', ')}` : ''),
  );
  // Enrich straight away when the backlog is big enough, so the feed does not sit
  // on an hour of unclustered items.
  if ((await countPendingItems()) >= PENDING_TRIGGER) {
    await once('enrich', runEnrich);
  }
}

async function runEnrich(): Promise<void> {
  let cost = 0;
  for (const lane of lanes) {
    const result = await enrichLane(lane);
    cost += result.costUsd;
    if (result.created || result.updated || result.dropped) {
      console.log(
        `  enrich ${lane}: ${result.created} new, ${result.updated} updated, ${result.dropped} dropped`,
      );
    }
  }
  if (cost > 0) console.log(`  enrich: $${cost.toFixed(4)} of model usage`);
}

async function runDigest(): Promise<void> {
  const now = new Date();
  await postHeader(digestHeader(lanes.length, now));
  const quiet: Lane[] = [];
  const failed: Lane[] = [];
  for (const lane of lanes) {
    try {
      const result = await digestLane(lane);
      if (!result.ok) failed.push(lane);
      else if (result.sent === 0) quiet.push(lane);
    } catch {
      failed.push(lane);
    }
  }
  await postFooter(digestFooter(quiet, failed));
}

async function main(): Promise<void> {
  await migrate();

  const tz = env.tz;
  const interval = env.enrichIntervalMin;
  // `*/N` is only valid for N <= 59; a larger interval (the 999 development
  // setting) becomes a once-a-day tick, which is the intended "effectively off".
  const enrichCron = interval <= 59 ? `*/${Math.max(1, interval)} * * * *` : '5 3 * * *';

  const tasks: ScheduledTask[] = [
    cron.schedule(INGEST_CRON, () => void once('ingest', runIngest), { timezone: tz }),
    cron.schedule(enrichCron, () => void once('enrich', runEnrich), { timezone: tz }),
    cron.schedule(DIGEST_CRON, () => void once('digest', runDigest), { timezone: tz }),
    cron.schedule(
      PRUNE_CRON,
      () =>
        void once('prune', async () => {
          const n = await pruneOldBodies(BODY_RETENTION_DAYS);
          console.log(`  prune: cleared ${n} bodies older than ${BODY_RETENTION_DAYS} days`);
        }),
      { timezone: tz },
    ),
  ];

  console.log(`info-feed worker started · TZ ${tz}`);
  console.log(`  ingest ${INGEST_CRON}`);
  console.log(`  enrich ${enrichCron}${interval > 59 ? `  (ENRICH_INTERVAL_MIN=${interval}, effectively off)` : ''}`);
  console.log(`  digest ${DIGEST_CRON}`);
  console.log(`  prune  ${PRUNE_CRON}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, stopping.`);
    for (const task of tasks) void task.stop();
    // Let an in-flight job finish its current database write before the pool closes.
    const wait = setInterval(() => {
      if (running.size === 0) {
        clearInterval(wait);
        void closeDb().finally(() => process.exit(0));
      }
    }, 250);
    wait.unref();
    setTimeout(() => process.exit(0), 15_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async (err) => {
  if (isProjectPausedError(err)) {
    console.error(`Supabase project paused, resume it at ${dashboardUrl()}`);
  } else {
    console.error('Worker failed to start:', err);
  }
  await closeDb().catch(() => {});
  process.exit(1);
});

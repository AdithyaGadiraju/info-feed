/**
 * `npm run digest` — the primary way info-feed is used (ADR 0001).
 *
 * No machine is assumed to be always on, so this runs the whole pipeline once and
 * exits. It streams: lanes are posted to Discord in order, each as soon as it is
 * ready, so reading can begin while later lanes are still running (ADR 0004). It
 * holds no source or LLM logic of its own.
 *
 * The lanes overlap. Ingestion still runs one lane at a time, but a lane's model
 * work (enrichment, then the fact-check of its digest stories) starts the moment
 * its ingestion ends and runs alongside every other lane's. Model calls are nearly
 * all of the wall-clock time, so the run takes about as long as its slowest lane
 * rather than the sum of all of them.
 *
 * Cross-platform by construction: plain Node, no shell syntax, no native modules.
 */
import { closeDb, dashboardUrl, isProjectPausedError } from '../lib/db/client';
import { migrate } from '../lib/db/migrate';
import { getLastDigestAt } from '../lib/db/queries';
import { isLane, type Lane, type StoryWithLink } from '../lib/db/types';
import { sourcesConfig } from '../config/sources';
import { ingest } from '../lib/sources/index';
import { enrichLane } from '../lib/enrich/run';
import { digestFooter, digestHeader, digestLane, prepareLane } from '../lib/digest/run';
import { postFooter, postHeader } from '../lib/digest/discord';

const MAX_SINCE_HOURS = 72;

interface Args {
  lanes: Lane[];
  sinceHours: number | null;
}

function parseArgs(argv: string[]): Args {
  let lanes: Lane[] = [...sourcesConfig.laneOrder];
  let sinceHours: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lane' || arg === '--lanes') {
      const value = argv[i + 1];
      if (!value) throw new Error('--lane needs a lane name');
      const names = value.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = names.filter((n) => !isLane(n));
      if (bad.length > 0) {
        throw new Error(`unknown lane(s): ${bad.join(', ')}. Valid: ${sourcesConfig.laneOrder.join(', ')}`);
      }
      // Keep the configured order rather than the order they were typed, so the
      // Discord messages always arrive in the same sequence.
      const wanted = new Set(names);
      lanes = sourcesConfig.laneOrder.filter((l) => wanted.has(l));
      i += 1;
    } else if (arg === '--since') {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) throw new Error('--since needs a number of hours');
      sinceHours = Math.min(value, MAX_SINCE_HOURS);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run digest -- [--lane ai,markets] [--since 24]');
      process.exit(0);
    }
  }

  return { lanes, sinceHours };
}

interface LaneOutcome {
  lane: Lane;
  fetched: number;
  stored: number;
  filtered: number;
  created: number;
  updated: number;
  /** Digest stories that got a fact-check verdict in this run. */
  checked: number;
  costUsd: number;
  posted: number;
  error?: string;
}

/**
 * Runs tasks one at a time, in the order they were queued.
 *
 * Ingestion is the one stage that must not overlap. Reddit's limit is a single
 * per-address budget (lib/sources/reddit.ts spaces its own requests for that
 * reason), so six lanes fetching at once would get the whole address throttled.
 */
function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

interface PreparedLane {
  out: LaneOutcome;
  /** Selected and fact-checked, ready to post. Null when the lane failed before that. */
  stories: StoryWithLink[] | null;
}

/**
 * Everything a lane needs before it can be posted. Never rejects: a failure is
 * recorded on the outcome, because this promise is left unawaited while earlier
 * lanes post.
 */
async function prepare(
  lane: Lane,
  since: Date,
  ingestInTurn: ReturnType<typeof serialQueue>,
): Promise<PreparedLane> {
  const out: LaneOutcome = {
    lane,
    fetched: 0,
    stored: 0,
    filtered: 0,
    created: 0,
    updated: 0,
    checked: 0,
    costUsd: 0,
    posted: 0,
  };

  try {
    const ingested = await ingestInTurn(() => ingest({ lanes: [lane], since, job: `ingest:${lane}` }));
    out.fetched = ingested.fetched;
    out.stored = ingested.stored;
    out.filtered = ingested.filtered;
    if (ingested.failed.length > 0) {
      console.warn(
        `  ${lane}: ${ingested.failed.length} source(s) failed: ${ingested.failed
          .map((f) => f.source)
          .join(', ')}`,
      );
    }

    const enriched = await enrichLane(lane);
    out.created = enriched.created;
    out.updated = enriched.updated;
    out.costUsd = enriched.costUsd;

    const prepared = await prepareLane(lane);
    out.checked = prepared.checked;
    out.costUsd += prepared.costUsd;
    return { out, stories: prepared.stories };
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    return { out, stories: null };
  }
}

async function post({ out, stories }: PreparedLane): Promise<LaneOutcome> {
  if (stories === null) return out;
  try {
    const posted = await digestLane(out.lane, { prepared: stories });
    out.posted = posted.sent;
    if (!posted.ok) {
      // -1 means postLane never made a request, which is a configuration problem
      // rather than a Discord problem; saying "Discord returned -1" would send
      // someone looking in the wrong place.
      out.error = posted.status < 0 ? 'no Discord webhook configured' : `Discord returned ${posted.status}`;
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

async function main(): Promise<void> {
  const { lanes, sinceHours } = parseArgs(process.argv.slice(2));

  // The schema is applied on every run so a fresh checkout on a second machine
  // needs no separate setup step (ADR 0001).
  await migrate();

  const since = sinceHours
    ? new Date(Date.now() - sinceHours * 3600_000)
    : await getLastDigestAt(MAX_SINCE_HOURS);

  const startedAt = new Date();
  console.log(
    `info-feed digest · ${lanes.join(', ')} · since ${since.toISOString()} · model ${process.env.LLM_MODEL ?? 'claude-sonnet-5'}`,
  );

  // The header goes out first so the start of a run is visible in Discord even if
  // a later lane hangs (ADR 0004).
  await postHeader(digestHeader(lanes.length, startedAt));

  // Every lane starts now; the loop below only decides the order they are posted in.
  const ingestInTurn = serialQueue();
  const preparing = lanes.map((lane) => prepare(lane, since, ingestInTurn));

  const outcomes: LaneOutcome[] = [];
  for (const [i, lane] of lanes.entries()) {
    const outcome = await post(await preparing[i]);
    outcomes.push(outcome);
    const status = outcome.error ? `FAILED (${outcome.error})` : `${outcome.posted} posted`;
    console.log(
      `  ${lane}: ${outcome.fetched} fetched, ${outcome.stored} stored, ${outcome.filtered} filtered, ` +
        `${outcome.created} new stories, ${outcome.updated} updated, ${outcome.checked} fact-checked, ` +
        `$${outcome.costUsd.toFixed(4)} · ${status}`,
    );
  }

  const quiet = outcomes.filter((o) => !o.error && o.posted === 0).map((o) => o.lane);
  const failed = outcomes.filter((o) => o.error).map((o) => o.lane);
  await postFooter(digestFooter(quiet, failed));

  const totalCost = outcomes.reduce((sum, o) => sum + o.costUsd, 0);
  const totalPosted = outcomes.reduce((sum, o) => sum + o.posted, 0);
  console.log(
    `Done in ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s · ` +
      `${totalPosted} stories posted · $${totalCost.toFixed(4)} of model usage`,
  );

  // Only a total failure is worth a non-zero exit. One dead lane is normal.
  if (failed.length === lanes.length) {
    console.error('Every lane failed.');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    if (isProjectPausedError(err)) {
      console.error(`Supabase project paused, resume it at ${dashboardUrl()}`);
    } else {
      console.error('Digest failed:', err instanceof Error ? err.message : err);
    }
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => {}));

/**
 * `npm run digest` — the primary way info-feed is used (ADR 0001).
 *
 * No machine is assumed to be always on, so this runs the whole pipeline once and
 * exits. It streams: each lane is ingested, enriched and posted to Discord before
 * the next lane starts, so reading can begin while later lanes are still running
 * (ADR 0004). It holds no source or LLM logic of its own.
 *
 * Cross-platform by construction: plain Node, no shell syntax, no native modules.
 */
import { closeDb, dashboardUrl, isProjectPausedError } from '../lib/db/client';
import { migrate } from '../lib/db/migrate';
import { getLastDigestAt } from '../lib/db/queries';
import { isLane, type Lane } from '../lib/db/types';
import { sourcesConfig } from '../config/sources';
import { ingest } from '../lib/sources/index';
import { enrichLane } from '../lib/enrich/run';
import { digestFooter, digestHeader, digestLane } from '../lib/digest/run';
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
  costUsd: number;
  posted: number;
  error?: string;
}

async function runLane(lane: Lane, since: Date): Promise<LaneOutcome> {
  const out: LaneOutcome = {
    lane,
    fetched: 0,
    stored: 0,
    filtered: 0,
    created: 0,
    updated: 0,
    costUsd: 0,
    posted: 0,
  };

  try {
    const ingested = await ingest({ lanes: [lane], since, job: `ingest:${lane}` });
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

    const posted = await digestLane(lane);
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

  const outcomes: LaneOutcome[] = [];
  for (const lane of lanes) {
    const outcome = await runLane(lane, since);
    outcomes.push(outcome);
    const status = outcome.error ? `FAILED (${outcome.error})` : `${outcome.posted} posted`;
    console.log(
      `  ${lane}: ${outcome.fetched} fetched, ${outcome.stored} stored, ${outcome.filtered} filtered, ` +
        `${outcome.created} new stories, ${outcome.updated} updated, $${outcome.costUsd.toFixed(4)} · ${status}`,
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

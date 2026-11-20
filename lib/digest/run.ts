/**
 * Digest orchestration for one lane (ADR 0004). A digest picks a lane's best new
 * stories, fact-checks them and marks them digested. It used to post them to
 * Discord too; that was removed on 2026-11-20 and the web feed is now the only
 * reader. Lane ordering belongs to the script that calls this module; this file
 * only knows how to do one lane at a time, and writes the `runs` row for it.
 */
import { finishRun, getDigestStories, recordDigest, remindUpcomingEvents, startRun } from '../db/queries';
import type { Lane, StoryWithLink } from '../db/types';
import { verifyStories, type VerifyResult } from '../verify/run';

export interface DigestLaneResult {
  /** Stories selected, fact-checked and marked digested. */
  digested: number;
}

export interface DigestLaneDeps {
  /** Injectable so tests never start a model call. */
  verifier?: (lane: Lane, stories: StoryWithLink[]) => Promise<VerifyResult>;
  /**
   * Stories already selected and fact-checked by `prepareLane`. `npm run digest`
   * passes this so the slow part can run for every lane at once.
   */
  prepared?: StoryWithLink[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `runs` is the system's only observability (ADR 0001), so a lane that fails has
 * to leave a row behind — but the row is a record of the work, never the work
 * itself. If the runs table is unreachable, the digest still happens and the
 * failure is downgraded to a console line.
 */
async function openRun(job: string): Promise<number | null> {
  try {
    return await startRun(job);
  } catch (err) {
    console.warn(`[digest] could not open a runs row for ${job}: ${errorText(err)}`);
    return null;
  }
}

async function closeRun(
  runId: number | null,
  ok: boolean,
  counts: Record<string, unknown>,
  error?: string | null,
): Promise<void> {
  if (runId === null) return;
  try {
    await finishRun(runId, ok, counts, error);
  } catch (err) {
    console.warn(`[digest] could not close runs row ${runId}: ${errorText(err)}`);
  }
}

/** Stories a digest takes per lane, best first. */
const DIGEST_LIMIT = 8;

/**
 * Lanes that take more than `DIGEST_LIMIT`. ai_gamedev is where Gadi wants every
 * new tool, niche ones included, and a busy release week fills 8 slots with the
 * big vendors alone.
 */
const DIGEST_LIMIT_BY_LANE: Partial<Record<Lane, number>> = { ai_gamedev: 12 };

/**
 * Puts events whose deadline is near back into the selection (and at the top of
 * the web feed). A failure here only costs the reminder, so it never stops the
 * lane.
 */
async function remindEvents(): Promise<void> {
  try {
    const ids = await remindUpcomingEvents();
    if (ids.length > 0) console.log(`  events: reminder for ${ids.length} event(s) near their deadline: ${ids.join(', ')}`);
  } catch (err) {
    console.warn(`[digest] events reminder failed: ${errorText(err)}`);
  }
}

export function digestLimit(lane: Lane): number {
  return DIGEST_LIMIT_BY_LANE[lane] ?? DIGEST_LIMIT;
}

/**
 * The slow half of a lane's digest: pick the stories, then fact-check them. It
 * writes verdicts and nothing else, so it is safe to run for several lanes at once
 * and safe to repeat.
 */
export async function prepareLane(lane: Lane, deps: DigestLaneDeps = {}): Promise<VerifyResult> {
  if (lane === 'events') await remindEvents();
  const stories = await getDigestStories(lane, 4, digestLimit(lane));
  if (stories.length === 0) return { stories, checked: 0, failed: 0, costUsd: 0 };
  return (deps.verifier ?? verifyStories)(lane, stories);
}

/**
 * Selects, fact-checks and marks one lane. Marking means the next digest skips
 * these stories (and so does not pay to fact-check them again) until one changes.
 */
export async function digestLane(lane: Lane, deps: DigestLaneDeps = {}): Promise<DigestLaneResult> {
  const runId = await openRun(`digest:${lane}`);
  let selected = 0;

  try {
    const stories = deps.prepared ?? (await prepareLane(lane, deps)).stories;
    selected = stories.length;
    if (stories.length > 0) await recordDigest(lane, stories.map((s) => s.id));
    await closeRun(runId, true, { lane, selected, digested: selected });
    return { digested: selected };
  } catch (err) {
    await closeRun(runId, false, { lane, selected, digested: 0 }, errorText(err));
    throw err;
  }
}

/**
 * Digest orchestration for one lane (ADR 0004). Lane ordering and header/footer
 * sequencing across lanes belong to the script that calls this module; this file
 * only knows how to do one lane at a time, and writes the `runs` row for it.
 */
import { finishRun, getDigestStories, recordDigest, startRun } from '../db/queries';
import type { Lane, StoryWithLink } from '../db/types';
import { env } from '../env';
import { postLane, type PostResult } from './discord';

export interface DigestLaneResult {
  sent: number;
  ok: boolean;
  status: number;
}

export interface DigestLaneDeps {
  /** Injectable so tests can force a non-2xx without a fake network layer. */
  poster?: (lane: Lane, stories: StoryWithLink[]) => Promise<PostResult>;
  now?: Date;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `runs` is the system's only observability (ADR 0001), so a lane that fails has
 * to leave a row behind — but the row is a record of the work, never the work
 * itself. If the runs table is unreachable, the digest still goes out and the
 * failure is downgraded to a console line.
 *
 * `withRun` from the query layer is deliberately not used here: it decides ok/fail
 * by whether the callback threw, and a digest lane reports a non-2xx by returning,
 * not by throwing. Driving `startRun`/`finishRun` directly is what lets a 500 from
 * Discord land as `ok = false`.
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

/**
 * Selects, posts, and marks one lane. `digested_at` is only touched after a 2xx
 * (ADR 0004) so a failed post leaves the same stories eligible for the next run.
 */
export async function digestLane(lane: Lane, deps: DigestLaneDeps = {}): Promise<DigestLaneResult> {
  const runId = await openRun(`digest:${lane}`);
  let selected = 0;

  try {
    const stories = await getDigestStories(lane, 4, 8);
    selected = stories.length;

    if (stories.length === 0) {
      // Nothing new: skip the post entirely rather than sending an empty lane message.
      await closeRun(runId, true, { lane, selected: 0, sent: 0, discordStatus: 0 });
      return { sent: 0, ok: true, status: 0 };
    }

    const poster = deps.poster ?? ((l, s) => postLane(l, s, { now: deps.now }));
    const result = await poster(lane, stories);

    if (result.ok) {
      await recordDigest(lane, stories.map((s) => s.id), result.status);
    }

    await closeRun(
      runId,
      result.ok,
      { lane, selected, sent: result.ok ? selected : 0, discordStatus: result.status },
      result.ok ? null : `discord returned ${result.status}`,
    );

    return { sent: stories.length, ok: result.ok, status: result.status };
  } catch (err) {
    await closeRun(runId, false, { lane, selected, sent: 0 }, errorText(err));
    throw err;
  }
}

function inTz(now: Date, tz: string): { date: string; time: string } {
  const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric', month: 'short' }).format(
    now,
  );
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  return { date, time };
}

/** First message of a run (ADR 0004): makes the start of a run visible before any lane lands. */
export function digestHeader(laneCount: number, now: Date): string {
  const { date, time } = inTz(now, env.tz);
  return `Digest · ${date} ${time} · ${laneCount} lane${laneCount === 1 ? '' : 's'}`;
}

/** Final message of a run: names lanes with nothing new and any lane whose post failed. */
export function digestFooter(quietLanes: Lane[], failedLanes: Lane[]): string {
  const parts: string[] = [];
  if (quietLanes.length > 0) parts.push(`nothing new: ${quietLanes.join(', ')}`);
  if (failedLanes.length > 0) parts.push(`failed: ${failedLanes.join(', ')}`);
  return parts.length > 0 ? parts.join(' · ') : 'all lanes posted';
}

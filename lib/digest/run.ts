/**
 * Digest orchestration for one lane (ADR 0004). Lane ordering, header/footer
 * sequencing across lanes, and the run row belong to the script that calls this
 * module; this file only knows how to do one lane at a time.
 */
import { getDigestStories, recordDigest } from '../db/queries.js';
import type { Lane, Story } from '../db/types.js';
import { env } from '../env.js';
import { postLane, type PostResult } from './discord.js';

export interface DigestLaneResult {
  sent: number;
  ok: boolean;
  status: number;
}

export interface DigestLaneDeps {
  /** Injectable so tests can force a non-2xx without a fake network layer. */
  poster?: (lane: Lane, stories: Story[]) => Promise<PostResult>;
  now?: Date;
}

/**
 * Selects, posts, and marks one lane. `digested_at` is only touched after a 2xx
 * (ADR 0004) so a failed post leaves the same stories eligible for the next run.
 */
export async function digestLane(lane: Lane, deps: DigestLaneDeps = {}): Promise<DigestLaneResult> {
  const stories = await getDigestStories(lane, 4, 8);
  if (stories.length === 0) {
    // Nothing new: skip the post entirely rather than sending an empty lane message.
    return { sent: 0, ok: true, status: 0 };
  }

  const poster = deps.poster ?? ((l, s) => postLane(l, s, { now: deps.now }));
  const result = await poster(lane, stories);

  if (result.ok) {
    await recordDigest(lane, stories.map((s) => s.id), result.status);
  }

  return { sent: stories.length, ok: result.ok, status: result.status };
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

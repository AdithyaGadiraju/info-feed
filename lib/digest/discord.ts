/**
 * Discord webhook client for the digest (ADR 0004). Formatting is pure so it can be
 * unit-tested with fixtures; only `postWebhook`/`postLane`/`postHeader`/`postFooter`
 * touch the network, and even those take an injectable `fetch` so tests never post
 * to Gadi's real channel.
 */
import { env } from '../env';
import { LANE_LABELS, type Lane, type StoryWithLink } from '../db/types';

export interface DiscordEmbed {
  title: string;
  description: string;
}

export interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

/** Discord's documented webhook limits (ADR 0004: split, never truncate). */
export const DISCORD_LIMITS = {
  content: 2000,
  embedDescription: 4096,
  embedsPerMessage: 10,
  totalPerMessage: 6000,
} as const;

function laneDateLabel(now: Date, tz: string): string {
  // Built from parts (not a locale's default order) so "13 Sep" doesn't silently
  // flip to "Sep 13" depending on the runtime's ICU data.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
  }).formatToParts(now);
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';

  // hour12 formatting is the only reliable cross-runtime way to get AM/PM for an
  // arbitrary IANA zone without hand-rolling offset math.
  const dayPeriod =
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: true })
      .formatToParts(now)
      .find((p) => p.type === 'dayPeriod')?.value ?? 'AM';

  return `${day} ${month} ${dayPeriod.toUpperCase()}`;
}

function scoreMarker(score: number): string {
  // A glanceable strength read (filled vs. open dots) beats a bare digit in a feed.
  const filled = Math.max(0, Math.min(5, score));
  return '●'.repeat(filled) + '○'.repeat(5 - filled);
}

const ELLIPSIS = '…';

/**
 * Both links a story has: the article it is about, then the feed permalink. The
 * article comes first because it is what the digest is for — the permalink is the
 * way back into the feed, not the destination. A story with no items attached has
 * no article link, so only the permalink is emitted.
 */
function storyLinks(story: StoryWithLink, baseUrl: string): string {
  const permalink = `${baseUrl}/story/${story.id}`;
  return story.primaryUrl ? `${story.primaryUrl}\n${permalink}` : permalink;
}

/**
 * One story as one packable line. Nothing caps `summary_short` on the way in (the
 * enrichment validator caps only the title), and `packDescriptions` can only split
 * between lines — so a single runaway summary would be emitted intact, rejected by
 * Discord with a 400, and rebuilt identically on every later run, wedging the lane
 * forever. Truncating here is the only place that can make that impossible. The
 * links are never the part that gets cut: a clipped summary still reaches the
 * article, a clipped URL reaches nothing.
 */
function storyLine(story: StoryWithLink, baseUrl: string): string {
  const links = storyLinks(story, baseUrl);
  const head = `${scoreMarker(story.score)} **${story.title}**`;
  const line = `${head}\n${story.summaryShort}\n${links}`;
  if (line.length <= DISCORD_LIMITS.embedDescription) return line;

  const NEWLINES = 2;
  const room =
    DISCORD_LIMITS.embedDescription - (head.length + links.length + NEWLINES + ELLIPSIS.length);
  if (room > 0) return `${head}\n${story.summaryShort.slice(0, room)}${ELLIPSIS}\n${links}`;

  // Pathological: the title alone overruns the embed. Keep the links and whatever
  // of the heading fits in front of them.
  const headRoom = DISCORD_LIMITS.embedDescription - (links.length + 1 + ELLIPSIS.length);
  return `${head.slice(0, Math.max(0, headRoom))}${ELLIPSIS}\n${links}`;
}

/**
 * Greedy-packs story lines under the embed description limit. Greedy (not
 * bin-packing) is fine here: story order is already best-first, so keeping that
 * order across message boundaries matters more than minimizing message count.
 */
function packDescriptions(lines: string[]): string[] {
  const groups: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of lines) {
    const sepLen = current.length > 0 ? 2 : 0; // joining separator: '\n\n'
    if (current.length > 0 && currentLen + sepLen + line.length > DISCORD_LIMITS.embedDescription) {
      groups.push(current.join('\n\n'));
      current = [line];
      currentLen = line.length;
    } else {
      current.push(line);
      currentLen += sepLen + line.length;
    }
  }
  if (current.length > 0) groups.push(current.join('\n\n'));
  return groups;
}

/**
 * Pure formatting: one lane's stories to one or more message payloads. No network,
 * no env reads — the clock and timezone are arguments so tests control the date
 * without faking global time.
 */
export function buildLaneEmbed(
  lane: Lane,
  stories: StoryWithLink[],
  baseUrl: string,
  now: Date = new Date(),
  tz = 'Australia/Sydney',
): DiscordMessagePayload[] {
  if (stories.length === 0) return [];

  const titleBase = `${LANE_LABELS[lane].toUpperCase()} · ${laneDateLabel(now, tz)}`;
  const descriptions = packDescriptions(stories.map((s) => storyLine(s, baseUrl)));

  return descriptions.map((description, i) => ({
    embeds: [
      {
        title: descriptions.length > 1 ? `${titleBase} (${i + 1}/${descriptions.length})` : titleBase,
        description,
      },
    ],
  }));
}

export type FetchLike = typeof fetch;

export interface PostResult {
  ok: boolean;
  status: number;
}

/**
 * No request was attempted at all. Distinct from `0` (request made, transport
 * failed) so a run row or a console line says which of the two happened.
 */
export const NOT_SENT_STATUS = -1;

/**
 * Posts one payload. Retries exactly once on a 429, honouring the `retry_after`
 * (seconds) Discord puts in the body. Never throws — a dead webhook or malformed
 * body must not crash a digest run; the caller decides what a non-2xx means.
 */
export async function postWebhook(
  url: string,
  payload: DiscordMessagePayload,
  fetchImpl: FetchLike = fetch,
): Promise<PostResult> {
  const send = () =>
    fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

  try {
    const res = await send();
    if (res.status !== 429) return { ok: res.ok, status: res.status };

    let retryAfterMs = 1000;
    try {
      const body = (await res.clone().json()) as { retry_after?: number };
      if (typeof body.retry_after === 'number') retryAfterMs = body.retry_after * 1000;
    } catch {
      // Non-JSON body on a 429 is still a 429; fall back to the default backoff.
    }
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));

    const retry = await send();
    return { ok: retry.ok, status: retry.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export interface PostLaneOptions {
  fetchImpl?: FetchLike;
  now?: Date;
  tz?: string;
}

/**
 * Posts every split payload for a lane to the main channel, mirroring each to the
 * per-lane webhook when configured. The lane URL is a mirror, never a replacement
 * (ADR 0004) — the main channel is the one Gadi actually reads day to day, so it
 * must get every lane regardless of per-lane routing.
 */
export async function postLane(
  lane: Lane,
  stories: StoryWithLink[],
  opts: PostLaneOptions = {},
): Promise<PostResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const payloads = buildLaneEmbed(lane, stories, env.feedBaseUrl, opts.now, opts.tz ?? env.tz);
  // The only honest success without an HTTP call: there was nothing to send, so
  // there is also nothing a caller could wrongly mark as digested.
  if (payloads.length === 0) return { ok: true, status: 0 };

  const mainUrl = env.discordWebhook;
  if (!mainUrl) {
    // `DISCORD_WEBHOOK_URL` is optional in `lib/env.ts`, so an unset main webhook
    // is a live configuration state, not an impossible one. Reporting it as a
    // success would let `digestLane` stamp `digested_at` on stories nobody ever
    // received, consuming them forever (ADR 0004: mark only after a 2xx).
    console.error(
      `[digest] ${lane}: DISCORD_WEBHOOK_URL is not set — nothing was posted and nothing will be marked digested`,
    );
    return { ok: false, status: NOT_SENT_STATUS };
  }

  const laneUrl = env.discordLaneWebhook(lane);

  const mainResults: PostResult[] = [];
  for (const payload of payloads) {
    mainResults.push(await postWebhook(mainUrl, payload, fetchImpl));
    if (laneUrl) {
      const mirrored = await postWebhook(laneUrl, payload, fetchImpl);
      // The mirror is never an override (ADR 0004), so it must not change the
      // returned status — but a revoked or mistyped lane URL has to be visible
      // somewhere, and this log line is the only place it can be.
      if (!mirrored.ok) {
        console.warn(
          `[digest] ${lane}: per-lane mirror webhook returned ${mirrored.status} (main channel unaffected)`,
        );
      }
    }
  }

  // Report the first failure if any payload failed, otherwise the last success —
  // callers use this single status to decide whether the whole lane is "digested".
  return mainResults.find((r) => !r.ok) ?? mainResults[mainResults.length - 1];
}

async function postLine(text: string, fetchImpl: FetchLike): Promise<PostResult> {
  const url = env.discordWebhook;
  if (!url) return { ok: true, status: 0 };
  return postWebhook(url, { content: text }, fetchImpl);
}

/** One-line run-start message to the main channel only (ADR 0004: never mirrored). */
export async function postHeader(text: string, fetchImpl: FetchLike = fetch): Promise<PostResult> {
  return postLine(text, fetchImpl);
}

/** One-line run-summary message to the main channel only. */
export async function postFooter(text: string, fetchImpl: FetchLike = fetch): Promise<PostResult> {
  return postLine(text, fetchImpl);
}

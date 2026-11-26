/**
 * Reddit source (ADR 0002, revised). The public JSON endpoints (`www.reddit.com/r/<sub>/hot.json`
 * and `api.reddit.com`) hard-403 unauthenticated clients from this network, and
 * `old.reddit.com` redirects to nothing useful. The `.rss` path
 * (`/r/<sub>/hot/.rss`) is the one endpoint measured to actually return content, so
 * that's what this module uses -- via `rss-parser`, which understands Atom (what
 * Reddit serves) rather than hand-rolled XML parsing. `/r/<sub>.rss` (no `/hot/`)
 * 429s and must not be used.
 */
import Parser from 'rss-parser';
import type { RawItem, Source, SourceCtx, SubredditSpec } from './types';

/** Reddit blocks generic/default user agents outright; this one is honest and specific. */
const USER_AGENT = 'info-feed/1.0 (personal news digest by /u/gadi)';

/**
 * Lanes are fetched one at a time, spaced by at least this much. Reddit's limit on
 * this endpoint is a single shared per-IP budget rather than a per-subreddit one,
 * so concurrency buys nothing and only makes our own requests collide.
 */
const REQUEST_SPACING_MS = 30_000;
/** Ceiling on one wait, so a bogus reset header cannot stall the run. */
const MAX_WAIT_MS = 60_000;

/**
 * How long to wait before the next request. Measured 2026-10-14: the budget on this
 * endpoint is about one request per window. `x-ratelimit-remaining` reads 0 after a
 * single request, and a request sent when `x-ratelimit-reset` (~8 s) said the window
 * had closed still got a 429, while requests 30 s or more apart all succeeded. The
 * old fixed 1 s spacing made the second request of every run a 429, which is why
 * Reddit contributed almost nothing. The header only ever lengthens the 30 s floor.
 * Re-measured 2026-11-13: unchanged (`used 1, remaining 0.0`, reset 13-44 s after each
 * 200, and a 22-subreddit combined `.rss` still returns 100 entries), while
 * `/hot.json` still 403s.
 */
export function nextRequestDelayMs(remaining: string | null, reset: string | null): number {
  const left = Number(remaining);
  const resetS = Number(reset);
  if (remaining === null || reset === null || !Number.isFinite(left) || !Number.isFinite(resetS)) {
    return REQUEST_SPACING_MS;
  }
  if (left >= 1) return REQUEST_SPACING_MS;
  return Math.min(Math.max((resetS + 1) * 1000, REQUEST_SPACING_MS), MAX_WAIT_MS);
}

/** Body cap applied on write elsewhere; capping here too keeps memory bounded. */
const BODY_CAP = 2000;

const parser = new Parser({ headers: { 'User-Agent': USER_AGENT } });

/**
 * After a 429, Reddit is left alone for at least this long. Measured 2026-09-13: an
 * address that keeps knocking stays throttled for minutes, so one 429 benches the
 * source for the rest of a digest run, and the worker's next 30-minute ingest is
 * the next attempt. A longer Retry-After from Reddit wins.
 */
const BLOCK_MS = 15 * 60_000;

/**
 * How long Reddit is left alone once the public RSS itself answers 404. That is the
 * endpoint being gone (TODO T4), not a throttle, so it is checked a few times a day
 * rather than every 15 minutes: one digest is one request and one log line, and the
 * worker picks the feed up again by itself if Reddit ever brings it back.
 */
const GONE_BLOCK_MS = 6 * 60 * 60_000;
const GONE_REASON = 'public RSS returned HTTP 404 (needs OAuth, TODO T4)';

/**
 * Pacing and 429 state, held per PROCESS rather than per fetch() call. `npm run
 * digest` ingests lane by lane and calls fetch() once per lane, seconds apart, so
 * state kept inside one call let every lane's first request go out unspaced
 * (2026-11-13: four lanes, four 429s), and a 429 in one lane's call did not stop
 * the next lane's call from knocking again. Same idea as the session in twitter.ts.
 */
const state = { nextRequestAt: 0, blockedUntil: 0, blockReason: '', gone: false, worked: false };
let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Test hook: clears the process-wide pacing state and optionally swaps the sleeper. */
export function resetRedditState(opts: { sleep?: (ms: number) => Promise<void> } = {}): void {
  state.nextRequestAt = 0;
  state.blockedUntil = 0;
  state.blockReason = '';
  state.gone = false;
  state.worked = false;
  if (opts.sleep) sleep = opts.sleep;
}

/**
 * How long to leave Reddit alone after a 429: Retry-After or the rate-limit reset
 * (both seconds) when Reddit sends a longer one, never less than BLOCK_MS.
 */
export function blockMsAfter429(retryAfter: string | null, reset: string | null): number {
  const hinted = Math.max(Number(retryAfter) || 0, Number(reset) || 0) * 1000;
  return Math.max(hinted, BLOCK_MS);
}

/**
 * Reddit's Atom `content` for a submission is either a selftext `<div class="md">`
 * or a link-post thumbnail table, always followed by a "submitted by /u/x [link]
 * [comments]" footer. The `[link]` anchor's href is the outbound article URL for
 * link posts (it points back at the permalink itself for selftext posts, since
 * there is nothing else to link to).
 */
function extractOutboundLink(contentHtml: string, permalink: string): string | undefined {
  const match = contentHtml.match(/<a href="([^"]+)">\[link\]<\/a>/);
  if (!match) return undefined;
  // The href is HTML, so a query string arrives as `?v=abc&amp;t=30`.
  const href = match[1].replace(/&amp;/g, '&');
  return href && href !== permalink ? href : undefined;
}

/** Strips tags and the "submitted by /u/x [link] [comments]" footer reddit appends. */
function toPlainBody(contentHtml: string): string {
  const withoutFooter = contentHtml.replace(
    // The last "submitted by" only: the post's own text may say it too.
    /(&#32;\s*)?submitted by(?![\s\S]*submitted by)[\s\S]*$/i,
    '',
  );
  const text = withoutFooter
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#32;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // Last, so a literal "&lt;" in the post (sent as "&amp;lt;") is not decoded twice.
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

/**
 * Thrown to abandon the rest of the run the moment Reddit rate-limits us.
 *
 * Retrying a 429 is actively harmful here. Measured on 2026-09-13: after a burst
 * of retries the whole IP was throttled so hard that single requests spaced 25s
 * apart still came back 429, long after the burst stopped. Backing off inside the
 * run also blew past the runner's 20s per-source budget, so the source both
 * deepened the block and returned nothing. Failing the entire source on the first
 * 429 costs one subreddit's results in the rare case it was a fluke, and protects
 * the address the rest of the time.
 */
class RateLimited extends Error {}

/** Thrown when the RSS endpoint itself is gone; fetch() reports it once and goes quiet. */
class EndpointGone extends Error {}

/**
 * Fetches one listing, or throws why not. Every failure throws, so fetch() can tell
 * a quiet lane from a dead endpoint and report the second as a failed source rather
 * than as an "ok" source with 0 items (2026-11-18: every lane 404'd for a whole
 * digest, and the runs table said ok).
 */
async function fetchOnce(url: string, label: string, ctx: SourceCtx): Promise<Response> {
  const wait = state.nextRequestAt - Date.now();
  if (wait > 0) await sleep(wait);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs),
    });
  } catch (err) {
    state.nextRequestAt = Date.now() + REQUEST_SPACING_MS;
    throw new Error(`network error: ${(err as Error).message}`);
  }

  const reset = res.headers.get('x-ratelimit-reset');
  state.nextRequestAt = Date.now() + nextRequestDelayMs(res.headers.get('x-ratelimit-remaining'), reset);
  if (res.ok) {
    state.worked = true;
    return res;
  }
  if (res.status === 429) {
    state.blockedUntil = Date.now() + blockMsAfter429(res.headers.get('retry-after'), reset);
    state.blockReason = 'rate limited (HTTP 429)';
    throw new RateLimited(`${label} returned 429`);
  }
  if (res.status === 404 && !state.worked) {
    // Measured 2026-11-18, again 2026-11-21: Reddit's public RSS answers 404 "Not
    // Found" (served by rss.reddit.com) for every form, combined or single
    // subreddit, hot or new, with any user agent. That is the endpoint, not one
    // subreddit, so the other lanes would only wait out 30-60 s of pacing each to
    // get the same answer. A 404 after a listing has worked in this process is a
    // dead subreddit instead, and fails only its own lane.
    state.blockedUntil = Date.now() + GONE_BLOCK_MS;
    state.blockReason = GONE_REASON;
    state.gone = true;
    throw new EndpointGone(GONE_REASON);
  }

  // 403 and everything else: this lane fails, the next one still gets its turn.
  throw new Error(`HTTP ${res.status}`);
}

/** The subreddit a post belongs to, read from its permalink, lowercased. */
function subredditOf(entry: RedditEntry): string | undefined {
  return entry.link?.match(/\/r\/([^/]+)\//)?.[1]?.toLowerCase();
}

/** Splits a combined listing back into one entry list per subreddit, keeping hot order. */
export function groupBySubreddit(entries: RedditEntry[]): Map<string, RedditEntry[]> {
  const groups = new Map<string, RedditEntry[]>();
  for (const entry of entries) {
    const sub = subredditOf(entry);
    if (!sub) continue;
    const list = groups.get(sub) ?? [];
    list.push(entry);
    groups.set(sub, list);
  }
  return groups;
}

/**
 * One request for a whole lane: `/r/a+b+c/hot/.rss` is Reddit's combined listing,
 * and every entry's permalink names its subreddit. The rate limit is per request,
 * not per subreddit, so this turns ~25 requests a run into one per lane and stops
 * the later subreddits in the list losing out to a 429 every run. The trade-off is
 * that hot ranks the subreddits together, so a small one gets fewer slots than the
 * 25 it got alone; the 100-entry ceiling keeps that small in practice.
 */
async function fetchLane(
  specs: SubredditSpec[],
  ctx: SourceCtx,
): Promise<RawItem[]> {
  const label = specs.map((s) => `r/${s.sub}`).join('+');
  const url = `https://www.reddit.com/r/${specs.map((s) => s.sub).join('+')}/hot/.rss?limit=100`;
  const res = await fetchOnce(url, label, ctx);

  let entries: RedditEntry[];
  try {
    entries = (await parser.parseString(await res.text())).items;
  } catch (err) {
    throw new Error(`unparseable feed: ${(err as Error).message}`);
  }
  const groups = groupBySubreddit(entries);
  return specs.flatMap((spec) => mapEntries(groups.get(spec.sub.toLowerCase()) ?? [], spec, ctx));
}

/** One Atom entry as `rss-parser` hands it over. Only the fields this source reads. */
export interface RedditEntry {
  id?: string;
  link?: string;
  title?: string;
  author?: string;
  content?: string;
  isoDate?: string;
  pubDate?: string;
}

/**
 * Pure mapping from parsed Atom entries to RawItems. Split out from the fetch so
 * the parsing rules can be tested against a fixture: Reddit rate limits this
 * endpoint hard enough that a live test cannot reliably assert on content.
 */
export function mapEntries(entries: RedditEntry[], spec: SubredditSpec, ctx: SourceCtx): RawItem[] {
  // "Hot" is already ranked by Reddit's own engagement signal, and the RSS feed
  // carries no vote/comment counts to re-rank by. Taking the top N entries is the
  // same cost control as the old upvote threshold, expressed as a rank cutoff
  // instead of a vote count (config: thresholds.redditTopN).
  // A title gate runs before the cutoff, so a busy subreddit's top N are its top
  // N on-topic posts rather than whatever happened to be hot.
  const gated = spec.include ? entries.filter((e) => spec.include!.test(e.title ?? '')) : entries;
  const topN = gated.slice(0, ctx.config.thresholds.redditTopN);

  const items: RawItem[] = [];
  for (const entry of topN) {
    const permalink = entry.link;
    const id = entry.id;
    if (!permalink || !id) continue;

    const raw = entry.isoDate ?? entry.pubDate;
    const publishedAt = raw ? new Date(raw) : undefined;
    if (!publishedAt || Number.isNaN(publishedAt.getTime()) || publishedAt < ctx.since) continue;

    const contentHtml = entry.content ?? '';
    const outbound = extractOutboundLink(contentHtml, permalink);
    let body = toPlainBody(contentHtml).slice(0, BODY_CAP);
    if (outbound) {
      body = `${body}\n\nDiscussion: ${permalink}`.slice(0, BODY_CAP);
    }

    items.push({
      source: 'reddit',
      externalId: id,
      laneHint: spec.lane,
      // The article a link post points at, same rule as hn.ts: `url` is what the
      // post is about, falling back to the thread when the thread IS the content.
      // The feed and the digest surface this URL, so burying the article in the
      // body text left every reddit-sourced story linking at reddit instead.
      url: outbound ?? permalink,
      title: entry.title ?? '(untitled)',
      body: body.length > 0 ? body : undefined,
      author: entry.author,
      // RSS carries no vote or comment counts (unlike the JSON API this source
      // used to hit). Leaving this empty rather than inventing a number, since a
      // fake value would silently corrupt the engagement pre-filter downstream.
      engagement: {},
      publishedAt,
    });
  }
  return items;
}

export const reddit: Source = {
  name: 'reddit',
  // Seven requests 30-60 s apart took 337 s on 2026-10-14, far past the shared 20 s
  // budget. A timed-out source returns nothing rather than a partial result, so the
  // budget sits well clear of a slow run: an all-lanes call (the worker) is ~11
  // requests at up to 60 s each.
  timeoutMs: 900_000,
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    const subs = ctx.lanes
      ? ctx.config.subreddits.filter((s) => ctx.lanes!.includes(s.lane))
      : ctx.config.subreddits;

    const byLane = new Map<string, SubredditSpec[]>();
    for (const spec of subs) {
      const key = spec.solo ? `${spec.lane}:${spec.sub}` : spec.lane;
      byLane.set(key, [...(byLane.get(key) ?? []), spec]);
    }
    const lanes = [...byLane.values()];

    // The endpoint is gone and this process has already said so: nothing to fetch,
    // nothing to add to the log, and not a second failure for the same cause.
    if (state.gone && Date.now() < state.blockedUntil) return [];

    const items: RawItem[] = [];
    let succeeded = 0;
    const failures: string[] = [];
    for (const specs of lanes) {
      const label = specs.length === 1 && specs[0].solo ? `r/${specs[0].sub}` : specs[0].lane;
      if (Date.now() < state.blockedUntil) {
        // Stop knocking: the address has already been told to back off. The block
        // outlives this call, so the digest's later per-lane calls skip too.
        const until = new Date(state.blockedUntil).toLocaleTimeString();
        console.warn(`[reddit] ${state.blockReason}; skipping ${label} until ${until}`);
        failures.push(`${label} skipped, ${state.blockReason}`);
        continue;
      }
      try {
        items.push(...(await fetchLane(specs, ctx)));
        succeeded += 1;
      } catch (err) {
        if (err instanceof EndpointGone) {
          // One line and one failed source for the whole process, not one per lane:
          // a digest calls fetch() once per lane, and the later calls return above.
          const until = new Date(state.blockedUntil).toLocaleTimeString();
          console.warn(`[reddit] ${GONE_REASON}; Reddit is off, next check after ${until}`);
          throw err;
        }
        const why = err instanceof RateLimited ? 'HTTP 429' : (err as Error).message;
        console.warn(`[reddit] ${label} failed: ${why}`);
        failures.push(`${label}: ${why}`);
      }
    }

    // Some lanes working is a partial result and counts as a success. None working
    // is a failed source, so the runs table and the digest's "source(s) failed"
    // line say so instead of logging Reddit as ok with 0 items.
    if (succeeded === 0 && failures.length > 0) throw new Error(failures.join('; '));
    return items;
  },
};

export default reddit;

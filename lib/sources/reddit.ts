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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const href = match[1];
  return href && href !== permalink ? href : undefined;
}

/** Strips tags and the "submitted by /u/x [link] [comments]" footer reddit appends. */
function toPlainBody(contentHtml: string): string {
  const withoutFooter = contentHtml.replace(
    /(&#32;\s*)?submitted by[\s\S]*$/i,
    '',
  );
  const text = withoutFooter
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#32;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
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

async function fetchOnce(
  url: string,
  label: string,
  ctx: SourceCtx,
): Promise<{ res?: Response; delayMs: number }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs),
    });
  } catch (err) {
    console.warn(`[reddit] network error fetching ${label}: ${(err as Error).message}`);
    return { delayMs: REQUEST_SPACING_MS };
  }

  const delayMs = nextRequestDelayMs(res.headers.get('x-ratelimit-remaining'), res.headers.get('x-ratelimit-reset'));
  if (res.ok) return { res, delayMs };
  if (res.status === 429) throw new RateLimited(`${label} returned 429`);

  // 403 and everything else: degrade to partial results, keep going.
  console.warn(`[reddit] ${label} returned HTTP ${res.status}`);
  return { delayMs };
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
): Promise<{ items: RawItem[]; delayMs: number }> {
  const label = specs.map((s) => `r/${s.sub}`).join('+');
  const url = `https://www.reddit.com/r/${specs.map((s) => s.sub).join('+')}/hot/.rss?limit=100`;
  const { res, delayMs } = await fetchOnce(url, label, ctx);
  if (!res) return { items: [], delayMs };

  let entries: RedditEntry[];
  try {
    entries = (await parser.parseString(await res.text())).items;
  } catch (err) {
    console.warn(`[reddit] ${label} returned unparseable feed: ${(err as Error).message}`);
    return { items: [], delayMs };
  }
  const groups = groupBySubreddit(entries);
  const items = specs.flatMap((spec) => mapEntries(groups.get(spec.sub.toLowerCase()) ?? [], spec, ctx));
  return { items, delayMs };
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
  // budget sits well clear of a slow run.
  timeoutMs: 600_000,
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

    const items: RawItem[] = [];
    for (const [i, specs] of lanes.entries()) {
      let delayMs = REQUEST_SPACING_MS;
      try {
        const lane = await fetchLane(specs, ctx);
        items.push(...lane.items);
        delayMs = lane.delayMs;
      } catch (err) {
        if (err instanceof RateLimited) {
          // Stop the whole source here. Continuing would keep hitting an address
          // Reddit has already told us to back off, and the runner treats a short
          // partial result as a success, which is what we want.
          console.warn(`[reddit] rate limited (${err.message}); skipping ${lanes.length - i - 1} more lane(s) this run`);
          break;
        }
        console.warn(`[reddit] ${specs[0].lane} failed: ${(err as Error).message}`);
      }
      if (i < lanes.length - 1) await sleep(delayMs);
    }

    return items;
  },
};

export default reddit;

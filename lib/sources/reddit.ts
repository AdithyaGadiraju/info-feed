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
 * Subreddits are fetched one at a time, spaced by this much. Reddit's limit on
 * this endpoint is a single shared per-IP budget rather than a per-subreddit one,
 * so concurrency buys nothing and only makes our own requests collide.
 */
const REQUEST_SPACING_MS = 1_000;

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

async function fetchOnce(url: string, spec: SubredditSpec, ctx: SourceCtx): Promise<Response | undefined> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs),
    });
  } catch (err) {
    console.warn(`[reddit] network error fetching r/${spec.sub}: ${(err as Error).message}`);
    return undefined;
  }

  if (res.ok) return res;
  if (res.status === 429) throw new RateLimited(`r/${spec.sub} returned 429`);

  // 403 and everything else: degrade to partial results, keep going.
  console.warn(`[reddit] r/${spec.sub} returned HTTP ${res.status}`);
  return undefined;
}

async function fetchSubreddit(spec: SubredditSpec, ctx: SourceCtx): Promise<RawItem[]> {
  const url = `https://www.reddit.com/r/${spec.sub}/hot/.rss?limit=25`;
  const res = await fetchOnce(url, spec, ctx);
  if (!res) return [];

  let xml: string;
  let feed: Awaited<ReturnType<Parser['parseString']>>;
  try {
    xml = await res.text();
    feed = await parser.parseString(xml);
  } catch (err) {
    console.warn(`[reddit] r/${spec.sub} returned unparseable feed: ${(err as Error).message}`);
    return [];
  }

  // "Hot" is already ranked by Reddit's own engagement signal, and the RSS feed
  // carries no vote/comment counts to re-rank by. Taking the top N entries is the
  // same cost control as the old upvote threshold, expressed as a rank cutoff
  // instead of a vote count (config: thresholds.redditTopN).
  const topN = feed.items.slice(0, ctx.config.thresholds.redditTopN);

  const items: RawItem[] = [];
  for (const entry of topN) {
    const permalink = entry.link;
    const id = entry.id;
    if (!permalink || !id) continue;

    const publishedAt = entry.isoDate ? new Date(entry.isoDate) : entry.pubDate ? new Date(entry.pubDate) : undefined;
    if (!publishedAt || Number.isNaN(publishedAt.getTime()) || publishedAt < ctx.since) continue;

    const contentHtml = entry.content ?? '';
    const outbound = extractOutboundLink(contentHtml, permalink);
    let body = toPlainBody(contentHtml).slice(0, BODY_CAP);
    if (outbound) {
      body = `${body}\n\nLink: ${outbound}`.slice(0, BODY_CAP);
    }

    items.push({
      source: 'reddit',
      externalId: id,
      laneHint: spec.lane,
      url: permalink,
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
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    const subs = ctx.lanes
      ? ctx.config.subreddits.filter((s) => ctx.lanes!.includes(s.lane))
      : ctx.config.subreddits;

    const items: RawItem[] = [];
    for (const [i, spec] of subs.entries()) {
      try {
        items.push(...(await fetchSubreddit(spec, ctx)));
      } catch (err) {
        if (err instanceof RateLimited) {
          // Stop the whole source here. Continuing would keep hitting an address
          // Reddit has already told us to back off, and the runner treats a short
          // partial result as a success, which is what we want.
          console.warn(
            `[reddit] rate limited at r/${spec.sub}; skipping ${subs.length - i - 1} more subreddit(s) this run`,
          );
          break;
        }
        console.warn(`[reddit] r/${spec.sub} failed: ${(err as Error).message}`);
      }
      if (i < subs.length - 1) await sleep(REQUEST_SPACING_MS);
    }

    return items;
  },
};

export default reddit;

/**
 * Generic per-lane RSS ingestion (ADR 0002, T1). Curated RSS has no engagement
 * threshold — the curation of the feed list itself is the filter — so this source
 * emits every fresh item unfiltered and leaves scoring to the enrichment step.
 */
import Parser from 'rss-parser';
import type { FeedSpec, RawItem, Source, SourceCtx } from './types';

// A plain UA string, because some publishers (Cloudflare-fronted blogs especially)
// 403 the default Node/undici UA on RSS endpoints.
const USER_AGENT = 'info-feed/1.0 (personal news digest)';

// Six concurrent feed fetches is generous enough to keep a ~20-feed run fast
// without looking like a burst of traffic to any single host's shared infra.
const CONCURRENCY = 10;

/**
 * Requests to one host go out one at a time, at least this far apart. CONCURRENCY
 * only bounds the whole run: a lane lists 30 github.com feeds and two itch.io ones
 * next to each other, and they used to leave in the same instant. itch.io answered
 * that with 429 for both (2026-11-21).
 */
const HOST_SPACING_MS = 500;
/** A 429 is retried once, and only when the host names a wait no longer than this. */
const MAX_RETRY_AFTER_MS = 10_000;
/**
 * After a 429 with no usable Retry-After the host is left alone for this long, so
 * its other feeds do not knock again. Measured 2026-11-21: itch.io sends no
 * Retry-After and kept answering 429 for minutes while requests kept arriving.
 * Same idea as BLOCK_MS in reddit.ts.
 */
const HOST_BLOCK_MS = 15 * 60_000;

interface HostState {
  /** The host's queue: each request starts when the one before it has settled. */
  tail: Promise<unknown>;
  nextRequestAt: number;
  blockedUntil: number;
}

/**
 * Pacing and 429 state per host, held per PROCESS like the state in reddit.ts:
 * `npm run digest` calls fetch() once per lane, seconds apart.
 */
const hosts = new Map<string, HostState>();
let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Test hook: clears the per-host pacing state and optionally swaps the sleeper. */
export function resetRssState(opts: { sleep?: (ms: number) => Promise<void> } = {}): void {
  hosts.clear();
  if (opts.sleep) sleep = opts.sleep;
}

/** Retry-After as milliseconds from now: seconds or an HTTP date. Null when absent or junk. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Runs `tasks` with at most `limit` in flight at once, preserving input order. */
async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** Strips tags and collapses whitespace; RSS summaries frequently carry inline HTML. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseBody(item: Parser.Item): string | undefined {
  const raw = item.contentSnippet ?? item.summary;
  if (!raw) return undefined;
  const plain = stripHtml(raw);
  if (!plain) return undefined;
  return plain.length > 2000 ? plain.slice(0, 2000) : plain;
}

function parsePublishedAt(item: Parser.Item): Date {
  const raw = item.isoDate ?? item.pubDate;
  if (raw) {
    const d = new Date(raw);
    // Some feeds ship malformed dates; fall through to "now" rather than emit an Invalid Date.
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** One download, in its host's turn. Throws why not, so the caller logs one line. */
async function fetchPaced(url: string, host: string, state: HostState, ctx: SourceCtx): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    if (Date.now() < state.blockedUntil) throw new Error(`skipped, ${host} is rate limiting this address`);
    const wait = state.nextRequestAt - Date.now();
    if (wait > 0) await sleep(wait);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs),
      });
    } finally {
      state.nextRequestAt = Date.now() + HOST_SPACING_MS;
    }

    if (res.ok) {
      const text = await res.text();
      // A site that goes private or puts up a challenge answers 200 with a web page
      // (2026-11-21: updates.midjourney.com redirects /rss/ to a password page).
      // Say so, rather than let the XML parser report "Unexpected close tag".
      if (/^\s*<(!doctype html|html)\b/i.test(text)) {
        throw new Error(`not a feed: got an HTML page${res.redirected ? ` (redirected to ${res.url})` : ''}`);
      }
      return text;
    }
    if (res.status === 429) {
      const retry = retryAfterMs(res.headers.get('retry-after'));
      if (attempt === 0 && retry !== null && retry <= MAX_RETRY_AFTER_MS) {
        state.nextRequestAt = Math.max(state.nextRequestAt, Date.now() + retry);
        continue;
      }
      state.blockedUntil = Date.now() + Math.max(retry ?? 0, HOST_BLOCK_MS);
    }
    throw new Error(`HTTP ${res.status}`);
  }
}

async function fetchXml(url: string, ctx: SourceCtx): Promise<string> {
  const host = new URL(url).host;
  let state = hosts.get(host);
  if (!state) {
    state = { tail: Promise.resolve(), nextRequestAt: 0, blockedUntil: 0 };
    hosts.set(host, state);
  }
  const queued = state;
  const run = queued.tail.then(() => fetchPaced(url, host, queued, ctx));
  queued.tail = run.catch(() => {});
  return run;
}

/**
 * `xmlByUrl` holds one download per URL for the run. A feed can be listed more
 * than once, under different lanes and title gates (the events lane reads vendor
 * feeds that ai_gamedev already reads), and each listing parses the same text.
 */
async function fetchFeed(feed: FeedSpec, ctx: SourceCtx, xmlByUrl: Map<string, Promise<string>>): Promise<RawItem[]> {
  let pending = xmlByUrl.get(feed.url);
  if (!pending) {
    pending = fetchXml(feed.url, ctx);
    xmlByUrl.set(feed.url, pending);
  }
  const xml = await pending;

  const parser = new Parser({
    headers: { 'User-Agent': USER_AGENT },
    timeout: ctx.config.sourceTimeoutMs,
  });
  const parsed = await parser.parseString(xml);

  const seen = new Set<string>();
  const items: RawItem[] = [];
  for (const entry of parsed.items) {
    const url = entry.link;
    const title = entry.title ? stripHtml(entry.title) : undefined;
    if (!url || !title) continue;
    if (feed.include && !feed.include.test(title)) continue;
    if (feed.exclude?.test(title)) continue;

    // guid over link: some feeds reuse a canonical link across items (e.g. a
    // redesign) while the guid stays stable, so guid is the safer dedupe key.
    const externalId = entry.guid ?? url;
    if (seen.has(externalId)) continue;

    const publishedAt = parsePublishedAt(entry);
    if (publishedAt < ctx.since) continue;

    seen.add(externalId);
    items.push({
      source: 'rss',
      externalId,
      laneHint: feed.lane,
      url,
      title,
      body: parseBody(entry),
      // rss-parser normalizes both RSS `dc:creator` and Atom `author` into `creator`.
      author: entry.creator ?? feed.name,
      publishedAt,
    });
  }
  return items;
}

export const rss: Source = {
  name: 'rss',
  // Each feed has its own `sourceTimeoutMs` abort, but a lane fetches dozens of
  // feeds CONCURRENCY at a time, so the source as a whole needs a longer budget.
  // At the shared 20s, one slow feed (arXiv takes 10-40s) in a 60-feed lane timed
  // the whole source out, and a timed-out source returns nothing at all.
  timeoutMs: 90_000,
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    const feeds = ctx.lanes ? ctx.config.feeds.filter((f) => ctx.lanes!.includes(f.lane)) : ctx.config.feeds;

    const xmlByUrl = new Map<string, Promise<string>>();
    const results = await runWithConcurrency(
      feeds.map((feed) => async () => {
        try {
          return await fetchFeed(feed, ctx, xmlByUrl);
        } catch (err) {
          // A single dead/slow publisher must never take the whole source down
          // (ADR 0002) — log and move on, the run keeps whatever else succeeded.
          console.warn(`[rss] ${feed.name} (${feed.url}) failed: ${(err as Error).message}`);
          return [] as RawItem[];
        }
      }),
      CONCURRENCY,
    );

    return results.flat();
  },
};

export default rss;

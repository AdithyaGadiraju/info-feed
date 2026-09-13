/**
 * Generic per-lane RSS ingestion (ADR 0002, T1). Curated RSS has no engagement
 * threshold — the curation of the feed list itself is the filter — so this source
 * emits every fresh item unfiltered and leaves scoring to the enrichment step.
 */
import Parser from 'rss-parser';
import type { FeedSpec, RawItem, Source, SourceCtx } from './types.js';

// A plain UA string, because some publishers (Cloudflare-fronted blogs especially)
// 403 the default Node/undici UA on RSS endpoints.
const USER_AGENT = 'info-feed/1.0 (personal news digest)';

// Six concurrent feed fetches is generous enough to keep a ~20-feed run fast
// without looking like a burst of traffic to any single host's shared infra.
const CONCURRENCY = 6;

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

async function fetchFeed(feed: FeedSpec, ctx: SourceCtx): Promise<RawItem[]> {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();

  const parser = new Parser({
    headers: { 'User-Agent': USER_AGENT },
    timeout: ctx.config.sourceTimeoutMs,
  });
  const parsed = await parser.parseString(xml);

  const seen = new Set<string>();
  const items: RawItem[] = [];
  for (const entry of parsed.items) {
    const url = entry.link;
    const title = entry.title?.trim();
    if (!url || !title) continue;

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
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    const feeds = ctx.lanes ? ctx.config.feeds.filter((f) => ctx.lanes!.includes(f.lane)) : ctx.config.feeds;

    const results = await runWithConcurrency(
      feeds.map((feed) => async () => {
        try {
          return await fetchFeed(feed, ctx);
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

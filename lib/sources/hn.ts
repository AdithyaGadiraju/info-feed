/**
 * Hacker News via the Algolia HN Search API (free, no key). Two kinds of pull:
 * the front page (undifferentiated, routed into a lane by keyword) and one
 * keyword search per lane from `ctx.config.hnQueries` (already lane-scoped).
 */
import type { Lane } from '../db/types.js';
import type { RawItem, Source, SourceCtx } from './types.js';

const ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';
const FRONT_PAGE_HITS_PER_PAGE = 50;
const QUERY_HITS_PER_PAGE = 50;

interface AlgoliaHit {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string | null;
  points: number | null;
  num_comments: number | null;
  created_at: string;
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
}

/**
 * Routes an HN front-page story into a lane by first-match keyword against the
 * title (case-insensitive). Front-page stories have no lane of their own, and
 * guessing on a weak match would let one popular story flood a lane, so
 * unmatched titles are dropped rather than defaulted anywhere.
 */
export function routeFrontPageLane(
  title: string,
  rules: SourceCtx['config']['hnFrontPageLaneKeywords'],
): Lane | null {
  const lower = title.toLowerCase();
  for (const rule of rules) {
    if (rule.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return rule.lane;
    }
  }
  return null;
}

function hnUrl(hit: AlgoliaHit): string {
  return hit.url && hit.url.length > 0
    ? hit.url
    : `https://news.ycombinator.com/item?id=${hit.objectID}`;
}

function toRawItem(hit: AlgoliaHit, laneHint: Lane): RawItem {
  return {
    source: 'hn',
    externalId: hit.objectID,
    laneHint,
    url: hnUrl(hit),
    title: hit.title ?? '',
    author: hit.author ?? undefined,
    engagement: { points: hit.points ?? 0, comments: hit.num_comments ?? 0 },
    publishedAt: new Date(hit.created_at),
  };
}

async function fetchAlgolia(url: string, timeoutMs: number): Promise<AlgoliaHit[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`hn: ${url} responded ${res.status}`);
  const body = (await res.json()) as AlgoliaResponse;
  return body.hits ?? [];
}

async function fetchFrontPage(ctx: SourceCtx): Promise<RawItem[]> {
  const url = `${ALGOLIA_BASE}/search?tags=front_page&hitsPerPage=${FRONT_PAGE_HITS_PER_PAGE}`;
  const hits = await fetchAlgolia(url, ctx.config.sourceTimeoutMs);
  const items: RawItem[] = [];
  for (const hit of hits) {
    const lane = routeFrontPageLane(hit.title ?? '', ctx.config.hnFrontPageLaneKeywords);
    if (lane === null) continue;
    if (ctx.lanes && !ctx.lanes.includes(lane)) continue;
    items.push(toRawItem(hit, lane));
  }
  return items;
}

/**
 * The relevance-ranked `search` endpoint, not `search_by_date`, despite these
 * being incremental since-a-timestamp pulls. `hnQueries` entries are
 * multi-term "A OR B OR C" strings, and Algolia's default query mode is an
 * AND over every token (confirmed empirically: querying "bitcoin OR ethereum"
 * with no extra params returns zero hits, because it requires the literal
 * word "OR" to appear too). `removeWordsIfNoResults=allOptional` turns that
 * into an OR-of-terms match instead. Once matching is OR-based, `search_by_date`
 * degenerates to "newest story containing any one keyword", which is mostly
 * noise (single stray word matches); relevance ranking, restricted to the
 * window by `numericFilters`, actually surfaces the on-topic stories.
 */
async function fetchLaneQuery(
  spec: { lane: Lane; query: string },
  ctx: SourceCtx,
): Promise<RawItem[]> {
  const sinceSeconds = Math.floor(ctx.since.getTime() / 1000);
  const url =
    `${ALGOLIA_BASE}/search?query=${encodeURIComponent(spec.query)}` +
    `&tags=story&numericFilters=created_at_i>${sinceSeconds}` +
    `&removeWordsIfNoResults=allOptional&hitsPerPage=${QUERY_HITS_PER_PAGE}`;
  const hits = await fetchAlgolia(url, ctx.config.sourceTimeoutMs);
  return hits.map((hit) => toRawItem(hit, spec.lane));
}

async function fetch_(ctx: SourceCtx): Promise<RawItem[]> {
  const queries = ctx.config.hnQueries.filter(
    (spec) => !ctx.lanes || ctx.lanes.includes(spec.lane),
  );

  // Bounded set of requests (front page + one per configured lane query); run
  // them concurrently but let any single failure just drop that slice of
  // results rather than fail the whole source.
  const tasks: Array<Promise<RawItem[]>> = [
    fetchFrontPage(ctx),
    ...queries.map((spec) => fetchLaneQuery(spec, ctx)),
  ];

  const settled = await Promise.allSettled(tasks);
  const seen = new Set<string>();
  const out: RawItem[] = [];
  // Front page is index 0, so it wins dedupe ties over keyword-search hits.
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value) {
      if (seen.has(item.externalId)) continue;
      seen.add(item.externalId);
      out.push(item);
    }
  }
  return out;
}

export const hn: Source = {
  name: 'hn',
  fetch: fetch_,
};

export default hn;

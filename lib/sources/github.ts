/**
 * GitHub repository search (free; a token is optional). Blender add-ons, engine MCP
 * servers and ComfyUI workflows launch as GitHub repos long before anyone writes
 * them up, and stars are the traction signal.
 *
 * Each spec searches only repositories created in the last LOOKBACK_DAYS, ranked by
 * stars, so a new repo taking off is near the top instead of buried under the
 * all-time giants. Like `huggingface.ts`, this is not a snapshot source and does not
 * filter on `ctx.since`: stars arrive over days, so every run returns each new repo
 * that clears its spec's `minStars`. The runner upserts on (source, externalId), so
 * a repo already stored only has its star count refreshed, and a repo below the bar
 * first reaches the database on the run it crosses it, as a new pending item.
 */
import { env } from '../env';
import type { GithubSearchSpec, RawItem, Source, SourceCtx } from './types';

const SEARCH_URL = 'https://api.github.com/search/repositories';
const USER_AGENT = 'info-feed/1.0 (personal news digest)';
const DAY_MS = 24 * 60 * 60 * 1000;

const LOOKBACK_DAYS = 30;
/** One page. Sorted by stars, anything past 30 is far below every `minStars`. */
const PER_PAGE = 30;
/** The unauthenticated search budget is 10 requests a minute; one run never spends more. */
const MAX_QUERIES = 10;

/**
 * Gap between searches. Measured 2026-10-14: nine unauthenticated searches 7 s apart
 * all succeeded and `x-ratelimit-remaining` reset to 9 on the tenth, so 6.5 s (60 s
 * over 10 calls, with margin) never trips the limit. A token raises it to 30 a minute.
 */
export function requestSpacingMs(hasToken: boolean): number {
  return hasToken ? 2_100 : 6_500;
}

/** One repository as the search API returns it. Only the fields this source reads. */
export interface GithubRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  created_at: string;
  fork?: boolean;
  owner?: { login?: string };
}

interface SearchResponse {
  items?: GithubRepo[];
}

/** Abandons the rest of the run: retrying a rate-limited search only extends the block. */
class RateLimited extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function searchUrl(spec: GithubSearchSpec, oldest: Date): string {
  const q = `${spec.query} created:>=${oldest.toISOString().slice(0, 10)}`;
  return `${SEARCH_URL}?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_PAGE}`;
}

/** Pure mapping from search results to RawItems, split out so the threshold can be tested against a fixture. */
export function mapRepos(repos: GithubRepo[], spec: GithubSearchSpec): RawItem[] {
  const items: RawItem[] = [];
  for (const repo of repos) {
    if (!repo.full_name || !repo.html_url || repo.fork) continue;
    if (repo.stargazers_count < spec.minStars) continue;
    const publishedAt = new Date(repo.created_at);
    if (Number.isNaN(publishedAt.getTime())) continue;

    const description = repo.description?.replace(/\s+/g, ' ').trim();
    items.push({
      source: 'github',
      externalId: repo.full_name,
      laneHint: spec.lane,
      url: repo.html_url,
      title: description ? `${repo.full_name}: ${description}` : repo.full_name,
      // No body: the description is already the title, and the runner extracts the
      // README from the repo page, which says far more (checked 2026-10-14).
      author: repo.owner?.login,
      engagement: { likes: repo.stargazers_count },
      publishedAt,
    });
  }
  return items;
}

async function search(spec: GithubSearchSpec, oldest: Date, ctx: SourceCtx, token: string | undefined): Promise<RawItem[]> {
  const res = await fetch(searchUrl(spec, oldest), {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs),
  });
  // GitHub answers an exhausted search budget with 403 or 429.
  if (res.status === 403 || res.status === 429) throw new RateLimited(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as SearchResponse;
  return mapRepos(body.items ?? [], spec);
}

export const github: Source = {
  name: 'github',
  // Ten searches 6.5 s apart is a minute of waiting by design (71 s end to end on
  // 2026-10-14), far past the shared 20 s budget. A timed-out source returns
  // nothing, so leave a wide margin.
  timeoutMs: 120_000,
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    const all = ctx.lanes ? ctx.config.github.filter((s) => ctx.lanes!.includes(s.lane)) : ctx.config.github;
    if (all.length > MAX_QUERIES) {
      console.warn(`[github] ${all.length} searches configured; running the first ${MAX_QUERIES}`);
    }
    const specs = all.slice(0, MAX_QUERIES);
    const token = env.githubToken;
    const now = Date.now();
    // The earlier of the two, so a long `--since` backfill is not cut short by the window.
    const oldest = new Date(Math.min(ctx.since.getTime(), now - LOOKBACK_DAYS * DAY_MS));

    const seen = new Set<string>();
    const items: RawItem[] = [];
    for (const [i, spec] of specs.entries()) {
      if (i > 0) await sleep(requestSpacingMs(token !== undefined));
      try {
        for (const item of await search(spec, oldest, ctx, token)) {
          // A repo can match two searches; the first one listed keeps it.
          if (seen.has(item.externalId)) continue;
          seen.add(item.externalId);
          items.push(item);
        }
      } catch (err) {
        if (err instanceof RateLimited) {
          console.warn(`[github] rate limited (${err.message}); skipping ${specs.length - i - 1} more search(es) this run`);
          break;
        }
        // One search failing must not hide the others (ADR 0002).
        console.warn(`[github] ${spec.name} failed: ${(err as Error).message}`);
      }
    }
    return items;
  },
};

export default github;

/**
 * The ingest runner (ADR 0002).
 *
 * Three concerns live here and deliberately nowhere else, because every source
 * would otherwise reimplement them: parallelism with a per-source timeout, the
 * engagement pre-filter, and article body fetching. A source module only knows
 * how to talk to its own upstream and hand back RawItems.
 */
import { sourcesConfig } from '../../config/sources';
import { finishRun, setItemBodies, startRun, upsertItems } from '../db/queries';
import { EXCLUDED_STORY_ID, type NewItem } from '../db/types';
import { fetchBodies } from '../fetchBody';
import hn from './hn';
import prices from './prices';
import reddit from './reddit';
import rss from './rss';
import steam from './steam';
import twitter from './twitter';
import type { Lane, RawItem, Source, SourcesConfig, Thresholds } from './types';

/** Fetch order is irrelevant (they run concurrently); this is reporting order. */
export const allSources: Source[] = [rss, reddit, hn, steam, prices, twitter];

/**
 * A ceiling on body extraction per run. Bodies are the slowest part of ingestion
 * by an order of magnitude, and an unbounded first run against a fresh database
 * would sit there for minutes.
 */
export const DEFAULT_MAX_BODIES = 60;
const BODY_CONCURRENCY = 5;

export interface SourceReport {
  source: Source['name'];
  ok: boolean;
  /** Items returned by the source, after lane filtering and in-run dedupe. */
  fetched: number;
  /** Rows the upsert touched: inserted plus updated. */
  stored: number;
  inserted: number;
  /** Stored with story_id = EXCLUDED_STORY_ID by the engagement pre-filter. */
  filtered: number;
  bodiesFetched: number;
  /** Returned items whose laneHint was outside the requested lanes. */
  outOfLane: number;
  durationMs: number;
  error?: string;
}

export interface IngestResult {
  runId: number | null;
  since: Date;
  lanes: Lane[] | null;
  sources: SourceReport[];
  /** Each of these four is the sum of the matching per-source field. */
  fetched: number;
  stored: number;
  filtered: number;
  bodiesFetched: number;
  failed: Array<{ source: string; error: string }>;
  durationMs: number;
}

export interface IngestOptions {
  lanes?: Lane[];
  since: Date;
  /** Overridable so tests can inject a broken or hanging source. */
  sources?: Source[];
  /** Overridable so tests can set their own thresholds and timeouts. */
  config?: SourcesConfig;
  maxBodies?: number;
  /** `runs.job`, so tests can log under a name they are allowed to delete. */
  job?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Races a source against the clock. An abandoned fetch keeps running to
 * completion in the background; that is acceptable because a source holds no
 * locks, and the one source that writes (prices) writes idempotent snapshots.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The engagement pre-filter, the main cost control in the system (ADR 0002).
 * Excluded items are still stored, so the record of what was seen stays
 * complete; they just never reach the model.
 *
 * Keyed on the producing source's `name` rather than on `item.source`, so the
 * decision cannot be swayed by whatever string a source stamps on its rows.
 */
export function shouldExclude(
  sourceName: Source['name'],
  item: RawItem,
  thresholds: Thresholds,
): boolean {
  const engagement = item.engagement;

  switch (sourceName) {
    case 'reddit': {
      const upvotes = engagement?.upvotes;
      // THE TRAP: Reddit's .rss endpoint carries no vote counts, so `upvotes` is
      // normally absent. A missing count is not a count of zero -- reading it as
      // zero would filter out every single Reddit item. The source has already
      // applied the real cost control by capping itself to thresholds.redditTopN
      // per subreddit, so the upvote threshold only bites once a count actually
      // exists, which is the OAuth follow-up in ADR 0002.
      if (typeof upvotes !== 'number') return false;
      return upvotes < thresholds.redditMinUpvotes;
    }
    case 'hn': {
      const points = engagement?.points;
      if (typeof points !== 'number') return false;
      return points < thresholds.hnMinPoints;
    }
    case 'twitter': {
      const likes = engagement?.likes;
      if (typeof likes !== 'number') return false;
      return likes < thresholds.twitterMinLikes;
    }
    // rss is filtered by the curation of the feed list itself; steam and prices
    // carry no engagement number to threshold on.
    default:
      return false;
  }
}

/**
 * Postgres refuses an ON CONFLICT DO UPDATE that would touch the same row twice
 * inside one statement, so a source returning an externalId twice would blow up
 * the whole batch. Cheaper to collapse it here than to trust six modules.
 */
function dedupe(items: RawItem[]): RawItem[] {
  const seen = new Set<string>();
  const out: RawItem[] = [];
  for (const item of items) {
    const key = `${item.source} ${item.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

interface BodyCandidate {
  id: number;
  url: string;
  sourceName: Source['name'];
}

function isFetchableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function ingest(opts: IngestOptions): Promise<IngestResult> {
  const startedAt = Date.now();
  const config = opts.config ?? sourcesConfig;
  const sources = opts.sources ?? allSources;
  const lanes = opts.lanes && opts.lanes.length > 0 ? opts.lanes : undefined;
  const maxBodies = opts.maxBodies ?? DEFAULT_MAX_BODIES;
  const runId = await startRun(opts.job ?? 'ingest');

  try {
    // One broken source must never take down ingestion (ADR 0002), so every
    // fetch is both time-boxed and settled rather than awaited as a group.
    const settled = await Promise.allSettled(
      sources.map(async (source) => {
        const sourceStartedAt = Date.now();
        try {
          const items = await withTimeout(
            source.fetch({ since: opts.since, config, lanes }),
            config.sourceTimeoutMs,
          );
          return { items, durationMs: Date.now() - sourceStartedAt };
        } catch (err) {
          throw new Error(`${source.name}: ${message(err)}`, { cause: err });
        }
      }),
    );

    const reports: SourceReport[] = [];
    const failed: Array<{ source: string; error: string }> = [];
    const candidates: BodyCandidate[] = [];

    for (let i = 0; i < sources.length; i += 1) {
      const source = sources[i];
      const outcome = settled[i];

      if (outcome.status === 'rejected') {
        const error = message(outcome.reason);
        failed.push({ source: source.name, error });
        reports.push({
          source: source.name,
          ok: false,
          fetched: 0,
          stored: 0,
          inserted: 0,
          filtered: 0,
          bodiesFetched: 0,
          outOfLane: 0,
          durationMs: 0,
          error,
        });
        continue;
      }

      const raw = dedupe(outcome.value.items);
      // HN's front page in particular can route a story into a lane the caller
      // never asked for; drop it here rather than teaching every source to care.
      const inLane = lanes ? raw.filter((item) => lanes.includes(item.laneHint)) : raw;

      const excluded = new Set<string>();
      const toWrite: NewItem[] = inLane.map((item) => {
        const isExcluded = shouldExclude(source.name, item, config.thresholds);
        if (isExcluded) excluded.add(item.externalId);
        return {
          source: item.source,
          externalId: item.externalId,
          laneHint: item.laneHint,
          url: item.url,
          title: item.title,
          body: item.body ?? null,
          author: item.author ?? null,
          engagement: item.engagement ?? {},
          publishedAt: item.publishedAt,
          // The sentinel goes in on the insert itself, so enrichment cannot pick
          // the item up in the window between writing it and marking it.
          storyId: isExcluded ? EXCLUDED_STORY_ID : null,
        };
      });

      let stored = 0;
      let inserted = 0;
      let writeError: string | undefined;
      try {
        // One statement per source, never one per item: each is a network round
        // trip to Supabase (ADR 0001).
        const result = await upsertItems(toWrite);
        stored = result.total;
        inserted = result.inserted.length;

        for (const row of result.inserted) {
          // Bodies are fetched only for rows that are new, passed the pre-filter
          // and have no body yet. Fetching one for an excluded item would spend
          // exactly the time and bandwidth the pre-filter exists to save.
          if (row.hasBody) continue;
          if (excluded.has(row.externalId)) continue;
          if (!isFetchableUrl(row.url)) continue;
          candidates.push({ id: row.id, url: row.url, sourceName: source.name });
        }
      } catch (err) {
        writeError = `${source.name} upsert: ${message(err)}`;
        failed.push({ source: source.name, error: writeError });
      }

      reports.push({
        source: source.name,
        ok: writeError === undefined,
        fetched: inLane.length,
        stored,
        inserted,
        filtered: excluded.size,
        bodiesFetched: 0,
        outOfLane: raw.length - inLane.length,
        durationMs: outcome.value.durationMs,
        error: writeError,
      });
    }

    const bodiesBySource = await fetchAndStoreBodies(candidates, {
      maxBodies,
      timeoutMs: config.bodyTimeoutMs,
    });
    for (const report of reports) {
      report.bodiesFetched = bodiesBySource.get(report.source) ?? 0;
    }

    const result: IngestResult = {
      runId,
      since: opts.since,
      lanes: lanes ?? null,
      sources: reports,
      fetched: reports.reduce((n, r) => n + r.fetched, 0),
      stored: reports.reduce((n, r) => n + r.stored, 0),
      filtered: reports.reduce((n, r) => n + r.filtered, 0),
      bodiesFetched: reports.reduce((n, r) => n + r.bodiesFetched, 0),
      failed,
      durationMs: Date.now() - startedAt,
    };

    // `runs` is the only observability in the system (ADR 0001), so these counts
    // have to be enough to diagnose a quiet feed without reading the code.
    const allFailed = reports.length > 0 && failed.length === reports.length;
    await finishRun(
      runId,
      !allFailed,
      {
        since: opts.since.toISOString(),
        lanes: lanes ?? 'all',
        fetched: result.fetched,
        stored: result.stored,
        filtered: result.filtered,
        bodies: result.bodiesFetched,
        durationMs: result.durationMs,
        failedSources: failed.map((f) => f.source),
        bySource: Object.fromEntries(
          reports.map((r) => [
            r.source,
            {
              ok: r.ok,
              fetched: r.fetched,
              stored: r.stored,
              inserted: r.inserted,
              filtered: r.filtered,
              bodies: r.bodiesFetched,
              ms: r.durationMs,
              ...(r.error ? { error: r.error } : {}),
            },
          ]),
        ),
      },
      allFailed ? failed.map((f) => `${f.source}: ${f.error}`).join('; ') : null,
    );

    return result;
  } catch (err) {
    await finishRun(runId, false, {}, message(err));
    throw err;
  }
}

async function fetchAndStoreBodies(
  candidates: BodyCandidate[],
  opts: { maxBodies: number; timeoutMs: number },
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const picked = candidates.slice(0, opts.maxBodies);
  if (picked.length === 0) return counts;

  const bodies = await fetchBodies(
    picked.map((c) => c.url),
    { concurrency: BODY_CONCURRENCY, timeoutMs: opts.timeoutMs },
  );

  const updates: Array<{ id: number; body: string }> = [];
  for (const candidate of picked) {
    const body = bodies.get(candidate.url);
    if (!body) continue;
    updates.push({ id: candidate.id, body });
    counts.set(candidate.sourceName, (counts.get(candidate.sourceName) ?? 0) + 1);
  }

  // One statement for every body in the run, same reasoning as the upsert.
  await setItemBodies(updates);
  return counts;
}

export default ingest;

/**
 * Hugging Face Hub (free, no key). Two kinds of pull: new models that are getting
 * traction, by pipeline tag or name, and Daily Papers whose title is about something
 * a game can ship (3D, textures, motion, audio, world models). Open 3D and audio
 * models land here first, days before a vendor blog or fal.ai picks them up.
 *
 * Not a snapshot source, and not filtered by `ctx.since`. A model's signal is its
 * likes, and likes arrive over days: a model created ten days ago that reaches 50
 * likes today must still become an item, and a since-filter on its creation date
 * would drop exactly that model. So every run returns each model created in the
 * last MODEL_LOOKBACK_DAYS that clears its spec's `minLikes`, and each paper from
 * the last PAPER_LOOKBACK_DAYS that clears `minUpvotes`. The runner upserts on
 * (source, externalId): a model already stored only has its likes refreshed, and a
 * model below the bar is never returned, so it first reaches the database on the
 * run it crosses the bar, as a new pending item. `snapshot` would be wrong here: it
 * never revisits a known id, and it seeds a spec's first listing silently, so a spec
 * that matched nothing on its first run would swallow the first model it ever found.
 */
import type { HfModelSpec, HfPapersSpec, Lane, RawItem, Source, SourceCtx } from './types';

const HUB = 'https://huggingface.co';
const USER_AGENT = 'info-feed/1.0 (personal news digest)';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back a model's creation date may be. Measured 2026-10-14: the models that
 * mattered (TRELLIS.2, Pixal3D, HY-Motion) had hundreds of likes within weeks, while
 * the repo is often created a week or two before the public release.
 */
const MODEL_LOOKBACK_DAYS = 30;
/** Trending is ranked by recent likes, so a new model with traction is always near the top. */
const MODEL_LIMIT = 100;
/**
 * Papers collect most of their upvotes in the first two days. Four days of listings
 * keeps a paper in view while it climbs and covers a weekend, when the listing is empty.
 */
const PAPER_LOOKBACK_DAYS = 4;
/** The endpoint's ceiling; `limit=200` is a 400. A busy day lists about 90. */
const PAPERS_PER_DAY = 100;
const BODY_CAP = 2000;

/** One model as `/api/models` returns it with the `expand[]` fields below. */
export interface HubModel {
  id: string;
  likes?: number;
  createdAt?: string;
  pipeline_tag?: string;
}

/** One `/api/daily_papers` entry. Only the fields this source reads. */
export interface DailyPaper {
  paper: {
    id: string;
    title?: string;
    summary?: string;
    upvotes?: number;
    submittedOnDailyAt?: string;
    publishedAt?: string;
    authors?: Array<{ name?: string }>;
  };
  title?: string;
  numComments?: number;
  organization?: { fullname?: string; name?: string };
}

function parseDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** The trending listing for one spec, trimmed by `expand[]` to the fields the source reads. */
export function modelsUrl(spec: HfModelSpec): string {
  const params = new URLSearchParams({ sort: 'trendingScore', direction: '-1', limit: String(MODEL_LIMIT) });
  if (spec.pipelineTag) params.set('pipeline_tag', spec.pipelineTag);
  if (spec.search) params.set('search', spec.search);
  // Without `expand` every model carries its whole file list, about 10x the payload.
  for (const field of ['createdAt', 'likes', 'pipeline_tag']) params.append('expand[]', field);
  return `${HUB}/api/models?${params}`;
}

/** UTC dates, newest first, the way `/api/daily_papers?date=` keys its listings. */
export function paperDates(now: Date, days = PAPER_LOOKBACK_DAYS): string[] {
  return Array.from({ length: days }, (_, i) => new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10));
}

/**
 * Pure mapping from a trending listing to RawItems, split out so the window and
 * threshold rules can be tested against a fixture. `oldest` is the earliest
 * creation date that still counts as new.
 */
export function mapModels(models: HubModel[], spec: HfModelSpec, oldest: Date): RawItem[] {
  const items: RawItem[] = [];
  for (const model of models) {
    const createdAt = parseDate(model.createdAt);
    if (!model.id || !createdAt || createdAt < oldest) continue;
    const likes = model.likes ?? 0;
    if (likes < spec.minLikes) continue;

    const tag = model.pipeline_tag ?? spec.pipelineTag;
    const owner = model.id.includes('/') ? model.id.split('/')[0] : undefined;
    items.push({
      source: 'huggingface',
      externalId: model.id,
      laneHint: spec.lane,
      url: `${HUB}/${model.id}`,
      title: tag ? `${model.id} (${tag})` : model.id,
      // No body: the runner extracts the model card from the page, which reads
      // cleanly (checked on TRELLIS.2 and Fish Audio Drama 3, 2026-10-14).
      author: owner,
      engagement: { likes },
      publishedAt: createdAt,
    });
  }
  return items;
}

/** Pure mapping from Daily Papers listings to RawItems for one title gate. */
export function mapPapers(entries: DailyPaper[], spec: HfPapersSpec, now: Date): RawItem[] {
  const items: RawItem[] = [];
  for (const entry of entries) {
    const paper = entry.paper;
    const title = (paper?.title ?? entry.title ?? '').replace(/\s+/g, ' ').trim();
    if (!paper?.id || !title) continue;
    if (!spec.include.test(title) || spec.exclude?.test(title)) continue;
    const upvotes = Number(paper.upvotes ?? 0);
    if (!(upvotes >= spec.minUpvotes)) continue;

    const summary = paper.summary?.replace(/\s+/g, ' ').trim();
    items.push({
      source: 'huggingface',
      // Model ids always contain a slash and arXiv ids never start with "papers/",
      // so the two kinds of item cannot collide on the dedupe key.
      externalId: `papers/${paper.id}`,
      laneHint: spec.lane,
      url: `${HUB}/papers/${paper.id}`,
      title,
      body: summary ? summary.slice(0, BODY_CAP) : undefined,
      author: entry.organization?.fullname ?? paper.authors?.[0]?.name,
      engagement: { upvotes, comments: entry.numComments ?? 0 },
      // The day it reached Daily Papers, which is when it became news here.
      publishedAt: parseDate(paper.submittedOnDailyAt) ?? parseDate(paper.publishedAt) ?? now,
    });
  }
  return items;
}

function inLanes<T extends { lane: Lane }>(specs: T[], lanes: Lane[] | undefined): T[] {
  return lanes ? specs.filter((s) => lanes.includes(s.lane)) : specs;
}

async function getJson<T>(url: string, ctx: SourceCtx): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchModels(specs: HfModelSpec[], ctx: SourceCtx, now: Date): Promise<RawItem[]> {
  // The earlier of the two, so a long `--since` backfill is not cut short by the window.
  const oldest = new Date(Math.min(ctx.since.getTime(), now.getTime() - MODEL_LOOKBACK_DAYS * DAY_MS));
  const items: RawItem[] = [];
  // Sequential: a handful of calls a run, and the Hub's anonymous limit is per address.
  for (const spec of specs) {
    try {
      items.push(...mapModels(await getJson<HubModel[]>(modelsUrl(spec), ctx), spec, oldest));
    } catch (err) {
      // One listing failing must not hide the others (ADR 0002).
      console.warn(`[huggingface] models ${spec.name} failed: ${(err as Error).message}`);
    }
  }
  return items;
}

async function fetchPapers(specs: HfPapersSpec[], ctx: SourceCtx, now: Date): Promise<RawItem[]> {
  if (specs.length === 0) return [];
  // Each day is fetched once and every gate runs over it, so the call count does not
  // grow with the number of specs.
  const entries: DailyPaper[] = [];
  for (const date of paperDates(now)) {
    try {
      entries.push(...(await getJson<DailyPaper[]>(`${HUB}/api/daily_papers?date=${date}&limit=${PAPERS_PER_DAY}`, ctx)));
    } catch (err) {
      console.warn(`[huggingface] daily papers ${date} failed: ${(err as Error).message}`);
    }
  }
  return specs.flatMap((spec) => mapPapers(entries, spec, now));
}

export const huggingface: Source = {
  name: 'huggingface',
  // Eight sequential calls (four model listings, four days of papers) took 2.4 s on
  // 2026-10-14. A slow Hub is several times that, so the shared 20 s is too tight.
  timeoutMs: 60_000,
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    const { models, papers } = ctx.config.huggingface;
    const now = new Date();

    const items = [
      ...(await fetchModels(inLanes(models, ctx.lanes), ctx, now)),
      ...(await fetchPapers(inLanes(papers, ctx.lanes), ctx, now)),
    ];

    // A model can match two specs (a tag and a name search); keep the first.
    const seen = new Set<string>();
    const out: RawItem[] = [];
    for (const item of items) {
      if (seen.has(item.externalId)) continue;
      seen.add(item.externalId);
      out.push(item);
    }
    return out;
  },
};

export default huggingface;

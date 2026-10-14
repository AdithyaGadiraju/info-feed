/**
 * Hugging Face source tests (ADR 0002). The window and threshold rules are pinned
 * against fixtures through the pure mappers, the fetch wiring against a mocked
 * `fetch`, and one live smoke test checks the real Hub still answers in the shape
 * the mappers expect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import huggingface, {
  mapModels,
  mapPapers,
  modelsUrl,
  paperDates,
  type DailyPaper,
  type HubModel,
} from '../../lib/sources/huggingface';
import type { HfModelSpec, HfPapersSpec, SourceCtx, SourcesConfig } from '../../lib/sources/types';
import { sourcesConfig } from '../../config/sources';

const NOW = new Date('2026-10-14T12:00:00Z');
const OLDEST = new Date('2026-09-14T12:00:00Z');

const imageTo3d: HfModelSpec = { lane: 'ai_dev', name: 'image-to-3d', pipelineTag: 'image-to-3d', minLikes: 25 };
const assetPapers: HfPapersSpec = {
  lane: 'ai_dev',
  name: 'Daily Papers (game assets)',
  include: /\b3d\b|audio/i,
  exclude: /robot/i,
  minUpvotes: 20,
};

function paper(id: string, title: string, upvotes: number, over: Partial<DailyPaper> = {}): DailyPaper {
  return {
    paper: {
      id,
      title,
      summary: `Abstract of ${title}.`,
      upvotes,
      submittedOnDailyAt: '2026-10-13T00:00:00.000Z',
      authors: [{ name: 'First Author' }],
    },
    numComments: 2,
    ...over,
  };
}

function ctxWith(huggingfaceConfig: SourcesConfig['huggingface'], lanes?: SourceCtx['lanes']): SourceCtx {
  return { since: new Date(Date.now() - 6 * 3600_000), config: { ...sourcesConfig, huggingface: huggingfaceConfig }, lanes };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('modelsUrl', () => {
  it('asks for the trending listing of one tag, trimmed to the fields the source reads', () => {
    const url = new URL(modelsUrl(imageTo3d));
    expect(url.pathname).toBe('/api/models');
    expect(url.searchParams.get('pipeline_tag')).toBe('image-to-3d');
    expect(url.searchParams.get('sort')).toBe('trendingScore');
    expect(url.searchParams.get('direction')).toBe('-1');
    expect(url.searchParams.getAll('expand[]')).toEqual(['createdAt', 'likes', 'pipeline_tag']);
    expect(url.searchParams.has('search')).toBe(false);
  });

  it('passes a name search through', () => {
    const url = new URL(modelsUrl({ lane: 'ai_dev', name: 'trellis', search: 'trellis', minLikes: 10 }));
    expect(url.searchParams.get('search')).toBe('trellis');
    expect(url.searchParams.has('pipeline_tag')).toBe(false);
  });
});

describe('paperDates', () => {
  it('lists the last four UTC days, newest first', () => {
    expect(paperDates(new Date('2026-10-14T01:00:00Z'))).toEqual(['2026-10-14', '2026-10-13', '2026-10-12', '2026-10-11']);
  });
});

describe('mapModels', () => {
  const models: HubModel[] = [
    { id: 'fishaudio/drama-3', likes: 272, createdAt: '2026-10-01T09:00:00.000Z', pipeline_tag: 'text-to-speech' },
    // Created ten days ago and only now popular: the model a since-filter would drop.
    { id: 'acme/late-bloomer', likes: 60, createdAt: '2026-10-04T00:00:00.000Z' },
    { id: 'acme/too-quiet', likes: 24, createdAt: '2026-10-10T00:00:00.000Z' },
    { id: 'microsoft/TRELLIS.2-4B', likes: 1337, createdAt: '2025-12-01T02:25:40.000Z' },
    { id: 'acme/no-date', likes: 500 },
  ];

  it('keeps models created inside the window that clear minLikes', () => {
    const items = mapModels(models, imageTo3d, OLDEST);
    expect(items.map((i) => i.externalId)).toEqual(['fishaudio/drama-3', 'acme/late-bloomer']);
  });

  it('fills every RawItem field from the model', () => {
    const [drama] = mapModels(models, imageTo3d, OLDEST);
    expect(drama).toEqual({
      source: 'huggingface',
      externalId: 'fishaudio/drama-3',
      laneHint: 'ai_dev',
      url: 'https://huggingface.co/fishaudio/drama-3',
      title: 'fishaudio/drama-3 (text-to-speech)',
      author: 'fishaudio',
      engagement: { likes: 272 },
      publishedAt: new Date('2026-10-01T09:00:00.000Z'),
    });
  });

  it("falls back to the spec's tag when the model carries none", () => {
    const late = mapModels(models, imageTo3d, OLDEST).find((i) => i.externalId === 'acme/late-bloomer');
    expect(late?.title).toBe('acme/late-bloomer (image-to-3d)');
  });
});

describe('mapPapers', () => {
  const entries: DailyPaper[] = [
    paper('2610.10539', 'Tetris3D: 3D Scene  Generation With Objects That Fit Together', 48, {
      organization: { fullname: 'Some Lab', name: 'somelab' },
    }),
    paper('2610.08760', 'WorldSonus: Bringing Sound to Worlds via Audio', 41),
    paper('2610.12468', 'DreamTrue: Action-Faithful Robot World Model in 3D', 46),
    paper('2610.15327', 'CIViC: Audio-Conditioned Visual Prediction', 6),
    paper('2610.16794', 'TPPO: Tracking-Value PPO For Language Model Reasoning', 70),
  ];

  it('keeps titles through the gate with enough upvotes, and nothing else', () => {
    expect(mapPapers(entries, assetPapers, NOW).map((i) => i.externalId)).toEqual([
      'papers/2610.10539',
      'papers/2610.08760',
    ]);
  });

  it('links the paper page, uses the abstract as body and prefers the organization as author', () => {
    const [tetris, sonus] = mapPapers(entries, assetPapers, NOW);
    expect(tetris).toEqual({
      source: 'huggingface',
      externalId: 'papers/2610.10539',
      laneHint: 'ai_dev',
      url: 'https://huggingface.co/papers/2610.10539',
      title: 'Tetris3D: 3D Scene Generation With Objects That Fit Together',
      body: 'Abstract of Tetris3D: 3D Scene Generation With Objects That Fit Together.',
      author: 'Some Lab',
      engagement: { upvotes: 48, comments: 2 },
      publishedAt: new Date('2026-10-13T00:00:00.000Z'),
    });
    expect(sonus.author).toBe('First Author');
  });
});

describe('huggingface source (mocked fetch)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches each model listing and each day of papers once, sequentially, and dedupes', async () => {
    const recent = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/models')) return json([{ id: 'acme/mesh-gen', likes: 80, createdAt: recent }]);
      return json([paper('2610.10539', 'Tetris3D: 3D Scene Generation', 48)]);
    });

    const items = await huggingface.fetch(
      ctxWith({
        models: [imageTo3d, { ...imageTo3d, name: 'mesh search', pipelineTag: undefined, search: 'mesh' }],
        papers: [assetPapers, { ...assetPapers, name: 'second gate' }],
      }),
    );

    // Two model listings plus four days of papers, however many paper gates.
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    expect(items.map((i) => i.externalId).sort()).toEqual(['acme/mesh-gen', 'papers/2610.10539']);
  });

  it('keeps the other listings when one fails', async () => {
    const recent = new Date(Date.now() - 24 * 3600_000).toISOString();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('pipeline_tag=text-to-3d')) return json({ error: 'boom' }, 500);
      return json([{ id: 'acme/ok', likes: 30, createdAt: recent }]);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const items = await huggingface.fetch(
      ctxWith({ models: [{ ...imageTo3d, pipelineTag: 'text-to-3d' }, imageTo3d], papers: [] }),
    );
    expect(items.map((i) => i.externalId)).toEqual(['acme/ok']);
  });

  it('makes no request for a lane that was not asked for', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const items = await huggingface.fetch(ctxWith({ models: [imageTo3d], papers: [assetPapers] }, ['markets']));
    expect(items).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Live, like the other source tests: the real Hub must still answer in the shape
// the mappers read. Thresholds at zero, so a quiet week cannot fail it.
describe('huggingface source (live)', () => {
  it('returns new image-to-3d models and papers with required fields', async () => {
    const items = await huggingface.fetch(
      ctxWith({
        models: [{ ...imageTo3d, minLikes: 0 }],
        papers: [{ ...assetPapers, include: /./, exclude: undefined, minUpvotes: 0 }],
      }),
    );

    const models = items.filter((i) => !i.externalId.startsWith('papers/'));
    const papers = items.filter((i) => i.externalId.startsWith('papers/'));
    expect(models.length).toBeGreaterThan(0);
    expect(papers.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.source).toBe('huggingface');
      expect(item.url.startsWith('https://huggingface.co/')).toBe(true);
      expect(item.title.length).toBeGreaterThan(0);
      expect(Number.isNaN(item.publishedAt.getTime())).toBe(false);
    }
    for (const m of models) expect(typeof m.engagement?.likes).toBe('number');
    for (const p of papers) expect(typeof p.engagement?.upvotes).toBe('number');
  }, 60_000);
});

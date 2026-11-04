import { describe, expect, it } from 'vitest';
import type { ProductEntry, Story, StorySource } from '../../lib/db/types';
import { buildExplainSystemPrompt, buildExplainUserPrompt } from '../../lib/explain/prompt';
import { BATCH_SIZE, explainStories } from '../../lib/explain/run';
import { MAX_PRODUCTS, parseExplainResult, sanitizeProducts } from '../../lib/explain/schema';
import { EMPTY_USAGE } from '../../lib/enrich/transport';

function story(over: Partial<Story> = {}): Story {
  return {
    id: 7,
    lane: 'ai_gamedev',
    title: 'ComfyUI node remeshes dense generated meshes',
    summaryShort: 'A developer released ComfyUI-LATO2, a ComfyUI node for TRELLIS.2 meshes.',
    summaryDetail: 'It turns dense meshes into low-poly ones.',
    score: 4,
    glossary: [{ term: 'Low-poly remeshing', definition: 'Simple.' }],
    products: [],
    firstSeenAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    digestedAt: null,
    verification: null,
    doneAt: null,
    ...over,
  };
}

const entry = {
  name: 'ComfyUI',
  kind: 'Open-source node-based app for AI workflows.',
  maker: 'Comfy Org',
  access: 'open-source',
  url: 'https://github.com/comfyanonymous/ComfyUI',
  definition: 'ComfyUI is a node-based app for building AI image pipelines.',
  full: 'What it does:   it runs graphs.\n\n\nThis differs from  A1111.',
};

describe('sanitizeProducts', () => {
  it('keeps a well-formed entry, trimming the kind period and collapsing whitespace', () => {
    const [p] = sanitizeProducts([entry]);
    expect(p).toEqual<ProductEntry>({
      name: 'ComfyUI',
      kind: 'Open-source node-based app for AI workflows',
      maker: 'Comfy Org',
      access: 'open-source',
      url: 'https://github.com/comfyanonymous/ComfyUI',
      definition: 'ComfyUI is a node-based app for building AI image pipelines.',
      full: 'What it does: it runs graphs.\n\nThis differs from A1111.',
    });
  });

  it('drops only the bad optional fields', () => {
    const [p] = sanitizeProducts([{ ...entry, maker: '', access: 'cheap', url: 'javascript:alert(1)', full: '' }]);
    expect(p.maker).toBeNull();
    expect(p.access).toBeNull();
    expect(p.url).toBeNull();
    expect(p).not.toHaveProperty('full');
  });

  it('skips entries missing a required field, duplicates and overflow', () => {
    const many = Array.from({ length: MAX_PRODUCTS + 3 }, (_, i) => ({ ...entry, name: `Tool ${i}` }));
    expect(sanitizeProducts([{ ...entry, kind: '' }, { ...entry, definition: null }])).toEqual([]);
    expect(sanitizeProducts([entry, { ...entry, name: 'comfyui' }])).toHaveLength(1);
    expect(sanitizeProducts(many)).toHaveLength(MAX_PRODUCTS);
    expect(sanitizeProducts('nope')).toEqual([]);
  });
});

describe('parseExplainResult', () => {
  it('takes only ids from the batch, once each', () => {
    const parsed = {
      stories: [
        { id: 1, products: [entry] },
        { id: 1, products: [] },
        { id: 2, products: [] },
        { id: 99, products: [entry] },
        { id: 3 },
      ],
    };
    const out = parseExplainResult(parsed, [1, 2, 3]);
    expect([...out.keys()]).toEqual([1, 2]);
    expect(out.get(1)).toHaveLength(1);
    expect(out.get(2)).toEqual([]);
  });

  it('drops names that are not in the story text, and makers that repeat the name', () => {
    const parsed = {
      stories: [
        {
          id: 1,
          products: [
            { ...entry, name: 'LTO Ultrium10' },
            { ...entry, name: 'ETHGas', maker: 'ethgas' },
          ],
        },
      ],
    };
    const out = parseExplainResult(parsed, [1], new Map([[1, 'Fujifilm LTO tape and   ETHGas news']]));
    expect(out.get(1)).toEqual([expect.objectContaining({ name: 'ETHGas', maker: null })]);
  });
});

describe('explain prompts', () => {
  it('asks for search and forbids made-up URLs', () => {
    const system = buildExplainSystemPrompt();
    expect(system).toContain('search the web');
    expect(system).toContain('Never write one from');
    expect(system).toContain('"open-weights"');
  });

  it('shows terms and source links for each story', () => {
    const sources = new Map<number, StorySource[]>([
      [7, [{ source: 'reddit', url: 'https://github.com/x/ComfyUI-LATO2', title: 'LATO2 released', publishedAt: new Date() }]],
    ]);
    const user = buildExplainUserPrompt([story(), story({ id: 8, glossary: [], summaryDetail: null })], sources);
    expect(user).toContain('STORIES (2)');
    expect(user).toContain('terms: Low-poly remeshing');
    expect(user).toContain('src: LATO2 released | https://github.com/x/ComfyUI-LATO2');
    expect(user).not.toMatch(/#8\n[^#]*(terms|src|d): /);
  });
});

describe('explainStories', () => {
  it('batches, searches the web, and writes what the model returned', async () => {
    const stories = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => story({ id: i + 1 }));
    const calls: Array<{ user: string; webSearch?: boolean }> = [];
    const written: Array<{ id: number; products: ProductEntry[] }> = [];

    const result = await explainStories(stories, {
      loadSources: async () => new Map(),
      log: () => {},
      completer: async (_system, user, opts) => {
        calls.push({ user, webSearch: opts.webSearch });
        const ids = [...user.matchAll(/^#(\d+)$/gm)].map((m) => Number(m[1]));
        // The model skips the last story of the first batch.
        const answered = ids.length === BATCH_SIZE ? ids.slice(0, -1) : ids;
        return {
          text: JSON.stringify({ stories: answered.map((id) => ({ id, products: id === 1 ? [entry] : [] })) }),
          usage: EMPTY_USAGE,
          costUsd: 0.05,
        };
      },
      write: async (rows) => {
        written.push(...rows);
        return rows.length;
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.webSearch)).toBe(true);
    expect(result.written).toBe(BATCH_SIZE);
    expect(result.skipped).toBe(1);
    expect(result.entries).toBe(1);
    expect(result.costUsd).toBeCloseTo(0.1);
    expect(written.find((w) => w.id === 1)?.products[0].name).toBe('ComfyUI');
  });

  it('leaves a failed batch unwritten instead of throwing', async () => {
    const result = await explainStories([story()], {
      loadSources: async () => {
        throw new Error('db down');
      },
      log: () => {},
      completer: async () => {
        throw new Error('timeout');
      },
      write: async () => {
        throw new Error('should not write');
      },
    });
    expect(result).toMatchObject({ written: 0, skipped: 1, calls: 0 });
  });
});

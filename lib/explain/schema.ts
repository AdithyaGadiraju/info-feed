/**
 * The contract between the explainer's answer and the database, in the same two
 * parts as lib/enrich/schema.ts: a JSON Schema handed to the transport, and a
 * hand-written validator that always runs.
 *
 * Like the glossary, the section is a reading aid, so a bad entry is dropped
 * rather than failing the batch.
 */
import { PRODUCT_ACCESS, type ProductAccess, type ProductEntry } from '../db/types';
import { cleanFull } from '../enrich/schema';

export const MAX_PRODUCTS = 5;
const MAX_NAME_CHARS = 80;
const MAX_KIND_CHARS = 90;
const MAX_MAKER_CHARS = 80;
const MAX_DEFINITION_CHARS = 280;
/** A longer URL is almost always a tracking redirect. */
const MAX_URL_CHARS = 400;

const PRODUCT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    kind: { type: 'string' },
    maker: { type: ['string', 'null'] },
    access: { type: ['string', 'null'], enum: [...PRODUCT_ACCESS, null] },
    url: { type: ['string', 'null'] },
    definition: { type: 'string' },
    full: { type: 'string' },
  },
  required: ['name', 'kind', 'maker', 'access', 'url', 'definition', 'full'],
  additionalProperties: false,
} as const;

export const EXPLAIN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          products: { type: 'array', items: PRODUCT_SCHEMA },
        },
        required: ['id', 'products'],
        additionalProperties: false,
      },
    },
  },
  required: ['stories'],
  additionalProperties: false,
} as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneLine(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > 0 && s.length <= max ? s : null;
}

function httpUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const url = v.trim();
  if (url.length > MAX_URL_CHARS) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function isAccess(v: unknown): v is ProductAccess {
  return typeof v === 'string' && (PRODUCT_ACCESS as readonly string[]).includes(v);
}

/**
 * An entry needs a name, a kind and a simple definition; without one of those it
 * is skipped. A bad maker, access or URL loses only that field, and a missing or
 * oversized full definition only that one. Duplicate names (ignoring case) keep
 * the first, and the list is trimmed to the cap.
 */
export function sanitizeProducts(raw: unknown): ProductEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductEntry[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_PRODUCTS) break;
    if (!isObject(entry)) continue;
    const name = oneLine(entry.name, MAX_NAME_CHARS);
    const kind = oneLine(entry.kind, MAX_KIND_CHARS)?.replace(/\.$/, '');
    const definition = oneLine(entry.definition, MAX_DEFINITION_CHARS);
    if (!name || !kind || !definition) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const maker = oneLine(entry.maker, MAX_MAKER_CHARS);
    const product: ProductEntry = {
      name,
      kind,
      // "ETHGas, by ETHGas" says nothing.
      maker: maker && maker.toLowerCase() !== key ? maker : null,
      access: isAccess(entry.access) ? entry.access : null,
      url: httpUrl(entry.url),
      definition,
    };
    const full = cleanFull(entry.full);
    if (full) product.full = full;
    out.push(product);
  }
  return out;
}

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Products sections by story id, for ids from this batch only. A story the model
 * skipped is simply absent, so its column stays NULL and the next run retries it.
 *
 * `storyText` maps each id to its title and summaries. An entry whose name does not
 * appear there is dropped: the section explains the names the reader sees, and a
 * name the model swapped in from a search is one they never saw.
 */
export function parseExplainResult(
  parsed: unknown,
  batchIds: number[],
  storyText?: Map<number, string>,
): Map<number, ProductEntry[]> {
  const out = new Map<number, ProductEntry[]>();
  if (!isObject(parsed) || !Array.isArray(parsed.stories)) return out;
  const wanted = new Set(batchIds);
  for (const entry of parsed.stories) {
    if (!isObject(entry)) continue;
    const { id, products } = entry;
    if (typeof id !== 'number' || !wanted.has(id) || out.has(id) || !Array.isArray(products)) continue;
    const text = storyText?.get(id);
    const haystack = text === undefined ? null : normalise(text);
    out.set(
      id,
      sanitizeProducts(products).filter((p) => haystack === null || haystack.includes(normalise(p.name))),
    );
  }
  return out;
}

/**
 * The contract between the fact-check answer and the database, in the same two
 * parts as lib/enrich/schema.ts: a JSON Schema handed to the transport, and a
 * hand-written validator that always runs and encodes what the schema cannot.
 */
import { VERDICTS, isVerdict, type Verification, type VerificationSource } from '../db/types';

/** The note is one or two sentences shown beside the summary; this keeps it that. */
export const MAX_NOTE_CHARS = 300;
export const MAX_SOURCES = 3;
const MAX_SOURCE_TITLE_CHARS = 150;
/** A longer URL is almost always a tracking redirect, and it would crowd a Discord line. */
const MAX_SOURCE_URL_CHARS = 400;

export const VERIFY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    note: { type: 'string' },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, url: { type: 'string' } },
        required: ['title', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'note', 'sources'],
  additionalProperties: false,
} as const;

export type VerdictResult =
  | { ok: true; value: Omit<Verification, 'checkedAt'> }
  | { ok: false; error: string };

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_SOURCE_URL_CHARS) return false;
  try {
    const { protocol } = new URL(v);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * A malformed source is dropped rather than failing the whole answer: the verdict
 * and note are the product, and a bad link is not worth losing them for. The one
 * exception is the rule below.
 *
 * `disputed` and `false` tell the reader a story is wrong. That claim has to come
 * with the page that says so, or the reader has no way to check the checker, so a
 * disputed or false verdict with no usable source is rejected outright.
 */
export function validateVerdict(parsed: unknown): VerdictResult {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'response is not a JSON object' };
  }
  const { verdict, note, sources } = parsed as Record<string, unknown>;

  if (!isVerdict(verdict)) return { ok: false, error: `verdict ${JSON.stringify(verdict)} is not one of ${VERDICTS.join(', ')}` };
  if (typeof note !== 'string' || note.trim().length === 0) return { ok: false, error: 'note is missing' };

  const kept: VerificationSource[] = [];
  for (const raw of Array.isArray(sources) ? sources : []) {
    if (kept.length >= MAX_SOURCES) break;
    if (typeof raw !== 'object' || raw === null) continue;
    const { title, url } = raw as Record<string, unknown>;
    if (!isHttpUrl(url) || kept.some((s) => s.url === url)) continue;
    const label = typeof title === 'string' && title.trim() ? title : new URL(url).hostname;
    kept.push({ title: clip(label, MAX_SOURCE_TITLE_CHARS), url });
  }

  if ((verdict === 'disputed' || verdict === 'false') && kept.length === 0) {
    return { ok: false, error: `verdict ${verdict} came with no usable source` };
  }

  return { ok: true, value: { verdict, note: clip(note, MAX_NOTE_CHARS), sources: kept } };
}

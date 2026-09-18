/**
 * The contract between the model's answer and the database write path (ADR 0003).
 *
 * Two things live here. `ENRICH_JSON_SCHEMA` is what the SDK transport hands to
 * `output_config.format` and what the CLI transport passes to `--json-schema`, so
 * both back ends are constrained by the same object. Treat the validator, not the
 * schema, as the safety net: it is the one that always runs, and it is the only
 * thing standing between a hallucinated id and `applyAssignments`.
 *
 * No schema library is installed on purpose — one object literal plus one hand-written
 * validator is less code than a dependency, and the validator has to encode rules a
 * JSON Schema cannot express anyway (ids must come from *this* batch, exactly once).
 */
import { LANES, type Assignment, type EnrichResult, type Lane, type NewStoryInput, type Score } from '../db/types';

/** Detail summaries exist only at or above this score (ADR 0003). */
export const DETAIL_MIN_SCORE = 3;

/** Postgres `stories.title` is unbounded text; this is a sanity bound, not a DB limit. */
const MAX_TITLE_CHARS = 300;

const NEW_STORY_SCHEMA = {
  type: 'object',
  properties: {
    lane: { type: 'string', enum: [...LANES] },
    title: { type: 'string' },
    summaryShort: { type: 'string' },
    summaryDetail: { type: ['string', 'null'] },
    score: { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['lane', 'title', 'summaryShort', 'summaryDetail', 'score'],
  additionalProperties: false,
} as const;

export const ENRICH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: {
              itemIds: { type: 'array', items: { type: 'integer' } },
              storyId: { type: 'integer' },
              updatedShort: { type: 'string' },
              updatedDetail: { type: ['string', 'null'] },
              updatedScore: { type: 'integer', minimum: 1, maximum: 5 },
            },
            required: ['itemIds', 'storyId'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              itemIds: { type: 'array', items: { type: 'integer' } },
              newStory: NEW_STORY_SCHEMA,
            },
            required: ['itemIds', 'newStory'],
            additionalProperties: false,
          },
        ],
      },
    },
    dropped: { type: 'array', items: { type: 'integer' } },
  },
  required: ['assignments', 'dropped'],
  additionalProperties: false,
} as const;

export interface ValidationOk {
  ok: true;
  value: EnrichResult;
  /**
   * Pending ids the model mentioned nowhere.
   *
   * Deliberately NOT a hard failure. A rejected response costs a retry — a whole
   * extra model call — and on the third attempt the entire batch stays pending,
   * including the items the model did handle correctly. An unmentioned id simply
   * keeps `story_id IS NULL`, so it is still in the queue and the next run sees it
   * again. The failure mode of being lenient is one item arriving an hour late;
   * the failure mode of being strict is spending three calls and landing nothing.
   * Callers log this list so a model that systematically drops the tail is visible.
   */
  leftover: number[];
}

export interface ValidationErr {
  ok: false;
  errors: string[];
}

/** The non-`newStory` half of `Assignment`, so the optional fields can be filled in place. */
type UpdateAssignment = Extract<Assignment, { storyId: number }>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isScore(v: unknown): v is Score {
  return isInt(v) && v >= 1 && v <= 5;
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * The gate every model response passes through before it can touch the database.
 *
 * `pendingIds` and `openStoryIds` are the only ids the model was shown, so anything
 * outside them is an invention and the whole response is rejected rather than
 * partially applied — a half-applied batch would leave items attached to stories
 * that the rest of the answer assumed were different.
 */
export function validateEnrichResult(
  parsed: unknown,
  pendingIds: number[],
  openStoryIds: number[],
): ValidationOk | ValidationErr {
  const errors: string[] = [];
  const fail = (): ValidationErr => ({ ok: false, errors });

  if (!isObject(parsed)) return { ok: false, errors: ['response is not a JSON object'] };
  if (!Array.isArray(parsed.assignments)) errors.push('assignments is not an array');
  if (!Array.isArray(parsed.dropped)) errors.push('dropped is not an array');
  if (errors.length > 0) return fail();

  const pending = new Set(pendingIds);
  const open = new Set(openStoryIds);
  /** id -> where it was first claimed, so the duplicate message can name both places. */
  const claimed = new Map<number, string>();

  const claim = (id: unknown, where: string): boolean => {
    if (!isInt(id)) {
      errors.push(`${where}: item id ${JSON.stringify(id)} is not an integer`);
      return false;
    }
    if (!pending.has(id)) {
      errors.push(`${where}: item id ${id} was not in this batch`);
      return false;
    }
    const first = claimed.get(id);
    if (first !== undefined) {
      errors.push(`${where}: item id ${id} already claimed by ${first}`);
      return false;
    }
    claimed.set(id, where);
    return true;
  };

  const rawAssignments = parsed.assignments as unknown[];
  const assignments: Assignment[] = [];

  rawAssignments.forEach((raw, i) => {
    const where = `assignments[${i}]`;
    if (!isObject(raw)) {
      errors.push(`${where} is not an object`);
      return;
    }
    if (!Array.isArray(raw.itemIds)) {
      errors.push(`${where}.itemIds is not an array`);
      return;
    }

    const itemIds: number[] = [];
    for (const id of raw.itemIds as unknown[]) {
      if (claim(id, where)) itemIds.push(id as number);
    }

    if ('newStory' in raw && raw.newStory !== undefined && raw.newStory !== null) {
      const before = errors.length;
      const s = raw.newStory;
      if (!isObject(s)) {
        errors.push(`${where}.newStory is not an object`);
        return;
      }
      if (itemIds.length === 0) errors.push(`${where}.newStory has no items behind it`);
      if (typeof s.lane !== 'string' || !(LANES as readonly string[]).includes(s.lane)) {
        errors.push(`${where}.newStory.lane ${JSON.stringify(s.lane)} is not a lane`);
      }
      if (!nonEmptyString(s.title)) errors.push(`${where}.newStory.title is missing`);
      else if (s.title.length > MAX_TITLE_CHARS) {
        errors.push(`${where}.newStory.title is longer than ${MAX_TITLE_CHARS} chars`);
      }
      if (!nonEmptyString(s.summaryShort)) errors.push(`${where}.newStory.summaryShort is missing`);
      if (!isScore(s.score)) {
        errors.push(`${where}.newStory.score ${JSON.stringify(s.score)} is not 1-5`);
      }
      checkDetail(errors, `${where}.newStory`, s.score, s.summaryDetail, true);

      if (errors.length === before) {
        const newStory: NewStoryInput = {
          lane: s.lane as Lane,
          title: (s.title as string).trim(),
          summaryShort: (s.summaryShort as string).trim(),
          summaryDetail: typeof s.summaryDetail === 'string' ? s.summaryDetail : null,
          score: s.score as Score,
        };
        assignments.push({ itemIds, newStory });
      }
      return;
    }

    if (!isInt(raw.storyId)) {
      errors.push(`${where}: neither a newStory nor an integer storyId`);
      return;
    }
    if (!open.has(raw.storyId)) {
      errors.push(`${where}.storyId ${raw.storyId} is not an open story in this lane`);
      return;
    }

    const update: UpdateAssignment = { itemIds, storyId: raw.storyId };
    if (raw.updatedShort !== undefined) {
      if (!nonEmptyString(raw.updatedShort)) errors.push(`${where}.updatedShort is empty`);
      else update.updatedShort = raw.updatedShort.trim();
    }
    if (raw.updatedScore !== undefined) {
      if (!isScore(raw.updatedScore)) {
        errors.push(`${where}.updatedScore ${JSON.stringify(raw.updatedScore)} is not 1-5`);
      }
      // A score change can cross the detail threshold in either direction, so the
      // model must restate the detail alongside it. Without this pair rule a story
      // demoted to 2 would keep a detail summary the feed promises never exists.
      if (raw.updatedDetail === undefined) {
        errors.push(`${where}.updatedScore was set without updatedDetail`);
      } else {
        checkDetail(errors, where, raw.updatedScore, raw.updatedDetail, false);
        update.updatedDetail = typeof raw.updatedDetail === 'string' ? raw.updatedDetail : null;
      }
      update.updatedScore = raw.updatedScore as Score;
    } else if (raw.updatedDetail !== undefined) {
      if (raw.updatedDetail !== null && typeof raw.updatedDetail !== 'string') {
        errors.push(`${where}.updatedDetail is neither a string nor null`);
      } else {
        update.updatedDetail = raw.updatedDetail;
      }
    }
    assignments.push(update);
  });

  const dropped: number[] = [];
  (parsed.dropped as unknown[]).forEach((id, i) => {
    if (claim(id, `dropped[${i}]`)) dropped.push(id as number);
  });

  if (errors.length > 0) return fail();

  const leftover = pendingIds.filter((id) => !claimed.has(id));
  return { ok: true, value: { assignments, dropped }, leftover };
}

function checkDetail(
  errors: string[],
  where: string,
  score: unknown,
  detail: unknown,
  required: boolean,
): void {
  if (detail !== null && typeof detail !== 'string') {
    if (required || detail !== undefined) {
      errors.push(`${where}: summaryDetail is neither a string nor null`);
    }
    return;
  }
  if (!isScore(score)) return; // the score error already fired; do not pile on
  const hasDetail = typeof detail === 'string' && detail.trim().length > 0;
  if (score >= DETAIL_MIN_SCORE && !hasDetail) {
    errors.push(`${where}: score ${score} requires a summaryDetail`);
  }
  if (score < DETAIL_MIN_SCORE && hasDetail) {
    errors.push(`${where}: score ${score} must have summaryDetail null`);
  }
}

/**
 * Pull the answer out of whatever the model wrapped it in.
 *
 * The CLI transport has no structured-output mode, so the JSON arrives inside a
 * free-text field and may be fenced, prefaced or followed by a sentence. Scanning
 * for the outermost balanced object is cheaper than a retry.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the fence and brace scans
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i += 1) {
      const c = trimmed[i];
      if (escaped) {
        escaped = false;
      } else if (c === '\\' && inString) {
        escaped = true;
      } else if (c === '"') {
        inString = !inString;
      } else if (!inString && c === '{') {
        depth += 1;
      } else if (!inString && c === '}') {
        depth -= 1;
        if (depth === 0) {
          return JSON.parse(trimmed.slice(start, i + 1));
        }
      }
    }
  }

  throw new Error(`no JSON object in model output: ${trimmed.slice(0, 200)}`);
}

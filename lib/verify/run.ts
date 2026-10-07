/**
 * The fact-check pass: one web-search model call per story, all of a lane's
 * stories at once.
 *
 * It runs on the stories a digest is about to post, never on the whole feed, so
 * the cost follows what is actually read. Nothing here can stop a digest: a check
 * that fails, times out or returns nonsense leaves its story unchecked, and the
 * story is posted marked as such.
 */
import { finishRun, getStorySources, setVerification, startRun } from '../db/queries';
import type { Lane, StorySource, StoryWithLink, Verdict, Verification } from '../db/types';
import { env } from '../env';
import { extractJsonObject } from '../enrich/schema';
import { complete, type CompletionOptions, type CompletionResult } from '../enrich/transport';
import { buildVerifySystemPrompt, buildVerifyUserPrompt, VERIFY_PROMPT_VERSION } from './prompt';
import { validateVerdict, VERIFY_JSON_SCHEMA } from './schema';

/**
 * Measured on the CLI transport on 2026-10-07: three checks run together took
 * 19s, 20s and 31s. The ceiling leaves room for a slow search, but stays under the
 * transport's five-minute default because a lane waits for its slowest check
 * before it posts.
 */
const VERIFY_TIMEOUT_MS = 180_000;

export interface VerifyResult {
  /** The input stories in the same order, each with its verdict filled in if it has one. */
  stories: StoryWithLink[];
  /** Stories that got a verdict in this call. */
  checked: number;
  /** Stories whose check failed. They stay unchecked. */
  failed: number;
  costUsd: number;
}

export interface VerifyDeps {
  /** Injectable so tests never spawn the CLI or touch the network. */
  completer?: (system: string, user: string, opts: CompletionOptions) => Promise<CompletionResult>;
  now?: Date;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A verdict stands until the story changes. `updated_at` moves only when
 * enrichment attaches a new item or rewrites the summary, which is exactly when
 * the claim may have moved too: a denial arriving as a new item re-opens the check.
 */
export function needsCheck(story: StoryWithLink): boolean {
  return story.verification === null || story.verification.checkedAt < story.updatedAt;
}

async function checkStory(
  story: StoryWithLink,
  sources: StorySource[],
  deps: VerifyDeps,
): Promise<{ verification: Verification | null; costUsd: number }> {
  const completer = deps.completer ?? complete;
  let costUsd = 0;
  try {
    const completion = await completer(
      buildVerifySystemPrompt(),
      buildVerifyUserPrompt(story, sources, deps.now ?? new Date()),
      { schema: VERIFY_JSON_SCHEMA, webSearch: true, effort: 'medium', timeoutMs: VERIFY_TIMEOUT_MS },
    );
    costUsd = completion.costUsd ?? 0;

    const validated = validateVerdict(extractJsonObject(completion.text));
    if (!validated.ok) {
      console.warn(`verify ${story.lane}: story ${story.id} rejected — ${validated.error}`);
      return { verification: null, costUsd };
    }
    return { verification: await setVerification(story.id, validated.value), costUsd };
  } catch (err) {
    console.warn(`verify ${story.lane}: story ${story.id} failed — ${errorText(err)}`);
    return { verification: null, costUsd };
  }
}

/**
 * Checks every story that has no current verdict and returns the list with the
 * verdicts filled in. The model calls start together; `LLM_CONCURRENCY` in the
 * transport is what bounds how many actually run at once.
 */
export async function verifyStories(
  lane: Lane,
  stories: StoryWithLink[],
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const unchanged: VerifyResult = { stories, checked: 0, failed: 0, costUsd: 0 };
  if (!env.verifyStories) return unchanged;

  const due = stories.filter(needsCheck);
  if (due.length === 0) return unchanged;

  // The run row records the work and must never be the reason it does not happen,
  // the same rule lib/digest/run.ts follows.
  let runId: number | null = null;
  try {
    runId = await startRun(`verify:${lane}`);
  } catch (err) {
    console.warn(`verify ${lane}: could not open a runs row: ${errorText(err)}`);
  }

  let sources = new Map<number, StorySource[]>();
  try {
    sources = await getStorySources(due.map((s) => s.id));
  } catch (err) {
    // The title and summary are enough to search on; the item list only helps.
    console.warn(`verify ${lane}: could not load source items: ${errorText(err)}`);
  }

  const results = await Promise.all(due.map((s) => checkStory(s, sources.get(s.id) ?? [], deps)));

  const verdictById = new Map<number, Verification>();
  const tally: Partial<Record<Verdict, number>> = {};
  let costUsd = 0;
  results.forEach((r, i) => {
    costUsd += r.costUsd;
    if (!r.verification) return;
    verdictById.set(due[i].id, r.verification);
    tally[r.verification.verdict] = (tally[r.verification.verdict] ?? 0) + 1;
  });

  const checked = verdictById.size;
  const failed = due.length - checked;

  if (runId !== null) {
    try {
      await finishRun(
        runId,
        failed === 0,
        { lane, due: due.length, checked, failed, ...tally, costUsd: Number(costUsd.toFixed(6)), promptVersion: VERIFY_PROMPT_VERSION },
        failed > 0 ? `${failed} of ${due.length} checks failed` : null,
      );
    } catch (err) {
      console.warn(`verify ${lane}: could not close runs row ${runId}: ${errorText(err)}`);
    }
  }

  const summary = Object.entries(tally)
    .map(([verdict, count]) => `${count} ${verdict}`)
    .join(', ');
  console.log(
    `verify ${lane}: ${checked} of ${due.length} checked${summary ? ` (${summary})` : ''}` +
      `${failed > 0 ? `, ${failed} failed` : ''} | $${costUsd.toFixed(4)}`,
  );

  // A story whose re-check failed loses its old verdict here rather than keeping
  // it: that verdict was about the story before it changed.
  const dueIds = new Set(due.map((s) => s.id));
  return {
    stories: stories.map((s) =>
      dueIds.has(s.id) ? { ...s, verification: verdictById.get(s.id) ?? null } : s,
    ),
    checked,
    failed,
    costUsd,
  };
}

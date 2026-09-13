# ADR 0003: One Sonnet 5 call per enrichment run clusters, summarises and scores; two summary tiers pre-generated

- Status: Accepted
- Date: 2026-09-12
- Deciders: Gadi + Claude

## Context
Gadi wants condensed one-liners first, with an expandable detailed AI summary. The same story arrives from several sources (a lab blog post, its HN thread, three tweets, a Reddit thread), so the real job is clustering and ranking, not per-item summarising. Clustering must persist across runs: an item arriving at 11:00 must join the story created at 09:00.

Cost forks the design. A live feed means many enrichment runs a day. Measured against the Anthropic price table (Sonnet 5 US$2/M input, US$10/M output; Haiku 4.5 US$1/M and US$5/M; Opus 5 US$5/M and US$25/M), the driver is output tokens for detail summaries and input tokens for article bodies.

## Decision
`lib/enrich/run.ts` executes one Claude Messages API call per run (chunked at 60 pending items) using the official `@anthropic-ai/sdk`:

- **Model:** `claude-sonnet-5` by default (`LLM_MODEL` env overrides; `claude-haiku-4-5` is the cheap setting, `claude-opus-5` the quality setting). Adaptive thinking on, `output_config.effort: "low"`.
- **Input:** system prompt (stable, `cache_control` breakpoint) + open stories from the last 48 h (`id`, `lane`, `title`, `summary_short`) + pending items (`id`, `source`, `laneHint`, `title`, `body` capped 2000 chars, `engagement`, `publishedAt`).
- **Output:** structured output via `output_config.format` with a JSON schema (`lib/enrich/schema.ts`):
  ```ts
  { assignments: Array<
      | { itemIds: number[]; storyId: number; updatedShort?: string; updatedDetail?: string; updatedScore?: 1|2|3|4|5 }
      | { itemIds: number[]; newStory: { lane: Lane; title: string; summaryShort: string; summaryDetail: string | null; score: 1|2|3|4|5 } }
    >;
    dropped: number[]   // item ids judged noise: ads, memes, duplicates of nothing worth a story
  }
  ```
- **Prompt rules:** every pending item is assigned or dropped exactly once. `summaryShort` ≤ 2 sentences, plain words, no hype. `summaryDetail` is markdown, 150–300 words, only for `score ≥ 3` (null otherwise); it must say what happened, why it matters for Gadi's lanes, and what to watch next, citing the source titles. Score rubric: 5 = major (frontier model release, engine major version, market-moving event, AAA launch, a new public betting-model method or dataset, a major MMA card or fight-market shift); 4 = notable; 3 = worth a line; 2–1 = noise. Existing stories are updated only when a new item materially changes them.
- **Write path:** one SQLite transaction per response: create stories, set `items.story_id`, mark dropped items with `story_id = -1`, bump `stories.updated_at` only on material updates (so the digest re-includes them).
- **Triggers:** every `ENRICH_INTERVAL_MIN` (default 60) or when pending count ≥ 15. Skip the call when nothing is pending.
- **Failure:** API error or schema mismatch leaves items pending for the next run; logged to `runs`. Max 2 SDK retries.

**Budget estimate** (after engagement pre-filter, ~100–150 items/day): about 24 runs/day at ~8k input / ~1.5k output → roughly US$0.03 per run, US$10–25 per month on Sonnet 5. Haiku halves it. Ingest interval and pre-filter thresholds are the other two dials.

## Rejected alternatives
- **Per-item summarisation then a separate clustering pass.** Two calls, and the per-item summaries are thrown away once clustered.
- **Haiku 4.5 by default.** Cheaper but weaker at the judgement that is the whole product: what is a duplicate and what is actually big. It stays as a config flip.
- **Opus 5 by default.** Fine quality, 2.5× the cost of Sonnet for a job Sonnet handles.
- **Lazy detail generation on click.** Needs a request path from the web app to the model and adds latency on tap. Pre-generating for `score ≥ 3` only keeps the cost bounded.
- **Message Batches API.** 50 % cheaper but up to 24 h latency; wrong for a live feed.
- **Embeddings-based clustering.** More code and another model call for a problem the LLM solves in-pass with the open-stories context.

## Consequences
- Prompt quality is the product. Expect to iterate the rubric and lane definitions for the first weeks; keep the system prompt in one file with a version comment.
- Open-stories context grows with volume; capped at 48 h and ~150 stories (highest score first) to bound input tokens.
- Detail summaries for score 1–2 stories never exist; the feed shows source links instead.
- Model strings are exact IDs from the Anthropic table; never append date suffixes.

## Implementation surface
- `lib/enrich/schema.ts` — JSON schema + TS types for the structured output. Contract between prompt and write path.
- `lib/enrich/prompt.ts` — system prompt builder and item/story serialisation. Pure functions, unit-testable.
- `lib/enrich/run.ts` — SDK call, chunking, transaction write via `lib/db/queries.ts`, `runs` logging.
- `tests/enrich/prompt.test.ts` — serialisation and schema validation with fixture items; one optional live test gated on `ANTHROPIC_API_KEY`.
- Depends on `lib/db/queries.ts` only. Disjoint from sources, digest and web files.

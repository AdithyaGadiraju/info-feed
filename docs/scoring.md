# Story score

Every story carries a score from 1 to 5. It is the single signal that decides what
you see, what gets posted to Discord, and what the model spends output tokens on.

## Where it comes from

The score is a judgement by the model, not a formula. In each enrichment run
(`lib/enrich/run.ts`) one Claude call per lane clusters the pending items into
stories and gives every new story a score. There is no arithmetic over upvotes or
source counts. Engagement numbers (`pts`, `ups`, `likes`, `cmts`) and the source
list are shown to the model as evidence, but the number it returns is its own read.

The rubric lives in the system prompt in `lib/enrich/prompt.ts`:

| Score | Meaning | Examples |
| --- | --- | --- |
| 5 | Major | Frontier model release, engine major version, market-moving event, AAA launch, new public betting-model method or dataset, major MMA card or fight-market shift |
| 4 | Notable | Something a reader in this lane would want to know today: a significant release, funding round, outage, rule change or result |
| 3 | Worth a line | Real but minor, or interesting without consequence |
| 2 | Noise | Routine, speculative or already well known |
| 1 | Noise | No information |

Lanes can add their own guidance. `gamedev` does: a major engine version, a new
rendering, physics, networking or platform capability, or a licensing change is 4
or 5, while patch builds, QOL editor tweaks and dev snapshots are 1 or 2. This is
why engine blogs in `config/sources.ts` can be ingested unfiltered. `ai` does the
same for benchmarks: a new #1 on a major leaderboard (Arena, SWE-bench, ARC-AGI),
first results for a new frontier model, or a new benchmark labs adopt is 4 or 5,
while small rank shuffles among older models are 2 or 3.

Items that are ads, memes, job posts or engagement bait are not scored at all. They
go in `dropped`.

## How it changes

A story's score is set when it is created. A later run can change it with
`updatedScore`, but only when a new item materially changes the story (a new fact,
a correction, a reversal, a much bigger reaction). More coverage of the same fact
attaches the item and leaves the score alone.

## What it controls

| Threshold | Effect | Where |
| --- | --- | --- |
| `score >= 3` | A 150-300 word `summaryDetail` is written. Below 3 it must be `null`. | `DETAIL_MIN_SCORE` in `lib/enrich/schema.ts` |
| `score >= 3` | Default filter for the web feed. The "min score" buttons change it. | `DEFAULT_MIN_SCORE` in `app/api/feed/route.ts`, `app/page.tsx` |
| `score >= 4` | Story is eligible for the Discord digest, best first, 8 per lane. | `getDigestStories` in `lib/db/queries.ts` |
| Ordering | Open stories sent back to the model are sorted by score and capped at 150, so low scorers drop out of clustering context first. | `getOpenStories` in `lib/db/queries.ts` |

The score is shown as dots in the feed (`ScoreDots` in `components/StoryCard.tsx`)
and as `●●●○○` in Discord (`scoreMarker` in `lib/digest/discord.ts`).

## Why it matters

1. It filters. The sources return far more than is worth reading. The score is
   what separates the 3+ feed and the 4+ digest from the rest.
2. It controls cost. Detail summaries are most of the output tokens, and output
   tokens are about 70% of the bill. Tying the detail to `score >= 3` means noise
   never costs a detail summary.
3. It bounds input. Clustering context is capped by score, so the prompt stays
   small as volume grows.

## Validation

`validateEnrichResult` in `lib/enrich/schema.ts` rejects a response where:

- a score is missing or outside 1-5
- a story scored 3+ has no detail, or a story scored 1-2 has one
- `updatedScore` is set without `updatedDetail`, since a score change can cross
  the detail threshold

A rejected response is retried. After the retries run out, the items stay pending
for the next run. The database also enforces `CHECK (score BETWEEN 1 AND 5)`.

## Tuning

If the feed is noisy, tighten the rubric or lane notes in `lib/enrich/prompt.ts`
and bump `PROMPT_VERSION`, or raise the feed and digest thresholds. Changing the UI
does not fix bad scores.

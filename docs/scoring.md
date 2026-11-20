# Story score

Every story carries a score from 1 to 5. It is the single signal that decides what
you see, what gets fact-checked, and what the model spends output tokens on.

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
while small rank shuffles among older models are 2 or 3. `ai_dev` scores by how much
a story would change how you work this week: an official prompting or best-practices
guide, a coding-capable frontier model, or a tool or technique with evidence that it
cuts tokens or raises quality is 4 or 5, and routine changelogs, launches with no
evidence, anecdotes and opinion are 1 or 2. Every `ai_dev` detail ends with a
**Try this:** line.

`ai_gamedev` is the one lane that scores obscurity up rather than down: any new
tool, model, Blender add-on or MCP server whose output could go in a game is a 4,
even from a solo developer, and a new model or integration that beats the previous
best for an asset type is a 5. Papers with code, notable updates and hands-on
comparisons are 3; showcases with no tool behind them, unusable demos and opinion
are 1 or 2. Its detail says how to get the tool, what it costs and what it
exports, then ends with a **Try this:** line. A developer posting a tool they built
is a release here, not self-promotion, so it is not dropped. It also posts up to 12
stories per digest instead of 8 (`DIGEST_LIMIT_BY_LANE` in `lib/digest/run.ts`).

`ai`, `ai_dev` and `ai_gamedev` are enriched as one pool (`laneGroup` in
`lib/db/types.ts`). The model files each new story under one of the three by
content, not by source: AI tools for making games and game assets are
`ai_gamedev`, anything that helps you get better results from AI coding tools is
`ai_dev`, and the rest (security incidents, acquisitions, policy, hardware,
research news) is `ai`.

Items that are ads, memes, job posts or engagement bait are not scored at all. They
go in `dropped`.

## Events

`events` holds things to take part in, not news: game jams, hackathons and contests;
talks, seminars, conferences and expos; grants, calls for speakers and early-access
programmes. The subject is game development, or AI for games, 3D, graphics and
creative tools. It exists because the other lanes rank tools and news: the Epic AI
MegaJam reached the feed in October 2026 and scored 2-3 in `ai_gamedev`.

**How an event gets there.** An event is announced on the same feeds as tools and
engine news. So a batch from `ai`, `ai_dev`, `ai_gamedev` or `gamedev` also sees
the open events stories and may file a new story under `events` (`SHARED_LANES` in
`lib/db/types.ts`). The lane also has sources of its own in `config/sources.ts`:
vendor feeds read again through an event title gate, and Devpost hackathons with a
prize (`lib/sources/devpost.ts`).

```
 Unreal forum, Unity blog, 80.lv, HN, Reddit ...        Devpost, GCAP, SIGGRAPH ...
        |  (lane hint: ai_gamedev, gamedev, ...)                |  (lane hint: events)
        v                                                       v
  enrich batch for that lane  ------ "is this an event ------  enrich batch for events
        |                            the reader can enter?"         |
        |  no                              | yes                    |  not an open event
        v                                  v                        v
  story in the source lane         story in events             dropped
  (tool rubric)                    (three tests below)
```

**Only while it is open.** A story belongs in `events` while the reader can still
sign up, submit, apply, attend or watch live. Winners lists, recaps and one person's
jam entry stay in the lane they came from. Batches that can file into `events` are
told today's date for this.

**Score: three tests.** The reader wants top picks only.

| Test | Passes when |
|---|---|
| Theme | AI for game development, 3D or creative tools is the theme, or AI tools are allowed and central |
| Access | The reader can take part online, or in person in Australia. A hybrid event is judged by its online part |
| Weight | Real prizes, or a major organiser (engine vendor, AI lab, known tool vendor, major conference) |

| Result | Score |
|---|---|
| All three | 5 |
| Access plus one other (a major jam with prizes and no AI angle; an AI-for-games conference that streams) | 4 |
| One test only, or reachable only by travel overseas | 2, or 3 when the theme is AI for games |
| Small hobby jam, generic enterprise AI hackathon, paid course, sales webinar | dropped |

**Facts.** Each events story stores `event`: kind, starts, ends, deadline,
deadlineLabel, where, cost and prize. Dates are `YYYY-MM-DD` and are never guessed;
a fact the sources do not state is null. The web card shows them as a list and the
digest as one line. The detail ends with a **Do this:** line.

**One event, one story.** An events story stays in the open-stories list until its
last date has passed, not for 48 hours. A later post about the same event (partners,
sign-ups, the theme) joins that story, and may update the facts.

**Reminder.** Three days before the deadline (or the start, when there is no
deadline) the story gets a new `updated_at` once: it goes back to the top of the
feed, loses its Done mark, and the digest posts it again if it scores 4 or more. A
moved deadline is due a new reminder. `remindUpcomingEvents` in
`lib/db/queries.ts` does this, at the start of the events lane's digest.

## How it changes

A story's score is set when it is created. A later run can change it with
`updatedScore`, but only when a new item materially changes the story (a new fact,
a correction, a reversal, a much bigger reaction). More coverage of the same fact
attaches the item and leaves the score alone.

## What it controls

| Threshold | Effect | Where |
| --- | --- | --- |
| `score >= 3` | A 150-300 word `summaryDetail` is written. Below 3 it must be `null`. | `DETAIL_MIN_SCORE` in `lib/enrich/schema.ts` |
| `score >= 4` + picks | Default filter for the web feed: every 4+ story plus the day's picks (below). The "min score" buttons and "+ picks" change it. | `DEFAULT_MIN_SCORE` in `lib/feed/params.ts`, `getFeedPage` in `lib/db/queries.ts` |
| `score >= 4` | Story is eligible for the digest's fact-check, best first, 8 per lane (12 for `ai_gamedev`). | `getDigestStories` in `lib/db/queries.ts`, `digestLimit` in `lib/digest/run.ts` |
| Feed order | Newest day first; inside a day 5, 4, picks, other 3s, then newest change. So a lane is not on top only because its enrichment ran last. | `getFeedPage` in `lib/db/queries.ts` |
| Ordering | Open stories sent back to the model are sorted by score and capped at 150, so low scorers drop out of clustering context first. | `getOpenStories` in `lib/db/queries.ts` |

The score is shown as dots in the feed (`ScoreDots` in `components/StoryCard.tsx`).

## Picks

The reader reads almost every 4+ story but has no time for every 3: in November
2026 there were about 37 new 3s a day, and about 2 were read. So each new story
scored 3 also gets `nearFour` from the model, 1-10, "how close is this to a 4".
It is stored in `stories.near_four`. The feed shows the `PICKS_PER_DAY` (6) score-3
stories with the highest `near_four` for each day (by `first_seen_at` in `TZ`)
next to the 4+ stories, with a **Pick** tag. The rank uses only `near_four`: not
the lane and not what the reader marked done, because Done marks follow where a
story sat in the feed more than what the reader likes.

`nearFour` is optional in the schema. When it is missing or out of range, the
story is not a pick; the batch is not retried. 3s from before prompt version 14
have no `near_four` and are never picks. Picks are not fact-checked; the digest
does not use them.

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

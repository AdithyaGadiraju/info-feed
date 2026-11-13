# TODO: decisions to review

T1. **LLM transport: headless `claude` CLI on the subscription.** Chosen 2026-09-13 as a workaround to avoid API billing. Ties the worker to this Mac, shares the subscription rate-limit window, and is outside Anthropic's stated scope for subscription auth. Review: switch to `LLM_TRANSPORT=api` with an `ANTHROPIC_API_KEY` (est. US$10–25/month, ADR 0003) before any VPS deployment.

T2. **Store: Supabase Postgres (Free plan).** Decided 2026-09-13, replacing SQLite, because the digest runs from whichever machine is at hand. Review: (a) if a `npm run digest` fails with a paused project more than once, add a weekly keep-alive; (b) if DB size approaches 400 MB, shorten the 30-day body prune; (c) Free plan has no user-restorable backups, so set up a monthly `pg_dump` if the story history starts to matter.

T3. **Twitter source: live since 2026-11-12** with one followed account (@karpathy, `twitterUsers` in `config/sources.ts`); `twitterLists`/`twitterQueries` are still empty. Calls are paced (one shared session per digest, 3-9 s between calls, 10 calls max, worker waits 3 h+ between sessions). To set up a key again: create a throwaway X account, log into it in a private Firefox window and get the key from the [Rettiwt Auth Helper](https://addons.mozilla.org/en-US/firefox/addon/rettiwt-auth-helper) extension (rettiwt-api 7 dropped `auth login`; manual fallback: in DevTools copy the `auth_token`, `ct0` and `twid` cookies and run `btoa("auth_token=<v>;ct0=<v>;twid=<v>;")` in the console), put it in `.env` as `RETTIWT_API_KEY`, create one Twitter List per lane on the throwaway and add the List ids to `config/sources.ts`.

T4. **Reddit needs OAuth.** Found while building v1 on 2026-09-13. The public JSON API
returns 403 to unauthenticated clients from a normal home connection, not just from a
datacenter IP (re-checked 2026-11-13: still 403), and the `.rss` fallback the source
now uses allows one request per rate-limit window per address (`remaining 0` after a
single request, reset 13-44 s), with retries making the throttle worse rather than
better. On 2026-11-13 every lane of a digest got a 429 because pacing and the
"stop after a 429" flag lived inside one `fetch()` call while the digest calls it once
per lane; both are now process-wide (one request per ~30-60 s across all lanes, and a
429 benches Reddit for 15 min or the Retry-After). Consequences today: Reddit
contributes nothing on an already-throttled address, ~11 requests stretch Reddit
over several minutes of a run, and even when it works it carries no vote counts, so `thresholds.redditTopN` stands in for the
upvote threshold. To fix: register a free Reddit script app, put the client id and
secret in `.env`, and switch `lib/sources/reddit.ts` to OAuth (100 req/min). The module
shape does not change. This is the single highest-value follow-up for feed quality,
because r/gamedev, r/godot, r/MMA and r/algobetting are the main source for three lanes.

T5. **Nothing stops two digests running at once.** Found by the v1 code review on
2026-09-14. The worker's overlap guard is a `Set` inside one process, and
`scripts/digest.ts` has none, so `npm run digest` on the Mac while the worker's 08:00
cron fires means both select the same stories before either marks them, and the same
stories get posted to Discord twice. Two concurrent enrichments of one lane are worse:
both read the same pending rows, both call the model, and the losing transaction leaves
stories with no items attached that still score >= 4, so they reach Discord empty.
Not fixed in v1 because the obvious fix does not work here: `pg_try_advisory_lock` is
session-scoped, and `DATABASE_URL` is a Supavisor pooler string in transaction mode
where consecutive statements can land on different backends. The fix needs either a
claim row written in the same transaction as the read (`UPDATE ... RETURNING` or
`SELECT ... FOR UPDATE SKIP LOCKED`), or a direct non-pooled connection used solely for
the lock. Decide which before running the worker and on-command digests side by side.

T6. **A digest split across several Discord messages is not atomic.** If a lane needs
two messages and the second fails, `digestLane` records nothing, so the next run reposts
the first message's stories. Rare (a lane must exceed Discord's limits across 8 stories)
and the failure mode is a duplicate rather than a loss, so it was left alone. The fix is
to record per-message rather than per-lane.

# TODO: decisions to review

T1. **LLM transport: headless `claude` CLI on the subscription.** Chosen 2026-09-13 as a workaround to avoid API billing. Ties the worker to this Mac, shares the subscription rate-limit window, and is outside Anthropic's stated scope for subscription auth. Review: switch to `LLM_TRANSPORT=api` with an `ANTHROPIC_API_KEY` (est. US$10–25/month, ADR 0003) before any VPS deployment.

T2. **Store: Supabase Postgres (Free plan).** Decided 2026-09-13, replacing SQLite, because the digest runs from whichever machine is at hand. Review: (a) if a `npm run digest` fails with a paused project more than once, add a weekly keep-alive; (b) if DB size approaches 400 MB, shorten the 30-day body prune; (c) Free plan has no user-restorable backups, so set up a monthly `pg_dump` if the story history starts to matter.

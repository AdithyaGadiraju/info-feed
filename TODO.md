# TODO: decisions to review

T1. **LLM transport: headless `claude` CLI on the subscription.** Chosen 2026-09-13 as a workaround to avoid API billing. Ties the worker to this Mac, shares the subscription rate-limit window, and is outside Anthropic's stated scope for subscription auth. Review: switch to `LLM_TRANSPORT=api` with an `ANTHROPIC_API_KEY` (est. US$10–25/month, ADR 0003) before any VPS deployment.

T2. **Store: SQLite file, not Supabase.** Kept 2026-09-13 for v1. Now that `npm run digest` runs from whichever machine is at hand (Mac or Windows), each machine has its own SQLite file, so seen-item dedup and story history do not carry across machines: the same story can be posted twice if the Mac and the Windows box each run a digest. Supabase (or any shared Postgres) fixes this. Decide before running from a second machine. All DB access is in `lib/db/*`, so the switch is that folder plus a `DATABASE_URL`.

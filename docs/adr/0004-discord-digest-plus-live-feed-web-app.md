# ADR 0004: Twice-daily Discord digest plus a basic-auth Next.js live feed, both reading the stories table

- Status: Accepted
- Date: 2026-09-12
- Deciders: Gadi + Claude

## Context
Gadi wants both a pushed summary and a place to scroll and expand. Delivery channel chosen: Discord webhook (one URL, no bot registration, rich embeds). The web view must be a live scrolling feed, not static pages. The app lives on a shared VPS and must not be open to the internet without a lock.

## Decision
**Digest** (`lib/digest/run.ts`, `lib/digest/discord.ts`):
- Runs on command (`npm run digest`, ADR 0001) or from the worker at 08:00 and 18:00 `TZ`. Selects stories with `score ≥ 4` where `digested_at IS NULL OR updated_at > digested_at`, grouped by lane, ordered by score then `updated_at`, capped at 8 per lane.
- **Streams per lane.** `npm run digest` posts a lane's message as soon as that lane is ingested and enriched, then moves to the next lane, so reading can start while the rest is still running. Lane order: ai, markets, betting, gamedev, games (configurable). The first message of a run is a one-line header (`Digest · 13 Sep 14:05 · 5 lanes`) so the start of a run is visible; a final line reports lanes with nothing new and any lane that failed.
- One webhook message per lane with content (skip empty lanes). Embed per lane: title `AI · 12 Sep AM`, one line per story: score marker, bold title, `summary_short`, link to `${FEED_BASE_URL}/story/{id}`. Webhook URL: `DISCORD_WEBHOOK_URL` (main channel, always receives every lane). If `DISCORD_WEBHOOK_URL_<LANE>` is set, the same lane message is additionally posted to that channel (mirror, not override). One Discord server, one webhook per channel.
- Marks `digested_at` only after a 2xx; writes a `digests` row and a `runs` row. Respects Discord's 2000 char / 10 embed limits by splitting.

**Feed** (Next.js App Router at repo root):
- `middleware.ts` — HTTP basic auth against `FEED_USER`/`FEED_PASS`; applies to every route. No sessions, no user table.
- `app/page.tsx` — feed: lane filter chips (all + 5 lanes), min-score toggle (default ≥ 3), infinite scroll via `app/api/feed/route.ts` (cursor on `updated_at,id`, page 30). Card: lane badge, score, title, `summary_short`, source count, relative time. Tap expands in place: `summary_detail` (rendered markdown) or, if null, the source list. Source list shows title, source name, engagement, outbound link.
- `app/story/[id]/page.tsx` — the same card pre-expanded; digest links land here.
- Server components read Supabase Postgres via `lib/db/queries.ts` (`postgres` client, `DATABASE_URL`). No client-side data library; plain `fetch` for the scroll route.
- Styling: Tailwind, dark by default, mobile-first. It is a reading surface, not a dashboard.
- Runs as `next start` on `PORT`; reverse-proxied by whatever the box already uses (discovered at deploy time).

## Rejected alternatives
- **Telegram bot.** Better mobile notifications but needs a bot token and chat-id dance; Discord webhook is one URL.
- **Email.** Poor glanceability, needs a mail provider.
- **Static HTML pages.** Rejected by Gadi; he wants a live feed.
- **Websockets / live push.** Refresh and scroll are enough for a personal feed; push adds a long-lived connection to a shared box for nothing.
- **Real auth (OAuth, sessions).** Single user; basic auth over HTTPS is the whole threat model.
- **A separate API server.** Next.js route handlers reading Postgres directly remove a layer.

## Consequences
- Basic auth is only safe behind HTTPS; the reverse proxy must terminate TLS or the app must bind to localhost with a tunnel.
- The digest depends on `FEED_BASE_URL` being reachable from Gadi's phone; until the box is set up, links can point at a local tunnel or be omitted.
- `digested_at` semantics mean a story updated after a digest can appear twice, by design.
- If the feed gets noisy, the fix is the score threshold and the prompt rubric (ADR 0003), not the UI.

## Implementation surface
- `lib/digest/discord.ts` — webhook client, embed formatting, splitting. Pure formatting is unit-tested with fixtures.
- `lib/digest/run.ts` — selection query, send, mark. Depends on `lib/db/queries.ts`.
- `middleware.ts`, `app/layout.tsx`, `app/page.tsx`, `app/story/[id]/page.tsx`, `app/api/feed/route.ts`, `app/globals.css`, `components/StoryCard.tsx`, `components/Feed.tsx` — web only. Depends on `lib/db/queries.ts` and `lib/db/types.ts`.
- Digest and web files are disjoint from each other and from sources/enrich; they share only the db query layer.

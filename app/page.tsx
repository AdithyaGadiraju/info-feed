import Feed, { type FeedFilters } from '@/components/Feed';
import Icon from '@/components/Icon';
import { getFeedPage } from '@/lib/db/queries';
import { dayRange, isDay, parseDone, parseLanes, parseMinScore, parseSearch, today } from '@/lib/feed/params';

// Stories change every enrichment tick; a build-time snapshot would always be stale.
export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

/**
 * The page reads the same params as /api/feed but forgives them: an unknown lane
 * or a malformed day in an old link is dropped rather than turned into an error
 * page, because the link still names a view worth showing.
 */
function parseFilters(sp: Search): FeedFilters {
  const day = (v: string | null) => (v !== null && isDay(v.trim()) ? v.trim() : '');
  let from = day(one(sp.from));
  let to = day(one(sp.to));
  if (from && to && from > to) [from, to] = ['', ''];
  return {
    lanes: parseLanes(one(sp.lanes)).lanes,
    minScore: parseMinScore(one(sp.minScore)),
    done: parseDone(one(sp.done)),
    from,
    to,
    q: parseSearch(one(sp.q)),
  };
}

export default async function HomePage({ searchParams }: { searchParams: Promise<Search> }) {
  const filters = parseFilters(await searchParams);
  const { since, until } = dayRange(filters.from, filters.to);

  // Rendered on the server so the first paint needs no client fetch (ADR 0004).
  try {
    const page = await getFeedPage({
      lanes: filters.lanes,
      minScore: filters.minScore,
      done: filters.done,
      since,
      until,
      q: filters.q,
      limit: 30,
    });
    // `today` is named here, in the process timezone that dayRange() uses, so the
    // date chips mean the same day on the server, in the browser and in the query.
    return (
      <Feed initialStories={page.stories} initialCursor={page.nextCursor} initialFilters={filters} today={today()} />
    );
  } catch (err) {
    // The message stays generic and the real error goes to the server log. A
    // database error's text can carry connection details, and this page is the
    // only place an internal exception could reach an HTTP response.
    console.error('[feed] could not load the first page:', err);
    return (
      <>
        <div className="page-head">
          <p className="eyebrow">Live feed</p>
          <h1>Stories</h1>
        </div>
        <div className="callout callout-error" role="alert">
          <Icon name="alert" size={18} />
          <div>
            <p className="callout-title">Could not reach the database</p>
            <p>
              If the Supabase project has been idle for a week it is paused and needs resuming. The
              server log has the details.
            </p>
          </div>
        </div>
      </>
    );
  }
}

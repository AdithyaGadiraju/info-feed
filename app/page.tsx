import Feed from '@/components/Feed';
import { getFeedPage } from '@/lib/db/queries';
import { isLane, type Lane } from '@/lib/db/types';

// Stories change every enrichment tick; a build-time snapshot would always be stale.
export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parseLanes(raw: string | undefined): Lane[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(isLane);
}

function parseMinScore(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 5) : 3;
}

export default async function HomePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const lanes = parseLanes(one(sp.lanes));
  const minScore = parseMinScore(one(sp.minScore));

  // Rendered on the server so the first paint needs no client fetch (ADR 0004).
  try {
    const page = await getFeedPage({ lanes, minScore, limit: 30 });
    return (
      <Feed
        initialStories={page.stories}
        initialCursor={page.nextCursor}
        initialLanes={lanes}
        initialMinScore={minScore}
      />
    );
  } catch (err) {
    // The message stays generic and the real error goes to the server log. A
    // database error's text can carry connection details, and this page is the
    // only place an internal exception could reach an HTTP response.
    console.error('[feed] could not load the first page:', err);
    return (
      <main>
        <h1 className="text-lg font-semibold tracking-tight text-body">info-feed</h1>
        <p className="mt-6 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
          Could not reach the database. If the Supabase project has been idle for a week it is
          paused and needs resuming; the server log has the details.
        </p>
      </main>
    );
  }
}

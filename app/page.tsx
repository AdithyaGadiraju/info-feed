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
    // A paused Supabase project is the common case here; a stack trace on a
    // reading surface helps nobody.
    return (
      <main>
        <h1 className="text-lg font-semibold tracking-tight text-body">info-feed</h1>
        <p className="mt-6 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
          Could not reach the database: {err instanceof Error ? err.message : 'unknown error'}
        </p>
      </main>
    );
  }
}

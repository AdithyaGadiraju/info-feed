'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import StoryCard, { reviveStory, type WireStoryWithCount } from '@/components/StoryCard';
import { LANES, type FeedCursor, type Lane, type StoryWithCount } from '@/lib/db/types';

const PAGE_SIZE = 30;
const SCORES = [1, 2, 3, 4, 5] as const;

interface FeedResponse {
  stories: WireStoryWithCount[];
  nextCursor: FeedCursor | null;
}

/** The cursor travels as one opaque base64 param; its JSON is pure ASCII. */
function encodeCursor(c: FeedCursor): string {
  return btoa(JSON.stringify(c));
}

function buildUrl(lanes: Lane[], minScore: number, cursor: FeedCursor | null): string {
  const p = new URLSearchParams();
  if (lanes.length > 0) p.set('lanes', lanes.join(','));
  p.set('minScore', String(minScore));
  p.set('limit', String(PAGE_SIZE));
  if (cursor) p.set('cursor', encodeCursor(cursor));
  return `/api/feed?${p.toString()}`;
}

export interface FeedProps {
  initialStories: StoryWithCount[];
  initialCursor: FeedCursor | null;
  initialLanes: Lane[];
  initialMinScore: number;
}

export default function Feed({
  initialStories,
  initialCursor,
  initialLanes,
  initialMinScore,
}: FeedProps) {
  const [lanes, setLanes] = useState<Lane[]>(initialLanes);
  const [minScore, setMinScore] = useState(initialMinScore);

  const [stories, setStories] = useState<StoryWithCount[]>(initialStories);
  const [cursor, setCursor] = useState<FeedCursor | null>(initialCursor);
  const [done, setDone] = useState(initialCursor === null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Every filter change bumps the generation. A response carrying a stale
   * generation is dropped instead of appended, so a slow "ai" page landing after
   * the user switched to "markets" can never contaminate the list. `inFlight`
   * separately stops the sentinel from firing the same page twice while the
   * first request is still open.
   */
  const generation = useRef(0);
  const inFlight = useRef(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // Latest filter+cursor state for the observer callback, which is registered once.
  const query = useRef({ lanes, minScore, cursor, done, generation: 0 });
  query.current = { lanes, minScore, cursor, done, generation: generation.current };

  const load = useCallback(async (opts: { reset: boolean }) => {
    if (inFlight.current) return;
    const { lanes: l, minScore: m, cursor: c, done: d } = query.current;
    if (!opts.reset && (d || c === null)) return;

    const gen = generation.current;
    inFlight.current = true;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(buildUrl(l, m, opts.reset ? null : c), {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`feed request failed (${res.status})`);
      const body = (await res.json()) as FeedResponse;
      if (gen !== generation.current) return;

      const page = body.stories.map(reviveStory);
      setStories((prev) => (opts.reset ? page : [...prev, ...page]));
      setCursor(body.nextCursor);
      setDone(body.nextCursor === null);
    } catch (e: unknown) {
      if (gen === generation.current) {
        setError(e instanceof Error ? e.message : 'could not load the feed');
      }
    } finally {
      // Only the current generation may clear the guards: a stale request
      // finishing late must not unlock the sentinel for a live one.
      if (gen === generation.current) {
        setLoading(false);
        inFlight.current = false;
      }
    }
  }, []);

  const applyFilters = useCallback(
    (nextLanes: Lane[], nextMinScore: number) => {
      generation.current += 1;
      // In-flight work belongs to the old generation; unblock the reset immediately.
      inFlight.current = false;

      setLanes(nextLanes);
      setMinScore(nextMinScore);
      setStories([]);
      setCursor(null);
      setDone(false);
      query.current = {
        lanes: nextLanes,
        minScore: nextMinScore,
        cursor: null,
        done: false,
        generation: generation.current,
      };

      // Keep the filtered view linkable without a server round trip.
      const p = new URLSearchParams();
      if (nextLanes.length > 0) p.set('lanes', nextLanes.join(','));
      if (nextMinScore !== 3) p.set('minScore', String(nextMinScore));
      const qs = p.toString();
      window.history.replaceState(null, '', qs ? `/?${qs}` : '/');

      void load({ reset: true });
    },
    [load],
  );

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void load({ reset: false });
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [load]);

  const toggleLane = (lane: Lane) => {
    // Chips are a single-select "All | lane" switch: on a phone, a multi-select
    // of five lanes is fiddly and nothing in the ADR asks for combinations.
    applyFilters(lanes.length === 1 && lanes[0] === lane ? [] : [lane], minScore);
  };

  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
      active
        ? 'border-accent bg-accent/15 text-accent'
        : 'border-line bg-surface text-muted hover:text-body'
    }`;

  return (
    <main>
      <header className="mb-4">
        <h1 className="text-lg font-semibold tracking-tight text-body">info-feed</h1>
      </header>

      <div className="sticky top-0 z-10 -mx-4 mb-4 border-b border-line bg-ink/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={chip(lanes.length === 0)} onClick={() => applyFilters([], minScore)}>
            All
          </button>
          {LANES.map((lane) => (
            <button key={lane} type="button" className={chip(lanes.includes(lane))} onClick={() => toggleLane(lane)}>
              {lane}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-muted">min score</span>
          <div className="flex gap-1">
            {SCORES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={minScore === s}
                className={`h-7 w-7 rounded-md border text-xs tabular-nums transition-colors ${
                  minScore === s
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-line bg-surface text-muted hover:text-body'
                }`}
                onClick={() => applyFilters(lanes, s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {stories.map((s) => (
          <StoryCard key={s.id} story={s} />
        ))}
      </div>

      {error ? (
        <p className="mt-6 text-center text-sm text-lane-betting">
          {error}{' '}
          <button type="button" className="underline" onClick={() => void load({ reset: stories.length === 0 })}>
            retry
          </button>
        </p>
      ) : null}

      {!loading && !error && stories.length === 0 ? (
        <p className="mt-10 text-center text-sm text-muted">
          Nothing at score {minScore}+{lanes.length > 0 ? ` in ${lanes.join(', ')}` : ''} yet.
        </p>
      ) : null}

      {loading ? <p className="mt-6 text-center text-sm text-muted">Loading…</p> : null}

      {!loading && !error && done && stories.length > 0 ? (
        <p className="mt-8 text-center text-xs text-muted">Nothing more.</p>
      ) : null}

      <div ref={sentinel} aria-hidden className="h-px" />
    </main>
  );
}

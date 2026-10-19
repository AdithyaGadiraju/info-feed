'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '@/components/Icon';
import StoryCard, { reviveStory, type WireStoryWithCount } from '@/components/StoryCard';
import { ACTIVE_LANES, LANE_LABELS, type FeedCursor, type Lane, type StoryWithCount } from '@/lib/db/types';

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
    // of seven lanes is fiddly and nothing in the ADR asks for combinations.
    applyFilters(lanes.length === 1 && lanes[0] === lane ? [] : [lane], minScore);
  };

  const laneNames = lanes.map((l) => LANE_LABELS[l]).join(', ');
  // The filters are single-select, so a radio is only "on" when exactly that one lane is chosen.
  const laneChecked = (lane: Lane) => lanes.length === 1 && lanes[0] === lane;

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Live feed</p>
        <h1>Stories</h1>
        <p className="lede">
          Score {minScore}+ {lanes.length > 0 ? `in ${laneNames}` : 'across every lane'}, newest change first.
        </p>
      </div>

      <section className="card stack mb-6" aria-label="Filters">
        <fieldset className="chips">
          <legend className="field-label">Lane</legend>
          <label className="chip">
            <input type="radio" name="lane" checked={lanes.length === 0} onChange={() => applyFilters([], minScore)} />
            <span>All</span>
          </label>
          {ACTIVE_LANES.map((lane) => (
            <label key={lane} className="chip">
              <input type="radio" name="lane" checked={laneChecked(lane)} onChange={() => toggleLane(lane)} />
              <span>{LANE_LABELS[lane]}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="chips">
          <legend className="field-label">Minimum score</legend>
          {SCORES.map((s) => (
            <label key={s} className="chip">
              <input type="radio" name="minScore" checked={minScore === s} onChange={() => applyFilters(lanes, s)} />
              <span className="tnum">{s}+</span>
            </label>
          ))}
        </fieldset>
      </section>

      <div className="stack" aria-busy={loading}>
        {stories.map((s) => (
          <StoryCard key={s.id} story={s} />
        ))}
      </div>

      {error ? (
        <div className="callout callout-error mt-6" role="alert">
          <Icon name="alert" size={18} />
          <div className="flex flex-col gap-2">
            <div>
              <p className="callout-title">The feed did not load</p>
              <p>{error}</p>
            </div>
            <div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void load({ reset: stories.length === 0 })}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!loading && !error && stories.length === 0 ? (
        <div className="card empty" role="status">
          <span className="empty-icon">
            <Icon name="inbox" size={24} />
          </span>
          <h2>Nothing at score {minScore}+ yet</h2>
          <p className="muted">
            {lanes.length > 0 ? `No ${laneNames} stories clear the bar right now.` : 'No stories clear the bar right now.'}
          </p>
          {lanes.length > 0 || minScore > 1 ? (
            <button type="button" className="btn btn-secondary mt-2" onClick={() => applyFilters([], 1)}>
              Show every story
            </button>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <p className="subtle mt-6 text-center" role="status">
          Loading stories…
        </p>
      ) : null}

      {!loading && !error && done && stories.length > 0 ? (
        <p className="subtle small mt-8 text-center">That is everything at this score.</p>
      ) : null}

      <div ref={sentinel} aria-hidden className="h-px" />
    </>
  );
}

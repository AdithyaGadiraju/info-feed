'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '@/components/Icon';
import StoryCard, { reviveStory, type WireStoryWithCount } from '@/components/StoryCard';
import { ACTIVE_LANES, LANE_LABELS, type FeedCursor, type Lane, type StoryWithCount } from '@/lib/db/types';
import { DEFAULT_MIN_SCORE, MAX_SEARCH_LENGTH, dayStart, formatDay, isDay } from '@/lib/feed/params';

const PAGE_SIZE = 30;
const SCORES = [1, 2, 3, 4, 5] as const;
/** Long enough that a word gets typed before a request fires, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Everything that picks which stories the list shows. One object, because a
 * change to any part of it resets the list the same way, and because the URL,
 * the server page and the API all read exactly these fields (lib/feed/params.ts).
 */
export interface FeedFilters {
  lanes: Lane[];
  minScore: number;
  /** The done side of the feed (`?done=1`) rather than the stories still to read. */
  done: boolean;
  /** Calendar days, `YYYY-MM-DD`, both inclusive, on the story's last change. Empty is no bound. */
  from: string;
  to: string;
  /** Words that must all appear in the title or summaries. Empty is no search. */
  q: string;
}

interface FeedResponse {
  stories: WireStoryWithCount[];
  nextCursor: FeedCursor | null;
}

/** The cursor travels as one opaque base64 param; its JSON is pure ASCII. */
function encodeCursor(c: FeedCursor): string {
  return btoa(JSON.stringify(c));
}

/** Only the params away from their defaults, so a plain `/` stays a plain `/`. */
function filterParams(f: FeedFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.lanes.length > 0) p.set('lanes', f.lanes.join(','));
  if (f.minScore !== DEFAULT_MIN_SCORE) p.set('minScore', String(f.minScore));
  if (f.done) p.set('done', '1');
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.q) p.set('q', f.q);
  return p;
}

function buildUrl(f: FeedFilters, cursor: FeedCursor | null): string {
  const p = filterParams(f);
  p.set('limit', String(PAGE_SIZE));
  if (cursor) p.set('cursor', encodeCursor(cursor));
  return `/api/feed?${p.toString()}`;
}

/**
 * The date chips name a window ending today. "Today" is a window of one day,
 * "7 days" today and the six before it, so each chip is a `from` day and no `to`.
 */
const DATE_PRESETS = [
  { label: 'Any time', daysBack: null },
  { label: 'Today', daysBack: 0 },
  { label: '7 days', daysBack: 6 },
  { label: '30 days', daysBack: 29 },
] as const;

/**
 * The calendar day `daysBack` days before `today`, as `YYYY-MM-DD`. `today` comes
 * from the server (FeedProps), not from `new Date()` here: a render-time clock
 * would make the server and the browser disagree across midnight or a timezone
 * and fail hydration on the checked chip.
 */
function dayBefore(today: string, daysBack: number): string {
  return formatDay(dayStart(today, -daysBack));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-10-29` as "29 Oct 2026", for the lede. Spelled out by hand rather than
 * through `toLocaleDateString`, whose output can differ between the server's ICU
 * and the browser's and would then fail hydration on the first paint.
 */
function sayDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1] ?? '?'} ${y}`;
}

/** One sentence naming the view, so the page says what it is showing without reading the chips. */
function describe(f: FeedFilters, laneNames: string): string {
  const parts: string[] = [];
  parts.push(`${f.done ? 'Marked done, score' : 'Score'} ${f.minScore}+`);
  parts.push(f.lanes.length > 0 ? `in ${laneNames}` : 'across every lane');
  if (f.from && f.to) parts.push(f.from === f.to ? `on ${sayDay(f.from)}` : `${sayDay(f.from)} to ${sayDay(f.to)}`);
  else if (f.from) parts.push(`since ${sayDay(f.from)}`);
  else if (f.to) parts.push(`up to ${sayDay(f.to)}`);
  if (f.q) parts.push(`matching “${f.q}”`);
  return `${parts.join(', ')}, newest change first.`;
}

export interface FeedProps {
  initialStories: StoryWithCount[];
  initialCursor: FeedCursor | null;
  initialFilters: FeedFilters;
  /** Today as `YYYY-MM-DD` in the server's timezone, which the date window is read in. */
  today: string;
}

export default function Feed({ initialStories, initialCursor, initialFilters, today }: FeedProps) {
  const [filters, setFilters] = useState<FeedFilters>(initialFilters);
  // The search box is its own state: it changes on every keystroke, the filter
  // only after the pause.
  const [qInput, setQInput] = useState(initialFilters.q);

  const [stories, setStories] = useState<StoryWithCount[]>(initialStories);
  const [cursor, setCursor] = useState<FeedCursor | null>(initialCursor);
  const [exhausted, setExhausted] = useState(initialCursor === null);
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
  const query = useRef({ filters, cursor, exhausted, generation: 0 });
  query.current = { filters, cursor, exhausted, generation: generation.current };

  const load = useCallback(async (opts: { reset: boolean }) => {
    if (inFlight.current) return;
    const { filters: f, cursor: c, exhausted: x } = query.current;
    if (!opts.reset && (x || c === null)) return;

    const gen = generation.current;
    inFlight.current = true;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(buildUrl(f, opts.reset ? null : c), {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`feed request failed (${res.status})`);
      const body = (await res.json()) as FeedResponse;
      if (gen !== generation.current) return;

      const page = body.stories.map(reviveStory);
      setStories((prev) => (opts.reset ? page : [...prev, ...page]));
      setCursor(body.nextCursor);
      setExhausted(body.nextCursor === null);
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
    (next: FeedFilters) => {
      generation.current += 1;
      // In-flight work belongs to the old generation; unblock the reset immediately.
      inFlight.current = false;

      setFilters(next);
      setStories([]);
      setCursor(null);
      setExhausted(false);
      query.current = { filters: next, cursor: null, exhausted: false, generation: generation.current };

      // Keep the filtered view linkable without a server round trip.
      const qs = filterParams(next).toString();
      window.history.replaceState(null, '', qs ? `/?${qs}` : '/');

      void load({ reset: true });
    },
    [load],
  );

  // Search as you type, after a pause. Reads the live filters through the ref so
  // a lane change mid-pause is not undone by the stale search that follows it.
  useEffect(() => {
    const next = qInput.replace(/\s+/g, ' ').trim();
    if (next === query.current.filters.q) return;
    const t = setTimeout(() => applyFilters({ ...query.current.filters, q: next }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [qInput, applyFilters]);

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

  const { lanes, minScore, done: showDone, from, to, q } = filters;
  const set = (patch: Partial<FeedFilters>) => applyFilters({ ...filters, ...patch });

  const toggleLane = (lane: Lane) => {
    // Chips are a single-select "All | lane" switch: on a phone, a multi-select
    // of seven lanes is fiddly and nothing in the ADR asks for combinations.
    set({ lanes: lanes.length === 1 && lanes[0] === lane ? [] : [lane] });
  };

  /**
   * The list is one side of the done split, so a story the reader just moved to
   * the other side leaves it. Its card has already shown the new state; what is
   * left is the list no longer claiming it.
   */
  const onDoneChange = useCallback((s: StoryWithCount, doneAt: Date | null) => {
    if ((doneAt !== null) !== query.current.filters.done) {
      setStories((prev) => prev.filter((x) => x.id !== s.id));
    }
  }, []);

  const laneNames = lanes.map((l) => LANE_LABELS[l]).join(', ');
  // The filters are single-select, so a radio is only "on" when exactly that one lane is chosen.
  const laneChecked = (lane: Lane) => lanes.length === 1 && lanes[0] === lane;
  // A preset is "on" when the window is exactly the one it names; a hand-picked range lights none.
  const presetChecked = (daysBack: number | null) =>
    daysBack === null ? from === '' && to === '' : from === dayBefore(today, daysBack) && to === '';
  /**
   * A date input being typed passes through values the API would reject
   * (`0002-10-29` on the way to 2026) and the browser's min/max only bind the
   * picker, so a day is applied once it is real, and a window typed back to front
   * drops its other end rather than erroring the whole list.
   */
  const setDay = (side: 'from' | 'to', v: string) => {
    if (v !== '' && !isDay(v)) return;
    const next = { ...filters, [side]: v };
    if (next.from && next.to && next.from > next.to) next[side === 'from' ? 'to' : 'from'] = '';
    applyFilters(next);
  };
  const filtered = lanes.length > 0 || minScore > 1 || from !== '' || to !== '' || q !== '';

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">Live feed</p>
        <h1>Stories</h1>
        <p className="lede">{describe(filters, laneNames)}</p>
      </div>

      <section className="card stack mb-6" aria-label="Filters">
        <div className="search-row" role="search">
          <label htmlFor="feed-q">Search</label>
          <input
            id="feed-q"
            type="search"
            value={qInput}
            maxLength={MAX_SEARCH_LENGTH}
            placeholder="Words in the title or summary"
            autoComplete="off"
            onChange={(e) => setQInput(e.target.value)}
          />
          <Icon name="search" size={18} />
        </div>
        <fieldset className="chips">
          <legend className="field-label">Lane</legend>
          <label className="chip">
            <input type="radio" name="lane" checked={lanes.length === 0} onChange={() => set({ lanes: [] })} />
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
              <input type="radio" name="minScore" checked={minScore === s} onChange={() => set({ minScore: s })} />
              <span className="tnum">{s}+</span>
            </label>
          ))}
        </fieldset>
        {/* Done is a second list, not a filter on this one: a story is on exactly one side. */}
        <fieldset className="chips">
          <legend className="field-label">Show</legend>
          <label className="chip">
            <input type="radio" name="show" checked={!showDone} onChange={() => set({ done: false })} />
            <span>To read</span>
          </label>
          <label className="chip">
            <input type="radio" name="show" checked={showDone} onChange={() => set({ done: true })} />
            <span>Done</span>
          </label>
        </fieldset>
        <fieldset className="chips">
          <legend className="field-label">Last changed</legend>
          {DATE_PRESETS.map((p) => (
            <label key={p.label} className="chip">
              <input
                type="radio"
                name="dateRange"
                checked={presetChecked(p.daysBack)}
                onChange={() => set({ from: p.daysBack === null ? '' : dayBefore(today, p.daysBack), to: '' })}
              />
              <span>{p.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="grid-2">
          <div className="field">
            <div className="inline-field">
              <label className="field-label" htmlFor="feed-from">
                From
              </label>
              <input
                className="input"
                id="feed-from"
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setDay('from', e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <div className="inline-field">
              <label className="field-label" htmlFor="feed-to">
                To
              </label>
              <input
                className="input"
                id="feed-to"
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setDay('to', e.target.value)}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="stack" aria-busy={loading}>
        {stories.map((s) => (
          <StoryCard key={s.id} story={s} onDoneChange={onDoneChange} />
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
          <h2>
            {q
              ? `Nothing matches “${q}”`
              : showDone
                ? `Nothing marked done at score ${minScore}+`
                : `Nothing at score ${minScore}+ yet`}
          </h2>
          <p className="muted">
            {showDone && !q
              ? 'Press Mark done on a story and it moves here.'
              : lanes.length > 0
                ? `No ${laneNames} stories fit these filters right now.`
                : 'No stories fit these filters right now.'}
          </p>
          {filtered ? (
            <button
              type="button"
              className="btn btn-secondary mt-2"
              onClick={() => {
                setQInput('');
                applyFilters({ lanes: [], minScore: 1, done: showDone, from: '', to: '', q: '' });
              }}
            >
              {showDone ? 'Show every done story' : 'Show every story'}
            </button>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <p className="subtle mt-6 text-center" role="status">
          Loading stories…
        </p>
      ) : null}

      {!loading && !error && exhausted && stories.length > 0 ? (
        <p className="subtle small mt-8 text-center">That is everything that fits.</p>
      ) : null}

      <div ref={sentinel} aria-hidden className="h-px" />
    </>
  );
}

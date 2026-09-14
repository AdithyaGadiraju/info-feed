'use client';

import { useCallback, useId, useState } from 'react';
import Markdown from 'react-markdown';
import { LANE_LABELS, type Engagement, type Lane, type StoryWithCount, type StoryWithItems } from '@/lib/db/types';

/**
 * JSON has no Date. Anything that arrives over `/api/feed` comes back with ISO
 * strings where the query layer promised `Date`, so the wire shapes are spelled
 * out and revived at the boundary instead of leaking `string | Date` unions into
 * every component below.
 */
type WithIsoDates<T> = Omit<T, 'firstSeenAt' | 'updatedAt' | 'digestedAt'> & {
  firstSeenAt: string;
  updatedAt: string;
  digestedAt: string | null;
};

export type WireStoryWithCount = WithIsoDates<StoryWithCount>;

export type WireStoryWithItems = Omit<WithIsoDates<StoryWithItems>, 'items'> & {
  items: Array<Omit<StoryWithItems['items'][number], 'publishedAt'> & { publishedAt: string }>;
};

export function reviveStory(r: WireStoryWithCount): StoryWithCount {
  return {
    ...r,
    firstSeenAt: new Date(r.firstSeenAt),
    updatedAt: new Date(r.updatedAt),
    digestedAt: r.digestedAt ? new Date(r.digestedAt) : null,
  };
}

export function reviveStoryWithItems(r: WireStoryWithItems): StoryWithItems {
  return {
    ...r,
    firstSeenAt: new Date(r.firstSeenAt),
    updatedAt: new Date(r.updatedAt),
    digestedAt: r.digestedAt ? new Date(r.digestedAt) : null,
    items: r.items.map((i) => ({ ...i, publishedAt: new Date(i.publishedAt) })),
  };
}

const LANE_CLASS: Record<Lane, string> = {
  ai: 'text-lane-ai',
  ai_dev: 'text-lane-ai_dev',
  markets: 'text-lane-markets',
  betting: 'text-lane-betting',
  gamedev: 'text-lane-gamedev',
  games: 'text-lane-games',
};

export function relativeTime(d: Date, now = Date.now()): string {
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  const days = Math.floor(s / 86_400);
  if (days < 7) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

function engagementLabel(e: Engagement): string | null {
  const parts: string[] = [];
  const votes = e.points ?? e.upvotes ?? e.likes;
  if (typeof votes === 'number' && votes > 0) parts.push(`${compact(votes)} pts`);
  if (typeof e.comments === 'number' && e.comments > 0) parts.push(`${compact(e.comments)} comments`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function ScoreDots({ score }: { score: number }) {
  return (
    <span className="tabular-nums text-muted" title={`score ${score}/5`} aria-label={`score ${score} of 5`}>
      {'●'.repeat(score)}
      <span className="text-line">{'●'.repeat(Math.max(0, 5 - score))}</span>
    </span>
  );
}

function SourceList({ items }: { items: StoryWithItems['items'] }) {
  if (items.length === 0) return <p className="text-sm text-muted">No sources recorded.</p>;
  return (
    <ul className="space-y-3">
      {items.map((i) => {
        const eng = engagementLabel(i.engagement);
        return (
          <li key={i.id} className="border-l-2 border-line pl-3">
            <a
              href={i.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-body underline decoration-line underline-offset-2 hover:text-accent"
            >
              {i.title}
            </a>
            <p className="mt-0.5 text-xs text-muted">
              <span className="uppercase tracking-wide">{i.source}</span>
              {i.author ? <> · {i.author}</> : null}
              {eng ? <> · {eng}</> : null} · <span suppressHydrationWarning>{relativeTime(i.publishedAt)}</span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export interface StoryCardProps {
  story: StoryWithCount;
  /**
   * Server-rendered detail. The permalink page passes it so `/story/[id]` is
   * complete HTML with no JavaScript (ADR 0004: digest links land there).
   */
  initialDetail?: StoryWithItems | null;
  defaultExpanded?: boolean;
}

/**
 * Expanded detail needs the item list, which `getFeedPage` deliberately does not
 * return — pulling 50 items per card for a 30-card page would make the feed query
 * enormous to serve a panel most cards never open. So the card fetches
 * `/api/feed?storyId=N` on first expand and caches it for the life of the card.
 * The permalink page skips that round trip entirely via `initialDetail`.
 */
export default function StoryCard({ story, initialDetail = null, defaultExpanded = false }: StoryCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [detail, setDetail] = useState<StoryWithItems | null>(initialDetail);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    // A story with `summary_detail` renders markdown and never shows the source
    // list, so there is nothing to fetch (ADR 0004: detail OR sources, not both).
    if (!next || detail || loading || story.summaryDetail) return;

    setLoading(true);
    setError(null);
    fetch(`/api/feed?storyId=${story.id}`, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`detail request failed (${res.status})`);
        const body = (await res.json()) as { story: WireStoryWithItems };
        setDetail(reviveStoryWithItems(body.story));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'could not load sources'))
      .finally(() => setLoading(false));
  }, [expanded, detail, loading, story]);

  const sourceCount = detail ? detail.items.length : story.itemCount;

  return (
    <article className="overflow-hidden rounded-xl border border-line bg-surface">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="block w-full cursor-pointer px-4 py-3.5 text-left transition-colors hover:bg-surface-2"
      >
        <div className="flex items-center gap-2 text-xs">
          <span className={`font-semibold uppercase tracking-wider ${LANE_CLASS[story.lane]}`}>{LANE_LABELS[story.lane]}</span>
          <ScoreDots score={story.score} />
          <span className="ml-auto text-muted" suppressHydrationWarning>
            {relativeTime(story.updatedAt)}
          </span>
        </div>
        <h2 className="mt-1.5 text-[15px] font-semibold leading-snug text-body">{story.title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">{story.summaryShort}</p>
        <p className="mt-2 text-xs text-muted">
          {sourceCount} {sourceCount === 1 ? 'source' : 'sources'}
          <span className="ml-2 text-line">{expanded ? '▲' : '▼'}</span>
        </p>
      </button>

      {expanded ? (
        <div id={panelId} className="border-t border-line bg-surface-2/40 px-4 py-3.5 text-sm">
          {story.summaryDetail ? (
            <div className="md text-body">
              <Markdown
                components={{
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                }}
              >
                {story.summaryDetail}
              </Markdown>
            </div>
          ) : loading ? (
            <p className="text-muted">Loading sources…</p>
          ) : error ? (
            <p className="text-lane-betting">{error}</p>
          ) : detail ? (
            <SourceList items={detail.items} />
          ) : (
            <p className="text-muted">No detail yet.</p>
          )}
        </div>
      ) : null}
    </article>
  );
}

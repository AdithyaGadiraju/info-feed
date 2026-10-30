'use client';

import { useCallback, useId, useState } from 'react';
import Markdown from 'react-markdown';
import Icon, { type IconName } from '@/components/Icon';
import {
  LANE_LABELS,
  VERDICT_LABELS,
  type Engagement,
  type GlossaryTerm,
  type StoryWithCount,
  type StoryWithItems,
  type Verdict,
  type Verification,
} from '@/lib/db/types';

/**
 * JSON has no Date. Anything that arrives over `/api/feed` comes back with ISO
 * strings where the query layer promised `Date`, so the wire shapes are spelled
 * out and revived at the boundary instead of leaking `string | Date` unions into
 * every component below.
 */
type WireVerification = Omit<Verification, 'checkedAt'> & { checkedAt: string };

type WithIsoDates<T> = Omit<T, 'firstSeenAt' | 'updatedAt' | 'digestedAt' | 'doneAt' | 'verification'> & {
  firstSeenAt: string;
  updatedAt: string;
  digestedAt: string | null;
  doneAt: string | null;
  verification: WireVerification | null;
};

function reviveVerification(v: WireVerification | null): Verification | null {
  return v ? { ...v, checkedAt: new Date(v.checkedAt) } : null;
}

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
    doneAt: r.doneAt ? new Date(r.doneAt) : null,
    verification: reviveVerification(r.verification),
  };
}

export function reviveStoryWithItems(r: WireStoryWithItems): StoryWithItems {
  return {
    ...r,
    firstSeenAt: new Date(r.firstSeenAt),
    updatedAt: new Date(r.updatedAt),
    digestedAt: r.digestedAt ? new Date(r.digestedAt) : null,
    doneAt: r.doneAt ? new Date(r.doneAt) : null,
    verification: reviveVerification(r.verification),
    items: r.items.map((i) => ({ ...i, publishedAt: new Date(i.publishedAt) })),
  };
}

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

/** Display label for the article link: the bare host, so the card shows where it goes. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
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

function ScorePips({ score }: { score: number }) {
  return (
    <span className="pips" role="img" title={`Score ${score} of 5`} aria-label={`Score ${score} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= score ? 'on' : undefined} />
      ))}
    </span>
  );
}

/** Every verdict is a colour, an icon and its word, so none relies on colour alone. */
const VERDICT_STYLE: Record<Verdict, { tag: string; callout: string; icon: IconName }> = {
  confirmed: { tag: 'tag-green', callout: 'callout-success', icon: 'check' },
  unconfirmed: { tag: 'tag-amber', callout: 'callout-warn', icon: 'help' },
  disputed: { tag: 'tag-red', callout: 'callout-error', icon: 'alert' },
  false: { tag: 'tag-red', callout: 'callout-error', icon: 'x' },
};

/**
 * A verdict is about the story as it stood when it was checked. Once the story
 * has changed since, the verdict is shown muted and says so, until the next digest
 * re-checks it.
 */
function isOutdated(story: { updatedAt: Date; verification: Verification | null }): boolean {
  return story.verification !== null && story.verification.checkedAt < story.updatedAt;
}

function VerdictBadge({ verification, outdated }: { verification: Verification; outdated: boolean }) {
  const label = VERDICT_LABELS[verification.verdict];
  const style = VERDICT_STYLE[verification.verdict];
  // An outdated verdict drops its colour and says so in words.
  return (
    <span
      className={`tag ${outdated ? '' : style.tag}`}
      title={outdated ? `${label} when checked, before the story last changed` : `Fact-check: ${label}`}
    >
      <Icon name={outdated ? 'clock' : style.icon} size={14} />
      {label}
      {outdated ? ', outdated' : ''}
    </span>
  );
}

/**
 * The yellow tick is the house mark for "done" (docs/ui-design.md) and is never
 * shown without the word, so the state does not rest on colour.
 */
function DoneTag({ doneAt }: { doneAt: Date }) {
  return (
    <span className="tag" title={`Marked done ${relativeTime(doneAt)}`} suppressHydrationWarning>
      <span className="done-tick" aria-hidden="true">
        <Icon name="check" size={12} />
      </span>
      Done
    </span>
  );
}

function FactCheck({ verification, outdated }: { verification: Verification; outdated: boolean }) {
  const style = VERDICT_STYLE[verification.verdict];
  return (
    <div className={`callout ${outdated ? '' : style.callout} mb-5`}>
      <Icon name={outdated ? 'clock' : style.icon} size={18} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="callout-title">
          Fact-check: {VERDICT_LABELS[verification.verdict]}
          {outdated ? ', outdated' : ''}
          <span className="subtle small font-normal">
            {' '}
            · checked <span suppressHydrationWarning>{relativeTime(verification.checkedAt)}</span>
          </span>
        </p>
        <p>{verification.note}</p>
        {verification.sources.length > 0 ? (
          <ul className="small flex flex-col gap-0.5">
            {verification.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function SourceList({ items }: { items: StoryWithItems['items'] }) {
  if (items.length === 0) return <p className="muted">No sources recorded.</p>;
  return (
    <div>
      <div className="section-head">
        <h3 className="eyebrow">Sources</h3>
        <span className="count">{items.length}</span>
      </div>
      <ul className="flex flex-col gap-4">
        {items.map((i) => {
          const eng = engagementLabel(i.engagement);
          return (
            <li key={i.id} className="flex flex-col gap-1">
              <a href={i.url} target="_blank" rel="noopener noreferrer" className="font-semibold">
                {i.title}
              </a>
              <p className="subtle small">
                <span className="eyebrow">{i.source}</span>
                {i.author ? <> · {i.author}</> : null}
                {eng ? <> · {eng}</> : null} · <span suppressHydrationWarning>{relativeTime(i.publishedAt)}</span>
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The simple definition, always shown, and below it the full one behind a click. */
function TermDefinition({ term }: { term: GlossaryTerm }) {
  return (
    <div className="glossary-def">
      <p className="muted small">
        <span className="glossary-label">Simple:</span> {term.definition}
      </p>
      {term.full ? (
        <details className="glossary-full">
          <summary>
            <span className="glossary-label small">Detailed…</span>
          </summary>
          <div className="glossary-full-body">
            {term.full.split('\n\n').map((paragraph, i) => (
              <p key={i} className="muted small">
                {paragraph}
              </p>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Jargon from the summaries, closed by default. Native <details> all the way down,
 * so it works without JavaScript on the permalink page and several terms can be
 * open at once. It sits above the title button's overlay (see .glossary), so
 * opening it never toggles the card.
 */
function Glossary({ terms }: { terms: GlossaryTerm[] }) {
  if (terms.length === 0) return null;
  return (
    <details className="glossary mt-3">
      <summary>
        <span className="glossary-chevron">
          <Icon name="chevron" size={14} />
        </span>
        <span className="eyebrow">Terms</span>
        <span className="count">{terms.length}</span>
      </summary>
      <ul className="glossary-list">
        {terms.map((t, i) => (
          <li key={`${i}-${t.term}`}>
            <details className="glossary-term">
              <summary>
                <span className="glossary-chevron">
                  <Icon name="chevron" size={14} />
                </span>
                {t.term}
              </summary>
              <TermDefinition term={t} />
            </details>
          </li>
        ))}
      </ul>
    </details>
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
  /** The permalink page makes the story title its h1; in the feed each title is an h2. */
  headingLevel?: 1 | 2;
  /**
   * Fired after the server has accepted a Done or Undo, with the story's new
   * `doneAt`. The feed uses it to drop a card that no longer belongs to the side
   * it is showing; the permalink page has no list and leaves it unset.
   */
  onDoneChange?: (story: StoryWithCount, doneAt: Date | null) => void;
}

/**
 * Expanded detail needs the item list, which `getFeedPage` deliberately does not
 * return — pulling 50 items per card for a 30-card page would make the feed query
 * enormous to serve a panel most cards never open. So the card fetches
 * `/api/feed?storyId=N` on first expand and caches it for the life of the card.
 * The permalink page skips that round trip entirely via `initialDetail`.
 */
export default function StoryCard({
  story,
  initialDetail = null,
  defaultExpanded = false,
  headingLevel = 2,
  onDoneChange,
}: StoryCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [detail, setDetail] = useState<StoryWithItems | null>(initialDetail);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  // Done lives on the card, not the list: the permalink page has no list, and the
  // feed only needs to hear about a change (onDoneChange), not own it.
  const [doneAt, setDoneAt] = useState<Date | null>(story.doneAt);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  const setDone = useCallback(
    (done: boolean) => {
      if (marking) return;
      setMarking(true);
      setMarkError(null);
      fetch(`/api/story/${story.id}/done`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ done }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`request failed (${res.status})`);
          const body = (await res.json()) as { doneAt: string | null };
          const next = body.doneAt ? new Date(body.doneAt) : null;
          setDoneAt(next);
          onDoneChange?.(story, next);
        })
        .catch((e: unknown) => setMarkError(e instanceof Error ? e.message : 'could not save'))
        .finally(() => setMarking(false));
    },
    [marking, story, onDoneChange],
  );

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
  const verification = story.verification;
  const outdated = isOutdated(story);
  // The collapsed card carries the note only when it is a warning. A confirmed
  // story needs no second line; a disputed one should not need a click.
  const warn = verification !== null && !outdated && (verification.verdict === 'disputed' || verification.verdict === 'false');

  const Heading = headingLevel === 1 ? 'h1' : 'h2';

  return (
    <article className="panel overflow-hidden">
      {/* The title is the toggle button; its ::after stretches over the whole head,
          so the summary is clickable too while the heading stays a real heading. */}
      <div className="story-head">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="eyebrow">{LANE_LABELS[story.lane]}</span>
          <ScorePips score={story.score} />
          {verification ? <VerdictBadge verification={verification} outdated={outdated} /> : null}
          {doneAt ? <DoneTag doneAt={doneAt} /> : null}
          <span className="subtle small ml-auto" suppressHydrationWarning>
            {relativeTime(story.updatedAt)}
          </span>
        </div>
        <Heading className={`story-title ${headingLevel === 1 ? 'story-title-lg' : ''} mt-3`}>
          <button type="button" onClick={toggle} aria-expanded={expanded} aria-controls={panelId}>
            {story.title}
          </button>
        </Heading>
        <p className="muted mt-2">{story.summaryShort}</p>
        <Glossary terms={story.glossary} />
        {warn ? (
          <p className="mt-2 flex gap-2 font-semibold text-red-ink">
            <span className="mt-0.5 shrink-0">
              <Icon name={VERDICT_STYLE[verification.verdict].icon} />
            </span>
            {verification.note}
          </p>
        ) : null}
        <p className="subtle small mt-3 flex items-center gap-1.5">
          {sourceCount} {sourceCount === 1 ? 'source' : 'sources'}
          <span className={`story-chevron ${expanded ? 'is-open' : ''}`}>
            <Icon name="chevron" size={14} />
          </span>
        </p>
      </div>

      {/* The foot is the card's action row: the article on the left, Done on the
          right. It is the one place on the card that is not the title's toggle. */}
      <div className="story-foot">
        {story.primaryUrl ? (
          <a href={story.primaryUrl} target="_blank" rel="noopener noreferrer" className="story-link">
            <span>Read the original</span>
            <span className="subtle truncate font-normal">{hostOf(story.primaryUrl) ?? story.primaryUrl}</span>
            <Icon name="external" size={14} />
          </a>
        ) : (
          <span className="story-link" aria-hidden="true" />
        )}
        <button
          type="button"
          className={`btn btn-sm ${doneAt ? 'btn-ghost' : 'btn-secondary'}`}
          onClick={() => setDone(!doneAt)}
          disabled={marking}
          aria-busy={marking}
        >
          {doneAt ? (
            <>
              Undo<span className="visually-hidden"> done</span>
            </>
          ) : (
            <>
              <Icon name="check" size={14} />
              Mark done
            </>
          )}
        </button>
      </div>
      {markError ? (
        <p className="story-foot-error small text-red-ink" role="alert">
          Could not save: {markError}
        </p>
      ) : null}

      {expanded ? (
        <div id={panelId} className="story-detail">
          {verification ? <FactCheck verification={verification} outdated={outdated} /> : null}
          {story.summaryDetail ? (
            <div className="md">
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
            <p className="subtle" role="status">
              Loading sources…
            </p>
          ) : error ? (
            <div className="callout callout-error" role="alert">
              <Icon name="alert" size={18} />
              <div>
                <p className="callout-title">Sources did not load</p>
                <p>{error}</p>
              </div>
            </div>
          ) : detail ? (
            <SourceList items={detail.items} />
          ) : (
            <p className="muted">No detail yet.</p>
          )}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Devpost hackathon listings (free, no key). Devpost is where most online
 * hackathons with prize money are listed, and its listing API states what the
 * events lane needs for each one: the dates, the place, the prize pool and how
 * many people have registered. No feed carries these: `/hackathons.rss` answers 406.
 *
 * A snapshot source. A listing has no publish date, so the runner keeps only the
 * ids it has not stored yet. It does not seed the first listing as already seen
 * (`seedFirstListing: false`): a hackathon that is open on the day a search is
 * added is still an opportunity.
 */
import type { DevpostSpec, RawItem, Source, SourceCtx } from './types';

const API_URL = 'https://devpost.com/api/hackathons';
const USER_AGENT = 'info-feed/1.0 (personal news digest)';

/** The API returns 9 a page. Three pages is every Gaming hackathon open at once, with room. */
const MAX_PAGES = 3;
const PER_PAGE = 9;

/** One hackathon as the listing API returns it. Only the fields this source reads. */
export interface DevpostHackathon {
  id: number;
  title: string;
  url: string;
  displayed_location?: { location?: string };
  open_state?: string;
  submission_period_dates?: string;
  /** HTML: `$<span data-currency-value>35,000</span>`. */
  prize_amount?: string;
  prizes_counts?: { cash?: number; other?: number };
  registrations_count?: number;
  organization_name?: string | null;
  themes?: Array<{ name?: string }>;
  invite_only?: boolean;
}

interface ListingResponse {
  hackathons?: DevpostHackathon[];
  meta?: { total_count?: number; per_page?: number };
}

export function searchUrl(spec: DevpostSpec, page = 1): string {
  const params = new URLSearchParams();
  for (const theme of spec.themes ?? []) params.append('themes[]', theme);
  // Ended hackathons are never an opportunity.
  params.append('status[]', 'upcoming');
  params.append('status[]', 'open');
  if (spec.search) params.set('search', spec.search);
  if (page > 1) params.set('page', String(page));
  return `${API_URL}?${params.toString()}`;
}

/** `$<span data-currency-value>35,000</span>` as { text: "$35,000", value: 35000 }. */
export function parsePrize(raw: string | undefined): { text: string; value: number } {
  const text = (raw ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  const value = Number(text.replace(/[^0-9.]/g, ''));
  return { text, value: Number.isFinite(value) ? value : 0 };
}

/** Pure mapping from a listing to RawItems, split out so the gates can be tested against a fixture. */
export function mapHackathons(hackathons: DevpostHackathon[], spec: DevpostSpec, now: Date): RawItem[] {
  const items: RawItem[] = [];
  for (const h of hackathons) {
    if (!h.id || !h.title || !h.url || h.invite_only) continue;
    const location = h.displayed_location?.location?.trim() ?? '';
    if (spec.onlineOnly && location.toLowerCase() !== 'online') continue;
    const prize = parsePrize(h.prize_amount);
    if (prize.value < spec.minPrize) continue;

    const themes = (h.themes ?? []).map((t) => t.name).filter(Boolean).join(', ');
    // Labelled lines: this body is what the model reads the event facts from.
    const body = [
      `Hackathon listed on Devpost${h.organization_name ? `, run by ${h.organization_name}` : ''}.`,
      location ? `Where: ${location}.` : '',
      h.submission_period_dates ? `Submission period: ${h.submission_period_dates}.` : '',
      h.open_state ? `State: ${h.open_state}.` : '',
      prize.text ? `Prizes: ${prize.text} in total${h.prizes_counts?.cash ? ` (${h.prizes_counts.cash} cash prizes)` : ''}.` : '',
      typeof h.registrations_count === 'number' ? `Registered: ${h.registrations_count}.` : '',
      themes ? `Themes: ${themes}.` : '',
    ]
      .filter((line) => line.length > 0)
      .join(' ');

    items.push({
      source: 'devpost',
      externalId: String(h.id),
      laneHint: spec.lane,
      url: h.url,
      title: `${h.title} (hackathon${h.organization_name ? ` by ${h.organization_name}` : ''})`,
      body,
      // The spec name, not the organiser: the runner tracks a snapshot per author.
      author: spec.name,
      engagement: typeof h.registrations_count === 'number' ? { likes: h.registrations_count } : undefined,
      publishedAt: now,
    });
  }
  return items;
}

async function fetchPage(spec: DevpostSpec, page: number, ctx: SourceCtx): Promise<ListingResponse> {
  const res = await fetch(searchUrl(spec, page), {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ListingResponse;
}

async function search(spec: DevpostSpec, ctx: SourceCtx, now: Date): Promise<RawItem[]> {
  const all: DevpostHackathon[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await fetchPage(spec, page, ctx);
    const list = body.hackathons ?? [];
    all.push(...list);
    const total = body.meta?.total_count ?? 0;
    if (list.length < (body.meta?.per_page ?? PER_PAGE) || all.length >= total) break;
  }
  return mapHackathons(all, spec, now);
}

export const devpost: Source = {
  name: 'devpost',
  snapshot: true,
  seedFirstListing: false,
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    const specs = ctx.lanes ? ctx.config.devpost.filter((s) => ctx.lanes!.includes(s.lane)) : ctx.config.devpost;
    const now = new Date();
    const seen = new Set<string>();
    const items: RawItem[] = [];
    for (const spec of specs) {
      try {
        for (const item of await search(spec, ctx, now)) {
          // A hackathon can match two searches; the first one listed keeps it.
          if (seen.has(item.externalId)) continue;
          seen.add(item.externalId);
          items.push(item);
        }
      } catch (err) {
        // One search failing must not hide the others (ADR 0002).
        console.warn(`[devpost] ${spec.name} failed: ${(err as Error).message}`);
      }
    }
    return items;
  },
};

export default devpost;

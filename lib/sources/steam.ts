/**
 * Steam source (ADR 0002): `featuredcategories`, free, no key. Takes "new releases"
 * and "top sellers" as `games` lane items, deduped by appid.
 *
 * Response shape verified live on 2026-09-13 (`cc=au&l=english`): the payload is a
 * flat object keyed by category, some numeric-indexed spotlight slots plus named
 * keys `specials`, `coming_soon`, `top_sellers`, `new_releases`, each shaped as
 * `{ id, name, items: FeaturedItem[] }`. The two categories we want:
 *   new_releases.items — ~30 entries
 *   top_sellers.items  — ~10 entries
 * Each item looks like:
 *   { id: number, name: string, discounted: boolean, discount_percent: number,
 *     original_price: number, final_price: number, currency: string, ... }
 * Prices are in the smallest currency unit (cents for AUD) with no decimal point.
 */
import type { RawItem, Source, SourceCtx } from './types';

const ENDPOINT = 'https://store.steampowered.com/api/featuredcategories?cc=au&l=english';

/** A sale day can otherwise flood the games lane; this is a sensible sane cap. */
const MAX_ITEMS = 40;

const CATEGORY_LABELS: Record<'new_releases' | 'top_sellers', string> = {
  new_releases: 'new release',
  top_sellers: 'top seller',
};

interface FeaturedItem {
  id: number;
  name: string;
  discounted: boolean;
  discount_percent: number;
  original_price: number | null;
  final_price: number | null;
  currency: string;
}

interface FeaturedCategoriesResponse {
  new_releases?: { items: FeaturedItem[] };
  top_sellers?: { items: FeaturedItem[] };
}

/** Steam prices are integer minor units (e.g. cents); format as a decimal amount. */
function formatPrice(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function priceNote(item: FeaturedItem): string {
  if (item.final_price == null) return '';
  if (item.discounted && item.discount_percent > 0) {
    return `, -${item.discount_percent}% to ${formatPrice(item.final_price, item.currency)}`;
  }
  return `, ${formatPrice(item.final_price, item.currency)}`;
}

export const steam: Source = {
  name: 'steam',
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    if (ctx.lanes && !ctx.lanes.includes('games')) return [];

    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs),
      });
    } catch (err) {
      console.warn(`[steam] network error: ${(err as Error).message}`);
      return [];
    }

    if (!res.ok) {
      console.warn(`[steam] returned HTTP ${res.status}`);
      return [];
    }

    let data: FeaturedCategoriesResponse;
    try {
      data = (await res.json()) as FeaturedCategoriesResponse;
    } catch (err) {
      console.warn(`[steam] returned unparseable JSON: ${(err as Error).message}`);
      return [];
    }

    // appid -> accumulated state, so an app in both categories is emitted once
    // with both categories named in the body.
    const byAppId = new Map<number, { item: FeaturedItem; categories: Set<keyof typeof CATEGORY_LABELS> }>();

    for (const category of ['new_releases', 'top_sellers'] as const) {
      for (const item of data[category]?.items ?? []) {
        const existing = byAppId.get(item.id);
        if (existing) {
          existing.categories.add(category);
        } else {
          byAppId.set(item.id, { item, categories: new Set([category]) });
        }
      }
    }

    // No release timestamp is present anywhere in this payload, so ingest time is
    // the only date we have. That means `since` filtering never applies to Steam
    // items -- every run either includes an app or the run doesn't fetch at all.
    const now = new Date();

    const results: RawItem[] = [];
    for (const { item, categories } of byAppId.values()) {
      const labels = [...categories].map((c) => CATEGORY_LABELS[c]).join(' and ');
      results.push({
        source: 'steam',
        externalId: `steam-${item.id}`,
        laneHint: 'games',
        url: `https://store.steampowered.com/app/${item.id}/`,
        title: item.name,
        body: `Steam ${labels}${priceNote(item)}`,
        engagement: {},
        publishedAt: now,
      });
      if (results.length >= MAX_ITEMS) break;
    }

    return results;
  },
};

export default steam;

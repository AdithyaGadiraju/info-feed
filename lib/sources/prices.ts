/**
 * Price source (ADR 0002, T5): the one source that also writes to the database.
 * Crypto via CoinGecko free `/simple/price` (one request for the whole watchlist,
 * since the free tier is rate-limited per-request, not per-symbol). Stocks via
 * Yahoo Finance's unofficial chart endpoint, isolated in its own function with its
 * own try/catch so a Yahoo break can never take crypto down with it -- that
 * isolation is the explicit point of this module per the ADR.
 */
import { getPriceAt, insertPriceSnapshots } from '../db/queries.js';
import type { RawItem, Source, SourceCtx } from './types.js';

interface CoinGeckoEntry {
  usd: number;
  usd_24h_change?: number;
}

type CoinGeckoResponse = Record<string, CoinGeckoEntry | undefined>;

interface PricePoint {
  symbol: string;
  price: number;
  /** Percent, e.g. -7.4. Undefined when the API omitted it and no fallback was found. */
  change24h: number | undefined;
}

async function fetchCrypto(ctx: SourceCtx): Promise<PricePoint[]> {
  const crypto = ctx.config.crypto;
  if (crypto.length === 0) return [];

  const ids = crypto.map((c) => c.coingeckoId).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs) });
  } catch (err) {
    console.warn(`[prices] crypto network error: ${(err as Error).message}`);
    return [];
  }

  if (!res.ok) {
    // 429 is CoinGecko's normal reaction to the free tier under load; degrade to
    // no crypto points this run rather than throw and lose the stock leg too.
    console.warn(`[prices] CoinGecko returned HTTP ${res.status}`);
    return [];
  }

  let body: CoinGeckoResponse;
  try {
    body = (await res.json()) as CoinGeckoResponse;
  } catch (err) {
    console.warn(`[prices] CoinGecko returned unparseable JSON: ${(err as Error).message}`);
    return [];
  }

  const points: PricePoint[] = [];
  for (const c of crypto) {
    const entry = body[c.coingeckoId];
    if (!entry || typeof entry.usd !== 'number') continue;
    points.push({ symbol: c.symbol, price: entry.usd, change24h: entry.usd_24h_change });
  }
  return points;
}

/**
 * Isolated on purpose (ADR 0002 Consequences: "Yahoo's unofficial endpoint can
 * change"). Returns [] with zero network requests when the watchlist is empty,
 * which is the whole v1 case (stocks deliberately empty, GOAL.md).
 */
async function fetchStocks(ctx: SourceCtx): Promise<PricePoint[]> {
  const stocks = ctx.config.stocks;
  if (stocks.length === 0) return [];

  const points: PricePoint[] = [];
  for (const ticker of stocks) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2d&interval=1d`;
      const res = await fetch(url, { signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs) });
      if (!res.ok) {
        console.warn(`[prices] Yahoo returned HTTP ${res.status} for ${ticker}`);
        continue;
      }
      const json = (await res.json()) as {
        chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number } }> };
      };
      const meta = json.chart?.result?.[0]?.meta;
      if (!meta || typeof meta.regularMarketPrice !== 'number') continue;
      const price = meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose;
      const change24h =
        typeof prevClose === 'number' && prevClose !== 0
          ? ((price - prevClose) / prevClose) * 100
          : undefined;
      points.push({ symbol: ticker, price, change24h });
    } catch (err) {
      // One bad ticker (or a Yahoo shape change) must never take down the rest.
      console.warn(`[prices] Yahoo fetch failed for ${ticker}: ${(err as Error).message}`);
    }
  }
  return points;
}

/** Resolves the 24h change, falling back to a DB snapshot when the API omits it. */
async function resolveChange(point: PricePoint): Promise<number | null> {
  if (typeof point.change24h === 'number') return point.change24h;
  const prior = await getPriceAt(point.symbol, 24);
  if (prior === null || prior === 0) return null;
  return ((point.price - prior) / prior) * 100;
}

function toRawItem(point: PricePoint, change: number, coinUrl: string | undefined): RawItem {
  const direction = change >= 0 ? 'up' : 'down';
  const sign = change >= 0 ? '+' : '';
  const day = new Date().toISOString().slice(0, 10);
  const price = point.price.toLocaleString('en-US', { maximumFractionDigits: 2 });

  return {
    source: 'prices',
    // Stable within a run (same symbol/day/direction) so re-running the source
    // the same day never duplicates the alert, but changes if the move flips
    // direction later the same day.
    externalId: `price-${point.symbol}-${day}-${direction}`,
    laneHint: 'markets',
    url: coinUrl ?? `https://www.coingecko.com/en`,
    title: `${point.symbol} ${sign}${change.toFixed(1)}% in 24h to $${price}`,
    body: `${point.symbol} is at $${price}, ${sign}${change.toFixed(1)}% over the last 24 hours.`,
    publishedAt: new Date(),
  };
}

export const prices: Source = {
  name: 'prices',
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    if (ctx.lanes && !ctx.lanes.includes('markets')) return [];

    try {
      const [cryptoPoints, stockPoints] = await Promise.all([fetchCrypto(ctx), fetchStocks(ctx)]);
      const points = [...cryptoPoints, ...stockPoints];

      // The snapshot history is what makes move detection possible once the API's
      // own 24h figure is unavailable, so every fetched price gets written --
      // whether or not it moved, and even if we later fail to emit an item.
      if (points.length > 0) {
        try {
          await insertPriceSnapshots(points.map((p) => ({ symbol: p.symbol, price: p.price })));
        } catch (err) {
          console.warn(`[prices] failed to write snapshots: ${(err as Error).message}`);
        }
      }

      const coinGeckoUrlById = new Map(ctx.config.crypto.map((c) => [c.symbol, c.coingeckoId]));

      const items: RawItem[] = [];
      for (const point of points) {
        let change: number | null;
        try {
          change = await resolveChange(point);
        } catch (err) {
          console.warn(`[prices] failed to resolve change for ${point.symbol}: ${(err as Error).message}`);
          continue;
        }
        if (change === null || Math.abs(change) <= ctx.config.priceMovePct) continue;

        const coingeckoId = coinGeckoUrlById.get(point.symbol);
        const coinUrl = coingeckoId ? `https://www.coingecko.com/en/coins/${coingeckoId}` : undefined;
        items.push(toRawItem(point, change, coinUrl));
      }
      return items;
    } catch (err) {
      // Belt-and-braces: every real failure path above already degrades on its
      // own, but a source must never throw and take the whole run down with it.
      console.warn(`[prices] fetch failed: ${(err as Error).message}`);
      return [];
    }
  },
};

export default prices;

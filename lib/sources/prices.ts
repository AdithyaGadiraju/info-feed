/**
 * Price source (ADR 0002, T5): the one source that also writes to the database.
 * Crypto via CoinGecko free `/simple/price` (one request for the whole watchlist,
 * since the free tier is rate-limited per-request, not per-symbol). Stocks via
 * Yahoo Finance's unofficial chart endpoint, isolated in its own function with its
 * own try/catch so a Yahoo break can never take crypto down with it -- that
 * isolation is the explicit point of this module per the ADR.
 */
import { getPriceAt, insertPriceSnapshots } from '../db/queries';
import type { RawItem, Source, SourceCtx } from './types';

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
  /** When the market last traded. Keys the item to that trading day, so a weekend run does not repeat Friday's move. */
  asOf?: Date;
  url?: string;
}

/** Yahoo answers a bare Node fetch with 429 more often than a browser-like one. */
const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36' };

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
 * change"). Returns [] with zero network requests when the watchlist is empty.
 * Fetched in parallel: about 20 symbols in sequence would not fit the source budget.
 */
async function fetchStocks(ctx: SourceCtx): Promise<PricePoint[]> {
  const stocks = ctx.config.stocks;
  if (stocks.length === 0) return [];

  const results = await Promise.all(
    stocks.map(async (ticker): Promise<PricePoint | null> => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`;
        const res = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs) });
        if (!res.ok) {
          console.warn(`[prices] Yahoo returned HTTP ${res.status} for ${ticker}`);
          return null;
        }
        const json = (await res.json()) as {
          chart?: {
            result?: Array<{
              meta?: {
                regularMarketPrice?: number;
                regularMarketChangePercent?: number;
                previousClose?: number;
                regularMarketTime?: number;
              };
              indicators?: { quote?: Array<{ close?: Array<number | null> }> };
            }>;
          };
        };
        const r = json.chart?.result?.[0];
        const meta = r?.meta;
        if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
        const price = meta.regularMarketPrice;
        // The day's own change. `chartPreviousClose` is the close before the whole
        // range, so it would give a multi-day change; the closes series is the fallback.
        let change24h = meta.regularMarketChangePercent;
        if (typeof change24h !== 'number') {
          const closes = (r?.indicators?.quote?.[0]?.close ?? []).filter((c): c is number => typeof c === 'number');
          const prev = typeof meta.previousClose === 'number' ? meta.previousClose : closes[closes.length - 2];
          change24h = typeof prev === 'number' && prev !== 0 ? ((price - prev) / prev) * 100 : undefined;
        }
        const asOf = typeof meta.regularMarketTime === 'number' ? new Date(meta.regularMarketTime * 1000) : undefined;
        return { symbol: ticker, price, change24h, asOf, url: `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}` };
      } catch (err) {
        // One bad ticker (or a Yahoo shape change) must never take down the rest.
        console.warn(`[prices] Yahoo fetch failed for ${ticker}: ${(err as Error).message}`);
        return null;
      }
    }),
  );
  return results.filter((p): p is PricePoint => p !== null);
}

interface ScreenerQuote {
  symbol?: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  marketCap?: number;
  regularMarketTime?: number;
}

/**
 * Big single-stock moves: Yahoo's day gainers and losers screens, kept to large
 * companies. These are the "how did the stock react to the news" stories; the
 * model joins each one to the news item that explains it.
 */
async function fetchMovers(ctx: SourceCtx): Promise<MoverPoint[]> {
  const spec = ctx.config.stockMovers;
  if (!spec) return [];
  const out: MoverPoint[] = [];
  for (const scr of ['day_gainers', 'day_losers']) {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scr}&count=100`;
      const res = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(ctx.config.sourceTimeoutMs) });
      if (!res.ok) {
        console.warn(`[prices] Yahoo screener ${scr} returned HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { finance?: { result?: Array<{ quotes?: ScreenerQuote[] }> } };
      for (const q of json.finance?.result?.[0]?.quotes ?? []) {
        if (!q.symbol || typeof q.regularMarketPrice !== 'number' || typeof q.regularMarketChangePercent !== 'number') continue;
        if ((q.marketCap ?? 0) < spec.minMarketCapB * 1e9) continue;
        if (Math.abs(q.regularMarketChangePercent) < spec.minMovePct) continue;
        out.push({
          symbol: q.symbol,
          name: q.longName ?? q.shortName ?? q.symbol,
          price: q.regularMarketPrice,
          change: q.regularMarketChangePercent,
          marketCapB: Math.round((q.marketCap ?? 0) / 1e9),
          asOf: typeof q.regularMarketTime === 'number' ? new Date(q.regularMarketTime * 1000) : new Date(),
        });
      }
    } catch (err) {
      console.warn(`[prices] Yahoo screener ${scr} failed: ${(err as Error).message}`);
    }
  }
  return out;
}

interface MoverPoint {
  symbol: string;
  name: string;
  price: number;
  change: number;
  marketCapB: number;
  asOf: Date;
}

function moverItem(m: MoverPoint): RawItem {
  const sign = m.change >= 0 ? '+' : '';
  const day = m.asOf.toISOString().slice(0, 10);
  const price = m.price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return {
    source: 'prices',
    externalId: `mover-${m.symbol}-${day}`,
    laneHint: 'markets',
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(m.symbol)}`,
    title: `${m.name} (${m.symbol}) ${sign}${m.change.toFixed(1)}% today to ${price}`,
    body:
      `${m.name} (${m.symbol}), a US-listed company worth about ${m.marketCapB}B, moved ` +
      `${sign}${m.change.toFixed(1)}% in the trading day of ${day} to ${price}.`,
    publishedAt: m.asOf,
  };
}

/** Resolves the 24h change, falling back to a DB snapshot when the API omits it. */
async function resolveChange(point: PricePoint): Promise<number | null> {
  if (typeof point.change24h === 'number') return point.change24h;
  const prior = await getPriceAt(point.symbol, 24);
  if (prior === null || prior === 0) return null;
  return ((point.price - prior) / prior) * 100;
}

function toRawItem(point: PricePoint, change: number, coinUrl: string | undefined, name: string | undefined): RawItem {
  const direction = change >= 0 ? 'up' : 'down';
  const sign = change >= 0 ? '+' : '';
  const day = (point.asOf ?? new Date()).toISOString().slice(0, 10);
  const price = point.price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const label = name ? `${point.symbol} (${name})` : point.symbol;
  const window = point.asOf ? 'in the trading day' : 'in 24h';
  // Crypto is priced in USD; an index is in points, so it gets no currency sign.
  const shown = point.asOf ? price : `${price}`;

  return {
    source: 'prices',
    // Stable within a run (same symbol/day/direction) so re-running the source
    // the same day never duplicates the alert, but changes if the move flips
    // direction later the same day.
    externalId: `price-${point.symbol}-${day}-${direction}`,
    laneHint: 'markets',
    url: coinUrl ?? point.url ?? `https://www.coingecko.com/en`,
    title: `${label} ${sign}${change.toFixed(1)}% ${window} to ${shown}`,
    body: `${label} is at ${shown}, ${sign}${change.toFixed(1)}% ${point.asOf ? `in the trading day of ${day}` : 'over the last 24 hours'}.`,
    publishedAt: point.asOf ?? new Date(),
  };
}

export const prices: Source = {
  name: 'prices',
  // Crypto, about 20 Yahoo symbols in parallel and two screener calls.
  timeoutMs: 45_000,
  async fetch(ctx: SourceCtx): Promise<RawItem[]> {
    if (ctx.lanes && !ctx.lanes.includes('markets')) return [];

    try {
      const [cryptoPoints, stockPoints, movers] = await Promise.all([fetchCrypto(ctx), fetchStocks(ctx), fetchMovers(ctx)]);
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
        const bar = ctx.config.priceMovePctBySymbol?.[point.symbol] ?? ctx.config.priceMovePct;
        if (change === null || Math.abs(change) <= bar) continue;

        const coingeckoId = coinGeckoUrlById.get(point.symbol);
        const coinUrl = coingeckoId ? `https://www.coingecko.com/en/coins/${coingeckoId}` : undefined;
        items.push(toRawItem(point, change, coinUrl, ctx.config.priceNames?.[point.symbol]));
      }
      // Single-stock moves skip the snapshot table: the screener changes every
      // day, so a history per symbol would be mostly gaps.
      for (const m of movers) items.push(moverItem(m));
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

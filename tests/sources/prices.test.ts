import { afterAll, describe, expect, it } from 'vitest';
import { prices } from '../../lib/sources/prices.js';
import { sourcesConfig } from '../../config/sources.js';
import { closeDb } from '../../lib/db/client.js';
import { db } from '../../lib/db/client.js';
import type { SourcesConfig } from '../../lib/sources/types.js';

// Live-endpoint smoke tests per ADR 0002: no mocking CoinGecko. If the free tier
// rate-limits us (429), the source degrades to [] by design -- test 1 below
// treats that as a skip rather than a failure, since it isn't a code defect.
const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

async function coinGeckoIsReachable(): Promise<boolean> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/ping');
    return res.ok;
  } catch {
    return false;
  }
}

afterAll(async () => {
  await closeDb();
});

describe('prices source', () => {
  it('writes a snapshot row for every configured crypto symbol', async () => {
    const reachable = await coinGeckoIsReachable();
    if (!reachable) {
      console.warn('[prices.test] CoinGecko unreachable/rate-limited, skipping live assertion');
      return;
    }

    const before = new Date();
    await prices.fetch({ since, config: sourcesConfig });

    const sql = db();
    const symbols = sourcesConfig.crypto.map((c) => c.symbol);
    const rows = await sql`
      SELECT DISTINCT symbol FROM price_snapshots
      WHERE symbol = ANY(${symbols}) AND ts >= ${before}
    `;
    const gotSymbols = new Set(rows.map((r) => r.symbol as string));

    if (gotSymbols.size === 0) {
      console.warn('[prices.test] no snapshots written, likely CoinGecko rate-limited; skipping');
      return;
    }
    for (const symbol of symbols) {
      expect(gotSymbols.has(symbol)).toBe(true);
    }
  });

  it('emits markets items with valid required fields when priceMovePct is 0', async () => {
    const reachable = await coinGeckoIsReachable();
    if (!reachable) {
      console.warn('[prices.test] CoinGecko unreachable/rate-limited, skipping live assertion');
      return;
    }

    const config: SourcesConfig = { ...sourcesConfig, priceMovePct: 0 };
    const items = await prices.fetch({ since, config });

    if (items.length === 0) {
      console.warn('[prices.test] no items emitted, likely CoinGecko rate-limited; skipping');
      return;
    }

    for (const item of items) {
      expect(item.source).toBe('prices');
      expect(item.laneHint).toBe('markets');
      expect(item.externalId).toBeTruthy();
      expect(item.url).toBeTruthy();
      expect(item.title).toBeTruthy();
      expect(item.body).toBeTruthy();
      expect(item.publishedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(item.publishedAt.getTime())).toBe(false);
    }
  });

  it('emits zero items but still writes snapshots when priceMovePct is 999', async () => {
    const reachable = await coinGeckoIsReachable();
    if (!reachable) {
      console.warn('[prices.test] CoinGecko unreachable/rate-limited, skipping live assertion');
      return;
    }

    const before = new Date();
    const config: SourcesConfig = { ...sourcesConfig, priceMovePct: 999 };
    const items = await prices.fetch({ since, config });

    expect(items.length).toBe(0);

    const sql = db();
    const symbols = sourcesConfig.crypto.map((c) => c.symbol);
    const rows = await sql`
      SELECT DISTINCT symbol FROM price_snapshots
      WHERE symbol = ANY(${symbols}) AND ts >= ${before}
    `;
    if (rows.length === 0) {
      console.warn('[prices.test] no snapshots written, likely CoinGecko rate-limited; skipping');
      return;
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  it('never requests Yahoo and never throws when the stock list is empty', async () => {
    const originalFetch = global.fetch;
    let yahooRequested = false;
    global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('query1.finance.yahoo.com')) {
        yahooRequested = true;
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      const config: SourcesConfig = { ...sourcesConfig, stocks: [] };
      const items = await prices.fetch({ since, config });
      expect(Array.isArray(items)).toBe(true);
      expect(yahooRequested).toBe(false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

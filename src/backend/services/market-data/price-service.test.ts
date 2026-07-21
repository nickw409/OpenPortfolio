import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, closeDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { createLogger } from '@backend/lib/logger';

import { type Fetcher, centsFromDollars, isoDateString } from './types';
import { PriceService } from './price-service';

const logger = createLogger({ level: 'silent' });

function today(): Date {
  return new Date();
}

function yesterday(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function makeFetcher(response: unknown): Fetcher {
  return async () => ({ ok: true, status: 200, json: async () => response });
}

function yahooChartResponse(quotes: { date: string; close: number }[]): unknown {
  const timestamps = quotes.map((q) => new Date(`${q.date}T00:00:00Z`).getTime() / 1000);
  const adjclose = quotes.map((q) => q.close);
  return {
    chart: {
      result: [
        {
          timestamp: timestamps,
          indicators: { adjclose: [adjclose] },
        },
      ],
      error: null,
    },
  };
}

describe('PriceService', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-price-test-'));
    db = createDb(join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    db.$client
      .prepare(
        "INSERT INTO securities (symbol, exchange, asset_class, currency_code, created_at, updated_at) VALUES ('AAPL', 'NASDAQ', 'equity', 'USD', ?, ?)",
      )
      .run(Date.now(), Date.now());
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a fresh quote from the provider and caches it', async () => {
    const d = isoDateString(today());
    let fetched = 0;
    const fetcher: Fetcher = async () => {
      fetched++;
      return {
        ok: true,
        status: 200,
        json: async () => yahooChartResponse([{ date: d, close: 175.25 }]),
      };
    };
    const service = PriceService.fromConfig(db, logger, { kind: 'yahoo' }, fetcher);
    const result = await service.getLatestPrice(1, { symbol: 'AAPL' });
    expect(result.quote?.close_cents).toBe(centsFromDollars(175.25));
    expect(result.warning).toBeNull();
    expect(fetched).toBe(1);

    // Second call uses cache without invoking fetcher again.
    const cached = await service.getLatestPrice(1, { symbol: 'AAPL' });
    expect(cached.quote?.close_cents).toBe(centsFromDollars(175.25));
    expect(fetched).toBe(1);
  });

  it('warns when no provider is configured and returns null', async () => {
    const service = new PriceService({ db, logger, provider: null });
    const result = await service.getLatestPrice(1, { symbol: 'AAPL' });
    expect(result.quote).toBeNull();
    expect(result.warning?.code).toBe('price.no_provider');
  });

  it('upserts a manual price and reads it back', async () => {
    const service = new PriceService({ db, logger, provider: null });
    const d = isoDateString(today());
    const quote = await service.setManualPrice(1, new Date(d), centsFromDollars(100));
    expect(quote.source).toBe('manual');
    const result = await service.getLatestPrice(1, { symbol: 'AAPL' });
    expect(result.quote?.source).toBe('manual');
  });

  it('respects the Polygon provider and parses aggregate response', async () => {
    const d = today();
    const d2 = yesterday();
    const response = {
      ticker: 'AAPL',
      status: 'OK',
      queryCount: 2,
      results_count: 2,
      results: [
        { t: d2.getTime(), c: 174.0 },
        { t: d.getTime(), c: 175.0 },
      ],
    };
    const service = PriceService.fromConfig(
      db,
      logger,
      { kind: 'polygon', apiKey: 'test-key' },
      makeFetcher(response),
    );
    const result = await service.getLatestPrice(1, { symbol: 'AAPL' });
    expect(result.quote?.close_cents).toBe(centsFromDollars(175.0));
  });

  it('fills missing history dates from the provider', async () => {
    const d2 = isoDateString(yesterday());
    const d = isoDateString(today());
    const quotes = [
      { date: d2, close: 174.0 },
      { date: d, close: 175.0 },
    ];
    const service = PriceService.fromConfig(
      db,
      logger,
      { kind: 'yahoo' },
      makeFetcher(yahooChartResponse(quotes)),
    );
    const result = await service.getPriceHistory(1, {
      from: new Date(d2),
      to: new Date(d),
    });
    expect(result.fullyCovered).toBe(true);
    expect(result.quotes).toHaveLength(2);
  });
});

describe('YahooProvider', () => {
  it('parses a chart response into PriceQuote objects', async () => {
    const { YahooProvider } = await import('./providers/yahoo');
    const d2 = isoDateString(yesterday());
    const d = isoDateString(today());
    const fetcher = makeFetcher(
      yahooChartResponse([
        { date: d2, close: 174.5 },
        { date: d, close: 175.5 },
      ]),
    );
    const provider = new YahooProvider(fetcher);
    const history = await provider.getHistory('AAPL', {
      from: new Date(d2),
      to: new Date(d),
    });
    expect(history).toHaveLength(2);
    expect(history[0]?.close_cents).toBe(centsFromDollars(174.5));
    expect(history[history.length - 1]?.close_cents).toBe(centsFromDollars(175.5));
  });
});

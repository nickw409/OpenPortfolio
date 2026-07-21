import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, closeDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { createServerState, type ServerState } from '@backend/lib/server-state';
import { centsFromDollars, type Fetcher } from '@backend/services/market-data/types';

import { createPricesRoute } from './prices';

function yahooChartResponse(quotes: { date: string; close: number }[]): unknown {
  const timestamps = quotes.map((q) => new Date(`${q.date}T00:00:00Z`).getTime() / 1000);
  const adjclose = quotes.map((q) => q.close);
  return {
    chart: {
      result: [{ timestamp: timestamps, indicators: { adjclose: [adjclose] } }],
      error: null,
    },
  };
}

describe('Prices route', () => {
  let tmpDir: string;
  let db: Db;
  let state: ServerState;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-prices-route-'));
    db = createDb(join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    db.$client
      .prepare(
        "INSERT INTO securities (symbol, exchange, asset_class, currency_code, created_at, updated_at) VALUES ('AAPL', 'NASDAQ', 'equity', 'USD', ?, ?)",
      )
      .run(Date.now(), Date.now());
    state = createServerState();
    state.phase = 'ready';
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mountApp(fetcher?: Fetcher): Hono {
    const app = new Hono();
    app.route(
      '/api/v1/prices',
      createPricesRoute({ db, state, config: { kind: 'yahoo' }, fetcher }),
    );
    return app;
  }

  it('GET /:security_id returns the latest cached price', async () => {
    const d = new Date().toISOString().slice(0, 10);
    const fetcher: Fetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => yahooChartResponse([{ date: d, close: 180 }]),
    });
    const res = await mountApp(fetcher).request('/api/v1/prices/1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quote: { close_cents: number } };
    expect(body.quote.close_cents).toBe(centsFromDollars(180));
  });

  it('POST /manual stores a manual price', async () => {
    const res = await mountApp().request('/api/v1/prices/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ security_id: 1, date: '2026-07-21', close_cents: 12345 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quote: { source: string; close_cents: number } };
    expect(body.quote.source).toBe('manual');
    expect(body.quote.close_cents).toBe(12345);
  });
});

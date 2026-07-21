import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { createErrorHandler } from '@backend/lib/error-handler';
import { logger } from '@backend/lib/logger';
import { runMigrations } from '@backend/db/migrate';
import { accounts } from '@backend/db/schema';

import { createTransactionsRoute } from './transactions';

const buy = {
  account_id: 1,
  transaction_type: 'buy',
  symbol: 'AAPL',
  transaction_date: '2020-01-02T00:00:00.000Z',
  quantity: 10,
  price_cents: 15000,
  amount_cents: 150000,
};

describe('transactions routes', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-rtx-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  function app(): Hono {
    const a = new Hono();
    a.onError(createErrorHandler(logger));
    a.route('/api/v1/transactions', createTransactionsRoute({ db }));
    return a;
  }

  const post = (body: unknown) => app().request('/api/v1/transactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('POST creates a transaction and returns warnings array', async () => {
    const res = await post(buy);
    expect(res.status).toBe(201);
    const body = await res.json() as { transaction: { id: number }; warnings: unknown[] };
    expect(body.transaction.id).toBeGreaterThan(0);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it('POST over-sell returns 409 with the typed code', async () => {
    await post(buy);
    const res = await post({
      ...buy,
      transaction_type: 'sell',
      quantity: 50,
      transaction_date: '2020-02-01T00:00:00.000Z',
    });
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('ingestion.sell_exceeds_holdings');
  });

  it('GET lists transactions', async () => {
    await post(buy);
    const res = await app().request('/api/v1/transactions?account_id=1');
    expect((await res.json() as { transactions: unknown[] }).transactions).toHaveLength(1);
  });
});

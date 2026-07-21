import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { createErrorHandler } from '@backend/lib/error-handler';
import { logger } from '@backend/lib/logger';
import { runMigrations } from '@backend/db/migrate';
import { accounts } from '@backend/db/schema';

import { createImportRoute } from './import';

const mapping = {
  transaction_date: 'D',
  transaction_type: 'T',
  symbol: 'S',
  quantity: 'Q',
  price: 'P',
  amount: 'A',
};
const text = ['D,T,S,Q,P,A', '2020-01-02,buy,AAPL,10,150.00,1500.00'].join('\n');

describe('import routes', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-rimp-'));
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
    a.route('/api/v1/import', createImportRoute({ db }));
    return a;
  }

  it('preview returns per-row results', async () => {
    const res = await app().request('/api/v1/import/csv/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, account_id: 1, mapping }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { summary: { total: number } }).summary.total).toBe(1);
  });

  it('commit inserts accepted rows', async () => {
    const res = await app().request('/api/v1/import/csv/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, account_id: 1, mapping, accepted_indexes: [0] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inserted: number }).inserted).toBe(1);
  });
});

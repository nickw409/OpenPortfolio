import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '@backend/db/client';
import * as schema from '@backend/db/schema';
import { createAccountsRoute } from './accounts';

describe('GET /api/v1/accounts', () => {
  let db: Db;

  beforeEach(() => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite, { schema }) as Db;
    migrate(db, { migrationsFolder: resolve(__dirname, '../../../migrations') });
  });

  afterEach(() => {
    db.$client.close();
  });

  it('returns an empty list when no accounts exist', async () => {
    const app = createAccountsRoute({ db });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ accounts: [] });
  });

  it('returns active accounts and excludes soft-deleted ones', async () => {
    const now = new Date();
    db.insert(schema.accounts)
      .values([
        {
          name: 'Active 1',
          broker: 'Fidelity',
          tax_treatment: 'taxable',
          cost_basis_method: 'fifo',
          currency_code: 'USD',
          created_at: now,
          updated_at: now,
          deleted_at: null,
        },
        {
          name: 'Active 2',
          broker: null,
          tax_treatment: 'tax_deferred',
          cost_basis_method: 'lifo',
          currency_code: 'USD',
          created_at: now,
          updated_at: now,
          deleted_at: null,
        },
        {
          name: 'Deleted',
          broker: 'Schwab',
          tax_treatment: 'taxable',
          cost_basis_method: 'fifo',
          currency_code: 'USD',
          created_at: now,
          updated_at: now,
          deleted_at: now,
        },
      ])
      .run();

    const app = createAccountsRoute({ db });
    const res = await app.request('/');
    const body = (await res.json()) as { accounts: Array<{ name: string; broker: string | null }> };
    expect(res.status).toBe(200);
    expect(body.accounts).toHaveLength(2);
    expect(body.accounts.map((a) => a.name).sort()).toEqual(['Active 1', 'Active 2']);
    expect(body.accounts.find((a) => a.name === 'Active 2')?.broker).toBeNull();
  });

  it('maps DB snake_case columns to camelCase wire shape', async () => {
    const now = new Date();
    db.insert(schema.accounts)
      .values({
        name: 'Test',
        broker: null,
        tax_treatment: 'taxable',
        cost_basis_method: 'fifo',
        currency_code: 'USD',
        created_at: now,
        updated_at: now,
        deleted_at: null,
      })
      .run();

    const app = createAccountsRoute({ db });
    const res = await app.request('/');
    const body = (await res.json()) as { accounts: Array<Record<string, unknown>> };
    const a = body.accounts[0];
    expect(a).toMatchObject({
      name: 'Test',
      broker: null,
      taxTreatment: 'taxable',
      costBasisMethod: 'fifo',
      currencyCode: 'USD',
    });
    expect(typeof a?.createdAt).toBe('string');
    // No snake_case leakage
    expect(a).not.toHaveProperty('tax_treatment');
    expect(a).not.toHaveProperty('cost_basis_method');
    expect(a).not.toHaveProperty('currency_code');
  });
});

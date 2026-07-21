import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pino, { type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createDb, type Db } from '@backend/db/client';
import * as schema from '@backend/db/schema';
import { createErrorHandler } from '@backend/lib/error-handler';
import { logger } from '@backend/lib/logger';
import { runMigrations } from '@backend/db/migrate';

import { createAccountsRoute } from './accounts';

function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

describe('GET /api/v1/accounts (main wire schema)', () => {
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
    const a = body.accounts[0]!;
    expect(a).toMatchObject({
      name: 'Test',
      broker: null,
      taxTreatment: 'taxable',
      costBasisMethod: 'fifo',
      currencyCode: 'USD',
    });
    expect(typeof a.createdAt).toBe('string');
    // No snake_case leakage
    expect(a).not.toHaveProperty('tax_treatment');
    expect(a).not.toHaveProperty('cost_basis_method');
    expect(a).not.toHaveProperty('currency_code');
  });

  it('surfaces response-schema drift as a 500 internal error, not a 400', async () => {
    const now = new Date();
    db.insert(schema.accounts)
      .values({
        name: 'Drifted',
        broker: null,
        tax_treatment: 'not_a_real_enum_value',
        cost_basis_method: 'fifo',
        currency_code: 'USD',
        created_at: now,
        updated_at: now,
        deleted_at: null,
      })
      .run();

    // The route itself has no onError handler (that's wired at the top-level
    // app in index.ts) — mount it under a parent app with the real error
    // handler so the response envelope matches production.
    const app = new Hono();
    app.onError(createErrorHandler(silentLogger()));
    app.route('/', createAccountsRoute({ db }));

    const res = await app.request('/');
    const body = (await res.json()) as { code: string };
    expect(res.status).toBe(500);
    expect(body.code).toBe('internal.unknown');
  });
});

describe('accounts routes CRUD', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-racct-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  function app(): Hono {
    const a = new Hono();
    a.onError(createErrorHandler(logger));
    a.route('/api/v1/accounts', createAccountsRoute({ db }));
    return a;
  }

  it('POST creates and GET lists', async () => {
    const post = await app().request('/api/v1/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Brokerage', tax_treatment: 'taxable' }),
    });
    expect(post.status).toBe(201);
    const list = await app().request('/api/v1/accounts');
    const body = (await list.json()) as { accounts: { name: string }[] };
    expect(body.accounts.map((x) => x.name)).toContain('Brokerage');
  });

  it('rejects an invalid tax treatment with a 400 envelope', async () => {
    const res = await app().request('/api/v1/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', tax_treatment: 'roth' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('validation.invalid_input');
  });
});

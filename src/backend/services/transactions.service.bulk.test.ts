import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, transaction_tags, transactions } from '@backend/db/schema';

import { createTag } from './tags.service';
import { bulkRetag, bulkSoftDelete, createTransaction } from './transactions.service';

const buy = {
  account_id: 1,
  transaction_type: 'buy',
  symbol: 'AAPL',
  transaction_date: '2020-01-02T00:00:00.000Z',
  quantity: 10,
  price_cents: 15000,
  amount_cents: 150000,
};

describe('bulk operations', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-bulk-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('bulk soft-deletes standalone deposits', () => {
    const a = createTransaction(db, {
      account_id: 1,
      transaction_type: 'deposit',
      transaction_date: '2020-01-02T00:00:00.000Z',
      amount_cents: 1000,
    }).transaction;
    const b = createTransaction(db, {
      account_id: 1,
      transaction_type: 'deposit',
      transaction_date: '2020-01-03T00:00:00.000Z',
      amount_cents: 2000,
    }).transaction;
    bulkSoftDelete(db, [a.id, b.id]);
    expect(
      db
        .select()
        .from(transactions)
        .all()
        .every((t) => t.deleted_at !== null),
    ).toBe(true);
  });

  it('bulk retag adds and removes tag links', () => {
    const t = createTransaction(db, buy).transaction;
    createTag(db, { name: 'Core' });
    bulkRetag(db, { ids: [t.id], add: [1], remove: [] });
    expect(db.select().from(transaction_tags).all()).toHaveLength(1);
    bulkRetag(db, { ids: [t.id], add: [], remove: [1] });
    expect(db.select().from(transaction_tags).all()).toHaveLength(0);
  });

  it('bulk delete is all-or-nothing (an over-sell in the set rolls back the whole batch)', () => {
    const b = createTransaction(db, buy).transaction;
    const s = createTransaction(db, {
      ...buy,
      transaction_type: 'sell',
      quantity: 8,
      transaction_date: '2020-03-01T00:00:00.000Z',
    }).transaction;
    expect(() => bulkSoftDelete(db, [b.id, s.id])).toThrow(/exceed/i);
    expect(
      db
        .select()
        .from(transactions)
        .all()
        .every((t) => t.deleted_at === null),
    ).toBe(true);
  });
});

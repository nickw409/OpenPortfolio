import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, audit_log, transactions } from '@backend/db/schema';

import { createTransaction, editTransaction, softDeleteTransaction } from './transactions.service';

const buy = {
  account_id: 1,
  transaction_type: 'buy',
  symbol: 'AAPL',
  transaction_date: '2020-01-02T00:00:00.000Z',
  quantity: 10,
  price_cents: 15000,
  amount_cents: 150000,
};

describe('editTransaction / softDeleteTransaction', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-txe-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('updates quantity in place and writes an update audit row with before/after', () => {
    const { transaction } = createTransaction(db, buy);
    const { transaction: edited } = editTransaction(db, transaction.id, { quantity: 12 });
    expect(edited.quantity).toBe(12);
    const audits = db.select().from(audit_log).all();
    expect(audits.some((a) => a.action === 'update')).toBe(true);
    const upd = audits.find((a) => a.action === 'update')!;
    expect(JSON.parse(upd.before_json!).quantity).toBe(10);
    expect(JSON.parse(upd.after_json!).quantity).toBe(12);
  });

  it('rejects an edit that would over-sell', () => {
    const { transaction: b } = createTransaction(db, buy);
    createTransaction(db, {
      ...buy,
      transaction_type: 'sell',
      quantity: 6,
      transaction_date: '2020-03-01T00:00:00.000Z',
    });
    expect(() => editTransaction(db, b.id, { quantity: 4 })).toThrow(/exceed/i);
  });

  it('soft-deletes and records a delete audit row', () => {
    const { transaction } = createTransaction(db, buy);
    softDeleteTransaction(db, transaction.id);
    const row = db.select().from(transactions).all()[0]!;
    expect(row.deleted_at).not.toBeNull();
    expect(db.select().from(audit_log).all().some((a) => a.action === 'delete')).toBe(true);
  });

  it('rejects deleting a buy that strands a later sell', () => {
    const { transaction: b } = createTransaction(db, buy);
    createTransaction(db, {
      ...buy,
      transaction_type: 'sell',
      quantity: 8,
      transaction_date: '2020-03-01T00:00:00.000Z',
    });
    expect(() => softDeleteTransaction(db, b.id)).toThrow(/exceed/i);
  });

  it('throws transaction_not_found for an unknown id', () => {
    expect(() => editTransaction(db, 999, { quantity: 1 })).toThrow(/not_found|not found/i);
  });
});

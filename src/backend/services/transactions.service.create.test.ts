import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, audit_log, transactions } from '@backend/db/schema';

import { createTransaction } from './transactions.service';

function seed(db: Db) {
  db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
}

const buy = {
  account_id: 1,
  transaction_type: 'buy',
  symbol: 'AAPL',
  transaction_date: '2020-01-02T00:00:00.000Z',
  quantity: 10,
  price_cents: 15000,
  amount_cents: 150000,
};

describe('createTransaction', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-txc-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    seed(db);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts a buy, creates the security, and writes an audit row', () => {
    const { transaction, warnings } = createTransaction(db, buy);
    expect(transaction.id).toBeGreaterThan(0);
    expect(transaction.security_id).toBe(1);
    expect(warnings).toHaveLength(0);
    expect(db.select().from(audit_log).all()).toHaveLength(1);
  });

  it('warns (non-blocking) on a same-day identical duplicate', () => {
    createTransaction(db, buy);
    const { warnings } = createTransaction(db, buy);
    expect(warnings.map((w: { code: string }) => w.code)).toContain('duplicate');
    expect(db.select().from(transactions).all()).toHaveLength(2);
  });

  it('rejects a sell that exceeds holdings', () => {
    createTransaction(db, buy);
    expect(() => createTransaction(db, {
      ...buy,
      transaction_type: 'sell',
      quantity: 25,
      transaction_date: '2020-02-01T00:00:00.000Z',
    })).toThrow(/sell_exceeds_holdings|exceed/i);
  });

  it('rejects a backdated sell that strands a later sell', () => {
    createTransaction(db, buy);
    createTransaction(db, {
      ...buy,
      transaction_type: 'sell',
      quantity: 8,
      transaction_date: '2020-03-01T00:00:00.000Z',
    });
    expect(() => createTransaction(db, {
      ...buy,
      transaction_type: 'sell',
      quantity: 5,
      transaction_date: '2020-02-01T00:00:00.000Z',
    })).toThrow(/exceed/i);
  });

  it('skips engine validation for a dividend', () => {
    const { transaction } = createTransaction(db, {
      account_id: 1,
      transaction_type: 'dividend',
      symbol: 'AAPL',
      transaction_date: '2020-02-01T00:00:00.000Z',
      amount_cents: 4200,
    });
    expect(transaction.transaction_type).toBe('dividend');
  });

  it('throws account_not_found for a missing account', () => {
    expect(() => createTransaction(db, { ...buy, account_id: 999 })).toThrow(/account_not_found|not found/i);
  });
});

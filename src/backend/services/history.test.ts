import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, securities, transactions } from '@backend/db/schema';
import { ofCents } from '@shared/money';

import { loadTxHistory } from './history';

describe('loadTxHistory', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-hist-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
    db.insert(securities)
      .values({ symbol: 'AAPL', exchange: 'UNKNOWN', asset_class: 'equity' })
      .run();
    db.insert(transactions)
      .values({
        account_id: 1,
        security_id: 1,
        transaction_type: 'buy',
        transaction_date: new Date('2020-01-02'),
        quantity: 10,
        price_cents: ofCents(15000),
        amount_cents: ofCents(150000),
      })
      .run();
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('maps active rows to engine Tx shape', () => {
    const txs = loadTxHistory(db, 1, 1);
    expect(txs).toHaveLength(1);
    const tx = txs[0]!;
    expect(tx.transaction_type).toBe('buy');
    expect(tx.quantity).toBe(10);
    expect(tx.amount_cents).toBe(150000);
    expect(tx.transaction_date).toBeInstanceOf(Date);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, securities, transactions } from '@backend/db/schema';
import { ofCents } from '@shared/money';

import { dedupKey, findDuplicates } from './dedup';

const fields = {
  transaction_date: new Date('2020-01-02T14:30:00Z'),
  security_id: 1,
  quantity: 10,
  price_cents: 15000,
  account_id: 1,
};

describe('dedupKey', () => {
  it('reduces the timestamp to a calendar day (same day → same key)', () => {
    const a = dedupKey(fields);
    const b = dedupKey({ ...fields, transaction_date: new Date('2020-01-02T23:59:00Z') });
    expect(a).toBe(b);
  });

  it('differs when any material field differs', () => {
    expect(dedupKey(fields)).not.toBe(dedupKey({ ...fields, quantity: 11 }));
  });
});

describe('findDuplicates', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-dup-'));
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
        transaction_date: new Date('2020-01-02T09:00:00Z'),
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

  it('finds a same-day identical row', () => {
    expect(findDuplicates(db, fields)).toHaveLength(1);
  });

  it('does not match a different quantity', () => {
    expect(findDuplicates(db, { ...fields, quantity: 99 })).toHaveLength(0);
  });
});

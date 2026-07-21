import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, transactions } from '@backend/db/schema';

import { commitImport, previewImport } from './import.service';

const mapping = { transaction_date: 'D', transaction_type: 'T', symbol: 'S', quantity: 'Q', price: 'P', amount: 'A' };
const csv = [
  'D,T,S,Q,P,A',
  '2020-01-02,buy,AAPL,10,150.00,1500.00',
  '2020-02-01,sell,AAPL,4,160.00,640.00',
].join('\n');

describe('CSV import', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-imp-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('preview reports per-row status and writes nothing', () => {
    const preview = previewImport(db, { text: csv, accountId: 1, mapping });
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows.every((r: { status: string }) => r.status !== 'error')).toBe(true);
    expect(preview.rows[0]?.isNewSecurity).toBe(true);
    expect(db.select().from(transactions).all()).toHaveLength(0);
  });

  it('preview flags an over-selling row as error', () => {
    const bad = ['D,T,S,Q,P,A', '2020-01-02,sell,AAPL,5,150.00,750.00'].join('\n');
    const preview = previewImport(db, { text: bad, accountId: 1, mapping });
    expect(preview.rows[0]?.status).toBe('error');
    expect(preview.summary.error).toBe(1);
  });

  it('commit inserts all accepted rows atomically', () => {
    const result = commitImport(db, { text: csv, accountId: 1, mapping, acceptedIndexes: [0, 1] });
    expect(result.inserted).toBe(2);
    expect(result.createdSecurities).toBe(1);
    expect(db.select().from(transactions).all()).toHaveLength(2);
  });

  it('commit rejects the whole batch if an accepted row errors', () => {
    const bad = ['D,T,S,Q,P,A', '2020-01-02,sell,AAPL,5,150.00,750.00'].join('\n');
    expect(() => commitImport(db, { text: bad, accountId: 1, mapping, acceptedIndexes: [0] })).toThrow(/commit_has_errors|error/i);
    expect(db.select().from(transactions).all()).toHaveLength(0);
  });
});

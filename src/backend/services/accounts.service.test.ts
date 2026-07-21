import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, audit_log } from '@backend/db/schema';

import { archiveAccount, createAccount, listAccounts, renameAccount } from './accounts.service';

describe('accounts.service', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-acct-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an account with defaults and audits it', () => {
    const a = createAccount(db, { name: 'Brokerage', tax_treatment: 'taxable' });
    expect(a.cost_basis_method).toBe('fifo');
    expect(
      db
        .select()
        .from(audit_log)
        .all()
        .some((r) => r.action === 'insert'),
    ).toBe(true);
  });

  it('renames and archives (soft-delete removes it from the active list)', () => {
    const a = createAccount(db, { name: 'Old', tax_treatment: 'taxable' });
    renameAccount(db, a.id, { name: 'New' });
    expect(
      db
        .select()
        .from(accounts)
        .where(undefined as never)
        .all()
        .find((r: { id: number; name: string }) => r.id === a.id)?.name,
    ).toBe('New');
    archiveAccount(db, a.id);
    expect(listAccounts(db).find((r: { id: number }) => r.id === a.id)).toBeUndefined();
  });

  it('throws for renaming a missing account', () => {
    expect(() => renameAccount(db, 999, { name: 'x' })).toThrow(/not found|account_not_found/i);
  });
});

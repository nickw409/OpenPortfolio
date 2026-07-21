import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';

import { findSecurityBySymbol, resolveSecurity } from './securities.service';

describe('securities.service', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-sec-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a minimal security when the symbol is new', () => {
    const { security, created } = resolveSecurity(db, 'AAPL');
    expect(created).toBe(true);
    expect(security.symbol).toBe('AAPL');
    expect(security.exchange).toBe('UNKNOWN');
    expect(security.asset_class).toBe('equity');
  });

  it('finds the existing security on a second resolve (symbol-first)', () => {
    const first = resolveSecurity(db, 'AAPL');
    const second = resolveSecurity(db, 'AAPL');
    expect(second.created).toBe(false);
    expect(second.security.id).toBe(first.security.id);
    expect(findSecurityBySymbol(db, 'AAPL')?.id).toBe(first.security.id);
  });

  it('returns undefined from find when the symbol is unknown', () => {
    expect(findSecurityBySymbol(db, 'NOPE')).toBeUndefined();
  });
});

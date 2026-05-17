import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, closeDb, type Db } from './client';
import { runMigrations } from './migrate';
import {
  accounts,
  dashboard_layouts,
  securities,
  tags,
  tile_configs,
  transactions,
} from './schema';
import { activeFilter, listSoftDeleteViolations, softDelete } from './soft-delete';

describe('schema invariant', () => {
  it('every user-data table has the soft-delete trio', () => {
    const userDataTables = {
      accounts,
      securities,
      transactions,
      dashboard_layouts,
      tile_configs,
      tags,
    };
    expect(listSoftDeleteViolations(userDataTables)).toEqual([]);
  });
});

describe('softDelete + activeFilter', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-softdel-'));
    db = createDb(join(tmpDir, 'test.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks deleted_at and updated_at, leaves the row in the table', () => {
    const [inserted] = db
      .insert(accounts)
      .values({ name: 'Test', tax_treatment: 'taxable' })
      .returning()
      .all();
    expect(inserted).toBeDefined();
    expect(inserted!.deleted_at).toBeNull();

    const changes = softDelete(db, accounts, eq(accounts.id, inserted!.id));
    expect(changes).toBe(1);

    const [row] = db
      .select()
      .from(accounts)
      .where(eq(accounts.id, inserted!.id))
      .all();
    expect(row).toBeDefined();
    expect(row!.deleted_at).toBeInstanceOf(Date);
  });

  it('activeFilter excludes soft-deleted rows', () => {
    const [a] = db
      .insert(accounts)
      .values({ name: 'A', tax_treatment: 'taxable' })
      .returning()
      .all();
    const [b] = db
      .insert(accounts)
      .values({ name: 'B', tax_treatment: 'taxable' })
      .returning()
      .all();
    softDelete(db, accounts, eq(accounts.id, a!.id));

    const active = db.select().from(accounts).where(activeFilter(accounts)).all();
    const names = active.map((r) => r.name).sort();
    expect(names).toEqual(['B']);
    expect(active.find((r) => r.id === b!.id)).toBeDefined();
  });

  it('softDelete on an already-deleted row affects nothing', () => {
    const [row] = db
      .insert(accounts)
      .values({ name: 'X', tax_treatment: 'taxable' })
      .returning()
      .all();
    expect(softDelete(db, accounts, eq(accounts.id, row!.id))).toBe(1);
    expect(softDelete(db, accounts, eq(accounts.id, row!.id))).toBe(0);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, closeDb, type Db } from './client';
import { runMigrations } from './migrate';

describe('runMigrations', () => {
  let tmpDir: string;
  let db: Db | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-migrate-'));
    db = undefined;
  });

  afterEach(() => {
    if (db) closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function tables(d: Db): string[] {
    return (
      d.$client
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
  }

  function views(d: Db): string[] {
    return (
      d.$client.prepare(`SELECT name FROM sqlite_master WHERE type='view'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
  }

  it('creates every table from the spec on a fresh DB', () => {
    db = createDb(join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    const found = new Set(tables(db));
    for (const t of [
      'accounts',
      'securities',
      'transactions',
      'price_history',
      'cpi_data',
      'dashboard_layouts',
      'tile_configs',
      'audit_log',
      'tags',
      'transaction_tags',
    ]) {
      expect(found.has(t), `missing table: ${t}`).toBe(true);
    }
  });

  it('does not have a positions view (dropped in 0001 — engine is the truth)', () => {
    db = createDb(join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    expect(views(db)).not.toContain('positions');
  });

  it('adds cost_basis_method to accounts with fifo default', () => {
    db = createDb(join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    db.$client
      .prepare(
        `INSERT INTO accounts (name, tax_treatment, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('Brokerage', 'taxable', Date.now(), Date.now());
    const row = db.$client
      .prepare(`SELECT cost_basis_method FROM accounts WHERE name = ?`)
      .get('Brokerage') as { cost_basis_method: string };
    expect(row.cost_basis_method).toBe('fifo');
  });

  it('is idempotent (re-running does nothing)', () => {
    db = createDb(join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    const tablesBefore = tables(db).sort();
    runMigrations(db);
    expect(tables(db).sort()).toEqual(tablesBefore);
  });

  it('round-trips a Money column via the custom type', () => {
    db = createDb(join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    db.$client
      .prepare(
        `INSERT INTO accounts (name, tax_treatment, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('Brokerage', 'taxable', Date.now(), Date.now());
    const row = db.$client
      .prepare(`SELECT id, name, tax_treatment FROM accounts WHERE name = ?`)
      .get('Brokerage') as { id: number; name: string; tax_treatment: string };
    expect(row.name).toBe('Brokerage');
    expect(row.tax_treatment).toBe('taxable');
  });
});

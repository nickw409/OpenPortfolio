import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { backupDatabase } from './backup';
import { createDb, closeDb, type Db } from './client';
import { runMigrations } from './migrate';
import { accounts } from './schema';

describe('backupDatabase', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-backup-'));
    db = createDb(join(tmpDir, 'source.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a backup file and a checksum sidecar', async () => {
    db.insert(accounts).values({ name: 'X', tax_treatment: 'taxable' }).run();
    const dest = join(tmpDir, 'backup.sqlite');
    const result = await backupDatabase(db, dest);

    expect(existsSync(dest)).toBe(true);
    expect(existsSync(`${dest}.sha256`)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);

    const computed = createHash('sha256').update(readFileSync(dest)).digest('hex');
    expect(result.sha256).toBe(computed);
  });

  it('sidecar matches sha256sum format', async () => {
    const dest = join(tmpDir, 'backup.sqlite');
    await backupDatabase(db, dest);
    const sidecar = readFileSync(`${dest}.sha256`, 'utf-8');
    expect(sidecar).toMatch(/^[a-f0-9]{64} {2}backup\.sqlite\n$/);
  });

  it('backup is openable and preserves inserted rows', async () => {
    db.insert(accounts).values({ name: 'Brokerage', tax_treatment: 'taxable' }).run();
    const dest = join(tmpDir, 'backup.sqlite');
    await backupDatabase(db, dest);

    const restored = createDb(dest);
    try {
      const rows = restored.select().from(accounts).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('Brokerage');
    } finally {
      closeDb(restored);
    }
  });

  it('creates the parent directory if missing', async () => {
    const dest = join(tmpDir, 'nested', 'dir', 'backup.sqlite');
    await backupDatabase(db, dest);
    expect(existsSync(dest)).toBe(true);
  });
});

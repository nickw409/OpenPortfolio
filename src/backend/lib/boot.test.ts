import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import pino, { type Logger } from 'pino';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';

import { runBoot } from './boot';
import { createServerState, type ServerState } from './server-state';

function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

describe('runBoot', () => {
  let tmpDir: string;
  let db: Db;
  let state: ServerState;
  let backupDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-boot-'));
    db = createDb(join(tmpDir, 'test.sqlite'));
    state = createServerState();
    backupDir = join(tmpDir, 'backups');
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies pending migrations and writes a pre-migration backup', async () => {
    await runBoot({ db, state, logger: silentLogger(), backupDir });
    expect(state.phase).toBe('ready');

    // Backup was created (there were pending migrations on a fresh DB).
    const backups = readdirSync(backupDir).filter((f) => f.startsWith('pre-migration-'));
    expect(backups.some((f) => f.endsWith('.sqlite'))).toBe(true);
    expect(backups.some((f) => f.endsWith('.sqlite.sha256'))).toBe(true);

    // Migrations table now exists and is populated.
    const row = db.$client.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get() as {
      c: number;
    };
    expect(row.c).toBeGreaterThan(0);
  });

  it('skips backup + migrate when no migrations are pending', async () => {
    runMigrations(db); // already up-to-date
    await runBoot({ db, state, logger: silentLogger(), backupDir });
    expect(state.phase).toBe('ready');
    expect(existsSync(backupDir)).toBe(false);
  });

  it('prunes backups beyond the retention cap', async () => {
    // Seed fake old backups; ISO-timestamp sort means lexicographic newest-first.
    writeFileSync(join(tmpDir, 'seed'), 'x'); // ensure tmpDir exists
    const mkBackupDir = join(tmpDir, 'backups');
    rmSync(mkBackupDir, { recursive: true, force: true });
    // Create 5 fake backups so the boot's real backup makes 6 total.
    // Retention 3 → expect 3 newest kept.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(mkBackupDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      const ts = `2020-01-0${i + 1}T00-00-00-000Z`;
      writeFileSync(join(mkBackupDir, `pre-migration-${ts}.sqlite`), 'old');
      writeFileSync(join(mkBackupDir, `pre-migration-${ts}.sqlite.sha256`), 'old');
    }

    await runBoot({
      db,
      state,
      logger: silentLogger(),
      backupDir: mkBackupDir,
      retention: 3,
    });

    const remaining = readdirSync(mkBackupDir).filter(
      (f) => f.startsWith('pre-migration-') && f.endsWith('.sqlite'),
    );
    expect(remaining).toHaveLength(3);
    // Newest by lexicographic sort — boot's own backup (timestamp ~now) wins.
    expect(remaining.sort((a, b) => b.localeCompare(a))[0]).toMatch(/^pre-migration-20[2-9]\d-/);
  });

  it('sets state.phase to degraded and rethrows on failure', async () => {
    // Point migrationsDir at a path that doesn't exist → readdir throws.
    const badDir = resolve(tmpDir, 'nope');
    await expect(
      runBoot({ db, state, logger: silentLogger(), backupDir, migrationsDir: badDir }),
    ).rejects.toThrow();
    expect(state.phase).toBe('degraded');
  });
});

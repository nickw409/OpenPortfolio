import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Logger } from 'pino';

import { backupDatabase } from '@backend/db/backup';
import type { Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';

import type { ServerState } from './server-state';

const DEFAULT_BACKUP_DIR = './data/backups';
const DEFAULT_RETENTION = 10;

export interface BootOptions {
  db: Db;
  state: ServerState;
  logger: Logger;
  migrationsDir?: string;
  backupDir?: string;
  retention?: number;
}

export async function runBoot(opts: BootOptions): Promise<void> {
  const { db, state, logger } = opts;
  const backupDir = resolve(
    opts.backupDir ?? process.env.OPENPORTFOLIO_BACKUP_DIR ?? DEFAULT_BACKUP_DIR,
  );
  const retention = opts.retention ?? DEFAULT_RETENTION;

  try {
    const pending = countPendingMigrations(db, opts.migrationsDir);
    if (pending > 0) {
      logger.info({ pending, backupDir }, 'migrations pending, backing up first');
      const backupPath = await createPreMigrationBackup(db, backupDir);
      logger.info({ backupPath }, 'pre-migration backup written');
      pruneOldBackups(backupDir, retention, logger);
      runMigrations(db, opts.migrationsDir);
      logger.info({ applied: pending }, 'migrations applied');
    } else {
      logger.debug('no pending migrations');
    }
    state.phase = 'ready';
  } catch (err) {
    state.phase = 'degraded';
    logger.error({ err }, 'boot failed');
    throw err;
  }
}

function countPendingMigrations(db: Db, migrationsDir: string | undefined): number {
  const dir = migrationsDir ?? resolve(new URL('../../../migrations', import.meta.url).pathname);
  const sqlFiles = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const total = sqlFiles.length;

  let applied = 0;
  try {
    const row = db.$client.prepare('SELECT COUNT(*) AS c FROM __drizzle_migrations').get() as
      | { c: number }
      | undefined;
    applied = row?.c ?? 0;
  } catch {
    // Migrations table doesn't exist yet → 0 applied.
  }

  return Math.max(0, total - applied);
}

async function createPreMigrationBackup(db: Db, backupDir: string): Promise<string> {
  // Filename-safe ISO timestamp: 2026-05-18T23-21-00-123Z
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destPath = resolve(backupDir, `pre-migration-${timestamp}.sqlite`);
  await backupDatabase(db, destPath);
  return destPath;
}

function pruneOldBackups(backupDir: string, retention: number, logger: Logger): void {
  if (!existsSync(backupDir)) return;
  // Filenames embed an ISO timestamp, so lexicographic desc-sort is the
  // newest-first order — no stat() needed.
  const backups = readdirSync(backupDir)
    .filter((f) => f.startsWith('pre-migration-') && f.endsWith('.sqlite'))
    .sort((a, b) => b.localeCompare(a));

  for (const name of backups.slice(retention)) {
    const path = resolve(backupDir, name);
    try {
      unlinkSync(path);
      const sidecar = `${path}.sha256`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
      logger.info({ pruned: name }, 'removed old backup');
    } catch (err) {
      logger.warn({ err, path }, 'failed to prune backup');
    }
  }
}

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import type { Db } from './client';

export interface BackupResult {
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * Snapshot the live database to `destPath` and write `<destPath>.sha256`.
 * Uses better-sqlite3's backup API so WAL contents are included.
 *
 * Sidecar format matches `sha256sum` output so users can verify with
 * `sha256sum -c backup.sqlite.sha256`.
 */
export async function backupDatabase(db: Db, destPath: string): Promise<BackupResult> {
  mkdirSync(dirname(destPath), { recursive: true });
  await db.$client.backup(destPath);
  const bytes = readFileSync(destPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(`${destPath}.sha256`, `${sha256}  ${basename(destPath)}\n`);
  return { path: destPath, sha256, bytes: bytes.length };
}

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const DEFAULT_PATH = './data/openportfolio.sqlite';

export function resolveDbPath(): string {
  return resolve(process.env.OPENPORTFOLIO_DB_PATH ?? DEFAULT_PATH);
}

export function createDb(path: string = resolveDbPath()): Db {
  mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);

  // WAL is required by the architecture: the MCP server reads while the
  // backend writes. journal_mode is persisted in the file header, so this
  // also fixes any DB created in a different mode.
  const journalMode = sqlite.pragma('journal_mode = WAL', { simple: true });
  if (journalMode !== 'wal') {
    sqlite.close();
    throw new Error(`failed to enable WAL mode (got: ${journalMode})`);
  }

  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  return drizzle(sqlite, { schema }) as Db;
}

export function closeDb(db: Db): void {
  db.$client.close();
}

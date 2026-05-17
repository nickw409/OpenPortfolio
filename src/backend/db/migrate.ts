import { migrate as drizzleMigrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createDb, type Db } from './client';

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'migrations',
);

export function runMigrations(db: Db = createDb(), migrationsDir = MIGRATIONS_DIR): void {
  drizzleMigrate(db, { migrationsFolder: migrationsDir });
}

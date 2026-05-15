import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, closeDb, resolveDbPath, type Db } from './client';

describe('createDb', () => {
  let tmpDir: string;
  let db: Db | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-test-'));
    db = undefined;
  });

  afterEach(() => {
    if (db) closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opens a SQLite file at the given path', () => {
    const path = join(tmpDir, 'test.sqlite');
    db = createDb(path);
    expect(existsSync(path)).toBe(true);
  });

  it('enables WAL mode at open', () => {
    db = createDb(join(tmpDir, 'test.sqlite'));
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('enables foreign keys', () => {
    db = createDb(join(tmpDir, 'test.sqlite'));
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('sets busy_timeout to 5000ms', () => {
    db = createDb(join(tmpDir, 'test.sqlite'));
    expect(db.$client.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('creates the parent directory if missing', () => {
    const path = join(tmpDir, 'nested', 'path', 'test.sqlite');
    db = createDb(path);
    expect(existsSync(path)).toBe(true);
  });

  it('preserves WAL mode across reopen', () => {
    const path = join(tmpDir, 'test.sqlite');
    db = createDb(path);
    closeDb(db);
    db = createDb(path);
    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
  });
});

describe('resolveDbPath', () => {
  const originalEnv = process.env.OPENPORTFOLIO_DB_PATH;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OPENPORTFOLIO_DB_PATH;
    else process.env.OPENPORTFOLIO_DB_PATH = originalEnv;
  });

  it('honors OPENPORTFOLIO_DB_PATH when set', () => {
    process.env.OPENPORTFOLIO_DB_PATH = '/custom/place/portfolio.sqlite';
    expect(resolveDbPath()).toBe('/custom/place/portfolio.sqlite');
  });

  it('defaults to ./data/openportfolio.sqlite', () => {
    delete process.env.OPENPORTFOLIO_DB_PATH;
    expect(resolveDbPath().endsWith('data/openportfolio.sqlite')).toBe(true);
  });
});

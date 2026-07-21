import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, closeDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';

import { RateLimiter, PROVIDER_RULES } from './rate-limiter';

describe('RateLimiter', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-rl-test-'));
    db = createDb(join(tmpDir, 'test.sqlite'));
    runMigrations(db);
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows the first request', () => {
    const limiter = new RateLimiter(db);
    const check = limiter.check('yahoo', PROVIDER_RULES.yahoo);
    expect(check.allowed).toBe(true);
  });

  it('blocks a second request within the minimum interval', () => {
    const limiter = new RateLimiter(db);
    limiter.record('yahoo', 'getHistory', new Date(), 'AAPL', true);
    const check = limiter.check('yahoo', PROVIDER_RULES.yahoo);
    expect(check.allowed).toBe(false);
    expect(check.nextAllowedAt).not.toBeNull();
  });

  it('enforces Polygon window caps', () => {
    const limiter = new RateLimiter(db);
    for (let i = 0; i < 5; i++) {
      limiter.record('polygon', 'getHistory', new Date(), 'AAPL', true);
    }
    const check = limiter.check('polygon', PROVIDER_RULES.polygon);
    expect(check.allowed).toBe(false);
    expect(check.windowRemaining).toBe(0);
  });
});

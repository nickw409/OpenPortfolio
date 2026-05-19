import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';

import { createHealthRoute, type HealthResponse } from './health';

describe('GET /api/v1/health', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-health-'));
    db = createDb(join(tmpDir, 'test.sqlite'));
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mountApp(startTimeMs: number): Hono {
    const app = new Hono();
    app.route('/api/v1/health', createHealthRoute({ db, startTimeMs, version: '9.9.9-test' }));
    return app;
  }

  it('returns ok with db_version after migrations have run', async () => {
    runMigrations(db);
    const start = Date.now();
    const res = await mountApp(start).request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.version).toBe('9.9.9-test');
    expect(typeof body.db_version).toBe('string');
    expect((body.db_version ?? '').length).toBeGreaterThan(0);
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  it('returns degraded when the migrations table does not exist', async () => {
    // No runMigrations — __drizzle_migrations does not exist yet.
    const res = await mountApp(Date.now()).request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('degraded');
    expect(body.db_version).toBeNull();
  });
});

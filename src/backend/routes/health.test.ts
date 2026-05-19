import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { createServerState, type ServerState } from '@backend/lib/server-state';

import { createHealthRoute, type HealthResponse } from './health';

describe('GET /api/v1/health', () => {
  let tmpDir: string;
  let db: Db;
  let state: ServerState;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-health-'));
    db = createDb(join(tmpDir, 'test.sqlite'));
    state = createServerState();
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mountApp(): Hono {
    const app = new Hono();
    app.route('/api/v1/health', createHealthRoute({ db, state, version: '9.9.9-test' }));
    return app;
  }

  it('reports migrating while phase is starting', async () => {
    runMigrations(db);
    // state.phase is 'starting' by default — migrations done, but boot
    // hasn't promoted us to 'ready' yet.
    const res = await mountApp().request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('migrating');
  });

  it('reports ok with db_version once phase is ready', async () => {
    runMigrations(db);
    state.phase = 'ready';
    const res = await mountApp().request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.version).toBe('9.9.9-test');
    expect(typeof body.db_version).toBe('string');
    expect((body.db_version ?? '').length).toBeGreaterThan(0);
    expect(body.uptime_ms).toBeGreaterThanOrEqual(0);
  });

  it('reports degraded when migrations table is missing', async () => {
    state.phase = 'ready';
    const res = await mountApp().request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('degraded');
    expect(body.db_version).toBeNull();
  });

  it('reports degraded when phase is shutting_down', async () => {
    runMigrations(db);
    state.phase = 'shutting_down';
    const res = await mountApp().request('/api/v1/health');
    const body = (await res.json()) as HealthResponse;
    expect(body.status).toBe('degraded');
  });
});

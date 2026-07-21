import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, closeDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { createServerState, type ServerState } from '@backend/lib/server-state';

import { createDashboardRoute } from './dashboard';

describe('Dashboard route', () => {
  let tmpDir: string;
  let db: Db;
  let state: ServerState;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openportfolio-dashboard-route-'));
    db = createDb(join(tmpDir, 'test.sqlite'));
    runMigrations(db);
    state = createServerState();
    state.phase = 'ready';
  });

  afterEach(() => {
    closeDb(db);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function app() {
    return createDashboardRoute({ db, state });
  }

  async function createLayout(name: string, isDefault = false): Promise<number> {
    const res = await app().request('/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, is_default: isDefault }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { layout: { id: number } };
    return body.layout.id;
  }

  it('POST /layouts creates a layout', async () => {
    const res = await app().request('/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Overview', is_default: true }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { layout: { name: string; is_default: boolean } };
    expect(body.layout.name).toBe('Overview');
    expect(body.layout.is_default).toBe(true);
  });

  it('GET /layouts lists layouts', async () => {
    await createLayout('A');
    await createLayout('B');
    const res = await app().request('/layouts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layouts: unknown[] };
    expect(body.layouts).toHaveLength(2);
  });

  it('POST /layouts/:id/tiles creates a tile', async () => {
    const layoutId = await createLayout('Overview');
    const res = await app().request(`/layouts/${layoutId}/tiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tile_type: 'positions_table',
        position_json: JSON.stringify({ x: 0, y: 0, w: 12, h: 4 }),
        config_json: JSON.stringify({ accounts: [] }),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tile: { tile_type: string; position: { w: number } } };
    expect(body.tile.tile_type).toBe('positions_table');
    expect(body.tile.position.w).toBe(12);
  });

  it('rejects overlapping tiles', async () => {
    const layoutId = await createLayout('Overview');
    const tile = {
      tile_type: 'positions_table',
      position_json: JSON.stringify({ x: 0, y: 0, w: 12, h: 4 }),
      config_json: '{}',
    };
    const first = await app().request(`/layouts/${layoutId}/tiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tile),
    });
    expect(first.status).toBe(201);
    const second = await app().request(`/layouts/${layoutId}/tiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...tile, tile_type: 'allocation_chart' }),
    });
    expect(second.status).toBe(400);
  });

  it('DELETE /layouts/:id/tiles/:tile_id soft-deletes a tile', async () => {
    const layoutId = await createLayout('Overview');
    const createRes = await app().request(`/layouts/${layoutId}/tiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tile_type: 'positions_table',
        position_json: JSON.stringify({ x: 0, y: 0, w: 12, h: 4 }),
        config_json: '{}',
      }),
    });
    const body = (await createRes.json()) as { tile: { id: number } };
    const res = await app().request(`/layouts/${layoutId}/tiles/${body.tile.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
  });

  it('DELETE /layouts/:id refuses to delete the only layout', async () => {
    const layoutId = await createLayout('Only');
    const res = await app().request(`/layouts/${layoutId}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
  });

  it('POST /layouts/:id/reset restores default tiles', async () => {
    const layoutId = await createLayout('Reset me');
    await app().request(`/layouts/${layoutId}/tiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tile_type: 'positions_table',
        position_json: JSON.stringify({ x: 0, y: 0, w: 12, h: 4 }),
        config_json: '{}',
      }),
    });
    const res = await app().request(`/layouts/${layoutId}/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layout: { tiles: { tile_type: string }[] } };
    expect(body.layout.tiles).toHaveLength(2);
    expect(body.layout.tiles[0]?.tile_type).toBe('positions_table');
    expect(body.layout.tiles[1]?.tile_type).toBe('allocation_chart');
  });
});

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

  async function addTile(
    layoutId: number,
    tileType: string,
    position: { x: number; y: number; w: number; h: number },
  ): Promise<number> {
    const res = await app().request(`/layouts/${layoutId}/tiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tile_type: tileType,
        position_json: JSON.stringify(position),
        config_json: '{}',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tile: { id: number } };
    return body.tile.id;
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

  it('GET /layouts/default auto-seeds an Overview default on a fresh database', async () => {
    const res = await app().request('/layouts/default');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      layout: { name: string; is_default: boolean; tiles: { tile_type: string }[] };
    };
    expect(body.layout.name).toBe('Overview');
    expect(body.layout.is_default).toBe(true);
    expect(body.layout.tiles.map((t) => t.tile_type)).toEqual([
      'positions_table',
      'allocation_chart',
    ]);

    // Idempotent: a second request must not create a second default layout.
    await app().request('/layouts/default');
    const list = (await (await app().request('/layouts')).json()) as { layouts: unknown[] };
    expect(list.layouts).toHaveLength(1);
  });

  it('GET /layouts/default returns the flagged default when one already exists', async () => {
    await createLayout('Scratch');
    const defaultId = await createLayout('Primary', true);
    const res = await app().request('/layouts/default');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layout: { id: number; name: string } };
    expect(body.layout.id).toBe(defaultId);
    expect(body.layout.name).toBe('Primary');
  });

  it('POST /layouts/:id/tiles/reorder swaps two tiles atomically', async () => {
    const layoutId = await createLayout('Overview');
    const a = await addTile(layoutId, 'positions_table', { x: 0, y: 0, w: 6, h: 4 });
    const b = await addTile(layoutId, 'allocation_chart', { x: 6, y: 0, w: 6, h: 4 });

    const res = await app().request(`/layouts/${layoutId}/tiles/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moves: [
          { tile_id: a, position_json: JSON.stringify({ x: 6, y: 0, w: 6, h: 4 }) },
          { tile_id: b, position_json: JSON.stringify({ x: 0, y: 0, w: 6, h: 4 }) },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      layout: { tiles: { id: number; position: { x: number } }[] };
    };
    const byId = new Map(body.layout.tiles.map((t) => [t.id, t.position.x]));
    expect(byId.get(a)).toBe(6);
    expect(byId.get(b)).toBe(0);
  });

  it('POST /layouts/:id/tiles/reorder rejects an arrangement that overlaps', async () => {
    const layoutId = await createLayout('Overview');
    const a = await addTile(layoutId, 'positions_table', { x: 0, y: 0, w: 6, h: 4 });
    const b = await addTile(layoutId, 'allocation_chart', { x: 6, y: 0, w: 6, h: 4 });

    // Move a onto b's cell without moving b -> final arrangement overlaps.
    const res = await app().request(`/layouts/${layoutId}/tiles/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moves: [{ tile_id: a, position_json: JSON.stringify({ x: 6, y: 0, w: 6, h: 4 }) }],
      }),
    });
    expect(res.status).toBe(400);

    // Original positions are unchanged after a rejected reorder.
    const layout = (await (await app().request(`/layouts/${layoutId}`)).json()) as {
      layout: { tiles: { id: number; position: { x: number } }[] };
    };
    const positions = new Map(layout.layout.tiles.map((t) => [t.id, t.position.x]));
    expect(positions.get(a)).toBe(0);
    expect(positions.get(b)).toBe(6);
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

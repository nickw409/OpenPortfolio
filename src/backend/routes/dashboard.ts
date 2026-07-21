import { Hono } from 'hono';
import { z } from 'zod';

import type { Db } from '@backend/db/client';
import type { ServerState } from '@backend/lib/server-state';
import { logger } from '@backend/lib/logger';
import { createErrorHandler } from '@backend/lib/error-handler';
import {
  DashboardError,
  DashboardService,
  parseConfig,
  parsePosition,
} from '@backend/services/dashboard/dashboard-service';

export interface DashboardRouteDeps {
  db: Db;
  state: ServerState;
}

const CreateLayoutSchema = z.object({
  name: z.string().min(1).max(120),
  is_default: z.boolean().default(false),
});

const UpdateLayoutSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  is_default: z.boolean().optional(),
});

const CreateTileSchema = z.object({
  tile_type: z.string().min(1).max(80),
  position_json: z.string(),
  config_json: z.string().default('{}'),
});

const UpdateTileSchema = z.object({
  position_json: z.string().optional(),
  config_json: z.string().optional(),
});

function numericParam(param: string | undefined): number {
  const value = Number(param);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('invalid id');
  }
  return value;
}

export function createDashboardRoute(deps: DashboardRouteDeps): Hono {
  const app = new Hono();
  const service = new DashboardService({ db: deps.db });

  app.get('/layouts', async (c) => {
    const layouts = service.listLayouts();
    return c.json({ layouts });
  });

  app.get('/layouts/:id', async (c) => {
    const id = numericParam(c.req.param('id'));
    const layout = service.getLayout(id);
    return c.json({ layout });
  });

  app.post('/layouts', async (c) => {
    const body = CreateLayoutSchema.parse(await c.req.json());
    const layout = service.createLayout(body.name, body.is_default);
    return c.json({ layout }, 201);
  });

  app.patch('/layouts/:id', async (c) => {
    const id = numericParam(c.req.param('id'));
    const body = UpdateLayoutSchema.parse(await c.req.json());
    const layout = service.updateLayout(id, body);
    return c.json({ layout });
  });

  app.delete('/layouts/:id', async (c) => {
    const id = numericParam(c.req.param('id'));
    service.deleteLayout(id);
    return c.body(null, 204);
  });

  app.post('/layouts/:id/tiles', async (c) => {
    const layoutId = numericParam(c.req.param('id'));
    const body = CreateTileSchema.parse(await c.req.json());
    const tile = service.addTile(
      layoutId,
      body.tile_type,
      parsePosition(body.position_json),
      parseConfig(body.config_json),
    );
    return c.json({ tile }, 201);
  });

  app.patch('/layouts/:id/tiles/:tile_id', async (c) => {
    const layoutId = numericParam(c.req.param('id'));
    const tileId = numericParam(c.req.param('tile_id'));
    const body = UpdateTileSchema.parse(await c.req.json());
    const tile = service.updateTile(layoutId, tileId, {
      position: body.position_json ? parsePosition(body.position_json) : undefined,
      config: body.config_json ? parseConfig(body.config_json) : undefined,
    });
    return c.json({ tile });
  });

  app.delete('/layouts/:id/tiles/:tile_id', async (c) => {
    const layoutId = numericParam(c.req.param('id'));
    const tileId = numericParam(c.req.param('tile_id'));
    service.deleteTile(layoutId, tileId);
    return c.body(null, 204);
  });

  app.post('/layouts/:id/reset', async (c) => {
    const id = numericParam(c.req.param('id'));
    const layout = service.resetLayout(id);
    return c.json({ layout });
  });

  app.onError((err, c) => {
    if (err instanceof DashboardError) {
      return c.json(err.toEnvelope(), err.status as 400 | 404 | 409);
    }
    return createErrorHandler(logger)(err, c);
  });
  return app;
}

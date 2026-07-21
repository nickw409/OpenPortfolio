import { Hono } from 'hono';
import { z } from 'zod';

import type { Db } from '@backend/db/client';
import type { ServerState } from '@backend/lib/server-state';
import { logger } from '@backend/lib/logger';
import { CpiService } from '@backend/services/market-data/cpi-service';
import { createErrorHandler } from '@backend/lib/error-handler';

export interface CpiRouteDeps {
  db: Db;
  state: ServerState;
}

const RangeQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  series_id: z.string().default('CUUR0000SA0'),
});

export function createCpiRoute(deps: CpiRouteDeps): Hono {
  const app = new Hono();
  const service = new CpiService({ db: deps.db, logger });

  app.get('/', async (c) => {
    const query = RangeQuerySchema.parse({
      from: c.req.query('from'),
      to: c.req.query('to'),
      series_id: c.req.query('series_id'),
    });
    const range =
      query.from && query.to ? { from: new Date(query.from), to: new Date(query.to) } : undefined;
    const series = await service.getSeries(query.series_id, range);
    return c.json({ series_id: query.series_id, count: series.length, series });
  });

  app.post('/refresh', async (c) => {
    const series_id = c.req.query('series_id') ?? 'CUUR0000SA0';
    const points = await service.refreshMonthly(series_id);
    return c.json({ series_id, count: points.length, points });
  });

  app.onError(createErrorHandler(logger));
  return app;
}

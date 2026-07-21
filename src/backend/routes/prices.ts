import { Hono } from 'hono';
import { z } from 'zod';

import { MoneySchema } from '@shared/schemas/money';
import type { Db } from '@backend/db/client';
import type { ServerState } from '@backend/lib/server-state';
import { logger } from '@backend/lib/logger';
import { priceProviderConfigFromEnv } from '@backend/services/market-data/provider-registry';
import {
  type PriceProviderConfig,
  type Fetcher,
  dateToUtcMidnight,
} from '@backend/services/market-data/types';
import { PriceService } from '@backend/services/market-data/price-service';
import { createErrorHandler } from '@backend/lib/error-handler';

export interface PricesRouteDeps {
  db: Db;
  state: ServerState;
  config?: PriceProviderConfig | null;
  fetcher?: Fetcher;
}

const RefreshSchema = z.object({
  security_id: z.number().int().positive(),
});

const ManualSchema = z.object({
  security_id: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  close_cents: MoneySchema,
});

const HistoryQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export function createPricesRoute(deps: PricesRouteDeps): Hono {
  const app = new Hono();
  const service = PriceService.fromConfig(
    deps.db,
    logger,
    deps.config ?? priceProviderConfigFromEnv(),
    deps.fetcher,
  );

  app.post('/refresh', async (c) => {
    const body = RefreshSchema.parse(await c.req.json());
    const quote = await service.refreshQuote('', body.security_id);
    return c.json({ quote });
  });

  app.get('/:security_id', async (c) => {
    const security_id = Number(c.req.param('security_id'));
    const as_of = c.req.query('as_of');
    const date = as_of ? new Date(as_of) : new Date();
    const quote = as_of
      ? await service
          .getPriceHistory(security_id, { from: date, to: date })
          .then((r) => r.quotes[0] ?? null)
      : (await service.getLatestPrice(security_id)).quote;
    return c.json({ security_id, as_of: dateToUtcMidnight(date), quote });
  });

  app.get('/:security_id/history', async (c) => {
    const security_id = Number(c.req.param('security_id'));
    const query = HistoryQuerySchema.parse({
      from: c.req.query('from'),
      to: c.req.query('to'),
    });
    const result = await service.getPriceHistory(security_id, {
      from: new Date(query.from),
      to: new Date(query.to),
    });
    return c.json({ security_id, from: query.from, to: query.to, ...result });
  });

  app.post('/manual', async (c) => {
    const body = ManualSchema.parse(await c.req.json());
    const quote = await service.setManualPrice(
      body.security_id,
      new Date(body.date),
      body.close_cents,
    );
    return c.json({ quote });
  });

  app.onError(createErrorHandler(logger));
  return app;
}

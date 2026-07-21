import { Hono } from 'hono';
import { z } from 'zod';

import type { Db } from '@backend/db/client';
import { commitImport, previewImport } from '@backend/services/csv/import.service';

export interface ImportDeps {
  db: Db;
}

const MappingSchema = z.object({
  transaction_type: z.string(),
  transaction_date: z.string(),
  symbol: z.string().optional(),
  quantity: z.string().optional(),
  price: z.string().optional(),
  amount: z.string().optional(),
  fee: z.string().optional(),
  notes: z.string().optional(),
});
const BrokerSchema = z.enum(['fidelity', 'schwab', 'vanguard', 'ibkr']);

const PreviewSchema = z.object({
  text: z.string(),
  account_id: z.number().int().positive(),
  broker: BrokerSchema.optional(),
  mapping: MappingSchema.optional(),
});
const CommitSchema = PreviewSchema.extend({
  accepted_indexes: z.array(z.number().int().nonnegative()).min(1),
});

export function createImportRoute(deps: ImportDeps): Hono {
  return new Hono()
    .post('/csv/preview', async (c) => {
      const p = PreviewSchema.parse(await c.req.json());
      return c.json(
        previewImport(deps.db, {
          text: p.text,
          accountId: p.account_id,
          broker: p.broker,
          mapping: p.mapping,
        }),
      );
    })
    .post('/csv/commit', async (c) => {
      const p = CommitSchema.parse(await c.req.json());
      return c.json(
        commitImport(deps.db, {
          text: p.text,
          accountId: p.account_id,
          broker: p.broker,
          mapping: p.mapping,
          acceptedIndexes: p.accepted_indexes,
        }),
      );
    });
}

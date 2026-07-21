import { Hono } from 'hono';

import type { Db } from '@backend/db/client';
import {
  bulkRetag,
  bulkSoftDelete,
  createTransaction,
  editTransaction,
  listTransactions,
  softDeleteTransaction,
} from '@backend/services/transactions.service';
import { BulkDeleteSchema, BulkRetagSchema } from '@shared/schemas/tag';

export interface TransactionsDeps {
  db: Db;
}

export function createTransactionsRoute(deps: TransactionsDeps): Hono {
  return new Hono()
    .get('/', (c) => {
      const raw = c.req.query('account_id');
      const accountId = raw === undefined ? undefined : Number(raw);
      return c.json({ transactions: listTransactions(deps.db, accountId) });
    })
    .post('/', async (c) => {
      const { transaction, warnings } = createTransaction(deps.db, await c.req.json());
      return c.json({ transaction, warnings }, 201);
    })
    .post('/bulk/delete', async (c) => {
      const { ids } = BulkDeleteSchema.parse(await c.req.json());
      bulkSoftDelete(deps.db, ids);
      return c.json({ deleted: ids.length });
    })
    .post('/bulk/retag', async (c) => {
      const parsed = BulkRetagSchema.parse(await c.req.json());
      bulkRetag(deps.db, parsed);
      return c.json({ retagged: parsed.ids.length });
    })
    .patch('/:id', async (c) => {
      const { transaction, warnings } = editTransaction(
        deps.db,
        Number(c.req.param('id')),
        await c.req.json(),
      );
      return c.json({ transaction, warnings });
    })
    .delete('/:id', (c) => {
      softDeleteTransaction(deps.db, Number(c.req.param('id')));
      return c.body(null, 204);
    });
}

import { Hono } from 'hono';

import type { Db } from '@backend/db/client';
import { accounts } from '@backend/db/schema';
import { activeFilter } from '@backend/db/soft-delete';

import { AccountsResponseSchema, type AccountsResponse } from '@shared/schemas/account';

export interface AccountsDeps {
  db: Db;
}

export function createAccountsRoute(deps: AccountsDeps): Hono {
  return new Hono().get('/', (c) => {
    const rows = deps.db.select().from(accounts).where(activeFilter(accounts)).all();
    const body: AccountsResponse = {
      accounts: rows.map((r) => ({
        id: r.id,
        name: r.name,
        broker: r.broker,
        taxTreatment: r.tax_treatment as AccountsResponse['accounts'][number]['taxTreatment'],
        costBasisMethod:
          r.cost_basis_method as AccountsResponse['accounts'][number]['costBasisMethod'],
        currencyCode: r.currency_code,
        createdAt: r.created_at.toISOString(),
      })),
    };
    // Throws on drift — exposes the bug in tests; in prod the error handler
    // converts the throw to a 500 envelope.
    AccountsResponseSchema.parse(body);
    return c.json(body);
  });
}

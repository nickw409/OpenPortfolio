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
    // Validated against our own wire schema: a failure here means server-side
    // data drift (e.g. a stored tax_treatment/cost_basis_method outside the
    // enum), not a bad client request. Throw a plain Error (not a ZodError)
    // so the error handler's generic branch surfaces it as a 500
    // internal.unknown at error level, never as a client-facing 400.
    const parsed = AccountsResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`accounts response failed schema validation: ${parsed.error.message}`);
    }
    return c.json(parsed.data);
  });
}

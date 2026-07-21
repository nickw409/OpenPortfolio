import { eq } from 'drizzle-orm';

import type { Db } from '@backend/db/client';
import { accounts } from '@backend/db/schema';
import { activeWhere, softDelete } from '@backend/db/soft-delete';
import { CreateAccountSchema, RenameAccountSchema } from '@shared/schemas/account';

import { writeAudit } from './audit.service';
import { getActiveAccount, type AccountRow } from './transactions.service';

export function listAccounts(db: Db): AccountRow[] {
  return db.select().from(accounts).where(activeWhere(accounts, undefined)).all();
}

export function createAccount(db: Db, raw: unknown): AccountRow {
  const input = CreateAccountSchema.parse(raw);
  let row!: AccountRow;
  db.$client.transaction(() => {
    row = db.insert(accounts).values({
      name: input.name,
      broker: input.broker ?? null,
      tax_treatment: input.tax_treatment,
      cost_basis_method: input.cost_basis_method,
      currency_code: input.currency_code,
    }).returning().get();
    writeAudit(db, { entity_type: 'account', entity_id: row.id, action: 'insert', after: row });
  })();
  return row;
}

export function renameAccount(db: Db, id: number, raw: unknown): AccountRow {
  const before = getActiveAccount(db, id);
  const patch = RenameAccountSchema.parse(raw);
  let row!: AccountRow;
  db.$client.transaction(() => {
    row = db.update(accounts).set({
      name: patch.name ?? before.name,
      broker: patch.broker === undefined ? before.broker : patch.broker,
      tax_treatment: patch.tax_treatment ?? before.tax_treatment,
      cost_basis_method: patch.cost_basis_method ?? before.cost_basis_method,
      updated_at: new Date(),
    }).where(eq(accounts.id, id)).returning().get();
    writeAudit(db, { entity_type: 'account', entity_id: id, action: 'update', before, after: row });
  })();
  return row;
}

export function archiveAccount(db: Db, id: number): void {
  const before = getActiveAccount(db, id);
  db.$client.transaction(() => {
    softDelete(db, accounts, eq(accounts.id, id));
    writeAudit(db, { entity_type: 'account', entity_id: id, action: 'delete', before });
  })();
}

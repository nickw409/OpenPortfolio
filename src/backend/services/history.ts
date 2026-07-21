import { and, asc, eq } from 'drizzle-orm';

import type { Db } from '@backend/db/client';
import { transactions } from '@backend/db/schema';
import { activeWhere } from '@backend/db/soft-delete';
import type { Tx, TxType } from '@backend/financial';

export type TransactionRow = typeof transactions.$inferSelect;

export function rowToTx(row: TransactionRow): Tx {
  if (row.security_id === null) {
    throw new Error(`rowToTx: transaction ${row.id} has no security_id`);
  }
  return {
    id: row.id,
    account_id: row.account_id,
    security_id: row.security_id,
    transaction_type: row.transaction_type as TxType,
    transaction_date: row.transaction_date,
    quantity: row.quantity,
    price_cents: row.price_cents ?? null,
    amount_cents: row.amount_cents,
    fee_cents: row.fee_cents ?? null,
    currency_code: row.currency_code,
  };
}

export function loadTxHistory(db: Db, accountId: number, securityId: number): Tx[] {
  const rows = db
    .select()
    .from(transactions)
    .where(activeWhere(transactions, and(
      eq(transactions.account_id, accountId),
      eq(transactions.security_id, securityId),
    )))
    .orderBy(asc(transactions.transaction_date), asc(transactions.id))
    .all();
  return rows.map(rowToTx);
}

import { and, eq, isNull } from 'drizzle-orm';

import type { Db } from '@backend/db/client';
import { transactions } from '@backend/db/schema';
import { activeWhere } from '@backend/db/soft-delete';
import type { TransactionRow } from './history';

export interface DedupFields {
  transaction_date: Date;
  security_id: number | null;
  quantity: number;
  price_cents: number | null;
  account_id: number;
}

function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

export function dedupKey(f: DedupFields): string {
  return [
    f.account_id,
    dayKey(f.transaction_date),
    f.security_id ?? 'null',
    f.quantity,
    f.price_cents ?? 'null',
  ].join('|');
}

export function findDuplicates(db: Db, f: DedupFields): TransactionRow[] {
  const securityPredicate =
    f.security_id === null
      ? isNull(transactions.security_id)
      : eq(transactions.security_id, f.security_id);

  const candidates = db
    .select()
    .from(transactions)
    .where(
      activeWhere(
        transactions,
        and(
          eq(transactions.account_id, f.account_id),
          securityPredicate,
          eq(transactions.quantity, f.quantity),
        ),
      ),
    )
    .all();

  const key = dedupKey(f);
  return candidates.filter(
    (row) =>
      dedupKey({
        transaction_date: row.transaction_date,
        security_id: row.security_id,
        quantity: row.quantity,
        price_cents: row.price_cents ?? null,
        account_id: row.account_id,
      }) === key,
  );
}

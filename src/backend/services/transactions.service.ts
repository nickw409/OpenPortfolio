import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from '@backend/db/client';
import { accounts, securities, transaction_tags, transactions } from '@backend/db/schema';
import { activeWhere, softDelete } from '@backend/db/soft-delete';
import { computeLots, FinancialError, type Tx } from '@backend/financial';
import {
  CreateTransactionSchema,
  EditTransactionSchema,
  isLotAffecting,
  isSecurityBearing,
  type CreateTransactionInput,
  type TxTypeName,
} from '@shared/schemas/transaction';

import { writeAudit } from './audit.service';
import { findDuplicates, type DedupFields } from './dedup';
import { loadTxHistory, type TransactionRow } from './history';
import { ingestionError } from './ingestion-errors';
import { resolveSecurity } from './securities.service';

export type AccountRow = typeof accounts.$inferSelect;

export interface IngestionWarning {
  code: 'duplicate';
  message: string;
  context?: Record<string, unknown>;
}

export interface WriteResult {
  transaction: TransactionRow;
  warnings: IngestionWarning[];
}

export function getActiveAccount(db: Db, id: number): AccountRow {
  const row = db.select().from(accounts).where(activeWhere(accounts, eq(accounts.id, id))).limit(1).get();
  if (!row) throw ingestionError('ingestion.account_not_found', `account ${id} not found`, { account_id: id });
  return row;
}

// Over-sell detection is method-independent; use FIFO to avoid the
// specific-method lot-selection requirement.
export function validateOverSell(
  db: Db,
  accountId: number,
  securityId: number,
  candidate: Tx,
  excludeTxId?: number,
): void {
  const history = loadTxHistory(db, accountId, securityId).filter((t) => t.id !== excludeTxId);
  try {
    computeLots([...history, candidate], { method: 'fifo' });
  } catch (e) {
    if (e instanceof FinancialError && e.code === 'domain.sell_exceeds_holdings') {
      throw ingestionError('ingestion.sell_exceeds_holdings', e.message, { ...e.context });
    }
    throw e;
  }
}

function nextValidationId(history: Tx[]): number {
  return history.reduce((max, t) => Math.max(max, t.id), 0) + 1;
}

interface Resolved {
  input: CreateTransactionInput;
  security_id: number | null;
  createdSecurity: boolean;
}

function resolve(db: Db, input: CreateTransactionInput): Resolved {
  getActiveAccount(db, input.account_id);
  let security_id: number | null = null;
  let createdSecurity = false;
  if (isSecurityBearing(input.transaction_type)) {
    // symbol presence is guaranteed by the schema refine for these types.
    const { security, created } = resolveSecurity(db, input.symbol!);
    security_id = security.id;
    createdSecurity = created;
  }
  return { input, security_id, createdSecurity };
}

function dedupFields(input: CreateTransactionInput, security_id: number | null): DedupFields {
  return {
    transaction_date: input.transaction_date,
    security_id,
    quantity: input.quantity,
    price_cents: input.price_cents ?? null,
    account_id: input.account_id,
  };
}

export function createTransaction(db: Db, raw: unknown): WriteResult {
  const input = CreateTransactionSchema.parse(raw);
  const { security_id } = resolve(db, input);

  const dupes = findDuplicates(db, dedupFields(input, security_id));
  const warnings: IngestionWarning[] = dupes.length
    ? [{ code: 'duplicate', message: `matches ${dupes.length} existing transaction(s)`, context: { ids: dupes.map((d) => d.id) } }]
    : [];

  if (isLotAffecting(input.transaction_type) && security_id !== null) {
    const history = loadTxHistory(db, input.account_id, security_id);
    const candidate: Tx = toEngineCandidate(input, security_id, nextValidationId(history));
    validateOverSell(db, input.account_id, security_id, candidate);
  }

  let transaction!: TransactionRow;
  db.$client.transaction(() => {
    transaction = db.insert(transactions).values({
      account_id: input.account_id,
      security_id,
      transaction_type: input.transaction_type,
      transaction_date: input.transaction_date,
      quantity: input.quantity,
      price_cents: input.price_cents ?? null,
      amount_cents: input.amount_cents,
      fee_cents: input.fee_cents ?? null,
      currency_code: input.currency_code,
      notes: input.notes ?? null,
    }).returning().get();
    writeAudit(db, { entity_type: 'transaction', entity_id: transaction.id, action: 'insert', after: transaction });
  })();

  return { transaction, warnings };
}

function toEngineCandidate(input: CreateTransactionInput, security_id: number, id: number): Tx {
  return {
    id,
    account_id: input.account_id,
    security_id,
    transaction_type: input.transaction_type as TxTypeName,
    transaction_date: input.transaction_date,
    quantity: input.quantity,
    price_cents: input.price_cents ?? null,
    amount_cents: input.amount_cents,
    fee_cents: input.fee_cents ?? null,
    currency_code: input.currency_code,
  };
}

function symbolOf(db: Db, securityId: number): string | undefined {
  return db.select().from(securities).where(eq(securities.id, securityId)).get()?.symbol;
}

export function getActiveTransaction(db: Db, id: number): TransactionRow {
  const row = db.select().from(transactions).where(activeWhere(transactions, eq(transactions.id, id))).limit(1).get();
  if (!row) throw ingestionError('ingestion.transaction_not_found', `transaction ${id} not found`, { id });
  return row;
}

function rowToCreateInput(row: TransactionRow): Record<string, unknown> {
  return {
    account_id: row.account_id,
    symbol: undefined,
    transaction_type: row.transaction_type,
    transaction_date: row.transaction_date,
    quantity: row.quantity,
    price_cents: row.price_cents ?? undefined,
    amount_cents: row.amount_cents,
    fee_cents: row.fee_cents ?? undefined,
    currency_code: row.currency_code,
    notes: row.notes ?? undefined,
  };
}

export function editTransaction(db: Db, id: number, rawPatch: unknown): WriteResult {
  const before = getActiveTransaction(db, id);
  const patch = EditTransactionSchema.parse(rawPatch);

  const existingSymbol = before.security_id !== null ? symbolOf(db, before.security_id) : undefined;
  const merged = { ...rowToCreateInput(before), symbol: existingSymbol, ...patch };
  const input = CreateTransactionSchema.parse(merged);
  const { security_id } = resolve(db, input);

  if (isLotAffecting(input.transaction_type) && security_id !== null) {
    const candidate = toEngineCandidate(input, security_id, id);
    validateOverSell(db, input.account_id, security_id, candidate, id);
  }

  const dupes = findDuplicates(db, dedupFields(input, security_id)).filter((d) => d.id !== id);
  const warnings: IngestionWarning[] = dupes.length
    ? [{ code: 'duplicate', message: `matches ${dupes.length} existing transaction(s)`, context: { ids: dupes.map((d) => d.id) } }]
    : [];

  let transaction!: TransactionRow;
  db.$client.transaction(() => {
    transaction = db.update(transactions).set({
      account_id: input.account_id,
      security_id,
      transaction_type: input.transaction_type,
      transaction_date: input.transaction_date,
      quantity: input.quantity,
      price_cents: input.price_cents ?? null,
      amount_cents: input.amount_cents,
      fee_cents: input.fee_cents ?? null,
      currency_code: input.currency_code,
      notes: input.notes ?? null,
      updated_at: new Date(),
    }).where(eq(transactions.id, id)).returning().get();
    writeAudit(db, { entity_type: 'transaction', entity_id: id, action: 'update', before, after: transaction });
  })();

  return { transaction, warnings };
}

export function softDeleteTransaction(db: Db, id: number): void {
  const before = getActiveTransaction(db, id);

  // Removing a lot-affecting row can strand a later sell — revalidate the
  // remaining stream (this row excluded) before committing the delete.
  if (isLotAffecting(before.transaction_type as TxTypeName) && before.security_id !== null) {
    const remaining = loadTxHistory(db, before.account_id, before.security_id).filter((t) => t.id !== id);
    try {
      computeLots(remaining, { method: 'fifo' });
    } catch (e) {
      if (e instanceof FinancialError && e.code === 'domain.sell_exceeds_holdings') {
        throw ingestionError('ingestion.sell_exceeds_holdings', `deleting transaction ${id} would cause a later sell to exceed holdings`, { id, ...e.context });
      }
      throw e;
    }
  }

  db.$client.transaction(() => {
    softDelete(db, transactions, eq(transactions.id, id));
    writeAudit(db, { entity_type: 'transaction', entity_id: id, action: 'delete', before });
  })();
}

export function bulkSoftDelete(db: Db, ids: number[]): void {
  const rows = ids.map((id) => getActiveTransaction(db, id));
  const deleted = new Set<number>();
  db.$client.transaction(() => {
    for (const before of rows) {
      if (isLotAffecting(before.transaction_type as TxTypeName) && before.security_id !== null) {
        const remaining = loadTxHistory(db, before.account_id, before.security_id)
          .filter((t) => t.id !== before.id && !deleted.has(t.id));
        try {
          computeLots(remaining, { method: 'fifo' });
        } catch (e) {
          if (e instanceof FinancialError && e.code === 'domain.sell_exceeds_holdings') {
            throw ingestionError('ingestion.sell_exceeds_holdings', `deleting transaction ${before.id} would cause a later sell to exceed holdings`, { id: before.id });
          }
          throw e;
        }
      }
      softDelete(db, transactions, eq(transactions.id, before.id));
      writeAudit(db, { entity_type: 'transaction', entity_id: before.id, action: 'delete', before });
      deleted.add(before.id);
    }
  })();
}

export interface BulkRetagParams { ids: number[]; add: number[]; remove: number[]; }

export function bulkRetag(db: Db, params: BulkRetagParams): void {
  const rows = params.ids.map((id) => getActiveTransaction(db, id));
  db.$client.transaction(() => {
    for (const row of rows) {
      for (const tagId of params.add) {
        db.insert(transaction_tags).values({ transaction_id: row.id, tag_id: tagId }).onConflictDoNothing().run();
      }
      if (params.remove.length > 0) {
        db.delete(transaction_tags).where(and(
          eq(transaction_tags.transaction_id, row.id),
          inArray(transaction_tags.tag_id, params.remove),
        )).run();
      }
      writeAudit(db, { entity_type: 'transaction', entity_id: row.id, action: 'update', before: { tags: 'retag' }, after: { add: params.add, remove: params.remove } });
    }
  })();
}

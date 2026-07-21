import { eq } from 'drizzle-orm';

import type { Db } from '@backend/db/client';
import { accounts, transactions } from '@backend/db/schema';
import { activeWhere } from '@backend/db/soft-delete';
import { computeLots, FinancialError, type Tx } from '@backend/financial';
import {
  CreateTransactionSchema,
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

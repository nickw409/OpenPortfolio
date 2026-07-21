import { parse as parseMoney } from '@shared/money';

import { ingestionError } from '../ingestion-errors';
import type { TxTypeName } from '@shared/schemas/transaction';

export interface ColumnMapping {
  transaction_type: string;
  transaction_date: string;
  symbol?: string;
  quantity?: string;
  price?: string;
  amount?: string;
  fee?: string;
  notes?: string;
}

export interface CanonicalRow {
  sourceIndex: number;
  transaction_type: string;
  transaction_date: string;
  symbol?: string;
  quantity?: string;
  price?: string;
  amount?: string;
  fee?: string;
  notes?: string;
}

const OPTIONAL_FIELDS = ['symbol', 'quantity', 'price', 'amount', 'fee', 'notes'] as const;

export function applyMapping(rows: Record<string, string>[], mapping: ColumnMapping): CanonicalRow[] {
  for (const required of ['transaction_type', 'transaction_date'] as const) {
    const header = mapping[required];
    if (!header || (rows.length > 0 && !(header in rows[0]!))) {
      throw ingestionError('ingestion.csv_mapping_incomplete', `missing required column for ${required}`, { field: required, header });
    }
  }
  return rows.map((row, sourceIndex) => {
    const canonical: CanonicalRow = {
      sourceIndex,
      transaction_type: row[mapping.transaction_type] ?? '',
      transaction_date: row[mapping.transaction_date] ?? '',
    };
    for (const field of OPTIONAL_FIELDS) {
      const header = mapping[field];
      if (header && header in row) canonical[field] = row[header];
    }
    return canonical;
  });
}

export function canonicalToCreateInput(
  row: CanonicalRow,
  accountId: number,
  normalizeType?: (raw: string) => TxTypeName | null,
): Record<string, unknown> {
  const type = normalizeType ? normalizeType(row.transaction_type) : row.transaction_type;
  const out: Record<string, unknown> = {
    account_id: accountId,
    transaction_type: type,
    transaction_date: row.transaction_date,
  };
  if (row.symbol) out.symbol = row.symbol;
  if (row.notes) out.notes = row.notes;
  if (row.quantity !== undefined && row.quantity !== '') out.quantity = Number(row.quantity);
  if (row.amount !== undefined && row.amount !== '') out.amount_cents = Math.abs(parseMoney(row.amount));
  if (row.price !== undefined && row.price !== '') out.price_cents = Math.abs(parseMoney(row.price));
  if (row.fee !== undefined && row.fee !== '') out.fee_cents = Math.abs(parseMoney(row.fee));
  return out;
}

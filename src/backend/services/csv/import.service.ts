import type { Db } from '@backend/db/client';
import { computeLots, FinancialError, type Tx } from '@backend/financial';
import {
  CreateTransactionSchema, isLotAffecting, isSecurityBearing, type TxTypeName,
} from '@shared/schemas/transaction';

import { findDuplicates } from '../dedup';
import { loadTxHistory } from '../history';
import { ingestionError } from '../ingestion-errors';
import { findSecurityBySymbol } from '../securities.service';
import { createTransaction, getActiveAccount } from '../transactions.service';
import { applyMapping, canonicalToCreateInput, type ColumnMapping } from './mapping';
import { parseCsv } from './parse';
import { getPreset, type BrokerId } from './presets';

export interface PreviewRowResult {
  sourceIndex: number;
  status: 'ok' | 'warn' | 'error';
  resolvedSymbol?: string;
  isNewSecurity: boolean;
  isDuplicate: boolean;
  errors: { message: string }[];
  warnings: { message: string }[];
}

export interface PreviewResult {
  rows: PreviewRowResult[];
  summary: { total: number; ok: number; warn: number; error: number };
  mapping: ColumnMapping;
}

export interface CommitResult {
  inserted: number;
  createdSecurities: number;
  warnings: { sourceIndex: number; message: string }[];
}

interface ImportParams {
  text: string;
  accountId: number;
  broker?: BrokerId;
  mapping?: ColumnMapping;
}

function resolveMapping(params: ImportParams): { mapping: ColumnMapping; normalizeType?: (raw: string) => TxTypeName | null } {
  if (params.broker) {
    const preset = getPreset(params.broker);
    return { mapping: preset.mapping, normalizeType: preset.normalizeType };
  }
  if (params.mapping) return { mapping: params.mapping };
  throw ingestionError('ingestion.csv_mapping_incomplete', 'either broker or mapping is required');
}

function buildSimulatedHistory(
  db: Db,
  accountId: number,
  securityId: number | null,
  prior: Tx[],
): Tx[] {
  const dbHistory = securityId !== null && securityId > 0
    ? loadTxHistory(db, accountId, securityId)
    : [];
  const baseId = dbHistory.reduce((m, t) => Math.max(m, t.id), 0);
  const simulated = prior.map((t, i) => ({ ...t, id: baseId + i + 1 }));
  return [...dbHistory, ...simulated];
}

export function previewImport(db: Db, params: ImportParams): PreviewResult {
  getActiveAccount(db, params.accountId);
  const { mapping, normalizeType } = resolveMapping(params);
  const { rows } = parseCsv(params.text);
  const canonical = applyMapping(rows, mapping);

  // Preview candidates accumulated per (account, security) so a sell later in
  // the same CSV can see holdings from an earlier buy.
  const simulated: Tx[] = [];

  const results: PreviewRowResult[] = canonical.map((row) => {
    const errors: { message: string }[] = [];
    const warnings: { message: string }[] = [];
    let isNewSecurity = false;
    let isDuplicate = false;
    let resolvedSymbol: string | undefined;

    const parsed = CreateTransactionSchema.safeParse(canonicalToCreateInput(row, params.accountId, normalizeType));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push({ message: `${issue.path.join('.')}: ${issue.message}` });
      return { sourceIndex: row.sourceIndex, status: 'error', isNewSecurity, isDuplicate, errors, warnings };
    }
    const input = parsed.data;
    resolvedSymbol = input.symbol;

    let securityId: number | null = null;
    if (isSecurityBearing(input.transaction_type)) {
      const existing = findSecurityBySymbol(db, input.symbol!);
      securityId = existing?.id ?? -1;
      isNewSecurity = !existing;
    }

    if (findDuplicates(db, {
      transaction_date: input.transaction_date,
      security_id: securityId === -1 ? null : securityId,
      quantity: input.quantity,
      price_cents: input.price_cents ?? null,
      account_id: input.account_id,
    }).length > 0) {
      isDuplicate = true;
      warnings.push({ message: 'matches an existing transaction' });
    }

    if (isLotAffecting(input.transaction_type)) {
      const history = buildSimulatedHistory(db, input.account_id, securityId, simulated);
      const candidate: Tx = {
        id: history.reduce((m, t) => Math.max(m, t.id), 0) + 1,
        account_id: input.account_id,
        security_id: securityId ?? -1,
        transaction_type: input.transaction_type as TxTypeName,
        transaction_date: input.transaction_date,
        quantity: input.quantity,
        price_cents: input.price_cents ?? null,
        amount_cents: input.amount_cents,
        fee_cents: input.fee_cents ?? null,
        currency_code: input.currency_code,
      };
      try {
        computeLots([...history, candidate], { method: 'fifo' });
      } catch (e) {
        if (e instanceof FinancialError && e.code === 'domain.sell_exceeds_holdings') {
          errors.push({ message: 'sell exceeds holdings' });
        } else { throw e; }
      }
      // Only add successful lot-affecting rows to the simulated stream so a
      // later error row can't hide an earlier real over-sell.
      if (errors.length === 0) simulated.push(candidate);
    }

    const status: PreviewRowResult['status'] = errors.length ? 'error' : warnings.length ? 'warn' : 'ok';
    return { sourceIndex: row.sourceIndex, status, resolvedSymbol, isNewSecurity, isDuplicate, errors, warnings };
  });

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    error: results.filter((r) => r.status === 'error').length,
  };
  return { rows: results, summary, mapping };
}

export function commitImport(db: Db, params: ImportParams & { acceptedIndexes: number[] }): CommitResult {
  const preview = previewImport(db, params);
  const accepted = new Set(params.acceptedIndexes);
  const acceptedRows = preview.rows.filter((r) => accepted.has(r.sourceIndex));
  const errored = acceptedRows.filter((r) => r.status === 'error');
  if (errored.length > 0) {
    throw ingestionError('ingestion.commit_has_errors', `${errored.length} accepted row(s) have errors`, { indexes: errored.map((r) => r.sourceIndex) });
  }

  const { mapping, normalizeType } = resolveMapping(params);
  const { rows } = parseCsv(params.text);
  const canonical = applyMapping(rows, mapping);

  const warnings: CommitResult['warnings'] = [];
  let createdSecurities = 0;
  let inserted = 0;

  db.$client.transaction(() => {
    for (const row of canonical) {
      if (!accepted.has(row.sourceIndex)) continue;
      const input = CreateTransactionSchema.parse(canonicalToCreateInput(row, params.accountId, normalizeType));
      const willCreate = isSecurityBearing(input.transaction_type) && !findSecurityBySymbol(db, input.symbol!);
      const { warnings: rowWarnings } = createTransaction(db, canonicalToCreateInput(row, params.accountId, normalizeType));
      if (willCreate) createdSecurities += 1;
      inserted += 1;
      for (const w of rowWarnings) warnings.push({ sourceIndex: row.sourceIndex, message: w.message });
    }
  })();

  return { inserted, createdSecurities, warnings };
}

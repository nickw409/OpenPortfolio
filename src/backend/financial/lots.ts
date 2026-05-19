// computeLots — the cost-basis-method choke point. Walks a chronologically
// ordered transaction stream for one (account, security) and emits the open
// lots remaining at `asOf` plus the closed lots realized along the way.
//
// Algorithm:
//   - buy / transfer_in: open new lot with basis = amount + fee
//   - sell / transfer_out: pick lots per method (FIFO/LIFO/specific),
//     consume proportionally, emit ClosedLot per source lot consumed.
//     Net proceeds = amount − fee.
//   - split: multiply every open lot's quantity by ratio; cost basis
//     unchanged (per-share basis is divided by ratio implicitly).
//   - dividend / interest / fee / deposit / withdrawal: skipped (income).
//
// See docs/specs/2026-05-18-financial-engine-slice-1.md.

import { ZERO, add, multiplyByRatio, subtract, type Money } from '@shared/money';

import { FinancialError } from './errors';
import type {
  ClosedLot,
  ComputeLotsOptions,
  Lot,
  LotResult,
  LotSelection,
  Tx,
  TxType,
} from './types';

// Quantity-comparison epsilon. Fractional-share precision in the wild is
// ~1e-6; accumulated FP error from chained splits and proportional sells
// is smaller. 1e-9 is loose enough to ignore noise, tight enough to catch
// real over-sells.
const EPSILON = 1e-9;

const SHARE_TX_TYPES: ReadonlySet<TxType> = new Set([
  'buy',
  'sell',
  'split',
  'transfer_in',
  'transfer_out',
]);

interface Chunk {
  lot: Lot;
  consumed: number;
}

export function computeLots(txns: readonly Tx[], opts: ComputeLotsOptions): LotResult {
  const shareTxns = txns.filter((t) => SHARE_TX_TYPES.has(t.transaction_type));
  if (shareTxns.length === 0) {
    return { openLots: [], closedLots: [] };
  }

  validateUniformGroup(shareTxns);

  const cutoffMs = opts.asOf?.getTime();
  const sorted = [...shareTxns].sort((a, b) => {
    const dt = a.transaction_date.getTime() - b.transaction_date.getTime();
    return dt !== 0 ? dt : a.id - b.id;
  });

  const openLots: Lot[] = [];
  const closedLots: ClosedLot[] = [];

  for (const tx of sorted) {
    if (cutoffMs !== undefined && tx.transaction_date.getTime() > cutoffMs) break;

    switch (tx.transaction_type) {
      case 'buy':
      case 'transfer_in':
        applyOpen(tx, openLots);
        break;
      case 'sell':
      case 'transfer_out':
        applyClose(tx, openLots, closedLots, opts);
        break;
      case 'split':
        applySplit(tx, openLots);
        break;
      default:
        // Non-share txns are filtered above; this branch is unreachable.
        break;
    }
  }

  // Drop fully consumed lots that the close-path didn't already remove.
  return {
    openLots: openLots.filter((l) => l.quantity > EPSILON),
    closedLots,
  };
}

function validateUniformGroup(txns: readonly Tx[]): void {
  const first = txns[0]!;
  for (const t of txns) {
    if (t.account_id !== first.account_id) {
      throw new FinancialError(
        'unsupported.mixed_grouping',
        'computeLots expects all transactions for a single (account, security)',
        { expected_account_id: first.account_id, got_account_id: t.account_id, tx_id: t.id },
      );
    }
    if (t.security_id !== first.security_id) {
      throw new FinancialError(
        'unsupported.mixed_grouping',
        'computeLots expects all transactions for a single (account, security)',
        { expected_security_id: first.security_id, got_security_id: t.security_id, tx_id: t.id },
      );
    }
    if (t.currency_code !== first.currency_code) {
      throw new FinancialError(
        'unsupported.mixed_currency',
        'computeLots requires a single currency per group',
        { expected: first.currency_code, got: t.currency_code, tx_id: t.id },
      );
    }
  }
  if (first.security_id == null) {
    // Share-affecting txn types require a security_id. Caller bug.
    throw new TypeError(
      `share-affecting transaction (id ${first.id}, ${first.transaction_type}) has null security_id`,
    );
  }
}

function applyOpen(tx: Tx, openLots: Lot[]): void {
  if (!Number.isFinite(tx.quantity) || tx.quantity <= 0) {
    throw new RangeError(
      `${tx.transaction_type} requires positive finite quantity (tx ${tx.id}, got ${tx.quantity})`,
    );
  }
  const fee = tx.fee_cents ?? ZERO;
  const basis = add(tx.amount_cents, fee);
  openLots.push({
    sourceTxId: tx.id,
    account_id: tx.account_id,
    security_id: tx.security_id!,
    acquired_at: tx.transaction_date,
    quantity: tx.quantity,
    cost_basis_cents: basis,
    currency_code: tx.currency_code,
  });
}

function applySplit(tx: Tx, openLots: Lot[]): void {
  if (!Number.isFinite(tx.quantity) || tx.quantity <= 0) {
    throw new RangeError(`split requires positive finite ratio (tx ${tx.id}, got ${tx.quantity})`);
  }
  // A reverse split (ratio < 1) is allowed by this signature — broker
  // statements record reverse splits as ratios like 0.1 (1-for-10).
  if (openLots.length === 0) {
    throw new FinancialError(
      'domain.split_without_open_lots',
      `split tx ${tx.id} has no open lots to adjust`,
      { tx_id: tx.id },
    );
  }
  const ratio = tx.quantity;
  for (const lot of openLots) {
    lot.quantity = lot.quantity * ratio;
    // cost_basis_cents stays; per-share basis is implicitly divided by ratio.
  }
}

function applyClose(
  tx: Tx,
  openLots: Lot[],
  closedLots: ClosedLot[],
  opts: ComputeLotsOptions,
): void {
  if (!Number.isFinite(tx.quantity) || tx.quantity <= 0) {
    throw new RangeError(
      `${tx.transaction_type} requires positive finite quantity (tx ${tx.id}, got ${tx.quantity})`,
    );
  }

  const chunks = planClose(tx, openLots, opts);

  const fee = tx.fee_cents ?? ZERO;
  const netProceeds = subtract(tx.amount_cents, fee);
  const sellQty = tx.quantity;

  // Allocate proceeds in order; the last chunk picks up the remainder so
  // sum(chunks.proceeds) == netProceeds exactly (no rounding gap).
  let proceedsAllocated: Money = ZERO;

  for (let i = 0; i < chunks.length; i++) {
    const { lot, consumed } = chunks[i]!;
    const isLastChunk = i === chunks.length - 1;

    // Cost allocation: empty the lot exactly when consumed == lot.quantity,
    // otherwise take a proportional slice. The lot-emptying branch avoids
    // a sub-cent remainder stuck in the closed lot.
    let allocatedCost: Money;
    const isLotEmptied = Math.abs(consumed - lot.quantity) <= EPSILON;
    if (isLotEmptied) {
      allocatedCost = lot.cost_basis_cents;
      lot.cost_basis_cents = ZERO;
      lot.quantity = 0;
    } else {
      const costRatio = consumed / lot.quantity;
      allocatedCost = multiplyByRatio(lot.cost_basis_cents, costRatio);
      lot.cost_basis_cents = subtract(lot.cost_basis_cents, allocatedCost);
      lot.quantity = lot.quantity - consumed;
    }

    // Proceeds allocation: proportional, with last chunk = remainder.
    let allocatedProceeds: Money;
    if (isLastChunk) {
      allocatedProceeds = subtract(netProceeds, proceedsAllocated);
    } else {
      allocatedProceeds = multiplyByRatio(netProceeds, consumed / sellQty);
      proceedsAllocated = add(proceedsAllocated, allocatedProceeds);
    }

    closedLots.push({
      sourceTxId: lot.sourceTxId,
      sellTxId: tx.id,
      account_id: tx.account_id,
      security_id: tx.security_id!,
      acquired_at: lot.acquired_at,
      disposed_at: tx.transaction_date,
      quantity: consumed,
      proceeds_cents: allocatedProceeds,
      cost_basis_cents: allocatedCost,
      realized_gain_cents: subtract(allocatedProceeds, allocatedCost),
      currency_code: tx.currency_code,
    });
  }

  // Compact: drop emptied lots (preserve order for fifo/lifo correctness).
  for (let i = openLots.length - 1; i >= 0; i--) {
    if (openLots[i]!.quantity <= EPSILON) {
      openLots.splice(i, 1);
    }
  }
}

function planClose(tx: Tx, openLots: readonly Lot[], opts: ComputeLotsOptions): Chunk[] {
  if (opts.method === 'specific') {
    return planSpecific(tx, openLots, opts.lotSelections?.get(tx.id));
  }
  return planFifoLifo(tx, openLots, opts.method);
}

function planFifoLifo(tx: Tx, openLots: readonly Lot[], method: 'fifo' | 'lifo'): Chunk[] {
  const ordered = method === 'fifo' ? openLots : [...openLots].reverse();
  const chunks: Chunk[] = [];
  let remaining = tx.quantity;
  for (const lot of ordered) {
    if (remaining <= EPSILON) break;
    if (lot.quantity <= EPSILON) continue;
    const take = Math.min(lot.quantity, remaining);
    chunks.push({ lot, consumed: take });
    remaining -= take;
  }
  if (remaining > EPSILON) {
    throw new FinancialError(
      'domain.sell_exceeds_holdings',
      `sell tx ${tx.id} exceeds available holdings`,
      { tx_id: tx.id, requested: tx.quantity, short_by: remaining },
    );
  }
  return chunks;
}

function planSpecific(
  tx: Tx,
  openLots: readonly Lot[],
  selections: readonly LotSelection[] | undefined,
): Chunk[] {
  if (!selections || selections.length === 0) {
    throw new FinancialError(
      'domain.specific_selection_missing',
      `sell tx ${tx.id} uses method 'specific' but no lot selections were provided`,
      { tx_id: tx.id },
    );
  }
  const total = selections.reduce((s, x) => s + x.quantityFromLot, 0);
  if (Math.abs(total - tx.quantity) > EPSILON) {
    throw new FinancialError(
      'domain.specific_selection_quantity_mismatch',
      `sell tx ${tx.id} selections sum to ${total} but sell quantity is ${tx.quantity}`,
      { tx_id: tx.id, selected: total, sell_qty: tx.quantity },
    );
  }
  const chunks: Chunk[] = [];
  for (const sel of selections) {
    const lot = openLots.find((l) => l.sourceTxId === sel.sourceTxId);
    if (!lot) {
      throw new FinancialError(
        'domain.unknown_lot_reference',
        `sell tx ${tx.id} references lot ${sel.sourceTxId} which is not open`,
        { tx_id: tx.id, source_tx_id: sel.sourceTxId },
      );
    }
    if (lot.quantity + EPSILON < sel.quantityFromLot) {
      throw new FinancialError(
        'domain.sell_exceeds_holdings',
        `sell tx ${tx.id}: lot ${sel.sourceTxId} has ${lot.quantity} shares, requested ${sel.quantityFromLot}`,
        {
          tx_id: tx.id,
          source_tx_id: sel.sourceTxId,
          available: lot.quantity,
          requested: sel.quantityFromLot,
        },
      );
    }
    chunks.push({ lot, consumed: sel.quantityFromLot });
  }
  return chunks;
}

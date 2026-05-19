// Public types for the financial calculation engine. Plain TS — no Drizzle,
// no SQLite. The engine is a pure-function library; the service layer next
// to routes is responsible for loading rows from the DB into these shapes.
//
// See docs/specs/2026-05-18-financial-engine-slice-1.md for the design.

import type { Money } from '@shared/money';

// ─── transaction input ──────────────────────────────────────────────────

// Mirrors transactions table semantics (schema.ts:53). 'split' encodes the
// split ratio (2.0 = 2-for-1) in `quantity`; price/amount/fee are ignored.
// 'dividend'/'interest'/'fee'/'deposit'/'withdrawal' don't carry shares.
export type TxType =
  | 'buy'
  | 'sell'
  | 'dividend'
  | 'interest'
  | 'fee'
  | 'split'
  | 'transfer_in'
  | 'transfer_out'
  | 'deposit'
  | 'withdrawal';

export interface Tx {
  id: number;
  account_id: number;
  security_id: number | null;
  transaction_type: TxType;
  transaction_date: Date;
  // Shares for buy/sell/transfer; ratio for split; ignored for cash events.
  quantity: number;
  price_cents: Money | null;
  // Gross trade value (qty × price). Engine combines with fee_cents to
  // compute cost basis on buys (basis = amount + fee) and proceeds on
  // sells (proceeds = amount − fee). Ignored for split.
  amount_cents: Money;
  fee_cents: Money | null;
  currency_code: string;
}

// ─── method / lot selection ─────────────────────────────────────────────

export type CostBasisMethod = 'fifo' | 'lifo' | 'specific';

// One entry per source lot consumed on a particular sell. The engine
// validates that the sum of `quantityFromLot` equals the sell quantity
// and that each `sourceTxId` references an open lot at the sell's date.
export interface LotSelection {
  sourceTxId: number;
  quantityFromLot: number;
}

// Map of sell-transaction-id → ordered list of lot selections.
// Required when method is 'specific'; ignored otherwise.
export type LotSelectionMap = ReadonlyMap<number, readonly LotSelection[]>;

export interface ComputeLotsOptions {
  method: CostBasisMethod;
  asOf?: Date;
  // For method='specific'. Keyed by sell transaction id.
  lotSelections?: LotSelectionMap;
}

// ─── outputs ────────────────────────────────────────────────────────────

export interface Lot {
  // The source transaction id (the buy or transfer_in that opened the lot).
  sourceTxId: number;
  account_id: number;
  security_id: number;
  acquired_at: Date;
  // Remaining open shares after sells and split adjustments.
  quantity: number;
  // Remaining cost basis (proportional to remaining shares). Money cents.
  cost_basis_cents: Money;
  currency_code: string;
}

export interface ClosedLot {
  sourceTxId: number;
  sellTxId: number;
  account_id: number;
  security_id: number;
  acquired_at: Date;
  disposed_at: Date;
  quantity: number;
  // proceeds_cents = sell amount × (qty / sellQty) − fee × (qty / sellQty).
  proceeds_cents: Money;
  cost_basis_cents: Money;
  realized_gain_cents: Money;
  currency_code: string;
}

export interface LotResult {
  openLots: Lot[];
  closedLots: ClosedLot[];
}

export interface PositionSnapshot {
  account_id: number;
  security_id: number;
  quantity: number;
  cost_basis_cents: Money;
  // null when no current price was supplied.
  current_price_cents: Money | null;
  market_value_cents: Money | null;
  unrealized_gain_cents: Money | null;
  currency_code: string;
}

// Caller supplies current prices keyed by security_id.
export type PriceMap = ReadonlyMap<number, Money>;

export interface PortfolioSnapshot {
  positions: PositionSnapshot[];
  total_cost_basis_cents: Money;
  // null if any position lacks a current price.
  total_market_value_cents: Money | null;
  total_unrealized_gain_cents: Money | null;
  as_of: Date;
}

export interface RealizedSummary {
  closedLots: ClosedLot[];
  total_proceeds_cents: Money;
  total_cost_cents: Money;
  total_realized_gain_cents: Money;
}

export interface IncomeSummary {
  dividends_cents: Money;
  interest_cents: Money;
  fees_cents: Money;
  // dividends + interest − fees. Yield (TTM div / value) is left to callers
  // that know the current portfolio value.
  net_cents: Money;
}

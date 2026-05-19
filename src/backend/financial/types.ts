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

// ─── slice 2: time / range / scope ──────────────────────────────────────

// Inclusive on both ends. `to >= from` required (RangeError otherwise).
export interface DateRange {
  from: Date;
  to: Date;
}

// Portfolio scope nets cross-account transfers; per-account scope treats
// transfer_in/transfer_out as deposits/withdrawals for that account's books.
export type Scope = 'portfolio' | { account_id: number };

// ─── slice 2: price history ─────────────────────────────────────────────

// Sparse — engine forward-carries the last known price across weekends,
// holidays, and gaps. Throws `price.stale` if a held day has no preceding
// price within `maxStalenessDays` for the security.
export interface PricePoint {
  date: Date;
  price_cents: Money;
}
export type PriceHistory = ReadonlyMap<number, ReadonlyArray<PricePoint>>;

// ─── slice 2: CPI ───────────────────────────────────────────────────────

// Monthly BLS CPI-U release-date / index-value pairs. Engine linearly
// interpolates between adjacent points; throws `cpi.out_of_range` for any
// requested date outside [first.date, last.date].
export interface CpiPoint {
  date: Date;
  index: number;
}
export type CpiSeries = ReadonlyArray<CpiPoint>;

// ─── slice 2: valuation series ──────────────────────────────────────────

export interface ValuationPoint {
  date: Date;
  market_value_cents: Money;
  cost_basis_cents: Money;
  external_cashflow_cents: Money;
  // Total-return index starting at 1.0 on the series's first point and
  // chained day-by-day from daily returns net of external cashflows.
  // Cashflow-neutral by construction — TWR is (tr_index[last] / tr_index[first]) − 1.
  tr_index: number;
}
export interface ValuationSeries {
  points: ReadonlyArray<ValuationPoint>;
  scope: Scope;
  range: DateRange;
}

// ─── slice 2: TWR / MWR / drawdown / real / allocation results ──────────

export interface TwrResult {
  return_pct: number;            // total period
  annualized_pct: number | null; // null when range < 365.25 days
  days: number;
}

export interface MwrResult {
  irr_pct: number;                            // annualized
  iterations: number;
  method: 'newton' | 'bisection';
}

export interface DrawdownStats {
  max_drawdown_pct: number;                    // in [−100, 0]
  max_drawdown_peak_date: Date;
  max_drawdown_trough_date: Date;
  max_drawdown_recovery_date: Date | null;     // null if never recovered
  current_drawdown_pct: number;                // in [−100, 0]; 0 if at all-time high
  current_peak_date: Date;
}

export interface DrawdownResult {
  nominal: DrawdownStats;
  real: DrawdownStats | null;                  // null when cpi omitted
}

export interface RealReturnResult {
  real_pct: number;
  cpi_change_pct: number;
}

export type AllocationDimension = 'asset_class' | 'account' | 'security' | 'tag';

// Lookup data is supplied by the caller (engine does no I/O). The fields
// required depend on the chosen `dimension`:
//   - 'asset_class' → `securities` (each entry must have asset_class)
//   - 'account'     → `accounts`
//   - 'security'    → `securities` (symbol used; falls back to "security:<id>")
//   - 'tag'         → `lots` and `lotTags`
// Missing entries throw FinancialError('allocation.missing_security') or
// .missing_account at runtime.
export interface AllocationOptions {
  dimension: AllocationDimension;
  securities?: ReadonlyMap<number, { asset_class?: string; symbol?: string | null }>;
  accounts?: ReadonlyMap<number, { name: string; tax_treatment?: string }>;
  lots?: ReadonlyArray<Lot>;
  lotTags?: ReadonlyMap<number, ReadonlyArray<string>>;
}

export interface AllocationBucket {
  key: string;
  market_value_cents: Money;
  cost_basis_cents: Money;
  weight_pct: number;
}

export interface AllocationBreakdown {
  dimension: AllocationDimension;
  buckets: ReadonlyArray<AllocationBucket>;
  total_market_value_cents: Money;
}

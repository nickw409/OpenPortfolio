// Tiny test-only builders for the financial engine. Kept inside src/ so
// tests can import via the same module-graph as production code; coverage
// exclusions (vitest.config.ts) skip *.test.ts but include this helper.
// That's intentional — the helper is small enough that a dropped branch
// here would show up as a coverage regression in test code, which is fine.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ofCents, ofDollars, ZERO, type Money } from '@shared/money';

import type { CpiPoint, Lot, PriceHistory, PricePoint, Scope, Tx, TxType } from './types';

export interface TxOverrides {
  id?: number;
  account_id?: number;
  security_id?: number | null;
  transaction_type?: TxType;
  transaction_date?: Date;
  quantity?: number;
  price_cents?: Money | null;
  amount_cents?: Money;
  fee_cents?: Money | null;
  currency_code?: string;
}

let nextId = 1;
export function resetTxIds(): void {
  nextId = 1;
}

export function buildTx(overrides: TxOverrides = {}): Tx {
  return {
    id: overrides.id ?? nextId++,
    account_id: overrides.account_id ?? 1,
    security_id: overrides.security_id === undefined ? 1 : overrides.security_id,
    transaction_type: overrides.transaction_type ?? 'buy',
    transaction_date: overrides.transaction_date ?? new Date('2026-01-01T00:00:00Z'),
    quantity: overrides.quantity ?? 100,
    price_cents: overrides.price_cents === undefined ? ofDollars(10) : overrides.price_cents,
    amount_cents: overrides.amount_cents ?? ofDollars(1000),
    fee_cents: overrides.fee_cents === undefined ? null : overrides.fee_cents,
    currency_code: overrides.currency_code ?? 'USD',
  };
}

// Convenience shortcuts used by golden tests.
export const D = (dollars: number): Money => ofDollars(dollars);
export const C = (cents: number): Money => ofCents(cents);
export const Z: Money = ZERO;

// Builds a UTC date from "YYYY-MM-DD" — short form used by slice 2 tests
// where the exact time-of-day is irrelevant.
export function dateD(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

// Build a PriceHistory map from an inline literal. Each entry is
// [securityId, [[isoDate, cents], ...]]. Dates are normalized via dateD.
export function buildPriceHistory(
  entries: ReadonlyArray<readonly [number, ReadonlyArray<readonly [string, number]>]>,
): PriceHistory {
  const out = new Map<number, ReadonlyArray<PricePoint>>();
  for (const [sec, pts] of entries) {
    out.set(
      sec,
      pts.map(([d, c]) => ({ date: dateD(d), price_cents: C(c) })),
    );
  }
  return out;
}

// Build a CpiSeries from inline literals: [[isoDate, indexValue], ...].
export function buildCpiSeries(
  entries: ReadonlyArray<readonly [string, number]>,
): ReadonlyArray<CpiPoint> {
  return entries.map(([d, idx]) => ({ date: dateD(d), index: idx }));
}

// ─── fixture loading ────────────────────────────────────────────────────

// Raw (JSON-serialized) counterparts of the domain types: Dates are ISO
// strings and Money is a plain cents number until revived below.
export type RawTx = Omit<
  Tx,
  'transaction_date' | 'price_cents' | 'amount_cents' | 'fee_cents'
> & {
  transaction_date: string;
  price_cents: number | null;
  amount_cents: number;
  fee_cents: number | null;
};

export interface RawPricePoint {
  date: string;
  price_cents: number;
}

// Top-level fixture shapes, one per consuming test. Kept here so call sites
// pass the shape as loadFixture's type argument instead of leaning on `any`.
export interface ValuationFixture {
  transactions: RawTx[];
  price_history: Record<string, RawPricePoint[]>;
  range: { from: string; to: string };
  scope: Scope;
  max_staleness_days?: number;
  expected?: Record<string, number>;
}

export interface DrawdownFixture extends ValuationFixture {
  expected: { max_drawdown_pct_approx: number };
}

export interface RealReturnFixture {
  cpi: Array<{ date: string; index: number }>;
  nominal_pct_total: number;
  range: { from: string; to: string };
  expected: { cpi_change_pct_approx: number; real_pct_approx: number };
}

export interface RawLot {
  sourceTxId: number;
  account_id: number;
  security_id: number;
  acquired_at: string;
  quantity: number;
  cost_basis_cents: number;
  currency_code: string;
}

export interface AllocationFixture {
  snapshot: {
    positions: Array<{
      account_id: number;
      security_id: number;
      quantity: number;
      cost_basis_cents: number;
      current_price_cents: number;
      market_value_cents: number;
      unrealized_gain_cents: number;
      currency_code: string;
    }>;
    total_cost_basis_cents: number;
    total_market_value_cents: number;
    total_unrealized_gain_cents: number;
    as_of: string;
  };
  securities: Record<string, { asset_class: string }>;
  expected: { equity_pct: number; bond_pct: number };
}

export interface TagAllocationFixture {
  snapshot: AllocationFixture['snapshot'];
  lots: RawLot[];
  // Keyed by sourceTxId (string, as JSON object keys must be). Opening buys
  // absent from this map are untagged.
  lotTags: Record<string, string[]>;
  expected: {
    core_pct: number;
    long_term_pct: number;
    untagged_pct: number;
    total_market_value_cents: number;
  };
}

// Loads a JSON fixture under tests/fixtures/financial/ by name. The caller
// supplies the expected shape as the type argument.
export function loadFixture<T>(name: string): T {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '../../../tests/fixtures/financial', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// Converts a raw lot array (parsed JSON) into Lot[] by reviving the Date
// and Money fields.
export function reviveLots(raw: readonly RawLot[]): Lot[] {
  return raw.map((l) => ({
    ...l,
    acquired_at: new Date(l.acquired_at),
    cost_basis_cents: ofCents(l.cost_basis_cents),
  }));
}

// Converts a raw transactions array (parsed JSON) into Tx[] by reviving
// Date and Money fields.
export function reviveTxns(raw: readonly RawTx[]): Tx[] {
  return raw.map((t) => ({
    ...t,
    transaction_date: new Date(t.transaction_date),
    price_cents: t.price_cents === null ? null : ofCents(t.price_cents),
    amount_cents: ofCents(t.amount_cents),
    fee_cents: t.fee_cents === null ? null : ofCents(t.fee_cents),
  }));
}

// Converts a raw price-history object (parsed JSON keyed by string
// security_id) into the PriceHistory Map shape the engine expects.
export function revivePrices(raw: Record<string, readonly RawPricePoint[]>): PriceHistory {
  const out = new Map<number, PricePoint[]>();
  for (const [secId, pts] of Object.entries(raw)) {
    out.set(
      Number(secId),
      pts.map((p) => ({ date: new Date(p.date), price_cents: ofCents(p.price_cents) })),
    );
  }
  return out;
}

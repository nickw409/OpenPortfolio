// Tiny test-only builders for the financial engine. Kept inside src/ so
// tests can import via the same module-graph as production code; coverage
// exclusions (vitest.config.ts) skip *.test.ts but include this helper.
// That's intentional — the helper is small enough that a dropped branch
// here would show up as a coverage regression in test code, which is fine.

import { ofCents, ofDollars, ZERO, type Money } from '@shared/money';

import type { Tx, TxType } from './types';

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

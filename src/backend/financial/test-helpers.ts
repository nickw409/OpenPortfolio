// Tiny test-only builders for the financial engine. Kept inside src/ so
// tests can import via the same module-graph as production code; coverage
// exclusions (vitest.config.ts) skip *.test.ts but include this helper.
// That's intentional — the helper is small enough that a dropped branch
// here would show up as a coverage regression in test code, which is fine.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ofCents, ofDollars, ZERO, type Money } from '@shared/money';

import type { CpiPoint, PriceHistory, PricePoint, Tx, TxType } from './types';

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

// Loads a JSON fixture under tests/fixtures/financial/ by name.
export function loadFixture(name: string): any {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '../../../tests/fixtures/financial', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Converts a raw transactions array (parsed JSON) into Tx[] by reviving
// Date and Money fields.
export function reviveTxns(raw: any[]): Tx[] {
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
export function revivePrices(raw: Record<string, any[]>): PriceHistory {
  const out = new Map<number, any[]>();
  for (const [secId, pts] of Object.entries(raw)) {
    out.set(
      Number(secId),
      pts.map((p) => ({ date: new Date(p.date), price_cents: ofCents(p.price_cents) })),
    );
  }
  return out;
}

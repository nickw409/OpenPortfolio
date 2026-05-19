// Per-security position aggregator. Sums an ordered set of open lots for
// one (account, security), optionally valuing them at a supplied current
// price.

import { ZERO, multiplyByRatio, subtract, sum, type Money } from '@shared/money';

import type { Lot, PositionSnapshot } from './types';

export interface ComputePositionOptions {
  // Optional current price for the security; if supplied, market value and
  // unrealized gain are computed, otherwise both are null.
  currentPriceCents?: Money;
}

// `lots` must be non-empty and all share the same (account_id, security_id,
// currency_code). Returns null when there are no lots.
export function computePosition(
  lots: readonly Lot[],
  opts: ComputePositionOptions = {},
): PositionSnapshot | null {
  if (lots.length === 0) return null;

  const first = lots[0]!;
  const totalQty = lots.reduce((s, l) => s + l.quantity, 0);
  const totalBasis = sum(lots.map((l) => l.cost_basis_cents));

  const price = opts.currentPriceCents ?? null;
  const marketValue: Money | null = price === null ? null : multiplyByRatio(price, totalQty);
  const unrealized: Money | null = marketValue === null ? null : subtract(marketValue, totalBasis);

  return {
    account_id: first.account_id,
    security_id: first.security_id,
    quantity: totalQty,
    cost_basis_cents: totalBasis,
    current_price_cents: price,
    market_value_cents: marketValue,
    unrealized_gain_cents: unrealized,
    currency_code: first.currency_code,
  };
}

// Convenience: when lots are exactly empty, return a zero-quantity snapshot.
// Used by the portfolio aggregator for groups that produced no open lots.
export function emptyPosition(
  account_id: number,
  security_id: number,
  currency_code: string,
): PositionSnapshot {
  return {
    account_id,
    security_id,
    quantity: 0,
    cost_basis_cents: ZERO,
    current_price_cents: null,
    market_value_cents: null,
    unrealized_gain_cents: null,
    currency_code,
  };
}

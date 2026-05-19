// Portfolio-wide aggregator. Groups a mixed transaction stream by
// (account_id, security_id), runs computeLots on each group, aggregates
// the resulting positions and closed lots. Method may be a constant or a
// per-account function (the service layer typically passes a function that
// reads accounts.cost_basis_method).

import { ZERO, add, type Money } from '@shared/money';

import { FinancialError } from './errors';
import { computeLots } from './lots';
import { computePosition } from './position';
import type {
  ClosedLot,
  CostBasisMethod,
  Lot,
  LotSelectionMap,
  PortfolioSnapshot,
  PositionSnapshot,
  PriceMap,
  Tx,
} from './types';

export type MethodResolver = CostBasisMethod | ((accountId: number) => CostBasisMethod);

export interface ComputePortfolioOptions {
  method: MethodResolver;
  asOf?: Date;
  prices?: PriceMap;
  lotSelections?: LotSelectionMap;
}

export interface PortfolioResult {
  snapshot: PortfolioSnapshot;
  // Open lots per group, in case downstream wants lot-level detail.
  openLots: Lot[];
  // All closed lots realized over the walked history (up to asOf).
  closedLots: ClosedLot[];
}

export function computePortfolio(
  txns: readonly Tx[],
  opts: ComputePortfolioOptions,
): PortfolioResult {
  validatePortfolioCurrency(txns);

  const resolveMethod: (accountId: number) => CostBasisMethod =
    typeof opts.method === 'function' ? opts.method : () => opts.method as CostBasisMethod;

  const groups = groupByAccountSecurity(txns);

  const positions: PositionSnapshot[] = [];
  const allOpenLots: Lot[] = [];
  const allClosedLots: ClosedLot[] = [];

  for (const group of groups) {
    const { openLots, closedLots } = computeLots(group.txns, {
      method: resolveMethod(group.account_id),
      asOf: opts.asOf,
      lotSelections: opts.lotSelections,
    });
    allOpenLots.push(...openLots);
    allClosedLots.push(...closedLots);

    if (openLots.length === 0) continue;
    const price = opts.prices?.get(group.security_id);
    const snap = computePosition(openLots, { currentPriceCents: price });
    if (snap) positions.push(snap);
  }

  let totalCost: Money = ZERO;
  let totalValue: Money = ZERO;
  let totalUnrealized: Money = ZERO;
  let anyMissingPrice = false;
  for (const p of positions) {
    totalCost = add(totalCost, p.cost_basis_cents);
    if (p.market_value_cents === null || p.unrealized_gain_cents === null) {
      anyMissingPrice = true;
    } else {
      totalValue = add(totalValue, p.market_value_cents);
      totalUnrealized = add(totalUnrealized, p.unrealized_gain_cents);
    }
  }

  return {
    snapshot: {
      positions,
      total_cost_basis_cents: totalCost,
      total_market_value_cents: anyMissingPrice ? null : totalValue,
      total_unrealized_gain_cents: anyMissingPrice ? null : totalUnrealized,
      as_of: opts.asOf ?? new Date(),
    },
    openLots: allOpenLots,
    closedLots: allClosedLots,
  };
}

function validatePortfolioCurrency(txns: readonly Tx[]): void {
  if (txns.length === 0) return;
  // Compare against the first non-deposit/withdrawal currency (deposits in
  // a foreign account would otherwise force-fail single-currency setups).
  let baseline: string | undefined;
  for (const t of txns) {
    if (baseline === undefined) {
      baseline = t.currency_code;
      continue;
    }
    if (t.currency_code !== baseline) {
      throw new FinancialError(
        'unsupported.mixed_currency',
        'computePortfolio does not support mixed-currency portfolios in v1.0',
        { expected: baseline, got: t.currency_code, tx_id: t.id },
      );
    }
  }
}

interface Group {
  account_id: number;
  security_id: number;
  txns: Tx[];
}

function groupByAccountSecurity(txns: readonly Tx[]): Group[] {
  const map = new Map<string, Group>();
  for (const t of txns) {
    if (t.security_id == null) continue; // cash-only txns don't form positions
    const key = `${t.account_id}|${t.security_id}`;
    let g = map.get(key);
    if (!g) {
      g = { account_id: t.account_id, security_id: t.security_id, txns: [] };
      map.set(key, g);
    }
    g.txns.push(t);
  }
  return [...map.values()];
}

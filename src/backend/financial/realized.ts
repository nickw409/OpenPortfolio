// Realized gain / loss summarizer. Operates on the ClosedLot stream
// produced by computeLots/computePortfolio. Date range filtering is
// inclusive on both ends and applied against `disposed_at`.

import { ZERO, sum, subtract, type Money } from '@shared/money';

import type { ClosedLot, RealizedSummary } from './types';

export interface RealizedRange {
  from?: Date;
  to?: Date;
}

export function computeRealizedGainsLoss(
  closedLots: readonly ClosedLot[],
  range: RealizedRange = {},
): RealizedSummary {
  const fromMs = range.from?.getTime();
  const toMs = range.to?.getTime();

  const inRange = closedLots.filter((cl) => {
    const ms = cl.disposed_at.getTime();
    if (fromMs !== undefined && ms < fromMs) return false;
    if (toMs !== undefined && ms > toMs) return false;
    return true;
  });

  if (inRange.length === 0) {
    return {
      closedLots: [],
      total_proceeds_cents: ZERO,
      total_cost_cents: ZERO,
      total_realized_gain_cents: ZERO,
    };
  }

  const totalProceeds: Money = sum(inRange.map((cl) => cl.proceeds_cents));
  const totalCost: Money = sum(inRange.map((cl) => cl.cost_basis_cents));
  return {
    closedLots: [...inRange],
    total_proceeds_cents: totalProceeds,
    total_cost_cents: totalCost,
    total_realized_gain_cents: subtract(totalProceeds, totalCost),
  };
}

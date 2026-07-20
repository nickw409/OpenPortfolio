// Allocation breakdown over a portfolio snapshot. Pure aggregation —
// no time-series component, no transaction walk. asset_class / account /
// security partition (weights sum to 100% within rounding); tag dimension
// (Task 14) is attribution (weights can exceed 100%).

import { add, ZERO, type Money } from '@shared/money';

import { FinancialError } from './errors';
import type {
  AllocationBreakdown,
  AllocationBucket,
  AllocationOptions,
  PortfolioSnapshot,
} from './types';

interface BucketAccum {
  market_value_cents: Money;
  cost_basis_cents: Money;
}

function emptyBucket(): BucketAccum {
  return { market_value_cents: ZERO, cost_basis_cents: ZERO };
}

function finalize(
  dimension: AllocationBreakdown['dimension'],
  buckets: Map<string, BucketAccum>,
  totalMv: Money,
): AllocationBreakdown {
  const mvNum = Number(totalMv);
  const out: AllocationBucket[] = [];
  for (const [key, acc] of buckets) {
    out.push({
      key,
      market_value_cents: acc.market_value_cents,
      cost_basis_cents: acc.cost_basis_cents,
      weight_pct: mvNum === 0 ? 0 : (Number(acc.market_value_cents) / mvNum) * 100,
    });
  }
  // Stable ordering: largest bucket first.
  out.sort((a, b) => Number(b.market_value_cents) - Number(a.market_value_cents));
  return { dimension, buckets: out, total_market_value_cents: totalMv };
}

export function computeAllocation(
  snapshot: PortfolioSnapshot,
  opts: AllocationOptions,
): AllocationBreakdown {
  const buckets = new Map<string, BucketAccum>();
  let totalMv: Money = ZERO;

  for (const pos of snapshot.positions) {
    const mv = pos.market_value_cents ?? ZERO;
    totalMv = add(totalMv, mv);

    let key: string;
    if (opts.dimension === 'asset_class') {
      const entry = opts.securities?.get(pos.security_id);
      if (!entry || entry.asset_class == null) {
        throw new FinancialError(
          'allocation.missing_security',
          'security not in lookup map (asset_class)',
          { id: pos.security_id },
        );
      }
      key = entry.asset_class;
    } else if (opts.dimension === 'account') {
      const entry = opts.accounts?.get(pos.account_id);
      if (!entry) {
        throw new FinancialError(
          'allocation.missing_account',
          'account not in lookup map',
          { id: pos.account_id },
        );
      }
      key = entry.name;
    } else if (opts.dimension === 'security') {
      const entry = opts.securities?.get(pos.security_id);
      key = entry?.symbol ?? `security:${pos.security_id}`;
    } else {
      // 'tag' handled in Task 14
      throw new RangeError(`unsupported dimension: ${opts.dimension}`);
    }

    const acc = buckets.get(key) ?? emptyBucket();
    acc.market_value_cents = add(acc.market_value_cents, mv);
    acc.cost_basis_cents = add(acc.cost_basis_cents, pos.cost_basis_cents);
    buckets.set(key, acc);
  }

  return finalize(opts.dimension, buckets, totalMv);
}

// Allocation breakdown over a portfolio snapshot. Pure aggregation —
// no time-series component, no transaction walk. asset_class / account /
// security partition (weights sum to 100% within rounding); the tag
// dimension is attribution over the lot stream — a lot inherits its opening
// buy's tags and contributes its full market value to each, so tag weights
// can exceed 100%.

import { add, multiplyByRatio, ZERO, type Money } from '@shared/money';

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
  // Tag is attribution over lots, not a partition over positions — a single
  // position can span lots with different tags — so it runs its own path.
  if (opts.dimension === 'tag') {
    return allocateByTag(snapshot, opts);
  }

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
        throw new FinancialError('allocation.missing_account', 'account not in lookup map', {
          id: pos.account_id,
        });
      }
      key = entry.name;
    } else if (opts.dimension === 'security') {
      const entry = opts.securities?.get(pos.security_id);
      key = entry?.symbol ?? `security:${pos.security_id}`;
    } else {
      throw new RangeError(`unsupported dimension: ${opts.dimension}`);
    }

    const acc = buckets.get(key) ?? emptyBucket();
    acc.market_value_cents = add(acc.market_value_cents, mv);
    acc.cost_basis_cents = add(acc.cost_basis_cents, pos.cost_basis_cents);
    buckets.set(key, acc);
  }

  return finalize(opts.dimension, buckets, totalMv);
}

// Tag attribution over the lot stream. Each lot's market value is
// quantity × current price (reconstructed from the snapshot, since a Lot
// carries cost basis but not market value) and is added to every tag its
// opening buy carried. Lots whose opening buy had no tags land in a single
// "(untagged)" bucket. The denominator is the portfolio total (each lot
// counted once), so multi-tagged lots make the bucket weights sum past 100%.
function allocateByTag(snapshot: PortfolioSnapshot, opts: AllocationOptions): AllocationBreakdown {
  const { lots, lotTags } = opts;
  if (!lots || !lotTags) {
    throw new RangeError("allocation dimension 'tag' requires both lots and lotTags");
  }

  const priceByPos = new Map<string, Money>();
  for (const pos of snapshot.positions) {
    priceByPos.set(`${pos.account_id}:${pos.security_id}`, pos.current_price_cents ?? ZERO);
  }

  const buckets = new Map<string, BucketAccum>();
  let totalMv: Money = ZERO;
  for (const lot of lots) {
    const price = priceByPos.get(`${lot.account_id}:${lot.security_id}`) ?? ZERO;
    const mv = multiplyByRatio(price, lot.quantity);
    totalMv = add(totalMv, mv);

    const tags = lotTags.get(lot.sourceTxId);
    const keys = tags && tags.length > 0 ? tags : ['(untagged)'];
    for (const key of keys) {
      const acc = buckets.get(key) ?? emptyBucket();
      acc.market_value_cents = add(acc.market_value_cents, mv);
      acc.cost_basis_cents = add(acc.cost_basis_cents, lot.cost_basis_cents);
      buckets.set(key, acc);
    }
  }

  return finalize('tag', buckets, totalMv);
}

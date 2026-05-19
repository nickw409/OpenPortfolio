// Daily valuation series — the choke point of slice 2. TWR / drawdown /
// real-returns all reduce over this. Pure: takes txns + sparse prices +
// range + scope, returns a per-day series of
// { market_value, cost_basis, external_cashflow, tr_index }.
// See docs/specs/2026-05-19-financial-engine-slice-2.md.

import { add, multiplyByRatio, ZERO, type Money } from '@shared/money';

import { computeLots } from './lots';
import type {
  DateRange,
  PriceHistory,
  Scope,
  Tx,
  ValuationPoint,
  ValuationSeries,
} from './types';

export interface ComputeValuationSeriesOptions {
  scope: Scope;
  // Not yet implemented — Task 6 adds the staleness check.
  maxStalenessDays?: number;
}

const ONE_DAY_MS = 86_400_000;

export function computeValuationSeries(
  txns: ReadonlyArray<Tx>,
  prices: PriceHistory,
  range: DateRange,
  opts: ComputeValuationSeriesOptions,
): ValuationSeries {
  if (range.to.getTime() < range.from.getTime()) {
    throw new RangeError('range.to must be >= range.from');
  }

  // NOTE: `opts.scope` is currently passed through to the returned
  // ValuationSeries.scope but does not yet filter transactions to a
  // single account. Task 5 wires scope-aware filtering: account scope
  // restricts txns to that account_id and counts transfer_in/out as
  // external cashflows; portfolio scope nets cross-account transfers.
  // For now, every invocation behaves as if scope === 'portfolio'.

  // Group transactions by (account_id, security_id) so each call to
  // computeLots sees a uniform group. computeLots validates uniformity and
  // throws on mixed groups.
  const groups = groupTxns(txns);

  // Iterate one day at a time; for each day, snapshot open lots across all
  // groups and value them at the carried-forward price. TR-index and cashflow
  // handling land in later tasks — set both to neutral here.
  const points: ValuationPoint[] = [];
  for (
    let t = range.from.getTime();
    t <= range.to.getTime();
    t += ONE_DAY_MS
  ) {
    const day = new Date(t);

    // TODO(perf): computeLots re-sorts each group's transactions on every
    // day. For long histories with many securities this is gratuitous —
    // pre-sort groups once outside the day loop and memoize open-lot
    // snapshots between days where no transaction changes the lot set.
    let marketValue: Money = ZERO;
    let costBasis: Money = ZERO;
    for (const group of groups) {
      const { openLots } = computeLots(group, { method: 'fifo', asOf: day });
      // Cost basis sums all open lots regardless of price availability —
      // it's "what you paid" and doesn't depend on a live market quote.
      // Market value sums only lots with a recoverable price. Task 6
      // promotes the null-price case to a `price.stale` throw, eliminating
      // the asymmetry in production.
      for (const lot of openLots) {
        const price = lookupCarryForwardPrice(prices, lot.security_id, day);
        if (price !== null) {
          marketValue = add(marketValue, multiplyByRatio(price, lot.quantity));
        }
        costBasis = add(costBasis, lot.cost_basis_cents);
      }
    }

    points.push({
      date: day,
      market_value_cents: marketValue,
      cost_basis_cents: costBasis,
      external_cashflow_cents: ZERO, // Task 6: cashflow filter
      tr_index: 1.0,                 // Task 5: TR-index walk
    });
  }

  return { points, scope: opts.scope, range };
}

// Groups transactions by (account_id, security_id) into slices that
// computeLots can accept. Transactions with null security_id (cash events
// like deposit/withdrawal) have no lots and are dropped here — they don't
// affect market value.
function groupTxns(txns: ReadonlyArray<Tx>): Array<Tx[]> {
  const map = new Map<string, Tx[]>();
  for (const tx of txns) {
    if (tx.security_id === null) continue;
    const key = `${tx.account_id}:${tx.security_id}`;
    let group = map.get(key);
    if (!group) {
      group = [];
      map.set(key, group);
    }
    group.push(tx);
  }
  return Array.from(map.values());
}

// Returns the most recent price at or before `date` for `securityId`,
// or null if no such price exists in the series. Forward-only (never
// reaches backward in time). Staleness check is applied separately
// in Task 6.
function lookupCarryForwardPrice(
  prices: PriceHistory,
  securityId: number,
  date: Date,
): Money | null {
  const series = prices.get(securityId);
  if (!series || series.length === 0) return null;
  const t = date.getTime();
  // Binary search for the largest index with date <= t.
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid]!.date.getTime() <= t) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo - 1;
  if (idx < 0) return null;
  return series[idx]!.price_cents;
}

// Daily valuation series — the choke point of slice 2. TWR / drawdown /
// real-returns all reduce over this. Pure: takes txns + sparse prices +
// range + scope, returns a per-day series of
// { market_value, cost_basis, external_cashflow, tr_index }.
// See docs/specs/2026-05-19-financial-engine-slice-2.md.

import { add, multiplyByRatio, negate, ZERO, type Money } from '@shared/money';

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

  // Group transactions by (account_id, security_id) so each call to
  // computeLots sees a uniform group. computeLots validates uniformity and
  // throws on mixed groups.
  const allGroups = groupTxns(txns);
  const scopedAccountId = typeof opts.scope === 'object' ? opts.scope.account_id : null;
  const groupsForScope =
    scopedAccountId !== null
      ? allGroups.filter((g) => g[0]!.account_id === scopedAccountId)
      : allGroups;

  // Iterate one day at a time; for each day, snapshot open lots across all
  // groups and value them at the carried-forward price. External cashflows
  // are summed per scope; TR-index chains from those daily returns.
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
    for (const group of groupsForScope) {
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

    const cashflow = externalCashflowOnDay(txns, day, opts.scope);

    let trIndex = 1.0;
    if (points.length > 0) {
      const prev = points[points.length - 1]!;
      // Start-of-day cashflow convention: today's deposit is treated as
      // arriving at start of day and earns the day's return. The capital
      // base is V_open + CF; daily_return = V_close / (V_open + CF) − 1.
      const vOpen = Number(prev.market_value_cents);
      const cfNum = Number(cashflow);
      const base = vOpen + cfNum;
      if (base > 0) {
        const dailyReturn = Number(marketValue) / base - 1;
        trIndex = prev.tr_index * (1 + dailyReturn);
      } else {
        trIndex = prev.tr_index; // pre-funding day — no return to apply
      }
    }

    points.push({
      date: day,
      market_value_cents: marketValue,
      cost_basis_cents: costBasis,
      external_cashflow_cents: cashflow,
      tr_index: trIndex,
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

// Sums external cashflows on `date` under the chosen scope. Portfolio
// scope: deposit (+) and withdrawal (−) only. Account scope: also
// transfer_in (+) and transfer_out (−) for the chosen account.
function externalCashflowOnDay(
  txns: ReadonlyArray<Tx>,
  date: Date,
  scope: Scope,
): Money {
  const dayStart = startOfUtcDay(date).getTime();
  const dayEnd = dayStart + ONE_DAY_MS;
  const accountId = typeof scope === 'object' ? scope.account_id : null;

  let sum: Money = ZERO;
  for (const tx of txns) {
    const t = tx.transaction_date.getTime();
    if (t < dayStart || t >= dayEnd) continue;
    if (accountId !== null && tx.account_id !== accountId) continue;

    const kind = tx.transaction_type;
    if (kind === 'deposit') sum = add(sum, tx.amount_cents);
    else if (kind === 'withdrawal') sum = add(sum, negate(tx.amount_cents));
    else if (accountId !== null && kind === 'transfer_in') sum = add(sum, tx.amount_cents);
    else if (accountId !== null && kind === 'transfer_out')
      sum = add(sum, negate(tx.amount_cents));
  }
  return sum;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
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

// Money-weighted return — IRR of (start value + cashflows + end value),
// annualized via 365.25-day year. Newton-Raphson seeded with TWR; bisection
// fallback added in the follow-up commit (Task 10).

import { computeTimeWeightedReturn } from './twr';
import { FinancialError } from './errors';
import type { MwrResult, ValuationSeries } from './types';

const DAYS_PER_YEAR = 365.25;
const NEWTON_MAX_ITER = 100;
const ABS_NPV_TOL_CENTS = 1; // |NPV(r)| < 1 cent
const REL_R_TOL = 1e-10;

interface Cashflow {
  amount_cents: number;
  years_from_start: number;
}

// Collects external cashflows (in cents) and the implied start/end values.
// Sign convention: deposits positive, withdrawals negative.
function buildCashflows(series: ValuationSeries): {
  start_value_cents: number;
  end_value_cents: number;
  flows: Cashflow[];
} {
  const first = series.points[0]!;
  const last = series.points[series.points.length - 1]!;
  const startMs = first.date.getTime();
  const flows: Cashflow[] = [];
  // market_value_cents on any day reflects end-of-day portfolio value after
  // all transactions on that day. Day-0 cashflows are already embedded in
  // day-0 market_value (the bought shares are priced at cost). Adding the
  // cashflow on top would double-count it.
  const startVal = Number(first.market_value_cents);
  // Intermediate flows: days 1..N-2 inclusive (day 0 is the start bookend;
  // day N is the end bookend — both are already in their respective market
  // values and must not appear again as intermediate flows).
  for (let i = 1; i < series.points.length - 1; i++) {
    const p = series.points[i]!;
    const cf = Number(p.external_cashflow_cents);
    if (cf !== 0) {
      flows.push({
        amount_cents: cf,
        years_from_start: (p.date.getTime() - startMs) / 86_400_000 / DAYS_PER_YEAR,
      });
    }
  }
  // End value is likewise the closing market value — day-N cashflows are
  // already in that value and must not be double-subtracted.
  const endVal = Number(last.market_value_cents);
  return { start_value_cents: startVal, end_value_cents: endVal, flows };
}

function npv(r: number, start: number, end: number, flows: Cashflow[], years: number): number {
  // NPV in cents.
  let val = -start;
  for (const f of flows) {
    val -= f.amount_cents / Math.pow(1 + r, f.years_from_start);
  }
  val += end / Math.pow(1 + r, years);
  return val;
}

function npvPrime(r: number, end: number, flows: Cashflow[], years: number): number {
  // d NPV / dr.
  let d = 0;
  for (const f of flows) {
    d += (f.amount_cents * f.years_from_start) / Math.pow(1 + r, f.years_from_start + 1);
  }
  d -= (end * years) / Math.pow(1 + r, years + 1);
  return d;
}

export function computeMoneyWeightedReturn(series: ValuationSeries): MwrResult {
  if (series.points.length === 0) throw new RangeError('series.points must be non-empty');
  const { start_value_cents, end_value_cents, flows } = buildCashflows(series);
  if (start_value_cents <= 0) {
    throw new FinancialError(
      'irr.bad_initial_state',
      'IRR requires a positive starting value',
      { scope: series.scope, start_value_cents },
    );
  }
  const totalYears =
    (series.points[series.points.length - 1]!.date.getTime() -
      series.points[0]!.date.getTime()) /
    86_400_000 /
    DAYS_PER_YEAR;

  // Seed from TWR — usually within a few percent of IRR.
  const twr = computeTimeWeightedReturn(series);
  const seedAnnual =
    twr.annualized_pct !== null ? twr.annualized_pct / 100 : twr.return_pct / 100;
  let r = Number.isFinite(seedAnnual) ? seedAnnual : 0;

  let iter = 0;
  while (iter < NEWTON_MAX_ITER) {
    const v = npv(r, start_value_cents, end_value_cents, flows, totalYears);
    if (Math.abs(v) < ABS_NPV_TOL_CENTS) {
      return { irr_pct: r * 100, iterations: iter, method: 'newton' };
    }
    const dv = npvPrime(r, end_value_cents, flows, totalYears);
    if (dv === 0 || !Number.isFinite(dv)) break;
    const next = r - v / dv;
    if (!Number.isFinite(next) || next <= -0.99 || next >= 10.0) break;
    if (Math.abs(next - r) < REL_R_TOL) {
      return { irr_pct: next * 100, iterations: iter + 1, method: 'newton' };
    }
    r = next;
    iter++;
  }

  // Newton failed — Task 10 plugs in bisection. Throw for now.
  throw new FinancialError(
    'irr.no_convergence',
    'Newton-Raphson did not converge; bisection fallback not yet implemented',
    { last_estimate: r, iterations: iter },
  );
}

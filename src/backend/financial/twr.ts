// Time-weighted return — geometric chain of daily returns expressed via
// the valuation series's tr_index. Annualization uses 365.25-day year.

import type { TwrResult, ValuationSeries } from './types';

// 365.25 is used in two roles, intentionally tied together: (a) the
// annualization exponent denominator, and (b) the gate that decides
// whether annualization fires at all. A range of exactly 365 days
// (one non-leap-year) produces days = 365.0 < 365.25, so annualized_pct
// is null. Annualizing a sub-year return is a forecasting move we don't
// make in the engine; callers can do it themselves if they want it.
const DAYS_PER_YEAR = 365.25;
const ONE_DAY_MS = 86_400_000;

export function computeTimeWeightedReturn(series: ValuationSeries): TwrResult {
  if (series.points.length === 0) {
    throw new RangeError('series.points must be non-empty');
  }
  const first = series.points[0]!;
  const last = series.points[series.points.length - 1]!;
  const totalReturn = last.tr_index / first.tr_index - 1;
  const days = (last.date.getTime() - first.date.getTime()) / ONE_DAY_MS;
  const annualized =
    days >= DAYS_PER_YEAR ? (Math.pow(1 + totalReturn, DAYS_PER_YEAR / days) - 1) * 100 : null;
  return {
    return_pct: totalReturn * 100,
    annualized_pct: annualized,
    days,
  };
}

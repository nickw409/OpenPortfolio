// CPI helpers. Linear interpolation between adjacent monthly BLS CPI-U
// release-date / index-value points. Strict out-of-range behavior: the
// engine never extrapolates — extrapolation is a forecast, and forecasts
// don't belong in audited calc code. See
// docs/specs/2026-05-19-financial-engine-slice-2.md F6.

import { FinancialError } from './errors';
import type { CpiSeries, DateRange, RealReturnResult } from './types';

// Returns the CPI index at `date`, interpolating linearly between adjacent
// release-date points. Throws `cpi.out_of_range` if `date` is outside
// [first.date, last.date] or the series is empty.
export function cpiAt(cpi: CpiSeries, date: Date): number {
  if (cpi.length === 0) {
    throw new FinancialError('cpi.out_of_range', 'CPI series is empty', { requested_date: date });
  }
  const t = date.getTime();
  const first = cpi[0]!;
  const last = cpi[cpi.length - 1]!;
  if (t < first.date.getTime() || t > last.date.getTime()) {
    throw new FinancialError('cpi.out_of_range', 'CPI series does not cover the requested date', {
      requested_date: date,
      cpi_range: { from: first.date, to: last.date },
    });
  }
  // Binary search for the segment that brackets t. The series is small
  // enough that a linear scan would also be fast; binary search is used
  // here for clarity.
  let lo = 0;
  let hi = cpi.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (cpi[mid]!.date.getTime() <= t) lo = mid;
    else hi = mid;
  }
  const a = cpi[lo]!;
  const b = cpi[hi]!;
  if (a.date.getTime() === t) return a.index;
  if (b.date.getTime() === t) return b.index;
  const frac = (t - a.date.getTime()) / (b.date.getTime() - a.date.getTime());
  return a.index + (b.index - a.index) * frac;
}

// Period-boundary deflation: real = (1+nominal)/(1+cpi_change) − 1.
// `nominal_pct` and the returned `real_pct`/`cpi_change_pct` are all in
// percent (10 means +10%, not +1000%).
export function computeRealReturn(
  nominal_pct: number,
  range: DateRange,
  cpi: CpiSeries,
): RealReturnResult {
  if (range.to.getTime() < range.from.getTime()) {
    throw new RangeError('range.to must be >= range.from');
  }
  const cpiStart = cpiAt(cpi, range.from);
  const cpiEnd = cpiAt(cpi, range.to);
  if (cpiStart <= 0) {
    throw new FinancialError(
      'cpi.out_of_range',
      'CPI index at range start is not positive; cannot deflate',
      { requested_date: range.from, cpi_index: cpiStart },
    );
  }
  const cpiChange = cpiEnd / cpiStart - 1;
  const nominal = nominal_pct / 100;
  const real = (1 + nominal) / (1 + cpiChange) - 1;
  return {
    real_pct: real * 100,
    cpi_change_pct: cpiChange * 100,
  };
}

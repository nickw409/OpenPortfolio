// Drawdown: peak/trough/recovery on the TR index (cashflow-neutral by
// construction). Real branch added in the follow-up commit (Task 12).

import type {
  CpiSeries,
  DrawdownResult,
  DrawdownStats,
  ValuationSeries,
} from './types';

interface IndexPoint {
  date: Date;
  value: number;
}

function statsFromSeries(idx: ReadonlyArray<IndexPoint>): DrawdownStats {
  if (idx.length === 0) {
    throw new RangeError('drawdown requires non-empty series');
  }
  let runningPeak = idx[0]!.value;
  let runningPeakDate = idx[0]!.date;
  let maxDdPct = 0;
  let maxDdPeak: Date = runningPeakDate;
  let maxDdTrough: Date = runningPeakDate;
  let maxDdPeakValue: number = runningPeak;

  for (let i = 0; i < idx.length; i++) {
    const p = idx[i]!;
    if (p.value > runningPeak) {
      runningPeak = p.value;
      runningPeakDate = p.date;
    }
    const ddPct = (p.value / runningPeak - 1) * 100;
    if (ddPct < maxDdPct) {
      maxDdPct = ddPct;
      maxDdPeak = runningPeakDate;
      maxDdTrough = p.date;
      maxDdPeakValue = runningPeak;
    }
  }

  // Recovery: smallest date strictly after maxDdTrough where value >= peak's value at maxDdPeak.
  let recoveryDate: Date | null = null;
  for (const p of idx) {
    if (p.date.getTime() <= maxDdTrough.getTime()) continue;
    if (p.value >= maxDdPeakValue) {
      recoveryDate = p.date;
      break;
    }
  }

  const last = idx[idx.length - 1]!;
  const currentDdPct = (last.value / runningPeak - 1) * 100;

  return {
    max_drawdown_pct: maxDdPct,
    max_drawdown_peak_date: maxDdPeak,
    max_drawdown_trough_date: maxDdTrough,
    max_drawdown_recovery_date: recoveryDate,
    current_drawdown_pct: currentDdPct,
    current_peak_date: runningPeakDate,
  };
}

export function computeDrawdown(
  series: ValuationSeries,
  // NOTE: `cpi` is accepted now so the API doesn't churn when Task 12
  // wires the real-deflated drawdown branch. For this task, supplying
  // cpi has no effect — `real` is always null.
  cpi?: CpiSeries,
): DrawdownResult {
  void cpi; // consumed here so noUnusedParameters is satisfied; Task 12 will use it
  const nominalIdx = series.points.map((p) => ({ date: p.date, value: p.tr_index }));
  return {
    nominal: statsFromSeries(nominalIdx),
    real: null, // Task 12 fills this in when cpi is supplied
  };
}

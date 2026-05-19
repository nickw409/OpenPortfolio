import { computeDrawdown } from './drawdown';
import { computeValuationSeries } from './valuation';
import { buildPriceHistory, buildTx, D, dateD, resetTxIds } from './test-helpers';

beforeEach(() => resetTxIds());

describe('computeDrawdown — flat market', () => {
  it('no drawdown when prices are flat', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2026-01-07', 1000], ['2026-01-10', 1000]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-10') },
      { scope: 'portfolio' },
    );
    const result = computeDrawdown(series);
    expect(result.nominal.max_drawdown_pct).toBe(0);
    expect(result.nominal.current_drawdown_pct).toBe(0);
    expect(result.real).toBeNull();
  });
});

describe('computeDrawdown — peak / trough / recovery', () => {
  it('detects a 50% drawdown and its recovery', () => {
    // Index: 1.0 → 2.0 (peak) → 1.0 (50% DD trough) → 2.5 (recovery → new peak).
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-02', 2000], // tr_index 2.0
          ['2026-01-03', 1000], // tr_index 1.0 → 50% DD from prev peak
          ['2026-01-04', 2500], // tr_index 2.5 → recovered past prev peak
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-04') },
      { scope: 'portfolio' },
    );
    const result = computeDrawdown(series);
    expect(result.nominal.max_drawdown_pct).toBeCloseTo(-50, 4);
    expect(result.nominal.max_drawdown_peak_date.toISOString().slice(0, 10)).toBe('2026-01-02');
    expect(result.nominal.max_drawdown_trough_date.toISOString().slice(0, 10)).toBe('2026-01-03');
    expect(result.nominal.max_drawdown_recovery_date!.toISOString().slice(0, 10)).toBe('2026-01-04');
    expect(result.nominal.current_drawdown_pct).toBe(0); // at new high
  });
});

describe('computeDrawdown — unrecovered drawdown', () => {
  it('recovery_date is null when series ends below the peak', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-02', 2000],
          ['2026-01-03', 1500], // 25% off peak
          ['2026-01-04', 1500],
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-04') },
      { scope: 'portfolio' },
    );
    const result = computeDrawdown(series);
    expect(result.nominal.max_drawdown_pct).toBeCloseTo(-25, 4);
    expect(result.nominal.max_drawdown_recovery_date).toBeNull();
    expect(result.nominal.current_drawdown_pct).toBeCloseTo(-25, 4);
  });
});

import { computeDrawdown } from './drawdown';
import { computeValuationSeries } from './valuation';
import {
  buildCpiSeries,
  buildPriceHistory,
  buildTx,
  D,
  dateD,
  loadFixture,
  resetTxIds,
  revivePrices,
  reviveTxns,
  type DrawdownFixture,
} from './test-helpers';
import { FinancialError } from './errors';

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
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-07', 1000],
          ['2026-01-10', 1000],
        ],
      ],
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
    expect(result.nominal.max_drawdown_recovery_date!.toISOString().slice(0, 10)).toBe(
      '2026-01-04',
    );
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

describe('computeDrawdown — real branch', () => {
  it('real drawdown deeper than nominal when CPI inflates through the trough', () => {
    // Nominal TR index: 1.0 → 1.2 → 1.0 → 1.0 (nominal DD = −16.67%).
    // CPI inflates 10% over the period — real index deflated by CPI
    // grows less, so the relative drop from peak is deeper.
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
          ['2026-04-01', 1200],
          ['2026-07-01', 1000],
          ['2026-10-01', 1000],
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-10-01') },
      { scope: 'portfolio', maxStalenessDays: 95 },
    );
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-10-01', 330.0], // +10% over 9 months
    ]);
    const result = computeDrawdown(series, cpi);

    // Nominal drawdown is exactly (1.0 / 1.2) - 1 = -16.67%.
    expect(result.nominal.max_drawdown_pct).toBeCloseTo(-16.67, 1);

    // Real drawdown: peak at 2026-04-01, trough at 2026-07-01 (or 10-01).
    // CPI is linearly interpolated between 300 (Jan 1) and 330 (Oct 1):
    //   cpiAt(Apr 1) ≈ 300 + 30 × (90/273) ≈ 309.89
    //   cpiAt(Jul 1) ≈ 300 + 30 × (181/273) ≈ 319.89
    //   cpiAt(Oct 1) = 330.00
    // Real peak ≈ 1.2 / (309.89/300) ≈ 1.1617
    // Real trough at Oct 1 ≈ 1.0 / (330/300) ≈ 0.9091
    // Real DD ≈ (0.9091 / 1.1617) - 1 ≈ -21.74%
    expect(result.real).not.toBeNull();
    expect(result.real!.max_drawdown_pct).toBeCloseTo(-21.74, 0);

    // Sanity: real deeper than nominal.
    expect(result.real!.max_drawdown_pct).toBeLessThan(result.nominal.max_drawdown_pct);
  });

  it('throws cpi.out_of_range when CPI does not cover the requested range', () => {
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
          ['2026-02-01', 1100],
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-02-01') },
      { scope: 'portfolio', maxStalenessDays: 35 },
    );
    // CPI series ends before the engine's last day.
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-01-15', 301.0],
    ]);
    expect(() => computeDrawdown(series, cpi)).toThrow(FinancialError);
  });
});

describe('fixture: drawdown-2008', () => {
  it('reports ~−40% max drawdown that never recovers', () => {
    const fx = loadFixture<DrawdownFixture>('drawdown-2008');
    const series = computeValuationSeries(
      reviveTxns(fx.transactions),
      revivePrices(fx.price_history),
      { from: new Date(fx.range.from), to: new Date(fx.range.to) },
      { scope: fx.scope, maxStalenessDays: fx.max_staleness_days },
    );
    const result = computeDrawdown(series);
    expect(result.nominal.max_drawdown_pct).toBeCloseTo(fx.expected.max_drawdown_pct_approx, 0);
    expect(result.nominal.max_drawdown_recovery_date).toBeNull();
  });
});

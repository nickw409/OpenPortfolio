import { computeTimeWeightedReturn } from './twr';
import { computeValuationSeries } from './valuation';
import { buildPriceHistory, buildTx, D, dateD, resetTxIds } from './test-helpers';

beforeEach(() => resetTxIds());

describe('computeTimeWeightedReturn — flat market', () => {
  it('0% return on a flat-price hold', () => {
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
      [1, [
        ['2026-01-01', 1000],
        ['2026-01-07', 1000],
        ['2026-01-14', 1000],
        ['2026-01-21', 1000],
        ['2026-01-28', 1000],
        ['2026-01-31', 1000],
      ]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-31') },
      { scope: 'portfolio' },
    );
    const result = computeTimeWeightedReturn(series);
    expect(result.return_pct).toBeCloseTo(0, 8);
    expect(result.days).toBe(30);
    expect(result.annualized_pct).toBeNull();
  });
});

describe('computeTimeWeightedReturn — 10% over 30 days', () => {
  it('return_pct ≈ 10', () => {
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
      [1, [
        ['2026-01-01', 1000],
        ['2026-01-07', 1000],
        ['2026-01-14', 1000],
        ['2026-01-21', 1000],
        ['2026-01-28', 1000],
        ['2026-01-31', 1100],
      ]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-31') },
      { scope: 'portfolio' },
    );
    const result = computeTimeWeightedReturn(series);
    expect(result.return_pct).toBeCloseTo(10, 6);
    expect(result.days).toBe(30);
  });
});

describe('computeTimeWeightedReturn — annualization', () => {
  it('annualized_pct present when range >= 365.25 days', () => {
    // 366-day range so days >= 365.25 (the annualization gate).
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    // Flat at 1000, then jump to 1210 on the last day. Weekly anchors keep
    // the staleness gate from firing over the 366-day span.
    const prices = buildPriceHistory([
      [1, [
        ['2026-01-01', 1000],
        ['2026-01-08', 1000],
        ['2026-01-15', 1000],
        ['2026-01-22', 1000],
        ['2026-01-29', 1000],
        ['2026-02-05', 1000],
        ['2026-02-12', 1000],
        ['2026-02-19', 1000],
        ['2026-02-26', 1000],
        ['2026-03-05', 1000],
        ['2026-03-12', 1000],
        ['2026-03-19', 1000],
        ['2026-03-26', 1000],
        ['2026-04-02', 1000],
        ['2026-04-09', 1000],
        ['2026-04-16', 1000],
        ['2026-04-23', 1000],
        ['2026-04-30', 1000],
        ['2026-05-07', 1000],
        ['2026-05-14', 1000],
        ['2026-05-21', 1000],
        ['2026-05-28', 1000],
        ['2026-06-04', 1000],
        ['2026-06-11', 1000],
        ['2026-06-18', 1000],
        ['2026-06-25', 1000],
        ['2026-07-02', 1000],
        ['2026-07-09', 1000],
        ['2026-07-16', 1000],
        ['2026-07-23', 1000],
        ['2026-07-30', 1000],
        ['2026-08-06', 1000],
        ['2026-08-13', 1000],
        ['2026-08-20', 1000],
        ['2026-08-27', 1000],
        ['2026-09-03', 1000],
        ['2026-09-10', 1000],
        ['2026-09-17', 1000],
        ['2026-09-24', 1000],
        ['2026-10-01', 1000],
        ['2026-10-08', 1000],
        ['2026-10-15', 1000],
        ['2026-10-22', 1000],
        ['2026-10-29', 1000],
        ['2026-11-05', 1000],
        ['2026-11-12', 1000],
        ['2026-11-19', 1000],
        ['2026-11-26', 1000],
        ['2026-12-03', 1000],
        ['2026-12-10', 1000],
        ['2026-12-17', 1000],
        ['2026-12-24', 1000],
        ['2026-12-31', 1000],
        ['2027-01-02', 1210], // +21% over 366 days
      ]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2027-01-02') },
      { scope: 'portfolio' },
    );
    const result = computeTimeWeightedReturn(series);
    expect(result.return_pct).toBeCloseTo(21, 4);
    expect(result.annualized_pct).not.toBeNull();
    // 1.21^(365.25/366) − 1 ≈ 0.20949 → 20.95%
    expect(result.annualized_pct!).toBeCloseTo(20.95, 1);
  });

  it('annualized_pct null when range < 365.25 days', () => {
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
      [1, [
        ['2026-01-01', 1000],
        ['2026-01-08', 1000],
        ['2026-01-15', 1000],
        ['2026-01-22', 1000],
        ['2026-01-29', 1000],
        ['2026-02-05', 1000],
        ['2026-02-12', 1000],
        ['2026-02-19', 1000],
        ['2026-02-26', 1000],
        ['2026-03-05', 1000],
        ['2026-03-12', 1000],
        ['2026-03-19', 1000],
        ['2026-03-26', 1000],
        ['2026-04-02', 1000],
        ['2026-04-09', 1000],
        ['2026-04-16', 1000],
        ['2026-04-23', 1000],
        ['2026-04-30', 1000],
        ['2026-05-07', 1000],
        ['2026-05-14', 1000],
        ['2026-05-21', 1000],
        ['2026-05-28', 1000],
        ['2026-06-04', 1000],
        ['2026-06-11', 1000],
        ['2026-06-18', 1000],
        ['2026-06-25', 1000],
        ['2026-07-02', 1000],
        ['2026-07-09', 1000],
        ['2026-07-16', 1000],
        ['2026-07-23', 1000],
        ['2026-07-30', 1000],
        ['2026-08-06', 1000],
        ['2026-08-13', 1000],
        ['2026-08-20', 1000],
        ['2026-08-27', 1000],
        ['2026-09-03', 1000],
        ['2026-09-10', 1000],
        ['2026-09-17', 1000],
        ['2026-09-24', 1000],
        ['2026-10-01', 1000],
        ['2026-10-08', 1000],
        ['2026-10-15', 1000],
        ['2026-10-22', 1000],
        ['2026-10-29', 1000],
        ['2026-11-05', 1000],
        ['2026-11-12', 1000],
        ['2026-11-19', 1000],
        ['2026-11-26', 1000],
        ['2026-12-03', 1000],
        ['2026-12-10', 1000],
        ['2026-12-17', 1000],
        ['2026-12-24', 1000],
        ['2026-12-31', 1100],
      ]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-12-31') },
      { scope: 'portfolio' },
    );
    expect(computeTimeWeightedReturn(series).annualized_pct).toBeNull();
  });
});

describe('computeTimeWeightedReturn — empty series guard', () => {
  it('throws RangeError on empty series', () => {
    const series = computeValuationSeries(
      [],
      buildPriceHistory([]),
      { from: dateD('2026-01-01'), to: dateD('2026-01-01') },
      { scope: 'portfolio' },
    );
    // Single point series should not throw (return = 0, days = 0).
    // But a manually-empty .points array should throw.
    expect(() => computeTimeWeightedReturn({ ...series, points: [] })).toThrow(RangeError);
  });

  it('single-point series: return_pct = 0, days = 0, annualized_pct = null', () => {
    // Same-day buy and query: series has exactly one point.
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([[1, [['2026-01-01', 1000]]]]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-01') },
      { scope: 'portfolio' },
    );
    expect(series.points).toHaveLength(1);
    const result = computeTimeWeightedReturn(series);
    expect(result.return_pct).toBe(0);
    expect(result.days).toBe(0);
    expect(result.annualized_pct).toBeNull();
  });
});

import { ofCents } from '@shared/money';

import { computeValuationSeries } from './valuation';
import { buildPriceHistory, buildTx, D, dateD, resetTxIds } from './test-helpers';

beforeEach(() => resetTxIds());

describe('computeValuationSeries — empty', () => {
  it('returns one point per day with zero value when no txns exist', () => {
    const series = computeValuationSeries(
      [],
      buildPriceHistory([]),
      { from: dateD('2026-01-01'), to: dateD('2026-01-03') },
      { scope: 'portfolio' },
    );
    expect(series.points).toHaveLength(3);
    expect(series.points.map((p) => p.market_value_cents)).toEqual([
      ofCents(0),
      ofCents(0),
      ofCents(0),
    ]);
    expect(series.points.map((p) => p.tr_index)).toEqual([1.0, 1.0, 1.0]);
  });
});

describe('computeValuationSeries — single buy with daily prices', () => {
  it('emits one point per day, market value = qty × carried-forward price', () => {
    // Buy 100 shares at $10 on day 1; price moves $10 → $11 → $12 over 3 days.
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
          ['2026-01-01', 1000], // $10.00
          ['2026-01-02', 1100], // $11.00
          ['2026-01-03', 1200], // $12.00
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-03') },
      { scope: 'portfolio' },
    );
    expect(series.points.map((p) => p.market_value_cents)).toEqual([
      D(1000), // 100 × $10.00
      D(1100), // 100 × $11.00
      D(1200), // 100 × $12.00
    ]);
    expect(series.points.map((p) => p.cost_basis_cents)).toEqual([D(1000), D(1000), D(1000)]);
    expect(series.points.map((p) => p.external_cashflow_cents)).toEqual([D(0), D(0), D(0)]);
  });
});

describe('computeValuationSeries — carry-forward for weekend / gap', () => {
  it('uses the last known price on days with no price update', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    // Only days 1 and 4 have a price. Days 2 and 3 carry forward day 1's
    // $10.00 — they are not stale within the 7-day default window.
    const prices = buildPriceHistory([
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-04', 1100],
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-04') },
      { scope: 'portfolio' },
    );
    expect(series.points.map((p) => p.market_value_cents)).toEqual([
      D(1000), // day 1
      D(1000), // day 2 — carry
      D(1000), // day 3 — carry
      D(1100), // day 4
    ]);
  });
});

describe('computeValuationSeries — multi-security portfolio', () => {
  it('sums market value across positions; each security has its own price line', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'buy',
        security_id: 1,
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        security_id: 2,
        transaction_date: dateD('2026-01-01'),
        quantity: 50,
        price_cents: D(20),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2026-01-02', 1100]]],
      [2, [['2026-01-01', 2000], ['2026-01-02', 1900]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-02') },
      { scope: 'portfolio' },
    );
    expect(series.points[0]!.market_value_cents).toBe(D(2000)); // 1000 + 1000
    expect(series.points[1]!.market_value_cents).toBe(D(2050)); // 1100 + 950
  });
});

describe('computeValuationSeries — range validation', () => {
  it('throws RangeError when to < from', () => {
    expect(() =>
      computeValuationSeries(
        [],
        buildPriceHistory([]),
        { from: dateD('2026-01-02'), to: dateD('2026-01-01') },
        { scope: 'portfolio' },
      ),
    ).toThrow(RangeError);
  });
});

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

describe('computeValuationSeries — external cashflows', () => {
  it('portfolio scope: deposits and withdrawals are external; transfer_in/out are not', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        transaction_date: dateD('2026-01-02'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(500),
      }),
      buildTx({
        id: 2,
        transaction_type: 'withdrawal',
        transaction_date: dateD('2026-01-03'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(100),
      }),
      buildTx({
        id: 3,
        transaction_type: 'transfer_in',
        transaction_date: dateD('2026-01-03'),
        security_id: 1,
        quantity: 10,
        price_cents: D(10),
        amount_cents: D(100),
      }),
    ];
    const series = computeValuationSeries(
      txns,
      buildPriceHistory([[1, [['2026-01-01', 1000]]]]),
      { from: dateD('2026-01-01'), to: dateD('2026-01-03') },
      { scope: 'portfolio' },
    );
    expect(series.points.map((p) => p.external_cashflow_cents)).toEqual([
      D(0),    // day 1 — nothing
      D(500),  // day 2 — deposit
      D(-100), // day 3 — withdrawal (transfer_in is internal at portfolio scope)
    ]);
  });

  it('account scope: transfer_in / transfer_out count as deposits / withdrawals for that account', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        account_id: 1,
        transaction_date: dateD('2026-01-01'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(500),
      }),
      buildTx({
        id: 2,
        transaction_type: 'transfer_in',
        account_id: 1,
        transaction_date: dateD('2026-01-02'),
        security_id: 1,
        quantity: 10,
        price_cents: D(10),
        amount_cents: D(100),
      }),
      buildTx({
        id: 3,
        transaction_type: 'transfer_out',
        account_id: 1,
        transaction_date: dateD('2026-01-03'),
        security_id: 1,
        quantity: 5,
        price_cents: D(10),
        amount_cents: D(50),
      }),
      // Other account — must be ignored entirely.
      buildTx({
        id: 4,
        transaction_type: 'deposit',
        account_id: 2,
        transaction_date: dateD('2026-01-02'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(9999),
      }),
    ];
    const series = computeValuationSeries(
      txns,
      buildPriceHistory([[1, [['2026-01-01', 1000]]]]),
      { from: dateD('2026-01-01'), to: dateD('2026-01-03') },
      { scope: { account_id: 1 } },
    );
    expect(series.points.map((p) => p.external_cashflow_cents)).toEqual([
      D(500),  // day 1 — deposit to account 1
      D(100),  // day 2 — transfer_in counted as deposit for account 1
      D(-50),  // day 3 — transfer_out counted as withdrawal for account 1
    ]);
  });

  it("account scope: market value reflects only that account's positions", () => {
    // Two accounts each holding 50 shares of security 1; account-scoped
    // series for account 1 should value only account 1's 50 shares, not 100.
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'buy',
        account_id: 1,
        transaction_date: dateD('2026-01-01'),
        quantity: 50,
        price_cents: D(10),
        amount_cents: D(500),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        account_id: 2,
        transaction_date: dateD('2026-01-01'),
        quantity: 50,
        price_cents: D(10),
        amount_cents: D(500),
      }),
    ];
    const series = computeValuationSeries(
      txns,
      buildPriceHistory([[1, [['2026-01-01', 1000]]]]),
      { from: dateD('2026-01-01'), to: dateD('2026-01-01') },
      { scope: { account_id: 1 } },
    );
    expect(series.points[0]!.market_value_cents).toBe(D(500)); // 50 × $10, not 100 × $10
    expect(series.points[0]!.cost_basis_cents).toBe(D(500));
  });
});

describe('computeValuationSeries — TR index', () => {
  it('flat day with no cashflow: tr_index unchanged', () => {
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
      [1, [['2026-01-01', 1000], ['2026-01-02', 1000]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-02') },
      { scope: 'portfolio' },
    );
    expect(series.points[0]!.tr_index).toBe(1.0);
    expect(series.points[1]!.tr_index).toBe(1.0);
  });

  it('+10% price day: tr_index goes 1.0 → 1.10', () => {
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
      [1, [['2026-01-01', 1000], ['2026-01-02', 1100]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-02') },
      { scope: 'portfolio' },
    );
    expect(series.points[0]!.tr_index).toBe(1.0);
    expect(series.points[1]!.tr_index).toBeCloseTo(1.10, 10);
  });

  it('strips deposit from daily return — start-of-day cashflow convention', () => {
    // Day 1: hold $1000 worth at close.
    // Day 2: deposit $1000 at start of day; close at $2200.
    // Without stripping: return = 2200/1000 - 1 = 120% (wrong, includes deposit).
    // With stripping: return = (2200 - 1000)/1000 - 1 = 20% (correct).
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'deposit',
        transaction_date: dateD('2026-01-02'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(1000),
      }),
      buildTx({
        id: 3,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-02'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2026-01-02', 1100]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-02') },
      { scope: 'portfolio' },
    );
    // Day 1: 100 × $10 = $1000. tr_index = 1.0.
    // Day 2: 200 × $11 = $2200, deposit_cf = $1000.
    //   daily_return = (2200 − 1000) / 1000 − 1 = 0.20 = +20%
    //   tr_index[1] = 1.0 × 1.20 = 1.20
    expect(series.points[1]!.tr_index).toBeCloseTo(1.20, 10);
    expect(series.points[1]!.external_cashflow_cents).toBe(D(1000));
  });

  it('pre-funding days: tr_index stays at 1.0 until first positive value', () => {
    // Account empty for 2 days, deposit + buy on day 3.
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        transaction_date: dateD('2026-01-03'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(1000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-03'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([[1, [['2026-01-03', 1000], ['2026-01-04', 1100]]]]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-04') },
      { scope: 'portfolio' },
    );
    expect(series.points.map((p) => p.tr_index)).toEqual([1.0, 1.0, 1.0, expect.closeTo(1.10, 10)]);
  });
});

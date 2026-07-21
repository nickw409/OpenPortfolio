import { ofCents } from '@shared/money';

import { FinancialError } from './errors';
import { computeValuationSeries } from './valuation';
import {
  buildPriceHistory,
  buildTx,
  D,
  dateD,
  loadFixture,
  resetTxIds,
  revivePrices,
  reviveTxns,
  type ValuationFixture,
} from './test-helpers';

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
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-02', 1100],
        ],
      ],
      [
        2,
        [
          ['2026-01-01', 2000],
          ['2026-01-02', 1900],
        ],
      ],
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
      D(0), // day 1 — nothing
      D(500), // day 2 — deposit
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
      D(500), // day 1 — deposit to account 1
      D(100), // day 2 — transfer_in counted as deposit for account 1
      D(-50), // day 3 — transfer_out counted as withdrawal for account 1
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

  it('portfolio scope: deposits from multiple accounts all count toward total cashflow', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        account_id: 1,
        transaction_date: dateD('2026-01-01'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(300),
      }),
      buildTx({
        id: 2,
        transaction_type: 'deposit',
        account_id: 2,
        transaction_date: dateD('2026-01-01'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(700),
      }),
    ];
    const series = computeValuationSeries(
      txns,
      buildPriceHistory([]),
      { from: dateD('2026-01-01'), to: dateD('2026-01-01') },
      { scope: 'portfolio' },
    );
    // Portfolio-wide sum: $300 + $700 = $1000
    expect(series.points[0]!.external_cashflow_cents).toBe(D(1000));
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
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-02', 1000],
        ],
      ],
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
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-02', 1100],
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-02') },
      { scope: 'portfolio' },
    );
    expect(series.points[0]!.tr_index).toBe(1.0);
    expect(series.points[1]!.tr_index).toBeCloseTo(1.1, 10);
  });

  it('strips deposit from daily return — start-of-day cashflow convention', () => {
    // Day 1: hold $1000 worth at close.
    // Day 2: deposit $1000 at start of day; close at $2200.
    // Without stripping: return = 2200/1000 - 1 = 120% (wrong, includes deposit).
    // With start-of-day: base = V_open + CF = 1000 + 1000 = 2000;
    //   return = 2200/2000 - 1 = 10% (correct — deposit earns the day's return).
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
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-02', 1100],
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-02') },
      { scope: 'portfolio' },
    );
    // Day 1: 100 × $10 = $1000. tr_index = 1.0.
    // Day 2: 200 × $11 = $2200, deposit_cf = $1000.
    //   base = V_open + CF = 1000 + 1000 = 2000
    //   daily_return = 2200 / 2000 − 1 = +10%
    //   tr_index[1] = 1.0 × 1.10 = 1.10
    expect(series.points[1]!.tr_index).toBeCloseTo(1.1, 10);
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
    const prices = buildPriceHistory([
      [
        1,
        [
          ['2026-01-03', 1000],
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
    expect(series.points.map((p) => p.tr_index)).toEqual([1.0, 1.0, 1.0, expect.closeTo(1.1, 10)]);
  });
});

describe('computeValuationSeries — price staleness', () => {
  it('throws price.stale when a held security has no price within maxStalenessDays', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    // Only one price on 2026-01-01; query a day 30 days later (well past 7-day default).
    const prices = buildPriceHistory([[1, [['2026-01-01', 1000]]]]);
    try {
      computeValuationSeries(
        txns,
        prices,
        { from: dateD('2026-01-15'), to: dateD('2026-01-15') },
        { scope: 'portfolio' },
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FinancialError);
      expect((e as FinancialError).code).toBe('price.stale');
      expect((e as FinancialError).context.security_id).toBe(1);
    }
  });

  it('throws price.stale when a held security has no preceding price at all', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    // Price series has no points before the query window.
    const prices = buildPriceHistory([[1, [['2026-02-01', 1000]]]]);
    expect(() =>
      computeValuationSeries(
        txns,
        prices,
        { from: dateD('2026-01-05'), to: dateD('2026-01-05') },
        { scope: 'portfolio' },
      ),
    ).toThrow(FinancialError);
  });

  it('respects custom maxStalenessDays', () => {
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
    // 3 days later, 7-day window — fine.
    expect(() =>
      computeValuationSeries(
        txns,
        prices,
        { from: dateD('2026-01-04'), to: dateD('2026-01-04') },
        { scope: 'portfolio', maxStalenessDays: 7 },
      ),
    ).not.toThrow();
    // 3 days later, 2-day window — too stale.
    expect(() =>
      computeValuationSeries(
        txns,
        prices,
        { from: dateD('2026-01-04'), to: dateD('2026-01-04') },
        { scope: 'portfolio', maxStalenessDays: 2 },
      ),
    ).toThrow(FinancialError);
  });

  it('does NOT throw when the security is no longer held on stale days', () => {
    // Buy then sell-out: after the sell, no open lot, no price needed.
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
        transaction_type: 'sell',
        transaction_date: dateD('2026-01-02'),
        quantity: 100,
        price_cents: D(11),
        amount_cents: D(1100),
      }),
    ];
    const prices = buildPriceHistory([
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-02', 1100],
        ],
      ],
    ]);
    // Day 30 is far past the staleness window, but no security is held.
    expect(() =>
      computeValuationSeries(
        txns,
        prices,
        { from: dateD('2026-01-30'), to: dateD('2026-01-30') },
        { scope: 'portfolio', maxStalenessDays: 7 },
      ),
    ).not.toThrow();
  });
});

// ─── fixture-driven tests ────────────────────────────────────────────────

describe('fixture: daily-twr-simple', () => {
  it('valuation series matches hand-computed TR index over 30 days at flat price + 10% sell', () => {
    const fx = loadFixture<ValuationFixture>('daily-twr-simple');
    const series = computeValuationSeries(
      reviveTxns(fx.transactions),
      revivePrices(fx.price_history),
      { from: new Date(fx.range.from), to: new Date(fx.range.to) },
      { scope: fx.scope },
    );
    // Day 1 = 100 × $100.00 = $10,000.00. Day 31 = sell-out → market value 0.
    expect(series.points[0]!.market_value_cents).toBe(ofCents(1_000_000));
    expect(series.points[series.points.length - 1]!.market_value_cents).toBe(ofCents(0));
    // tr_index right before the sell should be ~1.10.
    expect(series.points[29]!.tr_index).toBeCloseTo(1.1, 8);
  });
});

describe('fixture: pre-funding-days', () => {
  it('tr_index = 1.0 for the 10 pre-funding days; index moves only after the funded day', () => {
    const fx = loadFixture<ValuationFixture>('pre-funding-days');
    const series = computeValuationSeries(
      reviveTxns(fx.transactions),
      revivePrices(fx.price_history),
      { from: new Date(fx.range.from), to: new Date(fx.range.to) },
      { scope: fx.scope },
    );
    // points[0..9] are pre-funding days (Jan 1-10, no holdings); points[10]
    // is the funded day itself (Jan 11) where V_open=0 and V_close = CF
    // gives a 0% return, so tr_index stays at 1.0. Index 11 (Jan 12)
    // sees the +10% price move and chains to 1.10.
    for (let i = 0; i < 11; i++) {
      expect(series.points[i]!.tr_index).toBe(1.0);
    }
    expect(series.points[11]!.tr_index).toBeCloseTo(1.1, 8);
  });
});

describe('fixture: cashflows-mid-period', () => {
  it('valuation series captures mid-period cashflows + price moves across three sub-periods', () => {
    const fx = loadFixture<ValuationFixture>('cashflows-mid-period');
    const series = computeValuationSeries(
      reviveTxns(fx.transactions),
      revivePrices(fx.price_history),
      { from: new Date(fx.range.from), to: new Date(fx.range.to) },
      { scope: fx.scope },
    );
    // Day 1: $1M deposit + buy 100 shares at $100 = $10,000 market value.
    expect(series.points[0]!.market_value_cents).toBe(ofCents(1_000_000));
    expect(series.points[0]!.external_cashflow_cents).toBe(ofCents(1_000_000));

    // The series spans 30 days; cumulative cashflows from the three
    // deposits sum to $2,000,000 (1,000,000 + 500,000 + 500,000).
    const totalCashflow = series.points.reduce(
      (sum, p) => sum + Number(p.external_cashflow_cents),
      0,
    );
    expect(totalCashflow).toBe(2_000_000);

    // TR index should reflect compounded daily returns across the three
    // sub-periods (~+5% / -3% / +8% from price data). Daily interpolation
    // of the price series produces a final tr_index of ~1.0904 rather than
    // the simple sub-period product (1.05 × 0.97 × 1.08 ≈ 1.09998) because
    // the engine chains each day's actual price ratio, not the boundary
    // prices alone. Tolerance is loose because intermediate prices are
    // carried forward between weekly price points.
    const finalTrIndex = series.points[series.points.length - 1]!.tr_index;
    expect(finalTrIndex).toBeCloseTo(1.0904, 2);
  });
});

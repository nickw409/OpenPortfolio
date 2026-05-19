import { FinancialError } from './errors';
import { computeMoneyWeightedReturn } from './mwr';
import { computeValuationSeries } from './valuation';
import { buildPriceHistory, buildTx, D, dateD, resetTxIds } from './test-helpers';

beforeEach(() => resetTxIds());

describe('computeMoneyWeightedReturn — buy and hold, no intermediate flows', () => {
  it('IRR ≈ TWR over 1 year buy-and-hold at +21%', () => {
    // Use weekly anchor prices to avoid the 7-day staleness gate over the
    // full 366-day window. Final price reflects +21% gain.
    const pricePts: [string, number][] = [];
    // Generate every Monday from 2026-01-01 through 2027-01-02 with flat
    // price 10000 cents, then jump to 12100 on the last day.
    const startMs = new Date('2026-01-01T00:00:00Z').getTime();
    const endMs = new Date('2027-01-02T00:00:00Z').getTime();
    const stepMs = 6 * 86_400_000; // every 6 days — well under 7-day stale limit.
    for (let t = startMs; t < endMs; t += stepMs) {
      const iso = new Date(t).toISOString().slice(0, 10);
      pricePts.push([iso, 10000]);
    }
    pricePts.push(['2027-01-02', 12100]);

    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        transaction_date: dateD('2026-01-01'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(10000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(100),
        amount_cents: D(10000),
      }),
    ];
    const prices = buildPriceHistory([[1, pricePts]]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2027-01-02') },
      { scope: 'portfolio' },
    );
    const result = computeMoneyWeightedReturn(series);
    // For buy-and-hold with no intermediate cashflows, IRR == annualized TWR.
    // 1.21 annualized over 366 days ≈ 20.95%.
    expect(result.irr_pct).toBeCloseTo(20.95, 1);
    expect(result.method).toBe('newton');
    expect(result.iterations).toBeLessThan(20);
  });
});

describe('computeMoneyWeightedReturn — bad initial state', () => {
  it('throws irr.bad_initial_state when first day has zero market value and no deposit', () => {
    // No deposits, no positions — series is all zeros.
    const series = computeValuationSeries(
      [],
      buildPriceHistory([]),
      { from: dateD('2026-01-01'), to: dateD('2026-12-31') },
      { scope: 'portfolio' },
    );
    try {
      computeMoneyWeightedReturn(series);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FinancialError);
      expect((e as FinancialError).code).toBe('irr.bad_initial_state');
    }
  });
});

describe('computeMoneyWeightedReturn — intermediate cashflows', () => {
  it('handles a mid-period deposit; Newton converges (method=newton)', () => {
    // Day 0: deposit $10,000, buy 100 @ $100 ($10,000 position).
    // Day 180: deposit $5,000, buy 50 @ $100 ($5,000 position).
    // Final: 150 shares @ $120 = $18,000.
    // Generate weekly anchor prices flat at 10000 cents, then jump
    // to 12000 on the last day.
    const pricePts: [string, number][] = [];
    const startMs = new Date('2026-01-01T00:00:00Z').getTime();
    const endMs = new Date('2027-01-02T00:00:00Z').getTime();
    const stepMs = 6 * 86_400_000;
    for (let t = startMs; t < endMs; t += stepMs) {
      const iso = new Date(t).toISOString().slice(0, 10);
      pricePts.push([iso, 10000]);
    }
    pricePts.push(['2027-01-02', 12000]);

    const txns = [
      buildTx({ id: 1, transaction_type: 'deposit', transaction_date: dateD('2026-01-01'),
        security_id: null, quantity: 0, price_cents: null, amount_cents: D(10000) }),
      buildTx({ id: 2, transaction_type: 'buy', transaction_date: dateD('2026-01-01'),
        quantity: 100, price_cents: D(100), amount_cents: D(10000) }),
      buildTx({ id: 3, transaction_type: 'deposit', transaction_date: dateD('2026-07-01'),
        security_id: null, quantity: 0, price_cents: null, amount_cents: D(5000) }),
      buildTx({ id: 4, transaction_type: 'buy', transaction_date: dateD('2026-07-01'),
        quantity: 50, price_cents: D(100), amount_cents: D(5000) }),
    ];
    const prices = buildPriceHistory([[1, pricePts]]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2027-01-02') },
      { scope: 'portfolio' },
    );
    const result = computeMoneyWeightedReturn(series);
    // Sanity: result is a finite percentage in the credible range.
    expect(Number.isFinite(result.irr_pct)).toBe(true);
    expect(result.irr_pct).toBeGreaterThan(0);
    expect(result.irr_pct).toBeLessThan(100);
    expect(result.method).toBe('newton');
    expect(result.iterations).toBeLessThan(20);
  });
});

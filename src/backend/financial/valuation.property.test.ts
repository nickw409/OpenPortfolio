// TR-index invariants for the valuation series. Property tests run after
// the unit tests so a failure here surfaces an algorithmic-drift bug
// rather than a missing-feature bug.

import fc from 'fast-check';

import { multiplyByRatio, ofCents } from '@shared/money';

import { computeValuationSeries } from './valuation';
import type { PriceHistory, Tx } from './types';

// Build a buy-and-hold txn list plus a price history of `nDays` days where
// price is `startPrice × (1 + return)^d`. Daily return is constant; TR
// index should match (1 + return)^d exactly (within FP epsilon).
function makeConstantReturnInputs(
  nDays: number,
  dailyReturn: number,
  startCents: number,
): {
  txns: Tx[];
  prices: PriceHistory;
  from: Date;
  to: Date;
} {
  const from = new Date(Date.UTC(2026, 0, 1));
  const to = new Date(from.getTime() + (nDays - 1) * 86_400_000);
  const txns: Tx[] = [
    {
      id: 1,
      account_id: 1,
      security_id: 1,
      transaction_type: 'buy',
      transaction_date: from,
      quantity: 100,
      price_cents: ofCents(startCents),
      amount_cents: ofCents(100 * startCents),
      fee_cents: null,
      currency_code: 'USD',
    },
  ];
  const pricePts: { date: Date; price_cents: ReturnType<typeof ofCents> }[] = [];
  let cents = startCents;
  for (let d = 0; d < nDays; d++) {
    pricePts.push({
      date: new Date(from.getTime() + d * 86_400_000),
      price_cents: ofCents(Math.round(cents)),
    });
    cents = cents * (1 + dailyReturn);
  }
  return { txns, prices: new Map([[1, pricePts]]), from, to };
}

describe('property: tr_index follows constant-return chain', () => {
  it('tr_index[d] ≈ (1 + dailyReturn)^d within FP slack', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 60 }),
        fc.double({ min: -0.02, max: 0.02, noNaN: true }),
        (nDays, r) => {
          const { txns, prices, from, to } = makeConstantReturnInputs(nDays, r, 10_000);
          const series = computeValuationSeries(txns, prices, { from, to }, { scope: 'portfolio' });
          // First-day index is 1.0 by definition. Last-day index ≈ (1+r)^(nDays−1).
          // Tolerance is loose because rounding to cent on prices introduces
          // up to ~1 cent / 10000 cents (0.01%) per step; chained over 60 steps
          // that's ~0.6% drift in the absolute worst case.
          const expected = Math.pow(1 + r, nDays - 1);
          const actual = series.points[nDays - 1]!.tr_index;
          expect(Math.abs(actual - expected)).toBeLessThan(Math.max(1e-4, 0.001 * nDays));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('property: scale invariance', () => {
  it('doubling all share quantities leaves tr_index unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 30 }),
        fc.double({ min: -0.05, max: 0.05, noNaN: true }),
        (nDays, r) => {
          const a = makeConstantReturnInputs(nDays, r, 10_000);
          const b = makeConstantReturnInputs(nDays, r, 10_000);
          b.txns = b.txns.map((t) => ({
            ...t,
            quantity: t.quantity * 2,
            amount_cents: multiplyByRatio(t.amount_cents, 2),
          }));
          const seriesA = computeValuationSeries(
            a.txns,
            a.prices,
            { from: a.from, to: a.to },
            { scope: 'portfolio' },
          );
          const seriesB = computeValuationSeries(
            b.txns,
            b.prices,
            { from: b.from, to: b.to },
            { scope: 'portfolio' },
          );
          for (let i = 0; i < seriesA.points.length; i++) {
            expect(seriesA.points[i]!.tr_index).toBeCloseTo(seriesB.points[i]!.tr_index, 8);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

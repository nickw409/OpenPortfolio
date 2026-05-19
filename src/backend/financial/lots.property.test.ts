// Property-based tests for the lot engine. These invariants should hold
// for any random transaction sequence that the engine accepts. They guard
// against algorithmic drift — particularly around FP rounding in long
// histories — that hand-written cases would miss.

import fc from 'fast-check';

import { add, ofCents, sum, ZERO, type Money } from '@shared/money';

import { FinancialError } from './errors';
import { computeLots } from './lots';
import type { CostBasisMethod, Tx } from './types';

// ─── Arbitrary builders ─────────────────────────────────────────────────

// Cents in a reasonable range for portfolio simulations. Keeping under
// 10**9 leaves headroom against MAX_SAFE_INTEGER (~9.007e15) even after
// thousands of additions.
const arbCents = fc.integer({ min: 1, max: 1_000_000_000 }).map((n) => ofCents(n));

const arbQty = fc.integer({ min: 1, max: 10_000 });

// A buy-only sequence of N events. Used in invariants that don't need
// sells — keeps the arbitrary simple and small.
const arbBuySeq = fc.array(
  fc.record({
    qty: arbQty,
    cost: arbCents,
    fee: fc.option(arbCents, { freq: 4 }),
  }),
  { minLength: 1, maxLength: 50 },
);

// A buy/sell/split mix. Constructed to never over-sell: each event walks
// a running "available quantity" and bounds the sell.
interface BuySellEvent {
  kind: 'buy' | 'sell' | 'split';
  qty: number;
  cost?: Money;
}

const arbBuySellSeq = fc
  .array(
    fc.record({
      action: fc.constantFrom('buy', 'sell', 'split'),
      qty: arbQty,
      cost: arbCents,
      ratio: fc.constantFrom(2, 3, 4, 5),
    }),
    { minLength: 1, maxLength: 30 },
  )
  .map((raw): BuySellEvent[] => {
    let available = 0;
    const events: BuySellEvent[] = [];
    for (const r of raw) {
      if (r.action === 'buy') {
        events.push({ kind: 'buy', qty: r.qty, cost: r.cost });
        available += r.qty;
      } else if (r.action === 'split' && available > 0) {
        events.push({ kind: 'split', qty: r.ratio });
        available *= r.ratio;
      } else if (r.action === 'sell' && available > 0) {
        const sellQty = Math.min(r.qty, available);
        events.push({ kind: 'sell', qty: sellQty, cost: r.cost });
        available -= sellQty;
      }
    }
    return events;
  });

function eventsToTxns(events: BuySellEvent[]): Tx[] {
  const dayMs = 86400000;
  return events.map((e, i) => {
    const base = {
      id: i + 1,
      account_id: 1,
      security_id: 1,
      transaction_date: new Date(Date.UTC(2026, 0, 1) + i * dayMs),
      currency_code: 'USD',
      fee_cents: null as Money | null,
      price_cents: null as Money | null,
    };
    if (e.kind === 'buy') {
      return {
        ...base,
        transaction_type: 'buy' as const,
        quantity: e.qty,
        amount_cents: e.cost!,
      };
    }
    if (e.kind === 'sell') {
      return {
        ...base,
        transaction_type: 'sell' as const,
        quantity: e.qty,
        amount_cents: e.cost!,
      };
    }
    return {
      ...base,
      transaction_type: 'split' as const,
      quantity: e.qty,
      amount_cents: ZERO,
    };
  });
}

// ─── Invariants ─────────────────────────────────────────────────────────

describe('property: buy-only conservation', () => {
  it('sum(openLots.basis) == sum(amount + fee)', () => {
    fc.assert(
      fc.property(arbBuySeq, (events) => {
        const txns: Tx[] = events.map((e, i) => ({
          id: i + 1,
          account_id: 1,
          security_id: 1,
          transaction_type: 'buy' as const,
          transaction_date: new Date(Date.UTC(2026, 0, 1) + i * 86400000),
          quantity: e.qty,
          amount_cents: e.cost,
          fee_cents: e.fee ?? null,
          price_cents: null,
          currency_code: 'USD',
        }));
        const { openLots, closedLots } = computeLots(txns, { method: 'fifo' });
        expect(closedLots).toEqual([]);

        const actualBasis = sum(openLots.map((l) => l.cost_basis_cents));
        let expectedBasis: Money = ZERO;
        for (const e of events) {
          expectedBasis = add(expectedBasis, e.cost);
          if (e.fee) expectedBasis = add(expectedBasis, e.fee);
        }
        expect(actualBasis).toBe(expectedBasis);
      }),
      { numRuns: 100 },
    );
  });
});

describe('property: basis conservation across buys and sells', () => {
  // For any sequence: sum(open.basis) + sum(closed.cost_basis) ==
  // sum(buys.amount). Splits don't affect basis sums. Sells move basis
  // from open to closed but don't create or destroy any.
  it('sum(open.basis) + sum(closed.cost_basis) == sum(buys.amount)', () => {
    fc.assert(
      fc.property(
        arbBuySellSeq,
        fc.constantFrom<CostBasisMethod>('fifo', 'lifo'),
        (events, method) => {
          const txns = eventsToTxns(events);
          let result;
          try {
            result = computeLots(txns, { method });
          } catch (e) {
            // Our arbitrary should never produce over-sells; if it does, the
            // generator is the bug, not the engine.
            if (e instanceof FinancialError && e.code === 'domain.sell_exceeds_holdings') {
              throw new Error('generator produced an over-sell — fix arbBuySellSeq');
            }
            throw e;
          }
          const openBasis = sum(result.openLots.map((l) => l.cost_basis_cents));
          const closedBasis = sum(result.closedLots.map((cl) => cl.cost_basis_cents));
          const totalBasis = add(openBasis, closedBasis);
          const buysTotal = sum(
            txns.filter((t) => t.transaction_type === 'buy').map((t) => t.amount_cents),
          );
          // Drift bound: within (closedLots.length) cents — each closed lot
          // can introduce at most one cent of rounding gap, and the engine's
          // last-chunk-takes-remainder rule keeps proceeds (not basis) free
          // of gaps. The basis side can still drift by floor() vs round() on
          // proportional allocations from partially-consumed lots.
          const diff = Math.abs(Number(totalBasis) - Number(buysTotal));
          expect(diff).toBeLessThanOrEqual(result.closedLots.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property: FIFO and LIFO conserve the same total basis', () => {
  // The split between realized and open basis differs by method, but
  // sum(realized.basis) + sum(open.basis) is method-invariant up to the
  // documented cent-of-drift bound.
  it('FIFO total basis ≈ LIFO total basis (within closedLots-count cents)', () => {
    fc.assert(
      fc.property(arbBuySellSeq, (events) => {
        const txns = eventsToTxns(events);
        const fifo = computeLots(txns, { method: 'fifo' });
        const lifo = computeLots(txns, { method: 'lifo' });
        const fifoTotal = add(
          sum(fifo.openLots.map((l) => l.cost_basis_cents)),
          sum(fifo.closedLots.map((cl) => cl.cost_basis_cents)),
        );
        const lifoTotal = add(
          sum(lifo.openLots.map((l) => l.cost_basis_cents)),
          sum(lifo.closedLots.map((cl) => cl.cost_basis_cents)),
        );
        const maxClosedLen = Math.max(fifo.closedLots.length, lifo.closedLots.length);
        const diff = Math.abs(Number(fifoTotal) - Number(lifoTotal));
        expect(diff).toBeLessThanOrEqual(maxClosedLen * 2);
      }),
      { numRuns: 100 },
    );
  });
});

describe('property: proceeds allocation has no rounding gap', () => {
  // The last-chunk-takes-remainder rule in lots.ts ensures
  // sum(closed.proceeds) == net_proceeds of the originating sell exactly.
  it('sum(closed.proceeds for sellTx) == sell.amount - sell.fee, exactly', () => {
    fc.assert(
      fc.property(
        arbBuySellSeq,
        fc.constantFrom<CostBasisMethod>('fifo', 'lifo'),
        (events, method) => {
          const txns = eventsToTxns(events);
          const { closedLots } = computeLots(txns, { method });
          // Group closed lots by sellTxId, sum proceeds, compare to net sell.
          const proceedsBySell = new Map<number, Money>();
          for (const cl of closedLots) {
            proceedsBySell.set(
              cl.sellTxId,
              add(proceedsBySell.get(cl.sellTxId) ?? ZERO, cl.proceeds_cents),
            );
          }
          const sells = txns.filter((t) => t.transaction_type === 'sell');
          for (const sell of sells) {
            const expected = sell.amount_cents; // fee_cents is null in this arbitrary
            const actual = proceedsBySell.get(sell.id);
            if (actual === undefined) continue; // no closed lots if sell was empty (generator guard)
            expect(actual).toBe(expected);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('property: open quantities sum to net qty (buys − sells, after splits)', () => {
  it('sum(open.quantity) == expected running quantity', () => {
    fc.assert(
      fc.property(
        arbBuySellSeq,
        fc.constantFrom<CostBasisMethod>('fifo', 'lifo'),
        (events, method) => {
          const txns = eventsToTxns(events);
          const { openLots } = computeLots(txns, { method });
          // Recompute the expected open quantity by replaying the events.
          let expected = 0;
          for (const e of events) {
            if (e.kind === 'buy') expected += e.qty;
            else if (e.kind === 'sell') expected -= e.qty;
            else if (e.kind === 'split') expected *= e.qty;
          }
          const actual = openLots.reduce((s, l) => s + l.quantity, 0);
          // Quantities are float; tolerate FP noise on chained splits.
          expect(Math.abs(actual - expected)).toBeLessThan(1e-6);
        },
      ),
      { numRuns: 100 },
    );
  });
});

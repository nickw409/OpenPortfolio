import { add, ofDollars } from '@shared/money';

import { FinancialError } from './errors';
import { computeLots } from './lots';
import { buildTx, D, resetTxIds } from './test-helpers';
import type { LotSelectionMap } from './types';

beforeEach(() => resetTxIds());

describe('computeLots — empty / no-op', () => {
  it('returns empty arrays for no txns', () => {
    expect(computeLots([], { method: 'fifo' })).toEqual({ openLots: [], closedLots: [] });
  });

  it('returns empty arrays when only non-share txns are present', () => {
    const txns = [
      buildTx({ transaction_type: 'dividend', amount_cents: D(50), quantity: 0 }),
      buildTx({ transaction_type: 'fee', amount_cents: D(5), quantity: 0 }),
    ];
    expect(computeLots(txns, { method: 'fifo' })).toEqual({ openLots: [], closedLots: [] });
  });
});

describe('computeLots — single buy opens a lot', () => {
  it('lot.quantity and cost basis include fees on buys', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        quantity: 100,
        amount_cents: D(1000),
        fee_cents: D(5),
        transaction_date: new Date('2026-01-15Z'),
      }),
    ];
    const { openLots, closedLots } = computeLots(txns, { method: 'fifo' });
    expect(openLots).toHaveLength(1);
    expect(openLots[0]!.quantity).toBe(100);
    expect(openLots[0]!.cost_basis_cents).toBe(D(1005));
    expect(closedLots).toEqual([]);
  });

  it('transfer_in opens a lot just like buy', () => {
    const txns = [buildTx({ transaction_type: 'transfer_in', quantity: 50, amount_cents: D(500) })];
    const { openLots } = computeLots(txns, { method: 'fifo' });
    expect(openLots).toHaveLength(1);
    expect(openLots[0]!.cost_basis_cents).toBe(D(500));
  });

  it('rejects non-positive quantity on buy', () => {
    const txns = [buildTx({ transaction_type: 'buy', quantity: 0 })];
    expect(() => computeLots(txns, { method: 'fifo' })).toThrow(RangeError);
  });

  it('rejects non-finite quantity on buy', () => {
    const txns = [buildTx({ transaction_type: 'buy', quantity: Number.NaN })];
    expect(() => computeLots(txns, { method: 'fifo' })).toThrow(RangeError);
  });
});

describe('computeLots — FIFO sell', () => {
  it('consumes oldest lot first', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'buy',
        quantity: 10,
        amount_cents: D(100),
        transaction_date: new Date('2026-01-01Z'),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        quantity: 10,
        amount_cents: D(200),
        transaction_date: new Date('2026-02-01Z'),
      }),
      buildTx({
        id: 3,
        transaction_type: 'sell',
        quantity: 5,
        amount_cents: D(75),
        transaction_date: new Date('2026-03-01Z'),
      }),
    ];
    const { openLots, closedLots } = computeLots(txns, { method: 'fifo' });
    expect(closedLots).toHaveLength(1);
    expect(closedLots[0]!.sourceTxId).toBe(1);
    expect(closedLots[0]!.quantity).toBe(5);
    expect(closedLots[0]!.cost_basis_cents).toBe(D(50)); // half of first lot's $100
    expect(closedLots[0]!.proceeds_cents).toBe(D(75));
    expect(closedLots[0]!.realized_gain_cents).toBe(D(25));
    expect(openLots).toHaveLength(2);
    expect(openLots[0]!.quantity).toBe(5); // first lot half-consumed
    expect(openLots[0]!.cost_basis_cents).toBe(D(50));
    expect(openLots[1]!.quantity).toBe(10);
  });

  it('spans multiple lots when sell qty exceeds first lot', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        quantity: 10,
        amount_cents: D(200),
        transaction_date: new Date('2026-02-01Z'),
      }),
      buildTx({
        id: 3,
        transaction_type: 'sell',
        quantity: 15,
        amount_cents: D(300),
        transaction_date: new Date('2026-03-01Z'),
      }),
    ];
    const { openLots, closedLots } = computeLots(txns, { method: 'fifo' });
    expect(closedLots).toHaveLength(2);
    expect(closedLots[0]!.sourceTxId).toBe(1);
    expect(closedLots[0]!.quantity).toBe(10);
    expect(closedLots[1]!.sourceTxId).toBe(2);
    expect(closedLots[1]!.quantity).toBe(5);
    // Sum of allocated proceeds equals total net proceeds (no rounding gap).
    const totalProceeds = add(closedLots[0]!.proceeds_cents, closedLots[1]!.proceeds_cents);
    expect(totalProceeds).toBe(D(300));
    expect(openLots).toHaveLength(1);
    expect(openLots[0]!.sourceTxId).toBe(2);
    expect(openLots[0]!.quantity).toBe(5);
  });

  it('exact-fill empties the lot without rounding remainder', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 7, amount_cents: D(333.33) }),
      buildTx({
        id: 2,
        transaction_type: 'sell',
        quantity: 7,
        amount_cents: D(400),
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    const { openLots, closedLots } = computeLots(txns, { method: 'fifo' });
    expect(openLots).toEqual([]);
    expect(closedLots[0]!.cost_basis_cents).toBe(D(333.33));
    expect(closedLots[0]!.proceeds_cents).toBe(D(400));
  });

  it('throws sell_exceeds_holdings when there is not enough quantity', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 5, amount_cents: D(50) }),
      buildTx({
        id: 2,
        transaction_type: 'sell',
        quantity: 10,
        amount_cents: D(100),
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    expect(() => computeLots(txns, { method: 'fifo' })).toThrow(FinancialError);
    try {
      computeLots(txns, { method: 'fifo' });
    } catch (e) {
      expect((e as FinancialError).code).toBe('domain.sell_exceeds_holdings');
    }
  });

  it('rejects non-positive sell quantity', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        transaction_type: 'sell',
        quantity: 0,
        amount_cents: D(0),
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    expect(() => computeLots(txns, { method: 'fifo' })).toThrow(RangeError);
  });

  it('subtracts fees from proceeds (loss when fee dominates)', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        transaction_type: 'sell',
        quantity: 10,
        amount_cents: D(105),
        fee_cents: D(10),
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    const { closedLots } = computeLots(txns, { method: 'fifo' });
    expect(closedLots[0]!.proceeds_cents).toBe(D(95));
    expect(closedLots[0]!.realized_gain_cents).toBe(D(-5));
  });
});

describe('computeLots — LIFO sell', () => {
  it('consumes newest lot first', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'buy',
        quantity: 10,
        amount_cents: D(100),
        transaction_date: new Date('2026-01-01Z'),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        quantity: 10,
        amount_cents: D(200),
        transaction_date: new Date('2026-02-01Z'),
      }),
      buildTx({
        id: 3,
        transaction_type: 'sell',
        quantity: 5,
        amount_cents: D(150),
        transaction_date: new Date('2026-03-01Z'),
      }),
    ];
    const { openLots, closedLots } = computeLots(txns, { method: 'lifo' });
    expect(closedLots).toHaveLength(1);
    expect(closedLots[0]!.sourceTxId).toBe(2); // newest lot
    expect(closedLots[0]!.cost_basis_cents).toBe(D(100));
    expect(openLots).toHaveLength(2);
    // Order preserved: lot 1 remains untouched, lot 2 half-consumed.
    expect(openLots[0]!.sourceTxId).toBe(1);
    expect(openLots[0]!.quantity).toBe(10);
    expect(openLots[1]!.sourceTxId).toBe(2);
    expect(openLots[1]!.quantity).toBe(5);
  });
});

describe('computeLots — specific lot selection', () => {
  it('honors per-sell lot selections', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        quantity: 10,
        amount_cents: D(200),
        transaction_date: new Date('2026-02-01Z'),
      }),
      buildTx({
        id: 3,
        transaction_type: 'sell',
        quantity: 7,
        amount_cents: D(150),
        transaction_date: new Date('2026-03-01Z'),
      }),
    ];
    // Take 2 from lot 1 ($20 basis) and 5 from lot 2 ($100 basis).
    const lotSelections: LotSelectionMap = new Map([
      [
        3,
        [
          { sourceTxId: 1, quantityFromLot: 2 },
          { sourceTxId: 2, quantityFromLot: 5 },
        ],
      ],
    ]);
    const { openLots, closedLots } = computeLots(txns, { method: 'specific', lotSelections });
    expect(closedLots).toHaveLength(2);
    expect(closedLots[0]!.sourceTxId).toBe(1);
    expect(closedLots[0]!.cost_basis_cents).toBe(D(20));
    expect(closedLots[1]!.sourceTxId).toBe(2);
    expect(closedLots[1]!.cost_basis_cents).toBe(D(100));
    expect(openLots).toHaveLength(2);
    expect(openLots[0]!.quantity).toBe(8); // lot 1 minus 2
    expect(openLots[1]!.quantity).toBe(5); // lot 2 minus 5
  });

  it('throws specific_selection_missing when method is specific but no selections', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        transaction_type: 'sell',
        quantity: 5,
        amount_cents: D(75),
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    expect(() => computeLots(txns, { method: 'specific' })).toThrow(/specific.*no lot selections/);
  });

  it('throws specific_selection_quantity_mismatch when totals disagree', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        transaction_type: 'sell',
        quantity: 5,
        amount_cents: D(75),
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    const lotSelections: LotSelectionMap = new Map([[2, [{ sourceTxId: 1, quantityFromLot: 3 }]]]);
    expect(() => computeLots(txns, { method: 'specific', lotSelections })).toThrow(FinancialError);
  });

  it('throws unknown_lot_reference when selection points to a non-open lot', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        transaction_type: 'sell',
        quantity: 5,
        amount_cents: D(75),
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    const lotSelections: LotSelectionMap = new Map([
      [2, [{ sourceTxId: 999, quantityFromLot: 5 }]],
    ]);
    let caught: FinancialError | undefined;
    try {
      computeLots(txns, { method: 'specific', lotSelections });
    } catch (e) {
      caught = e as FinancialError;
    }
    expect(caught?.code).toBe('domain.unknown_lot_reference');
  });

  it('throws sell_exceeds_holdings when a specific selection over-draws a lot', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 5, amount_cents: D(50) }),
      buildTx({
        id: 2,
        transaction_type: 'sell',
        quantity: 10,
        amount_cents: D(100),
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    const lotSelections: LotSelectionMap = new Map([[2, [{ sourceTxId: 1, quantityFromLot: 10 }]]]);
    let caught: FinancialError | undefined;
    try {
      computeLots(txns, { method: 'specific', lotSelections });
    } catch (e) {
      caught = e as FinancialError;
    }
    expect(caught?.code).toBe('domain.sell_exceeds_holdings');
  });
});

describe('computeLots — splits', () => {
  it('2-for-1 split doubles open lot quantities, basis unchanged', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        transaction_type: 'split',
        quantity: 2,
        amount_cents: ofDollars(0),
        price_cents: null,
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    const { openLots } = computeLots(txns, { method: 'fifo' });
    expect(openLots).toHaveLength(1);
    expect(openLots[0]!.quantity).toBe(20);
    expect(openLots[0]!.cost_basis_cents).toBe(D(100));
  });

  it('reverse split (ratio < 1) shrinks quantities', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 100, amount_cents: D(100) }),
      buildTx({
        id: 2,
        transaction_type: 'split',
        quantity: 0.1,
        amount_cents: ofDollars(0),
        price_cents: null,
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    const { openLots } = computeLots(txns, { method: 'fifo' });
    expect(openLots[0]!.quantity).toBe(10);
    expect(openLots[0]!.cost_basis_cents).toBe(D(100));
  });

  it('split applies retroactively to prior lots but not to lots opened after', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'buy',
        quantity: 10,
        amount_cents: D(100),
        transaction_date: new Date('2026-01-01Z'),
      }),
      buildTx({
        id: 2,
        transaction_type: 'split',
        quantity: 2,
        amount_cents: ofDollars(0),
        price_cents: null,
        transaction_date: new Date('2026-02-01Z'),
      }),
      buildTx({
        id: 3,
        transaction_type: 'buy',
        quantity: 5,
        amount_cents: D(60),
        transaction_date: new Date('2026-03-01Z'),
      }),
    ];
    const { openLots } = computeLots(txns, { method: 'fifo' });
    expect(openLots).toHaveLength(2);
    expect(openLots[0]!.quantity).toBe(20); // doubled
    expect(openLots[1]!.quantity).toBe(5); // post-split, unaffected
  });

  it('throws split_without_open_lots when no lots are open', () => {
    const txns = [
      buildTx({
        transaction_type: 'split',
        quantity: 2,
        amount_cents: ofDollars(0),
        price_cents: null,
      }),
    ];
    let caught: FinancialError | undefined;
    try {
      computeLots(txns, { method: 'fifo' });
    } catch (e) {
      caught = e as FinancialError;
    }
    expect(caught?.code).toBe('domain.split_without_open_lots');
  });

  it('rejects non-positive split ratio', () => {
    const txns = [
      buildTx({ id: 1, transaction_type: 'buy', quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        transaction_type: 'split',
        quantity: 0,
        amount_cents: ofDollars(0),
        price_cents: null,
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    expect(() => computeLots(txns, { method: 'fifo' })).toThrow(RangeError);
  });
});

describe('computeLots — asOf cutoff', () => {
  it('stops processing once a txn date exceeds asOf', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'buy',
        quantity: 10,
        amount_cents: D(100),
        transaction_date: new Date('2026-01-01Z'),
      }),
      buildTx({
        id: 2,
        transaction_type: 'sell',
        quantity: 5,
        amount_cents: D(60),
        transaction_date: new Date('2026-03-01Z'),
      }),
    ];
    const { openLots, closedLots } = computeLots(txns, {
      method: 'fifo',
      asOf: new Date('2026-02-01Z'),
    });
    expect(openLots).toHaveLength(1);
    expect(openLots[0]!.quantity).toBe(10);
    expect(closedLots).toEqual([]);
  });
});

describe('computeLots — validation', () => {
  it('throws on mixed account_id', () => {
    const txns = [
      buildTx({ id: 1, account_id: 1 }),
      buildTx({
        id: 2,
        account_id: 2,
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    let caught: FinancialError | undefined;
    try {
      computeLots(txns, { method: 'fifo' });
    } catch (e) {
      caught = e as FinancialError;
    }
    expect(caught?.code).toBe('unsupported.mixed_grouping');
  });

  it('throws on mixed security_id', () => {
    const txns = [
      buildTx({ id: 1, security_id: 1 }),
      buildTx({
        id: 2,
        security_id: 2,
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    let caught: FinancialError | undefined;
    try {
      computeLots(txns, { method: 'fifo' });
    } catch (e) {
      caught = e as FinancialError;
    }
    expect(caught?.code).toBe('unsupported.mixed_grouping');
  });

  it('throws on mixed currency', () => {
    const txns = [
      buildTx({ id: 1, currency_code: 'USD' }),
      buildTx({
        id: 2,
        currency_code: 'EUR',
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    let caught: FinancialError | undefined;
    try {
      computeLots(txns, { method: 'fifo' });
    } catch (e) {
      caught = e as FinancialError;
    }
    expect(caught?.code).toBe('unsupported.mixed_currency');
  });

  it('throws when a share-affecting txn has null security_id', () => {
    const txns = [buildTx({ security_id: null })];
    expect(() => computeLots(txns, { method: 'fifo' })).toThrow(TypeError);
  });
});

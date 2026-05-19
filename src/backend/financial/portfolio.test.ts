import { computePortfolio } from './portfolio';
import { FinancialError } from './errors';
import { buildTx, D, resetTxIds } from './test-helpers';
import type { CostBasisMethod, PriceMap } from './types';

beforeEach(() => resetTxIds());

describe('computePortfolio', () => {
  it('groups by (account_id, security_id)', () => {
    const txns = [
      buildTx({ id: 1, account_id: 1, security_id: 1, quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        account_id: 1,
        security_id: 2,
        quantity: 5,
        amount_cents: D(250),
        transaction_date: new Date('2026-02-01Z'),
      }),
      buildTx({
        id: 3,
        account_id: 2,
        security_id: 1,
        quantity: 20,
        amount_cents: D(220),
        transaction_date: new Date('2026-03-01Z'),
      }),
    ];
    const { snapshot } = computePortfolio(txns, { method: 'fifo' });
    expect(snapshot.positions).toHaveLength(3);
    expect(snapshot.total_cost_basis_cents).toBe(D(570));
    expect(snapshot.total_market_value_cents).toBeNull();
  });

  it('skips cash-only transactions (security_id null)', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        security_id: null,
        quantity: 0,
        amount_cents: D(1000),
        price_cents: null,
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        security_id: 1,
        quantity: 10,
        amount_cents: D(100),
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    const { snapshot } = computePortfolio(txns, { method: 'fifo' });
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.total_cost_basis_cents).toBe(D(100));
  });

  it('values positions when prices are supplied', () => {
    const txns = [
      buildTx({ id: 1, security_id: 1, quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        security_id: 2,
        quantity: 5,
        amount_cents: D(250),
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    const prices: PriceMap = new Map([
      [1, D(15)],
      [2, D(60)],
    ]);
    const { snapshot } = computePortfolio(txns, { method: 'fifo', prices });
    expect(snapshot.total_market_value_cents).toBe(D(450)); // 10*15 + 5*60
    expect(snapshot.total_unrealized_gain_cents).toBe(D(100)); // (150-100) + (300-250)
  });

  it('reports null totals when any position lacks a price', () => {
    const txns = [
      buildTx({ id: 1, security_id: 1, quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        security_id: 2,
        quantity: 5,
        amount_cents: D(250),
        transaction_date: new Date('2026-02-01Z'),
      }),
    ];
    const prices: PriceMap = new Map([[1, D(15)]]); // missing security 2
    const { snapshot } = computePortfolio(txns, { method: 'fifo', prices });
    expect(snapshot.total_market_value_cents).toBeNull();
    expect(snapshot.total_unrealized_gain_cents).toBeNull();
  });

  it('resolves per-account method via function', () => {
    // Same buys, different methods → different lot consumption on sell.
    const txns = [
      buildTx({ id: 1, account_id: 1, security_id: 1, quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        account_id: 1,
        security_id: 1,
        quantity: 10,
        amount_cents: D(200),
        transaction_date: new Date('2026-02-01Z'),
      }),
      buildTx({
        id: 3,
        account_id: 1,
        security_id: 1,
        transaction_type: 'sell',
        quantity: 10,
        amount_cents: D(250),
        transaction_date: new Date('2026-03-01Z'),
      }),
      // Same pattern in account 2 but LIFO will consume the newer lot.
      buildTx({
        id: 4,
        account_id: 2,
        security_id: 1,
        quantity: 10,
        amount_cents: D(100),
      }),
      buildTx({
        id: 5,
        account_id: 2,
        security_id: 1,
        quantity: 10,
        amount_cents: D(200),
        transaction_date: new Date('2026-02-01Z'),
      }),
      buildTx({
        id: 6,
        account_id: 2,
        security_id: 1,
        transaction_type: 'sell',
        quantity: 10,
        amount_cents: D(250),
        transaction_date: new Date('2026-03-01Z'),
      }),
    ];
    const methodFor = (aid: number): CostBasisMethod => (aid === 1 ? 'fifo' : 'lifo');
    const { closedLots } = computePortfolio(txns, { method: methodFor });
    const fifoClose = closedLots.find((c) => c.account_id === 1)!;
    const lifoClose = closedLots.find((c) => c.account_id === 2)!;
    // FIFO consumes lot 1 ($100 basis); LIFO consumes lot 2 ($200 basis).
    expect(fifoClose.cost_basis_cents).toBe(D(100));
    expect(lifoClose.cost_basis_cents).toBe(D(200));
  });

  it('throws on mixed-currency portfolio', () => {
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
      computePortfolio(txns, { method: 'fifo' });
    } catch (e) {
      caught = e as FinancialError;
    }
    expect(caught?.code).toBe('unsupported.mixed_currency');
  });

  it('handles empty input', () => {
    const { snapshot, openLots, closedLots } = computePortfolio([], { method: 'fifo' });
    expect(snapshot.positions).toEqual([]);
    expect(openLots).toEqual([]);
    expect(closedLots).toEqual([]);
  });

  it('uses asOf when supplied', () => {
    const asOf = new Date('2026-06-01Z');
    const txns = [
      buildTx({ id: 1, security_id: 1, quantity: 10, amount_cents: D(100) }),
      buildTx({
        id: 2,
        security_id: 1,
        transaction_type: 'sell',
        quantity: 5,
        amount_cents: D(75),
        transaction_date: new Date('2026-12-01Z'),
      }),
    ];
    const { snapshot } = computePortfolio(txns, { method: 'fifo', asOf });
    // Sell is past asOf → ignored.
    expect(snapshot.positions[0]!.quantity).toBe(10);
    expect(snapshot.as_of).toEqual(asOf);
  });
});

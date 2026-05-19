import { computeIncomeStream } from './income';
import { buildTx, D, resetTxIds } from './test-helpers';

beforeEach(() => resetTxIds());

describe('computeIncomeStream', () => {
  it('aggregates dividends, interest, fees and net', () => {
    const txns = [
      buildTx({
        transaction_type: 'dividend',
        amount_cents: D(120),
        quantity: 0,
        price_cents: null,
      }),
      buildTx({
        transaction_type: 'interest',
        amount_cents: D(5),
        quantity: 0,
        price_cents: null,
      }),
      buildTx({
        transaction_type: 'fee',
        amount_cents: D(8),
        quantity: 0,
        price_cents: null,
      }),
    ];
    const s = computeIncomeStream(txns);
    expect(s.dividends_cents).toBe(D(120));
    expect(s.interest_cents).toBe(D(5));
    expect(s.fees_cents).toBe(D(8));
    expect(s.net_cents).toBe(D(117)); // 120 + 5 − 8
  });

  it('ignores share-affecting transactions', () => {
    const txns = [
      buildTx({ transaction_type: 'buy', quantity: 10, amount_cents: D(100) }),
      buildTx({
        transaction_type: 'dividend',
        amount_cents: D(20),
        quantity: 0,
        price_cents: null,
      }),
    ];
    const s = computeIncomeStream(txns);
    expect(s.dividends_cents).toBe(D(20));
    expect(s.net_cents).toBe(D(20));
  });

  it('applies inclusive date range', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'dividend',
        amount_cents: D(10),
        quantity: 0,
        price_cents: null,
        transaction_date: new Date('2026-01-15Z'),
      }),
      buildTx({
        id: 2,
        transaction_type: 'dividend',
        amount_cents: D(20),
        quantity: 0,
        price_cents: null,
        transaction_date: new Date('2026-06-15Z'),
      }),
      buildTx({
        id: 3,
        transaction_type: 'dividend',
        amount_cents: D(30),
        quantity: 0,
        price_cents: null,
        transaction_date: new Date('2026-12-15Z'),
      }),
    ];
    const s = computeIncomeStream(txns, {
      from: new Date('2026-03-01Z'),
      to: new Date('2026-09-01Z'),
    });
    expect(s.dividends_cents).toBe(D(20));
  });
});

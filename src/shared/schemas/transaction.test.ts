import {
  CreateTransactionSchema,
  isLotAffecting,
  isSecurityBearing,
  TX_TYPES,
} from './transaction';

const base = {
  account_id: 1,
  transaction_type: 'buy',
  symbol: 'AAPL',
  transaction_date: '2020-01-02T00:00:00.000Z',
  quantity: 10,
  price_cents: 15000,
  amount_cents: 150000,
};

describe('CreateTransactionSchema', () => {
  it('accepts a valid buy and coerces the date', () => {
    const r = CreateTransactionSchema.parse(base);
    expect(r.transaction_date).toBeInstanceOf(Date);
    expect(r.currency_code).toBe('USD');
  });

  it('rejects a future-dated transaction', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(() => CreateTransactionSchema.parse({ ...base, transaction_date: future })).toThrow();
  });

  it('rejects a buy with zero quantity', () => {
    expect(() => CreateTransactionSchema.parse({ ...base, quantity: 0 })).toThrow();
  });

  it('rejects a buy without a symbol', () => {
    const { symbol: _drop, ...noSym } = base;
    expect(() => CreateTransactionSchema.parse(noSym)).toThrow();
  });

  it('accepts a deposit with no symbol and no security', () => {
    const r = CreateTransactionSchema.parse({
      account_id: 1,
      transaction_type: 'deposit',
      transaction_date: '2020-01-02T00:00:00.000Z',
      amount_cents: 500000,
    });
    expect(r.transaction_type).toBe('deposit');
  });
});

describe('type predicates', () => {
  it('classifies lot-affecting and security-bearing types', () => {
    expect(isLotAffecting('sell')).toBe(true);
    expect(isLotAffecting('dividend')).toBe(false);
    expect(isSecurityBearing('dividend')).toBe(true);
    expect(isSecurityBearing('deposit')).toBe(false);
    expect(TX_TYPES).toHaveLength(10);
  });
});

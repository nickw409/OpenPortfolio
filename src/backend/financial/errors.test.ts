import { FinancialError } from './errors';

describe('FinancialError', () => {
  it('carries code, message, and frozen context', () => {
    const e = new FinancialError('domain.sell_exceeds_holdings', 'over the limit', {
      tx_id: 42,
    });
    expect(e.code).toBe('domain.sell_exceeds_holdings');
    expect(e.message).toBe('over the limit');
    expect(e.name).toBe('FinancialError');
    expect(e.context.tx_id).toBe(42);
    expect(Object.isFrozen(e.context)).toBe(true);
  });

  it('defaults context to {}', () => {
    const e = new FinancialError('unsupported.mixed_currency', 'mixed');
    expect(e.context).toEqual({});
  });

  it('is catchable as Error', () => {
    try {
      throw new FinancialError('domain.sell_exceeds_holdings', 'boom');
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(FinancialError);
    }
  });
});

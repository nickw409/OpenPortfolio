import { describe, it, expect } from 'vitest';

import { AccountSchema, AccountsResponseSchema } from './account';

describe('AccountSchema', () => {
  const valid = {
    id: 1,
    name: 'Brokerage',
    broker: 'Fidelity',
    taxTreatment: 'taxable',
    costBasisMethod: 'fifo',
    currencyCode: 'USD',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts a valid account', () => {
    expect(AccountSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a null broker', () => {
    expect(AccountSchema.safeParse({ ...valid, broker: null }).success).toBe(true);
  });

  const requiredFields = [
    'id',
    'name',
    'taxTreatment',
    'costBasisMethod',
    'currencyCode',
    'createdAt',
  ] as const;

  it.each(requiredFields)('rejects when %s is missing', (field) => {
    const partial = { ...valid };
    delete (partial as Record<string, unknown>)[field];
    expect(AccountSchema.safeParse(partial).success).toBe(false);
  });

  it('rejects an unknown tax treatment', () => {
    expect(AccountSchema.safeParse({ ...valid, taxTreatment: 'crypto' }).success).toBe(false);
  });

  it('rejects an unknown cost basis method', () => {
    expect(AccountSchema.safeParse({ ...valid, costBasisMethod: 'hifo' }).success).toBe(false);
  });
});

describe('AccountsResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(AccountsResponseSchema.safeParse({ accounts: [] }).success).toBe(true);
  });

  it('rejects missing accounts key', () => {
    expect(AccountsResponseSchema.safeParse({}).success).toBe(false);
  });
});

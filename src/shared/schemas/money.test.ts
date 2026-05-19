import { MoneySchema, NonNegativeMoneySchema } from './money';

describe('MoneySchema', () => {
  it('accepts integer cents', () => {
    const result = MoneySchema.safeParse(12345);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(12345);
    }
  });

  it('accepts negative integer cents (refunds, adjustments)', () => {
    const result = MoneySchema.safeParse(-500);
    expect(result.success).toBe(true);
  });

  it('rejects fractional cents (no silent rounding)', () => {
    const result = MoneySchema.safeParse(12.5);
    expect(result.success).toBe(false);
  });

  it('rejects NaN', () => {
    const result = MoneySchema.safeParse(NaN);
    expect(result.success).toBe(false);
  });

  it('rejects non-numbers', () => {
    expect(MoneySchema.safeParse('100').success).toBe(false);
    expect(MoneySchema.safeParse(null).success).toBe(false);
    expect(MoneySchema.safeParse(undefined).success).toBe(false);
  });
});

describe('NonNegativeMoneySchema', () => {
  it('accepts zero and positive integers', () => {
    expect(NonNegativeMoneySchema.safeParse(0).success).toBe(true);
    expect(NonNegativeMoneySchema.safeParse(100).success).toBe(true);
  });

  it('rejects negative integers', () => {
    const result = NonNegativeMoneySchema.safeParse(-1);
    expect(result.success).toBe(false);
  });
});

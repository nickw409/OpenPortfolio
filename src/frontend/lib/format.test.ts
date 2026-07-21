import { describe, expect, it } from 'vitest';

import { format as sharedFormat, ofCents } from '@shared/money';
import { formatMoney } from './format';

describe('formatMoney re-export', () => {
  it('resolves to @shared/money.format', () => {
    expect(formatMoney).toBe(sharedFormat);
  });

  it('produces the same output as @shared/money.format', () => {
    const m = ofCents(123_456);
    expect(formatMoney(m)).toBe(sharedFormat(m));
  });
});

import { z } from 'zod';

import type { Money } from '../money';

// Zod's `.brand<>()` mints a brand type structurally different from
// Money's `{ readonly __brand: 'money' }`, so we transform into the
// established Money brand instead. The runtime check (integer cents)
// is what matters at the boundary; the transform narrows the type.

export const MoneySchema = z
  .number()
  .int('Money must be integer cents (no fractional cents)')
  .transform((cents): Money => cents as Money);

export const NonNegativeMoneySchema = z
  .number()
  .int('Money must be integer cents (no fractional cents)')
  .nonnegative('Money must be non-negative')
  .transform((cents): Money => cents as Money);

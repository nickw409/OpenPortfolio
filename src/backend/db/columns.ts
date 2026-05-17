import { customType } from 'drizzle-orm/sqlite-core';
import { integer } from 'drizzle-orm/sqlite-core';

import { ofCents, type Money } from '@shared/money';

// Money column — stored as INTEGER cents, surfaced as branded Money.
export const money = customType<{ data: Money; driverData: number }>({
  dataType() {
    return 'integer';
  },
  fromDriver(value: number): Money {
    return ofCents(value);
  },
  toDriver(value: Money): number {
    return value as number;
  },
});

// Soft-delete + timestamps. Every user-data table spreads this in.
// Cache tables (price_history, cpi_data) deliberately don't use it.
export const timestamps = {
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  deleted_at: integer('deleted_at', { mode: 'timestamp_ms' }),
};

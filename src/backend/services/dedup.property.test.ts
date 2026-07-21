import fc from 'fast-check';

import { dedupKey } from './dedup';

it('dedupKey is deterministic for identical field values', () => {
  fc.assert(
    fc.property(
      fc.record({
        account_id: fc.integer(),
        security_id: fc.option(fc.integer(), { nil: null }),
        quantity: fc.double({ noNaN: true }),
        price_cents: fc.option(fc.integer(), { nil: null }),
        ms: fc.integer({ min: 0, max: 4_102_444_800_000 }),
      }),
      ({ account_id, security_id, quantity, price_cents, ms }) => {
        const mk = () =>
          dedupKey({
            account_id,
            security_id,
            quantity,
            price_cents,
            transaction_date: new Date(ms),
          });
        return mk() === mk();
      },
    ),
  );
});

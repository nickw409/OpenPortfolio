import { ZERO, type Money } from '@shared/money';

import { computePosition, emptyPosition } from './position';
import { D } from './test-helpers';
import type { Lot } from './types';

function lot(overrides: Partial<Lot> = {}): Lot {
  return {
    sourceTxId: 1,
    account_id: 1,
    security_id: 1,
    acquired_at: new Date('2026-01-01Z'),
    quantity: 100,
    cost_basis_cents: D(1000),
    currency_code: 'USD',
    ...overrides,
  };
}

describe('computePosition', () => {
  it('returns null when there are no lots', () => {
    expect(computePosition([])).toBeNull();
  });

  it('aggregates a single lot without a price (market value null)', () => {
    const snap = computePosition([lot()]);
    expect(snap).not.toBeNull();
    expect(snap!.quantity).toBe(100);
    expect(snap!.cost_basis_cents).toBe(D(1000));
    expect(snap!.market_value_cents).toBeNull();
    expect(snap!.unrealized_gain_cents).toBeNull();
  });

  it('sums quantity and cost basis across multiple lots', () => {
    const snap = computePosition([
      lot({ sourceTxId: 1, quantity: 10, cost_basis_cents: D(100) }),
      lot({ sourceTxId: 2, quantity: 20, cost_basis_cents: D(300) }),
    ]);
    expect(snap!.quantity).toBe(30);
    expect(snap!.cost_basis_cents).toBe(D(400));
  });

  it('computes market value and unrealized gain when price is supplied', () => {
    const snap = computePosition([lot({ quantity: 50, cost_basis_cents: D(500) })], {
      currentPriceCents: D(12),
    });
    expect(snap!.market_value_cents).toBe(D(600));
    expect(snap!.unrealized_gain_cents).toBe(D(100));
  });

  it('handles a loss (negative unrealized gain)', () => {
    const snap = computePosition([lot({ quantity: 10, cost_basis_cents: D(200) })], {
      currentPriceCents: D(15),
    });
    expect(snap!.market_value_cents).toBe(D(150));
    expect(snap!.unrealized_gain_cents).toBe(D(-50));
  });
});

describe('emptyPosition', () => {
  it('returns a zero-quantity placeholder', () => {
    const snap = emptyPosition(7, 42, 'USD');
    expect(snap.account_id).toBe(7);
    expect(snap.security_id).toBe(42);
    expect(snap.quantity).toBe(0);
    expect(snap.cost_basis_cents).toBe(ZERO as Money);
    expect(snap.market_value_cents).toBeNull();
  });
});

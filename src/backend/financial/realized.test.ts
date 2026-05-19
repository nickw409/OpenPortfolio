import { computeRealizedGainsLoss } from './realized';
import { D } from './test-helpers';
import type { ClosedLot } from './types';

function closed(overrides: Partial<ClosedLot> = {}): ClosedLot {
  return {
    sourceTxId: 1,
    sellTxId: 2,
    account_id: 1,
    security_id: 1,
    acquired_at: new Date('2026-01-01Z'),
    disposed_at: new Date('2026-06-01Z'),
    quantity: 10,
    proceeds_cents: D(150),
    cost_basis_cents: D(100),
    realized_gain_cents: D(50),
    currency_code: 'USD',
    ...overrides,
  };
}

describe('computeRealizedGainsLoss', () => {
  it('returns zero summary on empty input', () => {
    const s = computeRealizedGainsLoss([]);
    expect(s.closedLots).toEqual([]);
    expect(s.total_proceeds_cents).toBe(D(0));
    expect(s.total_cost_cents).toBe(D(0));
    expect(s.total_realized_gain_cents).toBe(D(0));
  });

  it('sums proceeds, cost, and gain across closed lots', () => {
    const s = computeRealizedGainsLoss([
      closed({ proceeds_cents: D(150), cost_basis_cents: D(100), realized_gain_cents: D(50) }),
      closed({ proceeds_cents: D(80), cost_basis_cents: D(100), realized_gain_cents: D(-20) }),
    ]);
    expect(s.total_proceeds_cents).toBe(D(230));
    expect(s.total_cost_cents).toBe(D(200));
    expect(s.total_realized_gain_cents).toBe(D(30));
  });

  it('filters by inclusive `from` boundary', () => {
    const s = computeRealizedGainsLoss(
      [
        closed({ disposed_at: new Date('2026-03-01Z') }),
        closed({ disposed_at: new Date('2026-06-01Z') }),
      ],
      { from: new Date('2026-06-01Z') },
    );
    expect(s.closedLots).toHaveLength(1);
  });

  it('filters by inclusive `to` boundary', () => {
    const s = computeRealizedGainsLoss(
      [
        closed({ disposed_at: new Date('2026-03-01Z') }),
        closed({ disposed_at: new Date('2026-06-01Z') }),
      ],
      { to: new Date('2026-03-01Z') },
    );
    expect(s.closedLots).toHaveLength(1);
  });

  it('applies both from and to', () => {
    const s = computeRealizedGainsLoss(
      [
        closed({ disposed_at: new Date('2026-01-01Z') }),
        closed({ disposed_at: new Date('2026-06-01Z') }),
        closed({ disposed_at: new Date('2026-12-01Z') }),
      ],
      { from: new Date('2026-03-01Z'), to: new Date('2026-09-01Z') },
    );
    expect(s.closedLots).toHaveLength(1);
    expect(s.closedLots[0]!.disposed_at).toEqual(new Date('2026-06-01Z'));
  });
});

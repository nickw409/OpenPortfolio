import { ofCents } from '@shared/money';

import { FinancialError } from './errors';
import { computeAllocation } from './allocation';
import { loadFixture, type AllocationFixture } from './test-helpers';
import type { PortfolioSnapshot } from './types';

function snap(positions: Array<{ account_id: number; security_id: number; mv: number; cb: number }>): PortfolioSnapshot {
  return {
    positions: positions.map((p) => ({
      account_id: p.account_id,
      security_id: p.security_id,
      quantity: 1,
      cost_basis_cents: ofCents(p.cb),
      current_price_cents: ofCents(p.mv),
      market_value_cents: ofCents(p.mv),
      unrealized_gain_cents: ofCents(p.mv - p.cb),
      currency_code: 'USD',
    })),
    total_cost_basis_cents: ofCents(positions.reduce((s, p) => s + p.cb, 0)),
    total_market_value_cents: ofCents(positions.reduce((s, p) => s + p.mv, 0)),
    total_unrealized_gain_cents: ofCents(positions.reduce((s, p) => s + (p.mv - p.cb), 0)),
    as_of: new Date('2026-12-31'),
  };
}

describe('computeAllocation — by asset_class', () => {
  it('partitions market value across asset classes; sums to 100%', () => {
    const s = snap([
      { account_id: 1, security_id: 1, mv: 60000, cb: 50000 },
      { account_id: 1, security_id: 2, mv: 40000, cb: 40000 },
      { account_id: 1, security_id: 3, mv: 100000, cb: 90000 },
    ]);
    const result = computeAllocation(s, {
      dimension: 'asset_class',
      securities: new Map([
        [1, { asset_class: 'equity' }],
        [2, { asset_class: 'bond' }],
        [3, { asset_class: 'equity' }],
      ]),
    });
    expect(result.dimension).toBe('asset_class');
    const totalPct = result.buckets.reduce((s, b) => s + b.weight_pct, 0);
    expect(totalPct).toBeCloseTo(100, 6);
    const equity = result.buckets.find((b) => b.key === 'equity')!;
    expect(Number(equity.market_value_cents)).toBe(160000);
    expect(equity.weight_pct).toBeCloseTo(80, 4);
  });

  it('throws allocation.missing_security when a security is not in the lookup map', () => {
    const s = snap([{ account_id: 1, security_id: 99, mv: 1, cb: 1 }]);
    try {
      computeAllocation(s, {
        dimension: 'asset_class',
        securities: new Map(),
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as FinancialError).code).toBe('allocation.missing_security');
    }
  });
});

describe('computeAllocation — by account', () => {
  it('partitions by account name', () => {
    const s = snap([
      { account_id: 1, security_id: 1, mv: 60000, cb: 50000 },
      { account_id: 2, security_id: 1, mv: 40000, cb: 40000 },
    ]);
    const result = computeAllocation(s, {
      dimension: 'account',
      accounts: new Map([
        [1, { name: 'Taxable' }],
        [2, { name: 'Roth IRA' }],
      ]),
    });
    expect(result.buckets.find((b) => b.key === 'Taxable')!.weight_pct).toBeCloseTo(60, 4);
    expect(result.buckets.find((b) => b.key === 'Roth IRA')!.weight_pct).toBeCloseTo(40, 4);
  });
});

describe('computeAllocation — by security', () => {
  it('uses symbol when present; falls back to security:<id> otherwise', () => {
    const s = snap([
      { account_id: 1, security_id: 1, mv: 70000, cb: 50000 },
      { account_id: 1, security_id: 2, mv: 30000, cb: 30000 },
    ]);
    const result = computeAllocation(s, {
      dimension: 'security',
      securities: new Map([
        [1, { symbol: 'VTI' }],
        [2, { symbol: null }],
      ]),
    });
    expect(result.buckets.find((b) => b.key === 'VTI')).toBeDefined();
    expect(result.buckets.find((b) => b.key === 'security:2')).toBeDefined();
  });
});

describe('fixture: allocation-by-class', () => {
  it('weights match the fixture-expected splits', () => {
    const fx = loadFixture<AllocationFixture>('allocation-by-class');
    const snap: PortfolioSnapshot = {
      ...fx.snapshot,
      positions: fx.snapshot.positions.map((p) => ({
        ...p,
        cost_basis_cents: ofCents(p.cost_basis_cents),
        current_price_cents: ofCents(p.current_price_cents),
        market_value_cents: ofCents(p.market_value_cents),
        unrealized_gain_cents: ofCents(p.unrealized_gain_cents),
      })),
      total_cost_basis_cents: ofCents(fx.snapshot.total_cost_basis_cents),
      total_market_value_cents: ofCents(fx.snapshot.total_market_value_cents),
      total_unrealized_gain_cents: ofCents(fx.snapshot.total_unrealized_gain_cents),
      as_of: new Date(fx.snapshot.as_of),
    };
    const securities = new Map(
      Object.entries(fx.securities).map(([k, v]): [number, { asset_class: string }] => [Number(k), v]),
    );
    const result = computeAllocation(snap, { dimension: 'asset_class', securities });
    expect(result.buckets.find((b) => b.key === 'equity')!.weight_pct).toBeCloseTo(
      fx.expected.equity_pct,
      4,
    );
    expect(result.buckets.find((b) => b.key === 'bond')!.weight_pct).toBeCloseTo(
      fx.expected.bond_pct,
      4,
    );
  });
});

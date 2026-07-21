import { ofCents } from '@shared/money';

import { FinancialError } from './errors';
import { computeAllocation } from './allocation';
import {
  loadFixture,
  reviveLots,
  type AllocationFixture,
  type TagAllocationFixture,
} from './test-helpers';
import type { Lot, PortfolioSnapshot } from './types';

function snap(
  positions: Array<{ account_id: number; security_id: number; mv: number; cb: number }>,
): PortfolioSnapshot {
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

describe('computeAllocation — by tag', () => {
  // Two securities in one account. Each open lot inherits the tags of its
  // opening buy; a lot with several tags contributes its full market value
  // to every one of those buckets, so tag weights can sum past 100%.
  const snapshot: PortfolioSnapshot = {
    positions: [
      {
        account_id: 1,
        security_id: 1,
        quantity: 100,
        cost_basis_cents: ofCents(11000),
        current_price_cents: ofCents(120),
        market_value_cents: ofCents(12000),
        unrealized_gain_cents: ofCents(1000),
        currency_code: 'USD',
      },
      {
        account_id: 1,
        security_id: 2,
        quantity: 200,
        cost_basis_cents: ofCents(17000),
        current_price_cents: ofCents(100),
        market_value_cents: ofCents(20000),
        unrealized_gain_cents: ofCents(3000),
        currency_code: 'USD',
      },
    ],
    total_cost_basis_cents: ofCents(28000),
    total_market_value_cents: ofCents(32000),
    total_unrealized_gain_cents: ofCents(4000),
    as_of: new Date('2026-12-31T00:00:00Z'),
  };
  // sec 1 lots price at 120¢/sh → 6000¢ each; sec 2 lots at 100¢/sh → 10000¢ each.
  const lots: Lot[] = [
    {
      sourceTxId: 1,
      account_id: 1,
      security_id: 1,
      acquired_at: new Date('2026-01-01T00:00:00Z'),
      quantity: 50,
      cost_basis_cents: ofCents(5000),
      currency_code: 'USD',
    },
    {
      sourceTxId: 2,
      account_id: 1,
      security_id: 1,
      acquired_at: new Date('2026-02-01T00:00:00Z'),
      quantity: 50,
      cost_basis_cents: ofCents(6000),
      currency_code: 'USD',
    },
    {
      sourceTxId: 3,
      account_id: 1,
      security_id: 2,
      acquired_at: new Date('2026-03-01T00:00:00Z'),
      quantity: 100,
      cost_basis_cents: ofCents(8000),
      currency_code: 'USD',
    },
    {
      sourceTxId: 4,
      account_id: 1,
      security_id: 2,
      acquired_at: new Date('2026-04-01T00:00:00Z'),
      quantity: 100,
      cost_basis_cents: ofCents(9000),
      currency_code: 'USD',
    },
  ];
  const lotTags = new Map<number, string[]>([
    [1, ['core']],
    [2, ['core']],
    [3, ['core', 'long-term']],
    // sourceTxId 4 has no entry → untagged
  ]);

  it('attributes each lot market value to every tag; multi-tagged lots push the weight sum over 100%', () => {
    const result = computeAllocation(snapshot, { dimension: 'tag', lots, lotTags });
    expect(result.dimension).toBe('tag');
    // Denominator is the portfolio total, each lot counted once.
    expect(Number(result.total_market_value_cents)).toBe(32000);
    const core = result.buckets.find((b) => b.key === 'core')!;
    const longTerm = result.buckets.find((b) => b.key === 'long-term')!;
    expect(Number(core.market_value_cents)).toBe(22000); // 6000 + 6000 + 10000
    expect(core.weight_pct).toBeCloseTo(68.75, 6);
    expect(Number(longTerm.market_value_cents)).toBe(10000);
    expect(longTerm.weight_pct).toBeCloseTo(31.25, 6);
    const totalPct = result.buckets.reduce((s, b) => s + b.weight_pct, 0);
    expect(totalPct).toBeGreaterThan(100);
  });

  it('buckets lots whose opening buy carries no tags under "(untagged)"', () => {
    const result = computeAllocation(snapshot, { dimension: 'tag', lots, lotTags });
    const untagged = result.buckets.find((b) => b.key === '(untagged)')!;
    expect(untagged).toBeDefined();
    expect(Number(untagged.market_value_cents)).toBe(10000);
    expect(untagged.weight_pct).toBeCloseTo(31.25, 6);
  });

  it('throws when lots or lotTags are missing for the tag dimension', () => {
    expect(() => computeAllocation(snapshot, { dimension: 'tag' })).toThrow();
    expect(() => computeAllocation(snapshot, { dimension: 'tag', lots })).toThrow();
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
      Object.entries(fx.securities).map(([k, v]): [number, { asset_class: string }] => [
        Number(k),
        v,
      ]),
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

describe('fixture: allocation-by-tag', () => {
  it('tag weights match the fixture splits and sum past 100%', () => {
    const fx = loadFixture<TagAllocationFixture>('allocation-by-tag');
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
    const lots = reviveLots(fx.lots);
    const lotTags = new Map(
      Object.entries(fx.lotTags).map(([k, v]): [number, string[]] => [Number(k), v]),
    );
    const result = computeAllocation(snap, { dimension: 'tag', lots, lotTags });
    expect(Number(result.total_market_value_cents)).toBe(fx.expected.total_market_value_cents);
    expect(result.buckets.find((b) => b.key === 'core')!.weight_pct).toBeCloseTo(
      fx.expected.core_pct,
      4,
    );
    expect(result.buckets.find((b) => b.key === 'long-term')!.weight_pct).toBeCloseTo(
      fx.expected.long_term_pct,
      4,
    );
    expect(result.buckets.find((b) => b.key === '(untagged)')!.weight_pct).toBeCloseTo(
      fx.expected.untagged_pct,
      4,
    );
    const totalPct = result.buckets.reduce((s, b) => s + b.weight_pct, 0);
    expect(totalPct).toBeGreaterThan(100);
  });
});

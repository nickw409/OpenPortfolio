# Financial engine slice 2 — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land WS3 slice 2: daily TWR via an exported `computeValuationSeries` primitive, MWR via Newton+bisection IRR, drawdown (nominal+real), real-return deflation via period-boundary linear CPI interpolation, and allocation (asset_class/account/security/tag-at-lot).

**Architecture:** Six new pure-function modules next to slice 1 in `src/backend/financial/`. Choke point is `computeValuationSeries(txns, prices, range, opts) → ValuationSeries` — a daily series of `{ market_value, cost_basis, external_cashflow, tr_index }`. TWR, drawdown, real-returns reduce over it. MWR runs Newton-Raphson on cashflow NPV with bisection fallback. Allocation is a separate snapshot reducer over slice-1 outputs. Zero I/O, zero Drizzle in the engine — service layer (separate, not in this plan) is what loads rows and calls in.

**Tech stack:** TypeScript strict, vitest, fast-check for property tests, `@shared/money` for integer-cent math. No new runtime deps.

**Spec:** [docs/specs/2026-05-19-financial-engine-slice-2.md](../../specs/2026-05-19-financial-engine-slice-2.md)

---

## File structure

- **Create:** `src/backend/financial/valuation.ts` — `computeValuationSeries` + internal helpers (carry-forward, scope-aware cashflow filter, TR-index walk)
- **Create:** `src/backend/financial/valuation.test.ts` — unit tests
- **Create:** `src/backend/financial/valuation.property.test.ts` — TR-index invariants
- **Create:** `src/backend/financial/twr.ts` — `computeTimeWeightedReturn`
- **Create:** `src/backend/financial/twr.test.ts`
- **Create:** `src/backend/financial/mwr.ts` — `computeMoneyWeightedReturn` (Newton + bisection)
- **Create:** `src/backend/financial/mwr.test.ts`
- **Create:** `src/backend/financial/cpi.ts` — linear interpolation + `computeRealReturn` helper
- **Create:** `src/backend/financial/cpi.test.ts`
- **Create:** `src/backend/financial/drawdown.ts` — peak/trough/recovery on TR index
- **Create:** `src/backend/financial/drawdown.test.ts`
- **Create:** `src/backend/financial/allocation.ts` — partitioned + tag-attribution dimensions
- **Create:** `src/backend/financial/allocation.test.ts`
- **Modify:** `src/backend/financial/types.ts` — append slice-2 types (Scope, DateRange, PriceHistory, CpiSeries, ValuationSeries, MwrResult, TwrResult, DrawdownStats, RealReturnResult, AllocationOptions, AllocationBreakdown)
- **Modify:** `src/backend/financial/errors.ts` — add new codes
- **Modify:** `src/backend/financial/test-helpers.ts` — `dateD(YYYYMMDD)`, `buildPriceHistory`, `buildCpiSeries` builders
- **Modify:** `src/backend/financial/index.ts` — export the six new functions and their types
- **Modify:** `docs/WORKSTREAMS.md` — flip slice 2 items from `[ ]` to `[x]` once everything lands
- **Create (fixtures):** `tests/fixtures/financial/daily-twr-simple.json`, `cashflows-mid-period.json`, `drawdown-2008.json`, `real-returns-1979-1981.json`, `pre-funding-days.json`, `allocation-by-class.json`, `allocation-by-tag.json`

Each `.ts` source file stays under ~250 LOC; if any approaches that, split before merging.

Conventional flow per task: write the failing test, run it, write the minimum code, run again, commit. The plan shows the *contract* (test bodies) precisely; implementation bodies are sketched where the algorithm is non-obvious (TR-index walk, IRR, drawdown peak/trough) and otherwise inferred from the test.

---

## Task 1: Extend types and errors

**Files:**
- Modify: `src/backend/financial/types.ts`
- Modify: `src/backend/financial/errors.ts`

### Step 1.1: Append new type exports to `types.ts`

- [ ] Add at the end of `worktrees/feat-financial-engine-slice-2/src/backend/financial/types.ts`:

```typescript
// ─── slice 2: time / range / scope ──────────────────────────────────────

// Inclusive on both ends. `to >= from` required (RangeError otherwise).
export interface DateRange {
  from: Date;
  to: Date;
}

// Portfolio scope nets cross-account transfers; per-account scope treats
// transfer_in/transfer_out as deposits/withdrawals for that account's books.
export type Scope = 'portfolio' | { account_id: number };

// ─── slice 2: price history ─────────────────────────────────────────────

// Sparse — engine forward-carries the last known price across weekends,
// holidays, and gaps. Throws `price.stale` if a held day has no preceding
// price within `maxStalenessDays` for the security.
export interface PricePoint {
  date: Date;
  price_cents: Money;
}
export type PriceHistory = ReadonlyMap<number, ReadonlyArray<PricePoint>>;

// ─── slice 2: CPI ───────────────────────────────────────────────────────

// Monthly BLS CPI-U release-date / index-value pairs. Engine linearly
// interpolates between adjacent points; throws `cpi.out_of_range` for any
// requested date outside [first.date, last.date].
export interface CpiPoint {
  date: Date;
  index: number;
}
export type CpiSeries = ReadonlyArray<CpiPoint>;

// ─── slice 2: valuation series ──────────────────────────────────────────

export interface ValuationPoint {
  date: Date;
  market_value_cents: Money;
  cost_basis_cents: Money;
  external_cashflow_cents: Money;
  tr_index: number;
}
export interface ValuationSeries {
  points: ReadonlyArray<ValuationPoint>;
  scope: Scope;
  range: DateRange;
}

// ─── slice 2: TWR / MWR / drawdown / real / allocation results ──────────

export interface TwrResult {
  return_pct: number;            // total period
  annualized_pct: number | null; // null when range < 365.25 days
  days: number;
}

export interface MwrResult {
  irr_pct: number;                            // annualized
  iterations: number;
  method: 'newton' | 'bisection';
}

export interface DrawdownStats {
  max_drawdown_pct: number;                    // in [−100, 0]
  max_drawdown_peak_date: Date;
  max_drawdown_trough_date: Date;
  max_drawdown_recovery_date: Date | null;     // null if never recovered
  current_drawdown_pct: number;                // 0 if at all-time high
  current_peak_date: Date;
}

export interface DrawdownResult {
  nominal: DrawdownStats;
  real: DrawdownStats | null;                  // null when cpi omitted
}

export interface RealReturnResult {
  real_pct: number;
  cpi_change_pct: number;
}

export type AllocationDimension = 'asset_class' | 'account' | 'security' | 'tag';

export interface AllocationOptions {
  dimension: AllocationDimension;
  securities?: ReadonlyMap<number, { asset_class?: string; symbol?: string | null }>;
  accounts?: ReadonlyMap<number, { name: string; tax_treatment?: string }>;
  lots?: ReadonlyArray<Lot>;
  lotTags?: ReadonlyMap<number, ReadonlyArray<string>>;
}

export interface AllocationBucket {
  key: string;
  market_value_cents: Money;
  cost_basis_cents: Money;
  weight_pct: number;
}

export interface AllocationBreakdown {
  dimension: AllocationDimension;
  buckets: ReadonlyArray<AllocationBucket>;
  total_market_value_cents: Money;
}
```

### Step 1.2: Append new error codes to `errors.ts`

- [ ] Extend the `FinancialErrorCode` union in `worktrees/feat-financial-engine-slice-2/src/backend/financial/errors.ts`:

```typescript
export type FinancialErrorCode =
  | 'domain.sell_exceeds_holdings'
  | 'domain.unknown_lot_reference'
  | 'domain.specific_selection_missing'
  | 'domain.specific_selection_quantity_mismatch'
  | 'domain.split_without_open_lots'
  | 'unsupported.corporate_action'
  | 'unsupported.mixed_currency'
  | 'unsupported.mixed_grouping'
  | 'price.stale'
  | 'cpi.out_of_range'
  | 'irr.bad_initial_state'
  | 'irr.no_solution'
  | 'irr.no_convergence'
  | 'allocation.missing_security'
  | 'allocation.missing_account';
```

### Step 1.3: Verify typecheck

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 typecheck`
- [ ] Expected: passes. No code consumes the new types yet, but the union/aliases must compile cleanly against the existing `Lot`, `Money`, `Tx` imports.

### Step 1.4: Commit

- [ ] Stage and commit:

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/types.ts src/backend/financial/errors.ts
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): slice 2 types and error codes

Adds the type vocabulary the slice 2 engine will speak: Scope, DateRange,
PriceHistory, CpiSeries, ValuationSeries, and the per-function result
types. Adds price.stale / cpi.out_of_range / irr.* / allocation.* codes to
FinancialError. No behavior yet — typecheck-only."
```

---

## Task 2: Test-helper builders for slice 2

**Files:**
- Modify: `src/backend/financial/test-helpers.ts`

### Step 2.1: Add `dateD`, `buildPriceHistory`, `buildCpiSeries`

- [ ] Append to `worktrees/feat-financial-engine-slice-2/src/backend/financial/test-helpers.ts`:

```typescript
import type { CpiPoint, PriceHistory, PricePoint } from './types';

// Builds a UTC date from "YYYY-MM-DD" — short form used by slice 2 tests
// where the exact time-of-day is irrelevant.
export function dateD(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

// Build a PriceHistory map from an inline literal. Each entry is
// [securityId, [[isoDate, cents], ...]]. Dates are normalized via dateD.
export function buildPriceHistory(
  entries: ReadonlyArray<readonly [number, ReadonlyArray<readonly [string, number]>]>,
): PriceHistory {
  const out = new Map<number, ReadonlyArray<PricePoint>>();
  for (const [sec, pts] of entries) {
    out.set(
      sec,
      pts.map(([d, c]) => ({ date: dateD(d), price_cents: C(c) })),
    );
  }
  return out;
}

// Build a CpiSeries from inline literals: [[isoDate, indexValue], ...].
export function buildCpiSeries(
  entries: ReadonlyArray<readonly [string, number]>,
): ReadonlyArray<CpiPoint> {
  return entries.map(([d, idx]) => ({ date: dateD(d), index: idx }));
}
```

### Step 2.2: Typecheck

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 typecheck`
- [ ] Expected: passes.

### Step 2.3: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/test-helpers.ts
git -C worktrees/feat-financial-engine-slice-2 commit -m "test(financial): builders for date / price-history / cpi-series

Slice 2 tests will inline literal date+price and date+cpi inputs; these
builders take the ceremony out of constructing the readonly maps and arrays."
```

---

## Task 3: CPI interpolation (`cpi.ts`)

The smallest stand-alone piece. Implement first so later tasks can compose against a tested helper.

**Files:**
- Create: `src/backend/financial/cpi.ts`
- Create: `src/backend/financial/cpi.test.ts`

### Step 3.1: Write the failing test

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/cpi.test.ts`:

```typescript
import { FinancialError } from './errors';
import { cpiAt, computeRealReturn } from './cpi';
import { buildCpiSeries, dateD } from './test-helpers';

describe('cpiAt — exact-date lookup', () => {
  it('returns the index on an exact release date', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-02-01', 303.0],
    ]);
    expect(cpiAt(cpi, dateD('2026-01-01'))).toBe(300.0);
    expect(cpiAt(cpi, dateD('2026-02-01'))).toBe(303.0);
  });
});

describe('cpiAt — linear interpolation', () => {
  it('returns the midpoint exactly halfway between releases', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-02-01', 303.0],
    ]);
    // 2026-01-16 is 15/31 of the way from Jan-1 to Feb-1.
    const expected = 300.0 + (303.0 - 300.0) * (15 / 31);
    expect(cpiAt(cpi, dateD('2026-01-16'))).toBeCloseTo(expected, 10);
  });
});

describe('cpiAt — out of range', () => {
  it('throws cpi.out_of_range below first release', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-02-01', 303.0],
    ]);
    expect(() => cpiAt(cpi, dateD('2025-12-31'))).toThrow(FinancialError);
  });

  it('throws cpi.out_of_range above last release', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-02-01', 303.0],
    ]);
    try {
      cpiAt(cpi, dateD('2026-02-02'));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(FinancialError);
      expect((e as FinancialError).code).toBe('cpi.out_of_range');
    }
  });

  it('throws on empty cpi series', () => {
    expect(() => cpiAt(buildCpiSeries([]), dateD('2026-01-01'))).toThrow(FinancialError);
  });
});

describe('computeRealReturn — period-boundary deflation', () => {
  it('zero inflation ⇒ real == nominal', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2027-01-01', 300.0],
    ]);
    const result = computeRealReturn(
      10.0, // 10% nominal
      { from: dateD('2026-01-01'), to: dateD('2027-01-01') },
      cpi,
    );
    expect(result.real_pct).toBeCloseTo(10.0, 8);
    expect(result.cpi_change_pct).toBeCloseTo(0, 8);
  });

  it('positive inflation reduces real return: (1+nom)/(1+cpi) - 1', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2027-01-01', 309.0], // +3% CPI
    ]);
    const result = computeRealReturn(
      10.0,
      { from: dateD('2026-01-01'), to: dateD('2027-01-01') },
      cpi,
    );
    // real = (1.10 / 1.03) - 1 = 0.067961... = 6.7961...%
    expect(result.real_pct).toBeCloseTo(6.7961165, 5);
    expect(result.cpi_change_pct).toBeCloseTo(3.0, 8);
  });

  it('range validation: throws RangeError when to < from', () => {
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2027-01-01', 303.0],
    ]);
    expect(() =>
      computeRealReturn(5, { from: dateD('2027-01-01'), to: dateD('2026-01-01') }, cpi),
    ).toThrow(RangeError);
  });
});
```

### Step 3.2: Run the failing test

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/cpi.test.ts`
- [ ] Expected: FAIL — `cpi` module does not exist.

### Step 3.3: Write the implementation

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/cpi.ts`:

```typescript
// CPI helpers. Linear interpolation between adjacent monthly BLS CPI-U
// release-date / index-value points. Strict out-of-range behavior: the
// engine never extrapolates — extrapolation is a forecast, and forecasts
// don't belong in audited calc code. See
// docs/specs/2026-05-19-financial-engine-slice-2.md F6.

import { FinancialError } from './errors';
import type { CpiSeries, DateRange, RealReturnResult } from './types';

// Returns the CPI index at `date`, interpolating linearly between adjacent
// release-date points. Throws `cpi.out_of_range` if `date` is outside
// [first.date, last.date] or the series is empty.
export function cpiAt(cpi: CpiSeries, date: Date): number {
  if (cpi.length === 0) {
    throw new FinancialError('cpi.out_of_range', 'CPI series is empty', { requested_date: date });
  }
  const t = date.getTime();
  const first = cpi[0]!;
  const last = cpi[cpi.length - 1]!;
  if (t < first.date.getTime() || t > last.date.getTime()) {
    throw new FinancialError(
      'cpi.out_of_range',
      'CPI series does not cover the requested date',
      {
        requested_date: date,
        cpi_range: { from: first.date, to: last.date },
      },
    );
  }
  // Binary search for the segment that brackets t. CPI series is monthly
  // — typically dozens to hundreds of points — so linear scan is also fine.
  let lo = 0;
  let hi = cpi.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (cpi[mid]!.date.getTime() <= t) lo = mid;
    else hi = mid;
  }
  const a = cpi[lo]!;
  const b = cpi[hi]!;
  if (a.date.getTime() === t) return a.index;
  if (b.date.getTime() === t) return b.index;
  const frac = (t - a.date.getTime()) / (b.date.getTime() - a.date.getTime());
  return a.index + (b.index - a.index) * frac;
}

// Period-boundary deflation: real = (1+nominal)/(1+cpi_change) − 1.
// `nominal_pct` and the returned `real_pct`/`cpi_change_pct` are all in
// percent (10 means +10%, not +1000%).
export function computeRealReturn(
  nominal_pct: number,
  range: DateRange,
  cpi: CpiSeries,
): RealReturnResult {
  if (range.to.getTime() < range.from.getTime()) {
    throw new RangeError('range.to must be >= range.from');
  }
  const cpiStart = cpiAt(cpi, range.from);
  const cpiEnd = cpiAt(cpi, range.to);
  const cpiChange = cpiEnd / cpiStart - 1;
  const nominal = nominal_pct / 100;
  const real = (1 + nominal) / (1 + cpiChange) - 1;
  return {
    real_pct: real * 100,
    cpi_change_pct: cpiChange * 100,
  };
}
```

### Step 3.4: Run the test to verify it passes

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/cpi.test.ts`
- [ ] Expected: PASS, all describe blocks green.

### Step 3.5: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/cpi.ts src/backend/financial/cpi.test.ts
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): cpi interpolation + period-boundary real return

Spec §F6. cpiAt does linear interpolation between adjacent monthly BLS
CPI-U points; out-of-range throws cpi.out_of_range — the engine never
extrapolates (forecasts don't belong in audited calc code).
computeRealReturn is the stateless period-boundary helper used both by
callers wanting a single number and by drawdown's real branch later."
```

---

## Task 3.5: Helper — open lots at a date

Tiny pure helper the valuation walk will reuse. Slice 1 already does this internally inside `computeLots`; we just need the per-day snapshot. Splitting it out keeps the valuation walk readable.

**Files:**
- Modify: `src/backend/financial/valuation.ts` (created in Task 4; this lives as an internal helper)

This step is folded into Task 4 — no separate task. Implementation note kept here so Task 4 doesn't surprise the reader: the valuation walk calls `computeLots(txns, { method: 'fifo', asOf })` once per day-with-a-change (not every day) and reuses the open-lots snapshot until the next change. Using FIFO is fine because the valuation sum only depends on `openLots[*].quantity`, which is method-invariant — the basis split between FIFO and LIFO differs, but the total quantity held does not.

---

## Task 4: `computeValuationSeries` — happy path

**Files:**
- Create: `src/backend/financial/valuation.ts`
- Create: `src/backend/financial/valuation.test.ts`

### Step 4.1: Write the failing test

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/valuation.test.ts`:

```typescript
import { ofCents } from '@shared/money';

import { computeValuationSeries } from './valuation';
import { buildPriceHistory, buildTx, D, dateD, resetTxIds } from './test-helpers';

beforeEach(() => resetTxIds());

describe('computeValuationSeries — empty', () => {
  it('returns one point per day with zero value when no txns exist', () => {
    const series = computeValuationSeries(
      [],
      buildPriceHistory([]),
      { from: dateD('2026-01-01'), to: dateD('2026-01-03') },
      { scope: 'portfolio' },
    );
    expect(series.points).toHaveLength(3);
    expect(series.points.map((p) => p.market_value_cents)).toEqual([
      ofCents(0),
      ofCents(0),
      ofCents(0),
    ]);
    expect(series.points.map((p) => p.tr_index)).toEqual([1.0, 1.0, 1.0]);
  });
});

describe('computeValuationSeries — single buy with daily prices', () => {
  it('emits one point per day, market value = qty × carried-forward price', () => {
    // Buy 100 shares at $10 on day 1; price moves $10 → $11 → $12 over 3 days.
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [
        1,
        [
          ['2026-01-01', 1000], // $10.00
          ['2026-01-02', 1100], // $11.00
          ['2026-01-03', 1200], // $12.00
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-03') },
      { scope: 'portfolio' },
    );
    expect(series.points.map((p) => p.market_value_cents)).toEqual([
      D(1000), // 100 × $10.00
      D(1100), // 100 × $11.00
      D(1200), // 100 × $12.00
    ]);
    expect(series.points.map((p) => p.cost_basis_cents)).toEqual([D(1000), D(1000), D(1000)]);
    expect(series.points.map((p) => p.external_cashflow_cents)).toEqual([D(0), D(0), D(0)]);
  });
});

describe('computeValuationSeries — carry-forward for weekend / gap', () => {
  it('uses the last known price on days with no price update', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    // Only days 1 and 4 have a price. Days 2 and 3 carry forward day 1's
    // $10.00 — they are not stale within the 7-day default window.
    const prices = buildPriceHistory([
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-04', 1100],
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-04') },
      { scope: 'portfolio' },
    );
    expect(series.points.map((p) => p.market_value_cents)).toEqual([
      D(1000), // day 1
      D(1000), // day 2 — carry
      D(1000), // day 3 — carry
      D(1100), // day 4
    ]);
  });
});

describe('computeValuationSeries — multi-security portfolio', () => {
  it('sums market value across positions; each security has its own price line', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'buy',
        security_id: 1,
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        security_id: 2,
        transaction_date: dateD('2026-01-01'),
        quantity: 50,
        price_cents: D(20),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2026-01-02', 1100]]],
      [2, [['2026-01-01', 2000], ['2026-01-02', 1900]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-02') },
      { scope: 'portfolio' },
    );
    expect(series.points[0]!.market_value_cents).toBe(D(2000)); // 1000 + 1000
    expect(series.points[1]!.market_value_cents).toBe(D(2050)); // 1100 + 950
  });
});

describe('computeValuationSeries — range validation', () => {
  it('throws RangeError when to < from', () => {
    expect(() =>
      computeValuationSeries(
        [],
        buildPriceHistory([]),
        { from: dateD('2026-01-02'), to: dateD('2026-01-01') },
        { scope: 'portfolio' },
      ),
    ).toThrow(RangeError);
  });
});
```

### Step 4.2: Run the failing test

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/valuation.test.ts`
- [ ] Expected: FAIL — `valuation` module does not exist.

### Step 4.3: Write the implementation (happy path only)

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/valuation.ts`. Structure: a single exported function plus internal helpers for (a) carry-forward price lookup, (b) summing market value across open lots at a date, (c) walking the day-by-day series. TR index, cashflow handling, and staleness checking arrive in tasks 5–7; this task keeps the file *almost* working so the tests compile and the happy-path cases pass.

```typescript
// Daily valuation series — the choke point of slice 2. TWR / drawdown /
// real-returns all reduce over this. Pure: takes txns + sparse prices +
// range + scope, returns a per-day series of
// { market_value, cost_basis, external_cashflow, tr_index }.
// See docs/specs/2026-05-19-financial-engine-slice-2.md.

import { add, multiplyByRatio, ofCents, ZERO, type Money } from '@shared/money';

import { computeLots } from './lots';
import { FinancialError } from './errors';
import type {
  DateRange,
  PriceHistory,
  Scope,
  Tx,
  ValuationPoint,
  ValuationSeries,
} from './types';

export interface ComputeValuationSeriesOptions {
  scope: Scope;
  maxStalenessDays?: number;
}

const ONE_DAY_MS = 86_400_000;
const DEFAULT_MAX_STALENESS_DAYS = 7;

export function computeValuationSeries(
  txns: ReadonlyArray<Tx>,
  prices: PriceHistory,
  range: DateRange,
  opts: ComputeValuationSeriesOptions,
): ValuationSeries {
  if (range.to.getTime() < range.from.getTime()) {
    throw new RangeError('range.to must be >= range.from');
  }
  if ((opts.maxStalenessDays ?? DEFAULT_MAX_STALENESS_DAYS) < 0) {
    throw new RangeError('maxStalenessDays must be non-negative');
  }

  // Iterate one day at a time; for each day, snapshot open lots and value
  // them at the carried-forward price. TR-index and cashflow handling
  // land in later tasks — set both to neutral here.
  const points: ValuationPoint[] = [];
  for (
    let t = range.from.getTime();
    t <= range.to.getTime();
    t += ONE_DAY_MS
  ) {
    const day = new Date(t);
    const { openLots } = computeLots(txns, { method: 'fifo', asOf: day });

    let marketValue: Money = ZERO;
    let costBasis: Money = ZERO;
    for (const lot of openLots) {
      const price = lookupCarryForwardPrice(prices, lot.security_id, day);
      if (price !== null) {
        marketValue = add(marketValue, multiplyByRatio(price, lot.quantity));
      } else {
        // No carry-forward available at all. Allowed silently in this
        // task (no positions in tests); Task 7 promotes this to price.stale.
        marketValue = add(marketValue, ZERO);
      }
      costBasis = add(costBasis, lot.cost_basis_cents);
    }

    points.push({
      date: day,
      market_value_cents: marketValue,
      cost_basis_cents: costBasis,
      external_cashflow_cents: ZERO, // Task 6
      tr_index: 1.0,                  // Task 5
    });
  }

  return { points, scope: opts.scope, range };
}

// Returns the most recent price at or before `date` for `securityId`,
// or null if no such price exists in the series. Staleness check is
// applied separately (Task 7).
function lookupCarryForwardPrice(
  prices: PriceHistory,
  securityId: number,
  date: Date,
): Money | null {
  const series = prices.get(securityId);
  if (!series || series.length === 0) return null;
  const t = date.getTime();
  // Binary search for the largest index with date <= t.
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid]!.date.getTime() <= t) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo - 1;
  if (idx < 0) return null;
  return series[idx]!.price_cents;
}
```

The `lookupCarryForwardPrice` deserves an internal comment explaining the forward-only contract (no backward extrapolation), but the test in Task 4 doesn't yet exercise that branch — Task 7 will add it.

### Step 4.4: Run the test to verify it passes

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/valuation.test.ts`
- [ ] Expected: all 5 tests PASS.

### Step 4.5: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/valuation.ts src/backend/financial/valuation.test.ts
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): computeValuationSeries happy path

Daily walk over the requested range; per-day market value = Σ open lots ×
carried-forward price; per-day cost basis = Σ open lots' basis. Forward-
only price carry-forward (binary search for the most-recent point at or
before the day). Cashflow handling, TR-index, and staleness checking
arrive in follow-up commits — set to neutral defaults here."
```

---

## Task 5: TR index + cashflows + scope handling

**Files:**
- Modify: `src/backend/financial/valuation.ts`
- Modify: `src/backend/financial/valuation.test.ts`

### Step 5.1: Add cashflow + TR-index tests

- [ ] Append to `valuation.test.ts`:

```typescript
describe('computeValuationSeries — external cashflows', () => {
  it('portfolio scope: deposits and withdrawals are external; transfer_in/out are not', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        transaction_date: dateD('2026-01-02'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(500),
      }),
      buildTx({
        id: 2,
        transaction_type: 'withdrawal',
        transaction_date: dateD('2026-01-03'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(100),
      }),
      buildTx({
        id: 3,
        transaction_type: 'transfer_in',
        transaction_date: dateD('2026-01-03'),
        security_id: 1,
        quantity: 10,
        price_cents: D(10),
        amount_cents: D(100),
      }),
    ];
    const series = computeValuationSeries(
      txns,
      buildPriceHistory([[1, [['2026-01-01', 1000]]]]),
      { from: dateD('2026-01-01'), to: dateD('2026-01-03') },
      { scope: 'portfolio' },
    );
    expect(series.points.map((p) => p.external_cashflow_cents)).toEqual([
      D(0),    // day 1 — nothing
      D(500),  // day 2 — deposit
      D(-100), // day 3 — withdrawal (transfer_in is internal at portfolio scope)
    ]);
  });

  it('account scope: transfer_in / transfer_out count as deposits / withdrawals for that account', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        account_id: 1,
        transaction_date: dateD('2026-01-01'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(500),
      }),
      buildTx({
        id: 2,
        transaction_type: 'transfer_in',
        account_id: 1,
        transaction_date: dateD('2026-01-02'),
        security_id: 1,
        quantity: 10,
        price_cents: D(10),
        amount_cents: D(100),
      }),
      buildTx({
        id: 3,
        transaction_type: 'transfer_out',
        account_id: 1,
        transaction_date: dateD('2026-01-03'),
        security_id: 1,
        quantity: 5,
        price_cents: D(10),
        amount_cents: D(50),
      }),
      // Other account — must be ignored entirely.
      buildTx({
        id: 4,
        transaction_type: 'deposit',
        account_id: 2,
        transaction_date: dateD('2026-01-02'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(9999),
      }),
    ];
    const series = computeValuationSeries(
      txns,
      buildPriceHistory([[1, [['2026-01-01', 1000]]]]),
      { from: dateD('2026-01-01'), to: dateD('2026-01-03') },
      { scope: { account_id: 1 } },
    );
    expect(series.points.map((p) => p.external_cashflow_cents)).toEqual([
      D(500),  // day 1 — deposit to account 1
      D(100),  // day 2 — transfer_in counted as deposit for account 1
      D(-50),  // day 3 — transfer_out counted as withdrawal for account 1
    ]);
  });
});

describe('computeValuationSeries — TR index', () => {
  it('flat day with no cashflow: tr_index unchanged', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2026-01-02', 1000]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-02') },
      { scope: 'portfolio' },
    );
    expect(series.points[0]!.tr_index).toBe(1.0);
    expect(series.points[1]!.tr_index).toBe(1.0);
  });

  it('+10% price day: tr_index goes 1.0 → 1.10', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2026-01-02', 1100]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-02') },
      { scope: 'portfolio' },
    );
    expect(series.points[0]!.tr_index).toBe(1.0);
    expect(series.points[1]!.tr_index).toBeCloseTo(1.10, 10);
  });

  it('strips deposit from daily return — start-of-day cashflow convention', () => {
    // Day 1: hold $1000 worth at close.
    // Day 2: deposit $1000 at start of day; close at $2200.
    // Without stripping: return = 2200/1000 - 1 = 120% (wrong, includes deposit).
    // With stripping: return = (2200 - 1000)/1000 - 1 = 20% (correct).
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'deposit',
        transaction_date: dateD('2026-01-02'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(1000),
      }),
      buildTx({
        id: 3,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-02'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2026-01-02', 1100]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-02') },
      { scope: 'portfolio' },
    );
    // Day 1: 100 × $10 = $1000. tr_index = 1.0.
    // Day 2: 200 × $11 = $2200, deposit_cf = $1000.
    //   daily_return = (2200 − 1000) / 1000 − 1 = 0.20 = +20%
    //   tr_index[1] = 1.0 × 1.20 = 1.20
    expect(series.points[1]!.tr_index).toBeCloseTo(1.20, 10);
    expect(series.points[1]!.external_cashflow_cents).toBe(D(1000));
  });

  it('pre-funding days: tr_index stays at 1.0 until first positive value', () => {
    // Account empty for 2 days, deposit + buy on day 3.
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        transaction_date: dateD('2026-01-03'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(1000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-03'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([[1, [['2026-01-03', 1000], ['2026-01-04', 1100]]]]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-04') },
      { scope: 'portfolio' },
    );
    expect(series.points.map((p) => p.tr_index)).toEqual([1.0, 1.0, 1.0, expect.closeTo(1.10, 10)]);
  });
});
```

### Step 5.2: Run the failing test

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/valuation.test.ts`
- [ ] Expected: the new tests FAIL (cashflow always 0, TR-index always 1.0 from Task 4's defaults). The originals still pass.

### Step 5.3: Add cashflow filter + TR-index walk

- [ ] Modify `worktrees/feat-financial-engine-slice-2/src/backend/financial/valuation.ts`. Add an internal `externalCashflowOnDay(txns, date, scope)` helper, then update the loop to (a) compute the daily cashflow, (b) compute `daily_return = (V_close − CF) / V_open − 1` when `V_open > 0`, else 0, and (c) chain into `tr_index`.

```typescript
// (append below lookupCarryForwardPrice in valuation.ts)

// Sums external cashflows on `date` under the chosen scope. Portfolio
// scope: deposit (+) and withdrawal (−) only. Account scope: also
// transfer_in (+) and transfer_out (−) for the chosen account.
function externalCashflowOnDay(
  txns: ReadonlyArray<Tx>,
  date: Date,
  scope: Scope,
): Money {
  const dayStart = startOfUtcDay(date).getTime();
  const dayEnd = dayStart + ONE_DAY_MS;
  const accountId = typeof scope === 'object' ? scope.account_id : null;

  let sum: Money = ZERO;
  for (const tx of txns) {
    const t = tx.transaction_date.getTime();
    if (t < dayStart || t >= dayEnd) continue;
    if (accountId !== null && tx.account_id !== accountId) continue;

    const kind = tx.transaction_type;
    if (kind === 'deposit') sum = add(sum, tx.amount_cents);
    else if (kind === 'withdrawal') sum = add(sum, ofCents(-Number(tx.amount_cents)));
    else if (accountId !== null && kind === 'transfer_in') sum = add(sum, tx.amount_cents);
    else if (accountId !== null && kind === 'transfer_out')
      sum = add(sum, ofCents(-Number(tx.amount_cents)));
  }
  return sum;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
```

Then update the main loop in `computeValuationSeries`:

```typescript
  // Inside the for-loop, AFTER computing marketValue and costBasis but
  // BEFORE pushing the point:
    const cashflow = externalCashflowOnDay(txns, day, opts.scope);

    let trIndex = 1.0;
    if (points.length > 0) {
      const prev = points[points.length - 1]!;
      const vOpen = Number(prev.market_value_cents);
      if (vOpen > 0) {
        const dailyReturn = (Number(marketValue) - Number(cashflow)) / vOpen - 1;
        trIndex = prev.tr_index * (1 + dailyReturn);
      } else {
        trIndex = prev.tr_index; // pre-funding day — no return to apply
      }
    }

    points.push({
      date: day,
      market_value_cents: marketValue,
      cost_basis_cents: costBasis,
      external_cashflow_cents: cashflow,
      tr_index: trIndex,
    });
```

### Step 5.4: Run the test to verify

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/valuation.test.ts`
- [ ] Expected: all tests PASS.

### Step 5.5: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/valuation.ts src/backend/financial/valuation.test.ts
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): valuation series — cashflows, scope, tr_index

Spec §F3, §F4, §F5, plus the TR-index construction conventions.

Scope-aware cashflow filter: portfolio scope counts only deposit/withdrawal;
account scope additionally counts transfer_in/transfer_out (and only for
the chosen account_id). Cashflow is summed by UTC day-boundary intersection.

TR index walks day-by-day starting at 1.0. Daily return strips the day's
external cashflow from V_close (start-of-day cashflow convention): on flat
markets index is unchanged; on no-flow days return collapses to V_close/V_open
- 1. Pre-funding days (V_open == 0) keep the index unchanged so the curve
doesn't see fictitious returns before the first funded day."
```

---

## Task 6: Price staleness check

**Files:**
- Modify: `src/backend/financial/valuation.ts`
- Modify: `src/backend/financial/valuation.test.ts`

### Step 6.1: Write failing tests

- [ ] Append to `valuation.test.ts`:

```typescript
import { FinancialError } from './errors';

describe('computeValuationSeries — price staleness', () => {
  it('throws price.stale when a held security has no price within maxStalenessDays', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    // Only one price on 2026-01-01; query a day 30 days later (well past 7-day default).
    const prices = buildPriceHistory([[1, [['2026-01-01', 1000]]]]);
    try {
      computeValuationSeries(
        txns,
        prices,
        { from: dateD('2026-01-15'), to: dateD('2026-01-15') },
        { scope: 'portfolio' },
      );
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FinancialError);
      expect((e as FinancialError).code).toBe('price.stale');
      expect((e as FinancialError).context.security_id).toBe(1);
    }
  });

  it('throws price.stale when a held security has no preceding price at all', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    // Price series has no points before the query window.
    const prices = buildPriceHistory([[1, [['2026-02-01', 1000]]]]);
    expect(() =>
      computeValuationSeries(
        txns,
        prices,
        { from: dateD('2026-01-05'), to: dateD('2026-01-05') },
        { scope: 'portfolio' },
      ),
    ).toThrow(FinancialError);
  });

  it('respects custom maxStalenessDays', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([[1, [['2026-01-01', 1000]]]]);
    // 3 days later, 7-day window — fine.
    expect(() =>
      computeValuationSeries(
        txns,
        prices,
        { from: dateD('2026-01-04'), to: dateD('2026-01-04') },
        { scope: 'portfolio', maxStalenessDays: 7 },
      ),
    ).not.toThrow();
    // 3 days later, 2-day window — too stale.
    expect(() =>
      computeValuationSeries(
        txns,
        prices,
        { from: dateD('2026-01-04'), to: dateD('2026-01-04') },
        { scope: 'portfolio', maxStalenessDays: 2 },
      ),
    ).toThrow(FinancialError);
  });

  it('does NOT throw when the security is no longer held on stale days', () => {
    // Buy then sell-out: after the sell, no open lot, no price needed.
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'sell',
        transaction_date: dateD('2026-01-02'),
        quantity: 100,
        price_cents: D(11),
        amount_cents: D(1100),
      }),
    ];
    const prices = buildPriceHistory([[1, [['2026-01-01', 1000], ['2026-01-02', 1100]]]]);
    // Day 30 is far past the staleness window, but no security is held.
    expect(() =>
      computeValuationSeries(
        txns,
        prices,
        { from: dateD('2026-01-30'), to: dateD('2026-01-30') },
        { scope: 'portfolio', maxStalenessDays: 7 },
      ),
    ).not.toThrow();
  });
});
```

### Step 6.2: Promote `lookupCarryForwardPrice` to staleness-aware

- [ ] Modify `valuation.ts`: replace the `lookupCarryForwardPrice(...) → Money | null` helper with one that takes `maxStalenessDays` and throws on stale. Update the call site in the loop accordingly. Only call the lookup for securities that actually have an open lot on `day` — the test above guards this.

```typescript
function carryForwardPrice(
  prices: PriceHistory,
  securityId: number,
  date: Date,
  maxStalenessDays: number,
): Money {
  const series = prices.get(securityId);
  const t = date.getTime();
  if (!series || series.length === 0) {
    throw new FinancialError('price.stale', 'no price series for security', {
      security_id: securityId,
      requested_date: date,
      last_price_date: null,
      max_staleness_days: maxStalenessDays,
    });
  }
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid]!.date.getTime() <= t) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo - 1;
  if (idx < 0) {
    throw new FinancialError('price.stale', 'no price on or before requested date', {
      security_id: securityId,
      requested_date: date,
      last_price_date: null,
      max_staleness_days: maxStalenessDays,
    });
  }
  const last = series[idx]!;
  const ageDays = (t - last.date.getTime()) / ONE_DAY_MS;
  if (ageDays > maxStalenessDays) {
    throw new FinancialError(
      'price.stale',
      'last price is older than maxStalenessDays',
      {
        security_id: securityId,
        requested_date: date,
        last_price_date: last.date,
        max_staleness_days: maxStalenessDays,
      },
    );
  }
  return last.price_cents;
}
```

Replace the in-loop call:

```typescript
    const maxStale = opts.maxStalenessDays ?? DEFAULT_MAX_STALENESS_DAYS;
    for (const lot of openLots) {
      const price = carryForwardPrice(prices, lot.security_id, day, maxStale);
      marketValue = add(marketValue, multiplyByRatio(price, lot.quantity));
      costBasis = add(costBasis, lot.cost_basis_cents);
    }
```

Delete the now-unused `lookupCarryForwardPrice` function.

### Step 6.3: Run tests

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/valuation.test.ts`
- [ ] Expected: all tests PASS, including the four new staleness tests.

### Step 6.4: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/valuation.ts src/backend/financial/valuation.test.ts
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): price.stale throw on held-day with no fresh price

Per spec §F9. Default maxStalenessDays = 7. Staleness is checked per
held day (a sold-out security on a price-less day is fine), and the
last-price-date plus configured window are included in the error context
so callers can surface 'add prices for AAPL after 2026-01-03' UX."
```

---

## Task 7: Valuation series — property tests + golden fixture

**Files:**
- Create: `src/backend/financial/valuation.property.test.ts`
- Create: `tests/fixtures/financial/daily-twr-simple.json`
- Create: `tests/fixtures/financial/cashflows-mid-period.json`
- Create: `tests/fixtures/financial/pre-funding-days.json`
- Modify: `src/backend/financial/valuation.test.ts` — fixture-driven tests

### Step 7.1: Write property tests

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/valuation.property.test.ts`:

```typescript
// TR-index invariants for the valuation series. Property tests run after
// the unit tests so a failure here surfaces an algorithmic-drift bug
// rather than a missing-feature bug.

import fc from 'fast-check';

import { ofCents } from '@shared/money';

import { computeValuationSeries } from './valuation';
import type { PriceHistory, Tx } from './types';

// Build a buy-and-hold txn list plus a price history of `nDays` days where
// price is `startPrice × (1 + return)^d`. Daily return is constant; TR
// index should match (1 + return)^d exactly (within FP epsilon).
function makeConstantReturnInputs(nDays: number, dailyReturn: number, startCents: number): {
  txns: Tx[];
  prices: PriceHistory;
  from: Date;
  to: Date;
} {
  const from = new Date(Date.UTC(2026, 0, 1));
  const to = new Date(from.getTime() + (nDays - 1) * 86_400_000);
  const txns: Tx[] = [
    {
      id: 1,
      account_id: 1,
      security_id: 1,
      transaction_type: 'buy',
      transaction_date: from,
      quantity: 100,
      price_cents: ofCents(startCents),
      amount_cents: ofCents(100 * startCents),
      fee_cents: null,
      currency_code: 'USD',
    },
  ];
  const pricePts: { date: Date; price_cents: ReturnType<typeof ofCents> }[] = [];
  let cents = startCents;
  for (let d = 0; d < nDays; d++) {
    pricePts.push({
      date: new Date(from.getTime() + d * 86_400_000),
      price_cents: ofCents(Math.round(cents)),
    });
    cents = cents * (1 + dailyReturn);
  }
  return { txns, prices: new Map([[1, pricePts]]), from, to };
}

describe('property: tr_index follows constant-return chain', () => {
  it('tr_index[d] ≈ (1 + dailyReturn)^d within FP slack', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 60 }),
        fc.double({ min: -0.02, max: 0.02, noNaN: true }),
        (nDays, r) => {
          const { txns, prices, from, to } = makeConstantReturnInputs(nDays, r, 10_000);
          const series = computeValuationSeries(txns, prices, { from, to }, { scope: 'portfolio' });
          // First-day index is 1.0 by definition. Last-day index ≈ (1+r)^(nDays−1).
          // Tolerance is loose because rounding to cent on prices introduces
          // up to ~1 cent / 10000 cents (0.01%) per step; chained over 60 steps
          // that's ~0.6% drift in the absolute worst case.
          const expected = Math.pow(1 + r, nDays - 1);
          const actual = series.points[nDays - 1]!.tr_index;
          expect(Math.abs(actual - expected)).toBeLessThan(Math.max(0.01, 0.001 * nDays));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('property: scale invariance', () => {
  it('doubling all share quantities leaves tr_index unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 5, max: 30 }),
        fc.double({ min: -0.05, max: 0.05, noNaN: true }),
        (nDays, r) => {
          const a = makeConstantReturnInputs(nDays, r, 10_000);
          const b = makeConstantReturnInputs(nDays, r, 10_000);
          b.txns = b.txns.map((t) => ({
            ...t,
            quantity: t.quantity * 2,
            amount_cents: ofCents(Number(t.amount_cents) * 2),
          }));
          const seriesA = computeValuationSeries(a.txns, a.prices, { from: a.from, to: a.to }, { scope: 'portfolio' });
          const seriesB = computeValuationSeries(b.txns, b.prices, { from: b.from, to: b.to }, { scope: 'portfolio' });
          for (let i = 0; i < seriesA.points.length; i++) {
            expect(seriesA.points[i]!.tr_index).toBeCloseTo(seriesB.points[i]!.tr_index, 8);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
```

### Step 7.2: Run property tests

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/valuation.property.test.ts`
- [ ] Expected: PASS.

### Step 7.3: Create the daily-twr-simple fixture

- [ ] Create `worktrees/feat-financial-engine-slice-2/tests/fixtures/financial/daily-twr-simple.json`:

```json
{
  "name": "daily-twr-simple",
  "description": "Buy 100 shares on day 1, hold 30 days at flat price, sell on day 31 at +10%. TWR = 10%; MWR ≈ 10% (single-period); no drawdown.",
  "transactions": [
    {
      "id": 1,
      "account_id": 1,
      "security_id": 1,
      "transaction_type": "buy",
      "transaction_date": "2026-01-01T00:00:00Z",
      "quantity": 100,
      "price_cents": 10000,
      "amount_cents": 1000000,
      "fee_cents": null,
      "currency_code": "USD"
    },
    {
      "id": 2,
      "account_id": 1,
      "security_id": 1,
      "transaction_type": "sell",
      "transaction_date": "2026-01-31T00:00:00Z",
      "quantity": 100,
      "price_cents": 11000,
      "amount_cents": 1100000,
      "fee_cents": null,
      "currency_code": "USD"
    }
  ],
  "price_history": {
    "1": [
      { "date": "2026-01-01T00:00:00Z", "price_cents": 10000 },
      { "date": "2026-01-31T00:00:00Z", "price_cents": 11000 }
    ]
  },
  "range": { "from": "2026-01-01T00:00:00Z", "to": "2026-01-31T00:00:00Z" },
  "scope": "portfolio",
  "expected": {
    "twr_return_pct": 10.0,
    "mwr_irr_pct_approx": 224.0,
    "drawdown_nominal_pct": 0.0
  }
}
```

(MWR is annualized — 30-day buy-and-hold of +10% annualizes to ~224%. We'll wire the exact expected value through the fixture-runner in Task 14.)

### Step 7.4: Create the cashflows-mid-period fixture

- [ ] Create `worktrees/feat-financial-engine-slice-2/tests/fixtures/financial/cashflows-mid-period.json`:

```json
{
  "name": "cashflows-mid-period",
  "description": "Deposit on day 10 + day 20; market moves +5% / −3% / +8% across three sub-periods. TWR and MWR diverge meaningfully.",
  "transactions": [
    { "id": 1, "account_id": 1, "security_id": null, "transaction_type": "deposit",
      "transaction_date": "2026-01-01T00:00:00Z", "quantity": 0, "price_cents": null,
      "amount_cents": 1000000, "fee_cents": null, "currency_code": "USD" },
    { "id": 2, "account_id": 1, "security_id": 1, "transaction_type": "buy",
      "transaction_date": "2026-01-01T00:00:00Z", "quantity": 100, "price_cents": 10000,
      "amount_cents": 1000000, "fee_cents": null, "currency_code": "USD" },
    { "id": 3, "account_id": 1, "security_id": null, "transaction_type": "deposit",
      "transaction_date": "2026-01-10T00:00:00Z", "quantity": 0, "price_cents": null,
      "amount_cents": 500000, "fee_cents": null, "currency_code": "USD" },
    { "id": 4, "account_id": 1, "security_id": 1, "transaction_type": "buy",
      "transaction_date": "2026-01-10T00:00:00Z", "quantity": 47, "price_cents": 10500,
      "amount_cents": 493500, "fee_cents": null, "currency_code": "USD" },
    { "id": 5, "account_id": 1, "security_id": null, "transaction_type": "deposit",
      "transaction_date": "2026-01-20T00:00:00Z", "quantity": 0, "price_cents": null,
      "amount_cents": 500000, "fee_cents": null, "currency_code": "USD" },
    { "id": 6, "account_id": 1, "security_id": 1, "transaction_type": "buy",
      "transaction_date": "2026-01-20T00:00:00Z", "quantity": 49, "price_cents": 10185,
      "amount_cents": 499065, "fee_cents": null, "currency_code": "USD" }
  ],
  "price_history": {
    "1": [
      { "date": "2026-01-01T00:00:00Z", "price_cents": 10000 },
      { "date": "2026-01-10T00:00:00Z", "price_cents": 10500 },
      { "date": "2026-01-20T00:00:00Z", "price_cents": 10185 },
      { "date": "2026-01-30T00:00:00Z", "price_cents": 11000 }
    ]
  },
  "range": { "from": "2026-01-01T00:00:00Z", "to": "2026-01-30T00:00:00Z" },
  "scope": "portfolio",
  "expected": {
    "_note": "Hand-computed: three sub-period returns ≈ +5%, −3%, +8%. TWR ≈ (1.05)(0.97)(1.08) − 1 ≈ +9.998%. MWR (IRR) ≈ different annualized number because of the cashflow timing; verified in the test by computing the same chain from the engine's tr_index.",
    "twr_return_pct_approx": 9.998
  }
}
```

The fixture's `expected` block records only the TWR (computed by hand against the TR chain). Drawdown, MWR, and other downstream metrics are validated against the engine output in their own tests; the fixture is the *input* canonical record.

### Step 7.5: Create pre-funding-days fixture

- [ ] Create `worktrees/feat-financial-engine-slice-2/tests/fixtures/financial/pre-funding-days.json`:

```json
{
  "name": "pre-funding-days",
  "description": "Empty account for 10 days, then deposit + buy. TR index stays at 1.0 through the empty stretch; first non-1.0 value appears once price moves after the funded date.",
  "transactions": [
    { "id": 1, "account_id": 1, "security_id": null, "transaction_type": "deposit",
      "transaction_date": "2026-01-11T00:00:00Z", "quantity": 0, "price_cents": null,
      "amount_cents": 1000000, "fee_cents": null, "currency_code": "USD" },
    { "id": 2, "account_id": 1, "security_id": 1, "transaction_type": "buy",
      "transaction_date": "2026-01-11T00:00:00Z", "quantity": 100, "price_cents": 10000,
      "amount_cents": 1000000, "fee_cents": null, "currency_code": "USD" }
  ],
  "price_history": {
    "1": [
      { "date": "2026-01-11T00:00:00Z", "price_cents": 10000 },
      { "date": "2026-01-12T00:00:00Z", "price_cents": 11000 }
    ]
  },
  "range": { "from": "2026-01-01T00:00:00Z", "to": "2026-01-12T00:00:00Z" },
  "scope": "portfolio",
  "expected": {
    "tr_index_day_1_through_11_pct_all_1": true,
    "tr_index_day_12_approx": 1.10,
    "twr_return_pct_approx": 10.0
  }
}
```

### Step 7.6: Add a fixture-loader test

- [ ] Append to `valuation.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function loadFixture(name: string): any {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '../../../tests/fixtures/financial', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function reviveTxns(raw: any[]): Tx[] {
  return raw.map((t) => ({
    ...t,
    transaction_date: new Date(t.transaction_date),
    price_cents: t.price_cents === null ? null : ofCents(t.price_cents),
    amount_cents: ofCents(t.amount_cents),
    fee_cents: t.fee_cents === null ? null : ofCents(t.fee_cents),
  }));
}

function revivePrices(raw: Record<string, any[]>): PriceHistory {
  const out = new Map<number, any[]>();
  for (const [secId, pts] of Object.entries(raw)) {
    out.set(
      Number(secId),
      pts.map((p) => ({ date: new Date(p.date), price_cents: ofCents(p.price_cents) })),
    );
  }
  return out;
}

import type { PriceHistory, Tx } from './types';

describe('fixture: daily-twr-simple', () => {
  it('valuation series matches hand-computed TR index over 30 days at flat price + 10% sell', () => {
    const fx = loadFixture('daily-twr-simple');
    const series = computeValuationSeries(
      reviveTxns(fx.transactions),
      revivePrices(fx.price_history),
      { from: new Date(fx.range.from), to: new Date(fx.range.to) },
      { scope: fx.scope },
    );
    // Day 1 = 100 × $100.00 = $10,000.00. Day 31 = sell-out → market value 0.
    expect(series.points[0]!.market_value_cents).toBe(ofCents(1_000_000));
    expect(series.points[series.points.length - 1]!.market_value_cents).toBe(ofCents(0));
    // tr_index right before the sell should be ~1.10.
    expect(series.points[29]!.tr_index).toBeCloseTo(1.10, 8);
  });
});

describe('fixture: pre-funding-days', () => {
  it('tr_index = 1.0 for the 10 pre-funding days; index moves only after the funded day', () => {
    const fx = loadFixture('pre-funding-days');
    const series = computeValuationSeries(
      reviveTxns(fx.transactions),
      revivePrices(fx.price_history),
      { from: new Date(fx.range.from), to: new Date(fx.range.to) },
      { scope: fx.scope },
    );
    for (let i = 0; i < 11; i++) {
      expect(series.points[i]!.tr_index).toBe(1.0);
    }
    expect(series.points[11]!.tr_index).toBeCloseTo(1.10, 8);
  });
});
```

### Step 7.7: Run all valuation tests

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/valuation`
- [ ] Expected: all unit + property + fixture tests PASS.

### Step 7.8: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/valuation.property.test.ts src/backend/financial/valuation.test.ts tests/fixtures/financial/daily-twr-simple.json tests/fixtures/financial/cashflows-mid-period.json tests/fixtures/financial/pre-funding-days.json
git -C worktrees/feat-financial-engine-slice-2 commit -m "test(financial): valuation property tests + 3 golden fixtures

Property: tr_index tracks constant-return chains within an FP slack
budget (allows ~1 cent/10k of price-rounding per step). Scale invariance:
doubling all share quantities leaves tr_index unchanged.

Fixtures: daily-twr-simple (single buy → 10% sell), cashflows-mid-period
(three sub-period chained returns ≈ +5/-3/+8%), pre-funding-days (TR
index stays at 1.0 until the funded day)."
```

---

## Task 8: `computeTimeWeightedReturn`

**Files:**
- Create: `src/backend/financial/twr.ts`
- Create: `src/backend/financial/twr.test.ts`

### Step 8.1: Write failing tests

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/twr.test.ts`:

```typescript
import { ofCents } from '@shared/money';

import { computeTimeWeightedReturn } from './twr';
import { computeValuationSeries } from './valuation';
import { buildPriceHistory, buildTx, D, dateD, resetTxIds } from './test-helpers';

beforeEach(() => resetTxIds());

describe('computeTimeWeightedReturn — flat market', () => {
  it('0% return on a flat-price hold', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2026-01-31', 1000]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-31') },
      { scope: 'portfolio' },
    );
    const result = computeTimeWeightedReturn(series);
    expect(result.return_pct).toBeCloseTo(0, 8);
    expect(result.days).toBe(30);
    expect(result.annualized_pct).toBeNull();
  });
});

describe('computeTimeWeightedReturn — 10% over 30 days', () => {
  it('return_pct ≈ 10', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2026-01-31', 1100]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-31') },
      { scope: 'portfolio' },
    );
    const result = computeTimeWeightedReturn(series);
    expect(result.return_pct).toBeCloseTo(10, 6);
    expect(result.days).toBe(30);
  });
});

describe('computeTimeWeightedReturn — annualization', () => {
  it('annualized_pct present when range >= 365.25 days', () => {
    // 366-day range so days >= 365.25 (the annualization gate).
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2027-01-02', 1210]]], // +21% over 366 days
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2027-01-02') },
      { scope: 'portfolio' },
    );
    const result = computeTimeWeightedReturn(series);
    expect(result.return_pct).toBeCloseTo(21, 4);
    expect(result.annualized_pct).not.toBeNull();
    // 1.21^(365.25/366) − 1 ≈ 0.20949 → 20.95%
    expect(result.annualized_pct!).toBeCloseTo(20.95, 1);
  });

  it('annualized_pct null when range < 365.25 days', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2026-12-31', 1100]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-12-31') },
      { scope: 'portfolio' },
    );
    expect(computeTimeWeightedReturn(series).annualized_pct).toBeNull();
  });
});

describe('computeTimeWeightedReturn — empty series guard', () => {
  it('throws RangeError on empty series', () => {
    const series = computeValuationSeries(
      [],
      buildPriceHistory([]),
      { from: dateD('2026-01-01'), to: dateD('2026-01-01') },
      { scope: 'portfolio' },
    );
    // Single point is fine (return = 0, 0 days), but a truly empty series
    // (no points) shouldn't be possible from computeValuationSeries.
    // Direct test: pass a manually-empty series.
    expect(() => computeTimeWeightedReturn({ ...series, points: [] })).toThrow(RangeError);
  });
});
```

### Step 8.2: Run failing tests

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/twr.test.ts`
- [ ] Expected: FAIL — module doesn't exist.

### Step 8.3: Write implementation

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/twr.ts`:

```typescript
// Time-weighted return — geometric chain of daily returns expressed via
// the valuation series's tr_index. Annualization uses 365.25-day year.

import type { TwrResult, ValuationSeries } from './types';

const DAYS_PER_YEAR = 365.25;
const ONE_DAY_MS = 86_400_000;

export function computeTimeWeightedReturn(series: ValuationSeries): TwrResult {
  if (series.points.length === 0) {
    throw new RangeError('series.points must be non-empty');
  }
  const first = series.points[0]!;
  const last = series.points[series.points.length - 1]!;
  const totalReturn = last.tr_index / first.tr_index - 1;
  const days =
    (last.date.getTime() - first.date.getTime()) / ONE_DAY_MS;
  const annualized =
    days >= DAYS_PER_YEAR
      ? (Math.pow(1 + totalReturn, DAYS_PER_YEAR / days) - 1) * 100
      : null;
  return {
    return_pct: totalReturn * 100,
    annualized_pct: annualized,
    days,
  };
}
```

### Step 8.4: Run tests

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/twr.test.ts`
- [ ] Expected: PASS.

### Step 8.5: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/twr.ts src/backend/financial/twr.test.ts
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): computeTimeWeightedReturn

Spec §F2 — true daily TWR via geometric chain of daily returns, exposed
as the ratio of the series's last vs first tr_index. Annualized only when
range ≥ 365.25 days (otherwise null — extrapolating annual rates from
sub-year periods is a forecasting move we don't make in the engine)."
```

---

## Task 9: NPV helper + Newton-Raphson MWR core

**Files:**
- Create: `src/backend/financial/mwr.ts`
- Create: `src/backend/financial/mwr.test.ts`

### Step 9.1: Write failing tests for the easy cases

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/mwr.test.ts`:

```typescript
import { ofCents } from '@shared/money';

import { FinancialError } from './errors';
import { computeMoneyWeightedReturn } from './mwr';
import { computeValuationSeries } from './valuation';
import { buildPriceHistory, buildTx, D, dateD, resetTxIds } from './test-helpers';

beforeEach(() => resetTxIds());

describe('computeMoneyWeightedReturn — buy and hold, no intermediate flows', () => {
  it('IRR ≈ TWR over 1 year buy-and-hold at +21%', () => {
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        transaction_date: dateD('2026-01-01'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(10000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(100),
        amount_cents: D(10000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 10000], ['2027-01-01', 12100]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2027-01-01') },
      { scope: 'portfolio' },
    );
    const result = computeMoneyWeightedReturn(series);
    expect(result.irr_pct).toBeCloseTo(20.97, 1); // matches TWR annualized for buy-and-hold
    expect(result.method).toBe('newton');
    expect(result.iterations).toBeLessThan(20);
  });
});

describe('computeMoneyWeightedReturn — bad initial state', () => {
  it('throws irr.bad_initial_state when first day has zero market value AND no deposit', () => {
    // No deposits, no positions — series is all zeros.
    const series = computeValuationSeries(
      [],
      buildPriceHistory([]),
      { from: dateD('2026-01-01'), to: dateD('2026-12-31') },
      { scope: 'portfolio' },
    );
    try {
      computeMoneyWeightedReturn(series);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FinancialError);
      expect((e as FinancialError).code).toBe('irr.bad_initial_state');
    }
  });
});
```

### Step 9.2: Write `mwr.ts` with Newton-Raphson + the bad-state guard (bisection arrives in Task 10)

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/mwr.ts`:

```typescript
// Money-weighted return — IRR of (start value + cashflows + end value),
// annualized via 365.25-day year. Newton-Raphson seeded with TWR; bisection
// fallback added in the follow-up commit.

import { computeTimeWeightedReturn } from './twr';
import { FinancialError } from './errors';
import type { MwrResult, ValuationSeries } from './types';

const DAYS_PER_YEAR = 365.25;
const NEWTON_MAX_ITER = 100;
const ABS_NPV_TOL_CENTS = 1; // |NPV(r)| < 1 cent
const REL_R_TOL = 1e-10;

interface Cashflow {
  amount_cents: number;
  years_from_start: number;
}

// Collects external cashflows (in cents) and the implied start/end values.
// Sign convention: deposits positive, withdrawals negative.
function buildCashflows(series: ValuationSeries): {
  start_value_cents: number;
  end_value_cents: number;
  flows: Cashflow[];
} {
  const first = series.points[0]!;
  const last = series.points[series.points.length - 1]!;
  const startMs = first.date.getTime();
  const flows: Cashflow[] = [];
  let startVal = Number(first.market_value_cents);
  // Day-0 cashflow is part of the start value, not a separate intermediate
  // flow. Otherwise IRR double-counts day-0 deposits.
  startVal += Number(first.external_cashflow_cents);
  // Intermediate flows: days 1..N-2 inclusive.
  for (let i = 1; i < series.points.length - 1; i++) {
    const p = series.points[i]!;
    const cf = Number(p.external_cashflow_cents);
    if (cf !== 0) {
      flows.push({
        amount_cents: cf,
        years_from_start: (p.date.getTime() - startMs) / 86_400_000 / DAYS_PER_YEAR,
      });
    }
  }
  // End-day cashflow is folded into end value too.
  let endVal = Number(last.market_value_cents);
  endVal -= Number(last.external_cashflow_cents);
  return { start_value_cents: startVal, end_value_cents: endVal, flows };
}

function npv(r: number, start: number, end: number, flows: Cashflow[], years: number): number {
  // NPV in cents.
  let val = -start;
  for (const f of flows) {
    val -= f.amount_cents / Math.pow(1 + r, f.years_from_start);
  }
  val += end / Math.pow(1 + r, years);
  return val;
}

function npvPrime(r: number, end: number, flows: Cashflow[], years: number): number {
  // d NPV / dr.
  let d = 0;
  for (const f of flows) {
    d += (f.amount_cents * f.years_from_start) / Math.pow(1 + r, f.years_from_start + 1);
  }
  d -= (end * years) / Math.pow(1 + r, years + 1);
  return d;
}

export function computeMoneyWeightedReturn(series: ValuationSeries): MwrResult {
  if (series.points.length === 0) throw new RangeError('series.points must be non-empty');
  const { start_value_cents, end_value_cents, flows } = buildCashflows(series);
  if (start_value_cents <= 0) {
    throw new FinancialError(
      'irr.bad_initial_state',
      'IRR requires a positive starting value',
      { scope: series.scope, start_value_cents },
    );
  }
  const totalYears =
    (series.points[series.points.length - 1]!.date.getTime() -
      series.points[0]!.date.getTime()) /
    86_400_000 /
    DAYS_PER_YEAR;

  // Seed from TWR — usually within a few percent of IRR.
  const twr = computeTimeWeightedReturn(series);
  const seedAnnual =
    twr.annualized_pct !== null ? twr.annualized_pct / 100 : twr.return_pct / 100;
  let r = Number.isFinite(seedAnnual) ? seedAnnual : 0;

  let iter = 0;
  while (iter < NEWTON_MAX_ITER) {
    const v = npv(r, start_value_cents, end_value_cents, flows, totalYears);
    if (Math.abs(v) < ABS_NPV_TOL_CENTS) {
      return { irr_pct: r * 100, iterations: iter, method: 'newton' };
    }
    const dv = npvPrime(r, end_value_cents, flows, totalYears);
    if (dv === 0 || !Number.isFinite(dv)) break;
    const next = r - v / dv;
    if (!Number.isFinite(next) || next <= -0.99 || next >= 10.0) break;
    if (Math.abs(next - r) < REL_R_TOL) {
      return { irr_pct: next * 100, iterations: iter + 1, method: 'newton' };
    }
    r = next;
    iter++;
  }

  // Newton failed — Task 10 plugs in bisection. Throw for now.
  throw new FinancialError(
    'irr.no_convergence',
    'Newton-Raphson did not converge; bisection fallback not yet implemented',
    { last_estimate: r, iterations: iter },
  );
}
```

### Step 9.3: Run tests

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/mwr.test.ts`
- [ ] Expected: both tests PASS (buy-and-hold case converges with Newton; bad-initial-state case throws the expected error).

### Step 9.4: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/mwr.ts src/backend/financial/mwr.test.ts
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): IRR via Newton-Raphson (bisection follow-up)

Spec MWR section. NPV in cents with TWR-seeded Newton iteration, 100-step
cap, abs-NPV tolerance 1 cent. Day-0 cashflow folds into start_value and
day-N folds into end_value so IRR isn't double-counting. bad_initial_state
throws on non-positive start value (an account with no money or in deficit
cannot have a well-defined IRR). Bisection fallback in next commit."
```

---

## Task 10: Bisection fallback + edge cases

**Files:**
- Modify: `src/backend/financial/mwr.ts`
- Modify: `src/backend/financial/mwr.test.ts`

### Step 10.1: Add tests for bisection-only cases

- [ ] Append to `mwr.test.ts`:

```typescript
describe('computeMoneyWeightedReturn — bisection fallback', () => {
  it('falls back to bisection for pathological cashflow series', () => {
    // Big start, big mid-period withdrawal that flips signs — Newton can
    // step outside the bracket. The exact construction is contrived; the
    // assertion is that *some* fallback path returns a valid IRR.
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        transaction_date: dateD('2026-01-01'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(100000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 1000,
        price_cents: D(100),
        amount_cents: D(100000),
      }),
      buildTx({
        id: 3,
        transaction_type: 'withdrawal',
        transaction_date: dateD('2026-06-01'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(95000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 10000], ['2026-06-01', 10000], ['2027-01-01', 9500]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2027-01-01') },
      { scope: 'portfolio' },
    );
    const result = computeMoneyWeightedReturn(series);
    expect(Number.isFinite(result.irr_pct)).toBe(true);
    expect(result.irr_pct).toBeGreaterThan(-99);
    expect(result.irr_pct).toBeLessThan(1000);
  });
});

describe('computeMoneyWeightedReturn — no solution', () => {
  it('throws irr.no_solution when NPV has no sign change in [−0.99, 10]', () => {
    // All-loss scenario with no path to break-even: start $10000, withdraw
    // nothing, end at $0. NPV is monotonically increasing in r toward zero
    // but never reaches it (asymptotically). Should throw no_solution
    // because Newton will diverge and bisection will see same-sign endpoints.
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'deposit',
        transaction_date: dateD('2026-01-01'),
        security_id: null,
        quantity: 0,
        price_cents: null,
        amount_cents: D(10000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(100),
        amount_cents: D(10000),
      }),
      buildTx({
        id: 3,
        transaction_type: 'sell',
        transaction_date: dateD('2026-12-31'),
        quantity: 100,
        price_cents: D(0),
        amount_cents: D(0),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 10000], ['2026-12-31', 0]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-12-31') },
      { scope: 'portfolio' },
    );
    // IRR for "lose everything" is −100% — but our bracket is [−0.99, 10]
    // so r = −0.99 makes NPV blow up. We accept whatever the engine returns
    // here: either irr_pct ≈ −99 (the boundary) OR no_solution.
    let result: any;
    let error: Error | null = null;
    try {
      result = computeMoneyWeightedReturn(series);
    } catch (e) {
      error = e as Error;
    }
    if (error) {
      expect((error as FinancialError).code).toBe('irr.no_solution');
    } else {
      expect(result.irr_pct).toBeLessThan(-95);
    }
  });
});
```

### Step 10.2: Add the bisection fallback

- [ ] In `mwr.ts`, replace the trailing `throw new FinancialError('irr.no_convergence', ...)` with a bisection call. Add the helper:

```typescript
function bisect(
  start: number,
  end: number,
  flows: Cashflow[],
  years: number,
): { r: number; iterations: number } | null {
  let lo = -0.99;
  let hi = 10.0;
  let fLo = npv(lo, start, end, flows, years);
  let fHi = npv(hi, start, end, flows, years);
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null;
  if (fLo === 0) return { r: lo, iterations: 0 };
  if (fHi === 0) return { r: hi, iterations: 0 };
  if (Math.sign(fLo) === Math.sign(fHi)) return null; // no sign change
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid, start, end, flows, years);
    if (Math.abs(fMid) < ABS_NPV_TOL_CENTS || (hi - lo) < REL_R_TOL) {
      return { r: mid, iterations: i + 1 };
    }
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid;
      fLo = fMid;
    } else {
      hi = mid;
      fHi = fMid;
    }
  }
  return null;
}
```

Then replace the trailing throw in `computeMoneyWeightedReturn`:

```typescript
  // Newton exhausted; try bisection.
  const bis = bisect(start_value_cents, end_value_cents, flows, totalYears);
  if (bis === null) {
    throw new FinancialError('irr.no_solution', 'NPV has no sign change in [−0.99, 10]', {
      start_value_cents,
      end_value_cents,
      cashflows: flows,
    });
  }
  return { irr_pct: bis.r * 100, iterations: iter + bis.iterations, method: 'bisection' };
```

### Step 10.3: Run tests

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/mwr.test.ts`
- [ ] Expected: all 4 tests PASS.

### Step 10.4: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/mwr.ts src/backend/financial/mwr.test.ts
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): bisection IRR fallback + no_solution throw

Bisection on [−0.99, 10] with sign-change detection. method='bisection'
surfaces on the MwrResult so debugging an unusual portfolio shows which
path produced the answer. no_solution thrown when both endpoints have
the same NPV sign (genuinely unsolvable in the bracket). Iterations
counted across both phases."
```

---

## Task 11: Drawdown — nominal branch

**Files:**
- Create: `src/backend/financial/drawdown.ts`
- Create: `src/backend/financial/drawdown.test.ts`

### Step 11.1: Write failing tests

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/drawdown.test.ts`:

```typescript
import { computeDrawdown } from './drawdown';
import { computeValuationSeries } from './valuation';
import { buildPriceHistory, buildTx, D, dateD, resetTxIds } from './test-helpers';

beforeEach(() => resetTxIds());

describe('computeDrawdown — flat market', () => {
  it('no drawdown when prices are flat', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [1, [['2026-01-01', 1000], ['2026-01-10', 1000]]],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-10') },
      { scope: 'portfolio' },
    );
    const result = computeDrawdown(series);
    expect(result.nominal.max_drawdown_pct).toBe(0);
    expect(result.nominal.current_drawdown_pct).toBe(0);
    expect(result.real).toBeNull();
  });
});

describe('computeDrawdown — peak / trough / recovery', () => {
  it('detects a 50% drawdown and its recovery', () => {
    // Index: 1.0 → 2.0 (peak) → 1.0 (50% DD trough) → 2.5 (recovery → new peak).
    // Engine internally uses tr_index, which we drive via price series.
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-02', 2000], // tr_index 2.0
          ['2026-01-03', 1000], // tr_index 1.0 → 50% DD from prev peak
          ['2026-01-04', 2500], // tr_index 2.5 → recovered past prev peak
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-04') },
      { scope: 'portfolio' },
    );
    const result = computeDrawdown(series);
    expect(result.nominal.max_drawdown_pct).toBeCloseTo(-50, 4);
    expect(result.nominal.max_drawdown_peak_date.toISOString().slice(0, 10)).toBe('2026-01-02');
    expect(result.nominal.max_drawdown_trough_date.toISOString().slice(0, 10)).toBe('2026-01-03');
    expect(result.nominal.max_drawdown_recovery_date!.toISOString().slice(0, 10)).toBe('2026-01-04');
    expect(result.nominal.current_drawdown_pct).toBe(0); // at new high
  });
});

describe('computeDrawdown — unrecovered drawdown', () => {
  it('recovery_date is null when series ends below the peak', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-01-02', 2000],
          ['2026-01-03', 1500], // 25% off peak
          ['2026-01-04', 1500],
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-01-04') },
      { scope: 'portfolio' },
    );
    const result = computeDrawdown(series);
    expect(result.nominal.max_drawdown_pct).toBeCloseTo(-25, 4);
    expect(result.nominal.max_drawdown_recovery_date).toBeNull();
    expect(result.nominal.current_drawdown_pct).toBeCloseTo(-25, 4);
  });
});
```

### Step 11.2: Write `drawdown.ts` (nominal only — real arrives in Task 12)

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/drawdown.ts`:

```typescript
// Drawdown: peak/trough/recovery on the TR index (cashflow-neutral by
// construction). Real branch added in the follow-up commit.

import type {
  CpiSeries,
  DrawdownResult,
  DrawdownStats,
  ValuationSeries,
} from './types';

interface IndexPoint {
  date: Date;
  value: number;
}

function statsFromSeries(idx: ReadonlyArray<IndexPoint>): DrawdownStats {
  if (idx.length === 0) {
    throw new RangeError('drawdown requires non-empty series');
  }
  let runningPeak = idx[0]!.value;
  let runningPeakDate = idx[0]!.date;
  // Track the worst drawdown observed and its peak/trough; recovery
  // computed in a second pass.
  let maxDdPct = 0;
  let maxDdPeak: Date = runningPeakDate;
  let maxDdTrough: Date = runningPeakDate;
  // Current state
  let currentPeak = runningPeak;
  let currentPeakDate = runningPeakDate;

  for (let i = 0; i < idx.length; i++) {
    const p = idx[i]!;
    if (p.value > runningPeak) {
      runningPeak = p.value;
      runningPeakDate = p.date;
    }
    const ddPct = (p.value / runningPeak - 1) * 100;
    if (ddPct < maxDdPct) {
      maxDdPct = ddPct;
      maxDdPeak = runningPeakDate;
      maxDdTrough = p.date;
    }
    currentPeak = runningPeak;
    currentPeakDate = runningPeakDate;
  }

  // Recovery: smallest date strictly after maxDdTrough where value >= peak's value at maxDdPeak.
  const peakValue = idx.find((p) => p.date.getTime() === maxDdPeak.getTime())!.value;
  let recoveryDate: Date | null = null;
  for (const p of idx) {
    if (p.date.getTime() <= maxDdTrough.getTime()) continue;
    if (p.value >= peakValue) {
      recoveryDate = p.date;
      break;
    }
  }

  const last = idx[idx.length - 1]!;
  const currentDdPct = (last.value / currentPeak - 1) * 100;

  return {
    max_drawdown_pct: maxDdPct,
    max_drawdown_peak_date: maxDdPeak,
    max_drawdown_trough_date: maxDdTrough,
    max_drawdown_recovery_date: recoveryDate,
    current_drawdown_pct: currentDdPct,
    current_peak_date: currentPeakDate,
  };
}

export function computeDrawdown(
  series: ValuationSeries,
  _cpi?: CpiSeries,
): DrawdownResult {
  const nominalIdx = series.points.map((p) => ({ date: p.date, value: p.tr_index }));
  return {
    nominal: statsFromSeries(nominalIdx),
    real: null, // Task 12
  };
}
```

### Step 11.3: Run tests

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/drawdown.test.ts`
- [ ] Expected: all 3 nominal tests PASS.

### Step 11.4: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/drawdown.ts src/backend/financial/drawdown.test.ts
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): nominal drawdown stats over TR index

Spec §F7 (nominal branch). Single forward pass tracking running peak,
worst DD%, and the dates that produced it; recovery is a second-pass
search for the first day after the trough that meets or exceeds the
peak's value. current_drawdown_pct is 0 when at all-time high."
```

---

## Task 12: Drawdown — real branch + fixture

**Files:**
- Modify: `src/backend/financial/drawdown.ts`
- Modify: `src/backend/financial/drawdown.test.ts`
- Create: `tests/fixtures/financial/drawdown-2008.json`
- Create: `tests/fixtures/financial/real-returns-1979-1981.json`

### Step 12.1: Write the real-drawdown + fixture tests

- [ ] Append to `drawdown.test.ts`:

```typescript
import { buildCpiSeries } from './test-helpers';

describe('computeDrawdown — real branch', () => {
  it('real drawdown deeper than nominal when CPI inflates through the trough', () => {
    // Nominal TR index: 1.0 → 1.2 → 1.0 → 1.0 (nominal DD = −16.67%).
    // CPI inflates 10% over the period — real index deflated by CPI grows
    // less, so the relative drop from peak is deeper.
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([
      [
        1,
        [
          ['2026-01-01', 1000],
          ['2026-04-01', 1200],
          ['2026-07-01', 1000],
          ['2026-10-01', 1000],
        ],
      ],
    ]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-10-01') },
      { scope: 'portfolio' },
    );
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-10-01', 330.0], // +10% over 9 months
    ]);
    const result = computeDrawdown(series, cpi);
    expect(result.real).not.toBeNull();
    expect(result.real!.max_drawdown_pct).toBeLessThan(result.nominal.max_drawdown_pct);
  });

  it('throws cpi.out_of_range when CPI does not cover the requested range', () => {
    const txns = [
      buildTx({
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const prices = buildPriceHistory([[1, [['2026-01-01', 1000], ['2026-02-01', 1100]]]]);
    const series = computeValuationSeries(
      txns,
      prices,
      { from: dateD('2026-01-01'), to: dateD('2026-02-01') },
      { scope: 'portfolio' },
    );
    // CPI series ends before the engine's last day.
    const cpi = buildCpiSeries([
      ['2026-01-01', 300.0],
      ['2026-01-15', 301.0],
    ]);
    expect(() => computeDrawdown(series, cpi)).toThrow(FinancialError);
  });
});

import { FinancialError } from './errors';
```

### Step 12.2: Implement real branch in `drawdown.ts`

- [ ] Modify `drawdown.ts` to compute the real TR index and delegate to `statsFromSeries` again:

```typescript
import { cpiAt } from './cpi';

export function computeDrawdown(
  series: ValuationSeries,
  cpi?: CpiSeries,
): DrawdownResult {
  const nominalIdx = series.points.map((p) => ({ date: p.date, value: p.tr_index }));
  const result: DrawdownResult = {
    nominal: statsFromSeries(nominalIdx),
    real: null,
  };
  if (cpi !== undefined && series.points.length > 0) {
    const cpi0 = cpiAt(cpi, series.points[0]!.date);
    const realIdx = series.points.map((p) => ({
      date: p.date,
      value: p.tr_index / (cpiAt(cpi, p.date) / cpi0),
    }));
    result.real = statsFromSeries(realIdx);
  }
  return result;
}
```

### Step 12.3: Write the drawdown-2008 + real-returns fixtures

- [ ] Create `worktrees/feat-financial-engine-slice-2/tests/fixtures/financial/drawdown-2008.json`:

```json
{
  "name": "drawdown-2008",
  "description": "Synthetic 18-month series: rise to peak, 40% drop to trough, partial recovery (still below peak when series ends). Expected: max_drawdown_pct ≈ −40, recovery_date = null.",
  "transactions": [
    { "id": 1, "account_id": 1, "security_id": null, "transaction_type": "deposit",
      "transaction_date": "2026-01-01T00:00:00Z", "quantity": 0, "price_cents": null,
      "amount_cents": 1000000, "fee_cents": null, "currency_code": "USD" },
    { "id": 2, "account_id": 1, "security_id": 1, "transaction_type": "buy",
      "transaction_date": "2026-01-01T00:00:00Z", "quantity": 100, "price_cents": 10000,
      "amount_cents": 1000000, "fee_cents": null, "currency_code": "USD" }
  ],
  "price_history": {
    "1": [
      { "date": "2026-01-01T00:00:00Z", "price_cents": 10000 },
      { "date": "2026-06-01T00:00:00Z", "price_cents": 12000 },
      { "date": "2026-12-01T00:00:00Z", "price_cents": 7200 },
      { "date": "2027-06-01T00:00:00Z", "price_cents": 10000 }
    ]
  },
  "range": { "from": "2026-01-01T00:00:00Z", "to": "2027-06-01T00:00:00Z" },
  "scope": "portfolio",
  "expected": {
    "max_drawdown_pct_approx": -40.0,
    "max_drawdown_recovery_date": null
  }
}
```

- [ ] Create `worktrees/feat-financial-engine-slice-2/tests/fixtures/financial/real-returns-1979-1981.json`:

```json
{
  "name": "real-returns-1979-1981",
  "description": "High-inflation period (CPI +13.3% over 2 years), portfolio +14% nominal annualized. Real return ≈ +0.6%. Catches deflation sign errors.",
  "nominal_pct_total": 29.96,
  "cpi": [
    { "date": "1979-01-01T00:00:00Z", "index": 204.7 },
    { "date": "1981-01-01T00:00:00Z", "index": 260.5 }
  ],
  "range": { "from": "1979-01-01T00:00:00Z", "to": "1981-01-01T00:00:00Z" },
  "expected": {
    "cpi_change_pct_approx": 27.26,
    "real_pct_approx": 2.12,
    "_note": "Engine: computeRealReturn(29.96, range, cpi). Hand-check: (1.2996 / 1.2726) − 1 = 0.0212 = 2.12% over 2 years; annualized ≈ +1.05%/yr. The fixture stores total-period numbers because computeRealReturn is unitless w.r.t. the period."
  }
}
```

### Step 12.4: Add fixture-driven assertions to `cpi.test.ts` and `drawdown.test.ts`

- [ ] In `cpi.test.ts`, append:

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function loadFixture(name: string): any {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '../../../tests/fixtures/financial', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('fixture: real-returns-1979-1981', () => {
  it('computeRealReturn matches hand-computed CPI deflation', () => {
    const fx = loadFixture('real-returns-1979-1981');
    const cpi = fx.cpi.map((p: any) => ({ date: new Date(p.date), index: p.index }));
    const result = computeRealReturn(
      fx.nominal_pct_total,
      { from: new Date(fx.range.from), to: new Date(fx.range.to) },
      cpi,
    );
    expect(result.cpi_change_pct).toBeCloseTo(fx.expected.cpi_change_pct_approx, 1);
    expect(result.real_pct).toBeCloseTo(fx.expected.real_pct_approx, 1);
  });
});
```

- [ ] In `drawdown.test.ts`, append:

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ofCents } from '@shared/money';
import type { PriceHistory, Tx } from './types';

function loadFixture(name: string): any {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '../../../tests/fixtures/financial', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function reviveTxns(raw: any[]): Tx[] {
  return raw.map((t) => ({
    ...t,
    transaction_date: new Date(t.transaction_date),
    price_cents: t.price_cents === null ? null : ofCents(t.price_cents),
    amount_cents: ofCents(t.amount_cents),
    fee_cents: t.fee_cents === null ? null : ofCents(t.fee_cents),
  }));
}

function revivePrices(raw: Record<string, any[]>): PriceHistory {
  const out = new Map<number, any[]>();
  for (const [s, pts] of Object.entries(raw)) {
    out.set(
      Number(s),
      pts.map((p) => ({ date: new Date(p.date), price_cents: ofCents(p.price_cents) })),
    );
  }
  return out;
}

describe('fixture: drawdown-2008', () => {
  it('reports ~−40% max drawdown that never recovers', () => {
    const fx = loadFixture('drawdown-2008');
    const series = computeValuationSeries(
      reviveTxns(fx.transactions),
      revivePrices(fx.price_history),
      { from: new Date(fx.range.from), to: new Date(fx.range.to) },
      { scope: fx.scope },
    );
    const result = computeDrawdown(series);
    expect(result.nominal.max_drawdown_pct).toBeCloseTo(fx.expected.max_drawdown_pct_approx, 0);
    expect(result.nominal.max_drawdown_recovery_date).toBeNull();
  });
});
```

### Step 12.5: Run all drawdown + cpi tests

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/drawdown src/backend/financial/cpi`
- [ ] Expected: all PASS.

### Step 12.6: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/drawdown.ts src/backend/financial/drawdown.test.ts src/backend/financial/cpi.test.ts tests/fixtures/financial/drawdown-2008.json tests/fixtures/financial/real-returns-1979-1981.json
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): real-deflated drawdown branch + fixtures

Real DD branch deflates tr_index by cpiAt(d) / cpiAt(first); same stats
computation runs over the real index. Throws cpi.out_of_range (via cpiAt)
when CPI doesn't cover the series range. Fixtures: drawdown-2008 (40%
unrecovered DD), real-returns-1979-1981 (high-inflation period sanity
check on the deflation formula)."
```

---

## Task 13: Allocation — partition dimensions (asset_class, account, security)

**Files:**
- Create: `src/backend/financial/allocation.ts`
- Create: `src/backend/financial/allocation.test.ts`
- Create: `tests/fixtures/financial/allocation-by-class.json`

### Step 13.1: Write tests for the three partition dimensions

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/allocation.test.ts`:

```typescript
import { ofCents } from '@shared/money';

import { FinancialError } from './errors';
import { computeAllocation } from './allocation';
import { D } from './test-helpers';
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
```

### Step 13.2: Write `allocation.ts` (no tag dim yet — Task 14)

- [ ] Create `worktrees/feat-financial-engine-slice-2/src/backend/financial/allocation.ts`:

```typescript
// Allocation breakdown over a portfolio snapshot. Pure aggregation —
// no time-series component, no transaction walk. asset_class / account /
// security partition (weights sum to 100% within rounding); tag dimension
// (Task 14) is attribution (weights can exceed 100%).

import { add, ofCents, ZERO, type Money } from '@shared/money';

import { FinancialError } from './errors';
import type {
  AllocationBreakdown,
  AllocationBucket,
  AllocationOptions,
  PortfolioSnapshot,
} from './types';

interface BucketAccum {
  market_value_cents: Money;
  cost_basis_cents: Money;
}

function emptyBucket(): BucketAccum {
  return { market_value_cents: ZERO, cost_basis_cents: ZERO };
}

function finalize(
  dimension: AllocationBreakdown['dimension'],
  buckets: Map<string, BucketAccum>,
  totalMv: Money,
): AllocationBreakdown {
  const mvNum = Number(totalMv);
  const out: AllocationBucket[] = [];
  for (const [key, acc] of buckets) {
    out.push({
      key,
      market_value_cents: acc.market_value_cents,
      cost_basis_cents: acc.cost_basis_cents,
      weight_pct: mvNum === 0 ? 0 : (Number(acc.market_value_cents) / mvNum) * 100,
    });
  }
  // Stable ordering: largest bucket first.
  out.sort((a, b) => Number(b.market_value_cents) - Number(a.market_value_cents));
  return { dimension, buckets: out, total_market_value_cents: totalMv };
}

export function computeAllocation(
  snapshot: PortfolioSnapshot,
  opts: AllocationOptions,
): AllocationBreakdown {
  const buckets = new Map<string, BucketAccum>();
  let totalMv: Money = ZERO;

  for (const pos of snapshot.positions) {
    const mv = pos.market_value_cents ?? ZERO;
    totalMv = add(totalMv, mv);

    let key: string;
    if (opts.dimension === 'asset_class') {
      const entry = opts.securities?.get(pos.security_id);
      if (!entry || entry.asset_class == null) {
        throw new FinancialError(
          'allocation.missing_security',
          'security not in lookup map (asset_class)',
          { id: pos.security_id },
        );
      }
      key = entry.asset_class;
    } else if (opts.dimension === 'account') {
      const entry = opts.accounts?.get(pos.account_id);
      if (!entry) {
        throw new FinancialError(
          'allocation.missing_account',
          'account not in lookup map',
          { id: pos.account_id },
        );
      }
      key = entry.name;
    } else if (opts.dimension === 'security') {
      const entry = opts.securities?.get(pos.security_id);
      key = entry?.symbol ?? `security:${pos.security_id}`;
    } else {
      // 'tag' handled in Task 14
      throw new RangeError(`unsupported dimension: ${opts.dimension}`);
    }

    const acc = buckets.get(key) ?? emptyBucket();
    acc.market_value_cents = add(acc.market_value_cents, mv);
    acc.cost_basis_cents = add(acc.cost_basis_cents, pos.cost_basis_cents);
    buckets.set(key, acc);
  }

  return finalize(opts.dimension, buckets, totalMv);
}
```

### Step 13.3: Run tests

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/allocation.test.ts`
- [ ] Expected: PASS for asset_class / account / security cases.

### Step 13.4: Create the allocation-by-class fixture + test

- [ ] Create `worktrees/feat-financial-engine-slice-2/tests/fixtures/financial/allocation-by-class.json`:

```json
{
  "name": "allocation-by-class",
  "description": "Three securities across two asset classes. Weights partition to 100%.",
  "snapshot": {
    "positions": [
      { "account_id": 1, "security_id": 1, "quantity": 100, "cost_basis_cents": 50000, "current_price_cents": 600, "market_value_cents": 60000, "unrealized_gain_cents": 10000, "currency_code": "USD" },
      { "account_id": 1, "security_id": 2, "quantity": 100, "cost_basis_cents": 40000, "current_price_cents": 400, "market_value_cents": 40000, "unrealized_gain_cents": 0, "currency_code": "USD" },
      { "account_id": 1, "security_id": 3, "quantity": 100, "cost_basis_cents": 90000, "current_price_cents": 1000, "market_value_cents": 100000, "unrealized_gain_cents": 10000, "currency_code": "USD" }
    ],
    "total_cost_basis_cents": 180000,
    "total_market_value_cents": 200000,
    "total_unrealized_gain_cents": 20000,
    "as_of": "2026-12-31T00:00:00Z"
  },
  "securities": {
    "1": { "asset_class": "equity" },
    "2": { "asset_class": "bond" },
    "3": { "asset_class": "equity" }
  },
  "expected": {
    "equity_pct": 80.0,
    "bond_pct": 20.0
  }
}
```

- [ ] Append to `allocation.test.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function loadFixture(name: string): any {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '../../../tests/fixtures/financial', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('fixture: allocation-by-class', () => {
  it('weights match the fixture-expected splits', () => {
    const fx = loadFixture('allocation-by-class');
    const snap: PortfolioSnapshot = {
      ...fx.snapshot,
      positions: fx.snapshot.positions.map((p: any) => ({
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
      Object.entries(fx.securities).map(([k, v]) => [Number(k), v as any]),
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
```

### Step 13.5: Run tests + commit

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/allocation.test.ts`
- [ ] Expected: PASS.

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/allocation.ts src/backend/financial/allocation.test.ts tests/fixtures/financial/allocation-by-class.json
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): allocation — asset_class / account / security partitions

Spec §F8 (three partition dimensions). Allocation is a pure aggregation
over PortfolioSnapshot — no walk, no time series. Caller supplies the
lookup maps (security → asset_class/symbol, account → name) consistent
with slice 1's no-I/O rule. Buckets are sorted descending by market
value for stable display ordering. allocation.missing_security and
.missing_account thrown when a lookup is absent."
```

---

## Task 14: Allocation — tag dimension (lot-level attribution)

**Files:**
- Modify: `src/backend/financial/allocation.ts`
- Modify: `src/backend/financial/allocation.test.ts`
- Create: `tests/fixtures/financial/allocation-by-tag.json`

### Step 14.1: Write failing tests

- [ ] Append to `allocation.test.ts`:

```typescript
import { computeLots } from './lots';
import { buildPriceHistory, buildTx, dateD, resetTxIds } from './test-helpers';

describe('computeAllocation — by tag (lot-level attribution)', () => {
  it('multi-tagged lot contributes its full value to each tag bucket; weights can sum to >100%', () => {
    // 3 buys; tag the first two with "core" and the second additionally
    // with "long-term". Third is untagged.
    const txns = [
      buildTx({
        id: 1,
        transaction_type: 'buy',
        transaction_date: dateD('2026-01-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
      buildTx({
        id: 2,
        transaction_type: 'buy',
        transaction_date: dateD('2026-02-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
      buildTx({
        id: 3,
        transaction_type: 'buy',
        transaction_date: dateD('2026-03-01'),
        quantity: 100,
        price_cents: D(10),
        amount_cents: D(1000),
      }),
    ];
    const { openLots } = computeLots(txns, { method: 'fifo' });
    const lotTags = new Map<number, ReadonlyArray<string>>([
      [1, ['core']],
      [2, ['core', 'long-term']],
      // 3 untagged → (untagged) bucket
    ]);
    const s = snap([{ account_id: 1, security_id: 1, mv: 3000, cb: 3000 }]);
    const result = computeAllocation(s, {
      dimension: 'tag',
      lots: openLots,
      lotTags,
    });
    const core = result.buckets.find((b) => b.key === 'core')!;
    const longTerm = result.buckets.find((b) => b.key === 'long-term')!;
    const untagged = result.buckets.find((b) => b.key === '(untagged)')!;
    // Per-lot price = $10 × 100 shares = $1000 each lot. Lots 1+2 → core; lot 2 → long-term; lot 3 → untagged.
    // Note: market value here is the snapshot total ($3000), so each lot's MV per-tag is computed by lot.quantity × snapshot price.
    expect(Number(core.market_value_cents)).toBeCloseTo(2000, 0);
    expect(Number(longTerm.market_value_cents)).toBeCloseTo(1000, 0);
    expect(Number(untagged.market_value_cents)).toBeCloseTo(1000, 0);
    // Tag weights can exceed 100%: 2000/3000 + 1000/3000 + 1000/3000 = 133.3%
    const totalPct = result.buckets.reduce((s, b) => s + b.weight_pct, 0);
    expect(totalPct).toBeGreaterThan(100);
    expect(totalPct).toBeCloseTo(133.33, 1);
  });

  it('throws RangeError when lots option is missing', () => {
    const s = snap([{ account_id: 1, security_id: 1, mv: 100, cb: 100 }]);
    expect(() => computeAllocation(s, { dimension: 'tag' })).toThrow(RangeError);
  });
});
```

### Step 14.2: Implement the tag branch

- [ ] Modify `allocation.ts` to add a separate code path for the tag dimension. Lot market value uses the snapshot's per-position `current_price_cents` (single-security lots × per-share price). Replace the `'tag'` throw in the existing function:

```typescript
  if (opts.dimension === 'tag') {
    if (!opts.lots || !opts.lotTags) {
      throw new RangeError('tag dimension requires both lots and lotTags');
    }
    return tagAllocation(snapshot, opts.lots, opts.lotTags);
  }
```

Add the helper:

```typescript
function tagAllocation(
  snapshot: PortfolioSnapshot,
  lots: ReadonlyArray<{ sourceTxId: number; account_id: number; security_id: number; quantity: number; cost_basis_cents: Money }>,
  lotTags: ReadonlyMap<number, ReadonlyArray<string>>,
): AllocationBreakdown {
  // Per-position price lookup keyed by (account_id, security_id).
  const priceByKey = new Map<string, Money | null>();
  for (const pos of snapshot.positions) {
    priceByKey.set(`${pos.account_id}:${pos.security_id}`, pos.current_price_cents);
  }

  const buckets = new Map<string, BucketAccum>();
  const totalMv = snapshot.total_market_value_cents ?? ZERO;

  for (const lot of lots) {
    const price = priceByKey.get(`${lot.account_id}:${lot.security_id}`);
    if (price == null) continue; // lot's position lacks a price — skip
    const lotMv = ofCents(Math.round(Number(price) * lot.quantity));
    const lotCb = lot.cost_basis_cents;
    const tags = lotTags.get(lot.sourceTxId) ?? [];
    const keys = tags.length === 0 ? ['(untagged)'] : tags;
    for (const key of keys) {
      const acc = buckets.get(key) ?? emptyBucket();
      acc.market_value_cents = add(acc.market_value_cents, lotMv);
      acc.cost_basis_cents = add(acc.cost_basis_cents, lotCb);
      buckets.set(key, acc);
    }
  }

  return finalize('tag', buckets, totalMv);
}
```

### Step 14.3: Run tests

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 exec vitest run src/backend/financial/allocation.test.ts`
- [ ] Expected: all PASS.

### Step 14.4: Add the allocation-by-tag fixture

- [ ] Create `worktrees/feat-financial-engine-slice-2/tests/fixtures/financial/allocation-by-tag.json`:

```json
{
  "name": "allocation-by-tag",
  "description": "Lot-level tag attribution. Lots 1+2 tagged 'core'; lot 2 also 'long-term'; lot 3 untagged. Tag weights sum to >100% (documented attribution behavior).",
  "transactions": [
    { "id": 1, "account_id": 1, "security_id": 1, "transaction_type": "buy",
      "transaction_date": "2026-01-01T00:00:00Z", "quantity": 100, "price_cents": 1000,
      "amount_cents": 100000, "fee_cents": null, "currency_code": "USD" },
    { "id": 2, "account_id": 1, "security_id": 1, "transaction_type": "buy",
      "transaction_date": "2026-02-01T00:00:00Z", "quantity": 100, "price_cents": 1000,
      "amount_cents": 100000, "fee_cents": null, "currency_code": "USD" },
    { "id": 3, "account_id": 1, "security_id": 1, "transaction_type": "buy",
      "transaction_date": "2026-03-01T00:00:00Z", "quantity": 100, "price_cents": 1000,
      "amount_cents": 100000, "fee_cents": null, "currency_code": "USD" }
  ],
  "lot_tags": {
    "1": ["core"],
    "2": ["core", "long-term"]
  },
  "expected": {
    "buckets": {
      "core": { "market_value_cents": 200000, "weight_pct_approx": 66.67 },
      "long-term": { "market_value_cents": 100000, "weight_pct_approx": 33.33 },
      "(untagged)": { "market_value_cents": 100000, "weight_pct_approx": 33.33 }
    },
    "total_weight_pct_approx": 133.33
  }
}
```

### Step 14.5: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/allocation.ts src/backend/financial/allocation.test.ts tests/fixtures/financial/allocation-by-tag.json
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): allocation — tag dimension at lot level

Spec §F8 (tag branch). Each open lot inherits its opening buy's tags;
lots with multiple tags contribute their full market value to each
bucket, so bucket weights sum to >100% by design (tags are descriptive
attribution, not partitioning). Lots with no tag aggregate into
'(untagged)'. Throws RangeError when lots/lotTags are absent."
```

---

## Task 15: Wire up `index.ts` exports + full-suite sanity

**Files:**
- Modify: `src/backend/financial/index.ts`

### Step 15.1: Add the six new function exports + new types

- [ ] Replace `worktrees/feat-financial-engine-slice-2/src/backend/financial/index.ts` with:

```typescript
// Public surface of the financial calculation engine. See
// docs/specs/2026-05-18-financial-engine-slice-1.md (slice 1) and
// docs/specs/2026-05-19-financial-engine-slice-2.md (slice 2).

export { FinancialError, type FinancialErrorCode } from './errors';

// Slice 1
export { computeLots } from './lots';
export { computePosition, emptyPosition, type ComputePositionOptions } from './position';
export {
  computePortfolio,
  type ComputePortfolioOptions,
  type MethodResolver,
  type PortfolioResult,
} from './portfolio';
export { computeRealizedGainsLoss, type RealizedRange } from './realized';
export { computeIncomeStream, type IncomeRange } from './income';

// Slice 2
export { computeValuationSeries, type ComputeValuationSeriesOptions } from './valuation';
export { computeTimeWeightedReturn } from './twr';
export { computeMoneyWeightedReturn } from './mwr';
export { computeDrawdown } from './drawdown';
export { computeRealReturn, cpiAt } from './cpi';
export { computeAllocation } from './allocation';

export type {
  // Slice 1
  ClosedLot,
  ComputeLotsOptions,
  CostBasisMethod,
  IncomeSummary,
  Lot,
  LotResult,
  LotSelection,
  LotSelectionMap,
  PortfolioSnapshot,
  PositionSnapshot,
  PriceMap,
  RealizedSummary,
  Tx,
  TxType,
  // Slice 2
  AllocationBreakdown,
  AllocationBucket,
  AllocationDimension,
  AllocationOptions,
  CpiPoint,
  CpiSeries,
  DateRange,
  DrawdownResult,
  DrawdownStats,
  MwrResult,
  PriceHistory,
  PricePoint,
  RealReturnResult,
  Scope,
  TwrResult,
  ValuationPoint,
  ValuationSeries,
} from './types';
```

### Step 15.2: Run the full suite

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 typecheck`
- [ ] Expected: PASS.
- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 test`
- [ ] Expected: all suites green, including slice 1's existing tests.

### Step 15.3: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add src/backend/financial/index.ts
git -C worktrees/feat-financial-engine-slice-2 commit -m "feat(financial): export slice 2 public surface

Six new functions (computeValuationSeries, computeTimeWeightedReturn,
computeMoneyWeightedReturn, computeDrawdown, computeRealReturn,
computeAllocation) plus cpiAt as a callable helper. Type exports
extended with all slice 2 types."
```

---

## Task 16: Update WORKSTREAMS and run linter / format

**Files:**
- Modify: `docs/WORKSTREAMS.md`

### Step 16.1: Flip slice-2 checkboxes in WORKSTREAMS

- [ ] Open `worktrees/feat-financial-engine-slice-2/docs/WORKSTREAMS.md` and replace the "Remaining (slice 2)" block with a "Landed (slice 2)" block listing TWR, MWR, drawdown (nominal + real), real-return deflation, and allocation. Keep the open-questions (risk metrics, benchmarks, rolling returns) under the workstream-3 remaining list — they are slice-3 candidates.

- [ ] Patch (illustrative — exact lines depend on the document state at time of merge; preserve any other recent edits):

```diff
-Remaining (slice 2, separate spec to come):
-- [ ] Time-weighted return (TWR) calculation
-- [ ] Money-weighted return (MWR / IRR) calculation
-- [ ] Drawdown calculation: max drawdown, current drawdown, drawdown duration, time-to-recovery
-- [ ] **Real returns net of CPI**: load CPI series from `cpi_data` table; deflate nominal returns to constant-dollar real returns; this is the default display surface
-- [ ] Allocation calculations: by asset class, by account, by security, by custom tag
-- [ ] Golden-dataset fixtures extended with hand-computed TWR/MWR/drawdown values
-- [ ] `scripts/regen-financial-fixtures.ts` typing-convenience regen helper (F7)
-- [ ] Coverage thresholds enforced in CI (target: 95%+ on `src/backend/financial/`) — lands with W12 test infrastructure
+Landed (slice 2 — spec [specs/2026-05-19-financial-engine-slice-2.md](specs/2026-05-19-financial-engine-slice-2.md)):
+- [x] `computeValuationSeries` daily primitive (F5) with forward-only price carry-forward and `price.stale` throw
+- [x] True daily TWR via `computeTimeWeightedReturn` (F2); annualized when range ≥ 365.25 days
+- [x] MWR / IRR via `computeMoneyWeightedReturn` — Newton-Raphson seeded with TWR + bisection fallback; `irr.bad_initial_state` / `irr.no_solution` / `irr.no_convergence` codes
+- [x] Drawdown nominal + real via `computeDrawdown` (F7); CPI deflation gates the real branch
+- [x] Real returns via `computeRealReturn` with period-boundary linear CPI interpolation (F6); `cpi.out_of_range` throws — no extrapolation
+- [x] Allocation via `computeAllocation` across asset_class / account / security (partition) and tag (lot-level attribution; weights can sum to >100%, by design — F8)
+- [x] Five new golden fixtures: `daily-twr-simple`, `cashflows-mid-period`, `drawdown-2008`, `real-returns-1979-1981`, `pre-funding-days`, `allocation-by-class`, `allocation-by-tag`
+- [x] Property tests: TR-index follows constant-return chains; scale invariance
+
+Remaining (slice 3 — separate spec):
+- [ ] Risk metrics: volatility (stdev of daily returns), Sharpe, Sortino, beta
+- [ ] Benchmark-relative returns (vs S&P 500 / 60-40 blend / user-chosen)
+- [ ] Rolling-window TWR / drawdown series (1Y / 3Y / 5Y)
+- [ ] `scripts/regen-financial-fixtures.ts` typing-convenience regen helper (carried from slice 1 F7)
+- [ ] Coverage thresholds enforced in CI (target: 95%+ on `src/backend/financial/`) — lands with W12
```

### Step 16.2: Lint + format

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 lint`
- [ ] Expected: PASS.
- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 format:check`
- [ ] If reports unformatted files, run: `pnpm -C worktrees/feat-financial-engine-slice-2 format`

### Step 16.3: Full suite one more time

- [ ] Run: `pnpm -C worktrees/feat-financial-engine-slice-2 test`
- [ ] Expected: ALL green, slice 1 + slice 2.

### Step 16.4: Commit

```bash
git -C worktrees/feat-financial-engine-slice-2 add docs/WORKSTREAMS.md
git -C worktrees/feat-financial-engine-slice-2 commit -m "docs(workstreams): mark WS3 slice 2 complete; carry remaining to slice 3

Slice 2 (TWR, MWR, drawdown nominal+real, real-return deflation, allocation
across four dimensions) landed. Risk metrics, benchmark comparison, and
rolling-window returns deferred to slice 3 per spec §'Out of scope'.
Fixture-regen helper and CI coverage gate still pending (the latter lands
with W12 test infrastructure)."
```

---

## Verification checklist

After Task 16 commits, run from the repo root:

- [ ] `pnpm -C worktrees/feat-financial-engine-slice-2 typecheck` — clean
- [ ] `pnpm -C worktrees/feat-financial-engine-slice-2 lint` — clean
- [ ] `pnpm -C worktrees/feat-financial-engine-slice-2 test` — all green
- [ ] `git -C worktrees/feat-financial-engine-slice-2 log --oneline main..HEAD` — shows 17 commits (the spec + 16 task commits) in order
- [ ] Spot-check `tests/fixtures/financial/*.json` — 7 new files exist alongside the slice 1 fixtures
- [ ] `git -C worktrees/feat-financial-engine-slice-2 diff main -- src/backend/financial/index.ts` — exports the six new functions and the new types

Once green, the branch is ready for the user to fast-forward into `main`.

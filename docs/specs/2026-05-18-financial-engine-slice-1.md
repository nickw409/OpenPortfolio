# Financial calculation engine — slice 1 (positions, lots, basis, realized/unrealized, dividends)

**Status:** Approved 2026-05-18
**Date:** 2026-05-18
**Workstream:** [docs/WORKSTREAMS.md](../WORKSTREAMS.md) §3 Financial calculation engine
**Depends on:** [Initial schema](2026-05-15-initial-schema-design.md), [Money primitive](2026-05-15-money-primitive-design.md)

## Context

WORKSTREAMS §3 names the calculation engine as the audited deterministic core — pure functions over `Money`, no side effects, no I/O, no AI involvement. It enumerates ten capabilities: position tracking, cost basis (FIFO/LIFO/specific-lot), TWR, MWR, drawdown, real returns net of CPI, allocation, realized vs unrealized G/L, dividend tracking + yield, and the test-coverage target (95% + golden datasets + property tests).

That's too large for one spec. Slice 1 is **lots-at-time-T**: everything you need to answer "what do I own, what did I pay, and what's the gain/loss" deterministically. Slice 2 (separate spec, later) layers returns/drawdown/allocation on top.

Out of slice 1: TWR, MWR, drawdown, real returns net of CPI, allocation. In slice 1: position tracking, cost basis (FIFO/LIFO/specific-lot), splits, dividends + yield, realized vs unrealized G/L, and the golden-dataset test pattern (W12 builds out the broader test infra; we sketch the pattern here so it has a real first consumer).

Pre-decided by the workstream-scoping conversation:
- Engine lives at `src/backend/financial/`. Coverage target 95% (CLAUDE.md).
- `transactions.transaction_type='split'` interprets `quantity` as the **split ratio** (2.0 = 2-for-1). The current `positions` view treats split quantity additively — that's a bug this slice fixes (see F3).
- Cost basis method: per-account default column + per-call override (requires schema migration).

Seven forks: engine input shape, lot materialization, the `positions` view's future, primitive API surface, quantity precision, cost-basis schema migration shape, and golden-fixture format.

---

## F1. Engine input shape

The calc engine must stay pure (WORKSTREAMS §3). The question is what "pure" looks like at the function boundary.

- **A. Pure functions over plain typed records** — engine takes `Transaction[]`, `PriceRow[]`, etc. as arguments. Callers (route handlers / services) load from the DB and pass arrays in. Engine has zero awareness of Drizzle, SQLite, or Hono.
- **B. Engine takes a DB handle, runs its own queries** — encapsulated; one function call to get a position with all its inputs. But couples the engine to Drizzle and makes it impossible to test without a database fixture, makes property-based testing harder, and conflicts with WORKSTREAMS' "no I/O" wording.
- **C. Repository interface injected** — engine takes a `TransactionRepo` interface and calls methods on it. Allows mock repos in test. More indirection than A buys us, given the data shapes are stable.

**Recommendation: A.** Pure functions over arrays. The engine module exports functions that take typed inputs and return typed outputs; service layer (next to routes) loads from the DB and calls in. Tests pass arrays directly; property-based tests synthesize arrays with fast-check. Cost is one extra layer (service vs. engine), value is that the engine is trivially testable and the boundary against I/O is enforced by what the engine *can't* import (no Drizzle, no `better-sqlite3`).

Engine functions are pure-with-throws — argument validation errors throw `RangeError`/`TypeError`, business-rule violations (sell-exceeds-holdings, etc.) throw a typed `FinancialError` with a stable `code`. No silent failure; no `null` for "couldn't compute."

---

## F2. Lot materialization

Cost basis methods (FIFO/LIFO/specific) need a lot ledger — each buy creates a lot, each sell consumes from existing lots per the chosen method.

- **A. Compute lots on demand from transactions** — every call walks the transaction history forward, building lots, applying splits, consuming on sells. No persisted state outside `transactions`. Single source of truth.
- **B. Materialized lot table updated on every txn insert/update/delete** — performance win at the cost of invalidation complexity. The transactions table is the truth; a derived table risks drift on edge cases (soft-delete edits, batch imports, schema migrations).
- **C. Cached materialization with version tag** — engine writes a lot snapshot keyed on a hash of the transaction set; invalidate by hash mismatch. Reuses A's logic for the cold path.

**Recommendation: A.** For v1.0, every position query re-walks transactions. The expensive constant is "transactions per security." For a 20-year portfolio with ~50 trades per year per security, that's ~1000 transactions per per-security walk — sub-millisecond. Per-portfolio queries walk all transactions once and bucket by security: a 100-security portfolio with 100k total transactions still completes in well under 100ms on modern hardware. We don't have data to suggest we need C, and B's drift risk is real. Revisit if profiling at slice-2-time shows return calculations dominated by lot reconstruction.

---

## F3. The `positions` view

The current `positions` SQL view (schema.ts:197) sums signed quantities by `transaction_type`. With splits now storing the ratio (not delta), the view is double-broken: it adds ratios as if they were share counts, and it doesn't apply the ratio retroactively to prior lots.

- **A. Fix the view** — make it ignore `split` entirely (treat splits as corporate actions handled only by the engine) and document its limits (no split-adjusted quantities, no cost basis). Useful for a fast "raw holdings list" tile that doesn't claim accuracy across corporate actions.
- **B. Drop the view, engine is the single source of truth** — every read of position state goes through the engine. Simpler mental model. Requires a migration to drop the view.
- **C. Keep the view as-is, document the bug** — punt. Cost: invites bugs in any UI that consumes the view.

**Recommendation: B.** Drop the view in a migration shipped with this slice. The engine is the authoritative source; the view's existence invites callers to bypass the engine and get wrong numbers. The "raw holdings list" use case is served by a thin engine function (`listCurrentHoldings`) that runs the same code path as everything else. One less place for the calculation to live, one less invariant to maintain.

Migration: `migrations/<next>_drop_positions_view.sql` with a `DROP VIEW IF EXISTS positions;`. Drizzle schema removes the `positions` export. Anything that imports `positions` from the schema gets a compile error — there are no such imports yet (verified: only schema.ts mentions it).

---

## F4. Primitive API surface

What the engine exports at the top level.

- **A. Single "kitchen sink" function** — `computePortfolio(txns, opts) → Snapshot` returns everything. Easy to call, hard to test in isolation, hard to extend.
- **B. Layered primitives** — `computeLots` (lowest), `computePosition` (per-security aggregate over lots), `computePortfolio` (aggregate across securities). Each layer is a thin reducer over the one below. Test the bottom exhaustively; the upper layers are mechanical.
- **C. Class-based engine** — `new FinancialEngine(txns).positions().at(date)`. Fluent, but state-y; cuts against the pure-function design.

**Recommendation: B.** Three layers:

```
computeLots(txns: Tx[], opts: { asOf?: Date }) → Lot[]
  // Walks txns chronologically. Applies splits to prior lots' shares
  // and per-share basis. Returns open lots only (closed lots are sold-out).
  // Includes a `closedLots` companion for realized G/L queries.

computePosition(lots: Lot[], opts: { method: CostBasisMethod, currentPriceCents?: Money })
  → PositionSnapshot
  // Aggregates a single security's open lots: total quantity, total cost
  // basis (sum across lots), unrealized G/L if currentPrice given.

computePortfolio(txns: Tx[], opts: { asOf?: Date, prices?: PriceMap })
  → PortfolioSnapshot
  // Convenience: groups by (account_id, security_id), calls computeLots,
  // then computePosition for each, then aggregates.
```

Realized G/L is a fourth function over the **closed-lot stream**: `computeRealizedGainsLoss(closedLots, range?) → RealizedSummary`. Closed lots are emitted by `computeLots` as a side-output; that keeps the cost-basis-method logic in exactly one place.

Dividends and fees are aggregated by a separate `computeIncomeStream(txns, range?) → IncomeSummary` — dividends, interest, fees, with yield computed as TTM-dividends ÷ current-market-value (current value injected by caller).

Five top-level functions. Each takes plain data, returns plain data, throws on invalid input.

---

## F5. Quantity precision and rounding

`transactions.quantity` is `REAL` (float). Fractional shares are common (DRIP rounding, ETF fractional-share brokers). The engine multiplies float quantity by `Money` cents to compute lot values, which goes through `multiplyByRatio` (round-half-to-even).

- **A. Keep `quantity` as float, round-to-even at every Money conversion, accept O(1) cents-of-drift across long histories.** The cumulative-rounding risk is bounded: even with banker's rounding bias-free, 1000 conversions × 0.5-cent average rounding gives a worst-case ~5-dollar drift over a 1000-trade portfolio — and round-half-to-even is unbiased so the *expected* drift is zero.
- **B. Migrate `quantity` to integer "millishares"** — quantity stored as `quantity_milli = integer(shares × 1000)`. Eliminates float entirely. Requires schema migration + every existing entry surface to convert. Adds friction to manual entry ("how many millishares?"). Most users think in shares.
- **C. Decimal library (decimal.js)** — full arbitrary precision. Adds a runtime dep and a type surface to plumb everywhere. Overkill for a personal portfolio tracker where the worst case is dollars of drift over decades.

**Recommendation: A** with a structural guarantee: the engine never round-trips through float dollars. The only float in the system is `quantity`; every Money value is integer cents throughout the engine. Round-half-to-even is already the `Money` policy (money.ts:130). Document the cents-of-drift bound in the engine module header. If a future user reports drift, the migration to B is a contained refactor.

Test coverage: a property test that drives 10,000-step random transaction histories through the engine and asserts that total cost basis (cents) never differs from a hand-computed reference (also in cents, using BigInt) by more than 1 cent per transaction.

---

## F6. `accounts.cost_basis_method` migration

Per slicing decision: column on `accounts` + per-call override.

- **Column:** `accounts.cost_basis_method TEXT NOT NULL DEFAULT 'fifo'`. Allowed values `'fifo'|'lifo'|'specific'` enforced at the app layer (matches the existing `tax_treatment` convention — schema.ts:22).
- **Migration:** `migrations/<next>_accounts_cost_basis_method.sql`. Adds the column with default `'fifo'` so existing rows (none yet, but the migration runs against any future seeded DB) get the right value.
- **Engine signature:** every position-computing function takes `method?: CostBasisMethod`; if omitted, the service layer resolves it from `accounts.cost_basis_method`. Engine itself is method-agnostic until told.
- **'specific' lot:** the per-call override carries a `lotSelections: { transactionId: number, quantityFromLot: number }[]` payload. v1.0 UX for specific-lot selection is a slice-2 concern; the engine accepts the payload now so the API doesn't churn later.

Not really a fork — calling out the shape so implementation doesn't drift.

---

## F7. Golden-dataset fixture format

WORKSTREAMS §3 calls for "golden-dataset tests: a hand-computed portfolio with known TWR/MWR/drawdown values; calculations must match to within rounding." Slice 1 covers lots, basis, realized/unrealized, dividends — the same fixture format will extend to slice 2's returns/drawdown.

- **A. JSON fixture files committed under `tests/fixtures/`** — each fixture is `{ name, description, transactions: [...], expected: { lots: [...], realized: {...}, ... } }`. Tests load and compare. Easy to author, easy to diff. Regenerable by a script that runs the engine and writes `expected`.
- **B. TypeScript fixture modules** — same data shape but as `.ts` files with `as const` assertions. Type-checked at compile time. Heavier to author. No big payoff over A given the test runner already type-checks.
- **C. SQL seed scripts + a separate fixtures table** — most realistic (round-trips through SQLite), but couples the engine tests to the DB layer, which F1 just told us not to do.

**Recommendation: A.** JSON fixtures in `tests/fixtures/financial/`. A small helper `loadFixture(name)` deserializes; Money fields are written as integer cents (no string form, no float-dollar form). The "regenerable by script" path is `pnpm exec tsx scripts/regen-financial-fixtures.ts` — runs the engine on each fixture's transactions, writes `expected`. Used carefully: a fixture's `expected` block is only regenerated when the test author has hand-verified the new values; the script is a typing convenience, not an "accept whatever the engine outputs" rubber stamp. Document this in `scripts/regen-financial-fixtures.ts` header.

Initial fixtures shipped with slice 1:
- `simple-buy-sell` — one buy, one sell, both partial; FIFO and LIFO diverge.
- `split-mid-history` — buy, 2-for-1 split, buy, sell. Validates split-adjusts-prior-lots logic.
- `multi-account` — same security across taxable and tax-deferred accounts; per-account method differs.
- `dividend-stream` — buys + dividends, validates yield-on-cost and TTM yield.
- `realized-loss` — sell at a loss, validates negative realized G/L sign convention.

---

## Open questions

- **Wash sale rules.** v1.0 doesn't generate tax documents, so wash-sale-disallowed losses are not computed. The engine reports realized G/L raw; downstream tax tooling is the user's. Flag for slice 2 if user demand emerges.
- **Corporate actions beyond splits.** Spinoffs, mergers, return-of-capital, dividend reinvestment plans (DRIP). v1.0 lean: DRIP is modeled as a `dividend` followed by a `buy` (two transactions). Spinoffs/mergers throw `FinancialError('unsupported.corporate_action')` with a clear message until v1.x. Slice-2 spec revisits.
- **Multi-currency.** Schema has `currency_code` everywhere. v1.0 engine errors on portfolios mixing currencies (`FinancialError('unsupported.mixed_currency')`). Single-currency-per-portfolio is the v1.0 contract.
- **Real-time price input for unrealized G/L.** Engine takes prices as an injected `PriceMap`; caller (service layer) decides whether to pull from `price_history` cache, an active provider quote, or manual entry. Out of engine scope.

---

## Out of scope (slice 1, deliberately)

- TWR (slice 2)
- MWR / IRR (slice 2)
- Drawdown (slice 2)
- Real returns net of CPI (slice 2)
- Allocation by class/account/security/tag (slice 2)
- Wash sale and tax-lot tax optimization (post-v1.0)
- Spinoffs, mergers, return-of-capital (post-v1.0; engine errors clearly)
- Multi-currency portfolios (post-v1.0; engine errors clearly)
- Persistent lot materialization (F2 §B — defer until profiling demands it)

---

## Decisions and rationale

Approved 2026-05-18.

- **F1 — Pure functions over typed records (A) chosen.** DB-handle (B) rejected: couples engine to Drizzle, kills property-based testing, conflicts with WORKSTREAMS' "no I/O" wording. Injected repo interface (C) rejected: indirection without payoff when data shapes are stable. Engine module imports zero DB code; services next to routes load and pass arrays in. Errors throw `RangeError`/`TypeError` for argument validation, typed `FinancialError` with stable `code` for business-rule violations.
- **F2 — Compute lots on demand (A) chosen.** Materialized lot table (B) rejected: drift risk under soft-delete edits, batch imports, and schema migrations is real, and the perf headroom of A is large (sub-millisecond per-security, <100ms for 100k-transaction portfolios). Cached materialization (C) rejected: same drift risk plus a hash-invalidation layer to maintain. Re-walk every query for v1.0; profile slice-2-time to revisit.
- **F3 — Drop the `positions` view (B) chosen.** Fixing the view (A) rejected: keeping a parallel SQL implementation of position semantics invites bypass and drift; engine is the single source of truth. Keep-the-bug (C) rejected: ships a known wrong answer. Migration `<next>_drop_positions_view.sql` drops the view; Drizzle schema removes the export; thin engine helper `listCurrentHoldings` serves the raw-holdings-list use case.
- **F4 — Layered primitives (B) chosen.** Single kitchen-sink function (A) rejected: hard to test in isolation, hard to extend. Class-based engine (C) rejected: state-y, fights the pure-function design. Five top-level functions: `computeLots`, `computePosition`, `computePortfolio`, `computeRealizedGainsLoss`, `computeIncomeStream`. `computeLots` is the cost-basis-method choke point; everything above is mechanical aggregation.
- **F5 — Keep `quantity` as float, round-half-to-even at every Money conversion (A) chosen.** Millishares migration (B) rejected: every entry surface and broker statement is share-denominated; the one-way-door risk to user data outweighs the cents-of-drift bound. Decimal library (C) rejected: dependency and pervasive type plumbing for a sub-dollar effect over decades. Engine never round-trips through float dollars; the only float is `quantity`. Property test asserts cents-of-drift bound under 10k-step random histories.
- **F6 — `accounts.cost_basis_method` + per-call override.** Migration adds the column with default `'fifo'`; allowed values constrained at app layer (matches existing `tax_treatment` convention). Engine signature takes `method?: CostBasisMethod`; service layer resolves the default from `accounts`. `'specific'` lot selection payload (`{ transactionId, quantityFromLot }[]`) accepted now so the API doesn't churn when slice-2 wires the UI.
- **F7 — JSON fixtures under `tests/fixtures/financial/` (A) chosen.** TypeScript modules (B) rejected: heavier authoring, no payoff over JSON given vitest type-checks call sites. SQL seeds (C) rejected: re-couples engine tests to the DB layer that F1 just decoupled. `loadFixture(name)` helper deserializes; Money fields are integer cents only. Regen script `scripts/regen-financial-fixtures.ts` is a typing convenience, not an "accept whatever the engine outputs" rubber stamp — fixtures are hand-verified.

Open questions remain open — not blocked on this spec:
- Wash sale: post-v1.0 unless tax-tooling demand emerges.
- Spinoffs/mergers/return-of-capital: engine throws `FinancialError('unsupported.corporate_action')` until v1.x.
- Multi-currency: engine throws `FinancialError('unsupported.mixed_currency')`; single-currency-per-portfolio is the v1.0 contract.
- Real-time price input: engine takes injected `PriceMap`; caller chooses cache vs live vs manual.

Implementation deviations, if any, will be appended below.

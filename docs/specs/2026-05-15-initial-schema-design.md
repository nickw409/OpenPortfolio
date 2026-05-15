# Initial schema — design spec

**Status:** Proposed
**Date:** 2026-05-15
**Workstream:** [docs/WORKSTREAMS.md](../WORKSTREAMS.md) §1 Database foundation and money types
**Depends on:** [Money primitive spec](2026-05-15-money-primitive-design.md) (cents columns reference `Money`)

## Context

WORKSTREAMS §1 names eight tables: `accounts`, `securities`, `transactions`, `positions`, `price_history`, `cpi_data`, `dashboard_layouts`, `tile_configs`, `audit_log`. This spec works through the cross-table design forks (identity, position computation, currency, audit shape, soft-delete enforcement) before the schema lands. Per-table column choices are normal implementation work and live in the migration files.

Six forks: securities identity, positions table-or-view, currency handling, audit log shape, soft-delete enforcement, indexing strategy.

---

## S1. Securities identity

How a holding is identified across transactions, prices, and positions.

- **A. Symbol-only** — `symbol TEXT PRIMARY KEY`. Simple, but symbols change (FB → META), collide across exchanges (`BHP` differs on NYSE vs ASX), and tickers get reused after delisting.
- **B. Composite (symbol + exchange + asset_class)** — composite key or surrogate `id` with unique `(symbol, exchange)`. Robust against cross-exchange collision, less robust against symbol changes.
- **C. Universal IDs (CUSIP / ISIN) plus user-friendly symbol** — most robust, but most users don't know their CUSIPs and free CUSIP→symbol resolvers don't exist.

**Recommendation: B with optional C columns.** Surrogate `id INTEGER PRIMARY KEY`, unique `(symbol, exchange)`, plus nullable `cusip TEXT` and `isin TEXT` columns users *can* fill but aren't required to. Users who want robust historical tracking (post-symbol-change) can fill the universal IDs; everyone else uses symbol+exchange.

`asset_class` is a separate column (`equity` | `etf` | `mutual_fund` | `bond` | `cash` | `crypto` | `other`), not part of identity. A symbol on different exchanges is the same asset class.

---

## S2. Positions — materialized table or always derived?

`positions` shows current holdings per account+security: quantity, cost basis, current value.

- **A. Materialized table** — recomputed on every transaction insert via a trigger or service-layer hook. Cache-invalidation problem: dividends, splits, and corrections all need to invalidate; bugs are silent and hard to detect.
- **B. Always derived** — no `positions` table. Queries compute holdings from `transactions` on demand, possibly via a SQL view for ergonomics.
- **C. Cached with explicit rebuild** — table exists but treated as cache; service exposes `rebuildPositions()` that the user can trigger from settings.

**Recommendation: B.** Single-user portfolios are tiny — a maximalist user with 30 years of weekly transactions has ~1,500 rows per account. SQLite computes the position aggregation in <1 ms at that scale. Correctness story is one-liner: *"positions = transactions, aggregated."* Move to C only if profiling demands it after we have realistic data volumes.

This means the workstreams' `positions` entry is a SQL view, not a `CREATE TABLE`. Updated table list:

`accounts`, `securities`, `transactions`, `price_history`, `cpi_data`, `dashboard_layouts`, `tile_configs`, `audit_log`, plus a `positions` view.

---

## S3. Currency

WORKSTREAMS doesn't mention multi-currency. Money is "integer cents" with no unit attached.

- **A. USD-only for v1.0** — `Money` columns are implicitly USD; no `currency_code` column.
- **B. USD-only behavior, currency_code column on transactions/positions** — default `'USD'`, no FX conversion in the financial engine, but the column exists so v1.x can add FX without a schema migration.

**Recommendation: B.** Three-character column on a few tables in exchange for not redoing the schema later. Validation rejects non-USD inserts in v1.0 with a clear error message; the moment FX support lands, validation relaxes and conversion logic plugs in.

Out of scope explicitly: FX rate tables, currency conversion in calculations, displaying converted values. Just the column.

---

## S4. Audit log shape

WORKSTREAMS §1 lists `audit_log` without prescribing structure.

- **A. Single generic table** — `entity_type TEXT`, `entity_id INTEGER`, `action TEXT` (`insert` | `update` | `delete`), `before_json TEXT`, `after_json TEXT`, `at INTEGER` (Unix epoch ms), `actor TEXT` (always `'user'` in v1.0; reserved for `'mcp'` etc. later).
- **B. Per-entity audit tables** — `transactions_audit`, `accounts_audit`, etc. Strong typing, but multiplies tables and queries.
- **C. Event-sourcing style** — full event stream with replay capability.

**Recommendation: A.** Simplest schema, supports the "show me my edit history" use case directly. The JSON blob columns are searchable enough for human review. Per-entity tables would be over-engineering for a single-user app; event sourcing is a different architectural commitment we shouldn't make implicitly.

The audit-write happens in the service layer (a wrapper around mutating Drizzle calls), not via SQL trigger — keeps the trigger surface area zero and lets us include actor / context.

---

## S5. Soft-delete enforcement

Per WORKSTREAMS invariant: every user-data table has `created_at`, `updated_at`, `deleted_at` (nullable); queries filter `deleted_at IS NULL` by default.

- **A. Drizzle query helpers** — wrapper functions (`findActive`, `findOne`, `findIncludingDeleted`) that pre-apply the `WHERE deleted_at IS NULL` predicate. Mutating helpers (`softDelete`) update `deleted_at = now()` instead of issuing `DELETE`.
- **B. SQL views** — for each table, a view named `<table>_active` that filters deleted rows. Queries write through the view; raw table is reserved for audit / migration.
- **C. Lint-only convention** — every query must explicitly include the predicate or pass `{ includeDeleted: true }`. No runtime enforcement.

**Recommendation: A.** Most ergonomic, fewest footguns. Helpers compose with Drizzle's query builder so we don't lose type safety. The wrapper module also becomes the natural place to enforce the *"every user-data table has the timestamp triple"* invariant — a unit test that walks the schema and asserts the columns exist on every table not in a known exclusion set (`cpi_data`, migration tables).

`dashboard_layouts` and `tile_configs` count as user data and get soft-delete. `cpi_data` and `price_history` don't — they're cache, refetchable from upstream, and `deleted_at` would be misleading.

---

## S6. Indexing strategy

Defer specifics to the migration files, but the query patterns drive the indexes:

- `transactions`: `(account_id, transaction_date)`, `(security_id, transaction_date)`
- `price_history`: `(security_id, price_date)` — also primary uniqueness
- `cpi_data`: `(period_date)` primary
- `audit_log`: `(entity_type, entity_id, at)` for entity history; `(at)` for chronological view
- `securities`: `(symbol, exchange)` unique; `cusip` and `isin` non-unique nullable indexes if filled
- `accounts`: small enough that no extra indexes are needed beyond PK

No covering indexes initially; add only when EXPLAIN QUERY PLAN shows full table scans on actual queries.

---

## Open questions

- **Tagging.** WORKSTREAMS §5 mentions "re-tag" as a bulk operation, and §3 calls for "allocation by custom tag". Tags need a table — proposed: `tags(id, name, color)` and `transaction_tags(transaction_id, tag_id)` join. Not in WORKSTREAMS §1's enumerated table list; flagging here.
- **`accounts.tax_treatment`.** §5 calls for "tax-treatment classification (taxable, tax-deferred, tax-free)". Add as a constrained TEXT column on `accounts` now or defer? Lean: add now — it's metadata, not a calculation, and adding later means a migration.
- **CPI series specifics.** Which CPI? CPI-U headline, chained CPI, regional? Defer to workstream 6 (price/CPI), but the column shape (`series_id`, `period_date`, `index_value`) needs to support multiple series side-by-side.

---

## Out of scope (deliberately)

- FX rate tables, multi-currency conversion (S3)
- Position cache table (S2; revisit on perf evidence)
- Per-entity audit tables, event sourcing (S4)
- Materialized aggregates / precomputed returns

---

## Decisions and rationale

Approved 2026-05-15.

- **S1 — Composite (B) with optional CUSIP/ISIN chosen.** Symbol-only (A) rejected for cross-exchange collision risk; required-CUSIP (C) rejected because most users don't know their CUSIPs and free symbol→CUSIP resolvers don't exist. Surrogate `id` PK with unique `(symbol, exchange)`; `cusip` and `isin` nullable for users who care.
- **S2 — Always derived (B) chosen.** This deviates from the WORKSTREAMS §1 enumerated table list: `positions` becomes a SQL view, not a `CREATE TABLE`. Materialized table (A) rejected for cache-invalidation risk; explicit cache (C) rejected as premature optimization given single-user portfolio sizes (<2k transactions per account).
- **S3 — `currency_code` column (B) chosen.** USD-only schema (A) rejected because adding currency later would require migrating every Money column. Validation rejects non-`'USD'` inserts in v1.0; the column exists so v1.x can plug in FX without a schema migration.
- **S4 — Single generic `audit_log` table (A) chosen.** Per-entity tables (B) rejected as over-engineering for a single-user app; event sourcing (C) rejected as a different architectural commitment we shouldn't make implicitly. Audit-write happens in the service layer wrapper, not via SQL trigger.
- **S5 — Drizzle query helpers (A) chosen.** SQL views (B) rejected for query-naming complexity; lint-only convention (C) rejected for runtime weakness. `cpi_data` and `price_history` excluded from soft-delete (cache, not user data). Helper module is the natural place to enforce the *"every user-data table has the timestamp triple"* schema invariant.
- **S6 — Index plan as proposed.** No covering indexes initially; add only on EXPLAIN-QUERY-PLAN evidence.

**Table list additions approved:**
- `positions` is a **view**, not a table (per S2).
- `tags` and `transaction_tags` added to v1.0 (per Open Questions). Required for WORKSTREAMS §3 "allocation by custom tag" and §5 "bulk re-tag".
- `accounts.tax_treatment` column added to v1.0 (per Open Questions). Constrained TEXT: `'taxable' | 'tax_deferred' | 'tax_free'`.

CPI series shape (`series_id`, `period_date`, `index_value`) reserved for workstream 6; v1.0 schema has the `cpi_data` table with that minimum shape.

No other deviations at approval time. Implementation deviations, if any, will be appended below.

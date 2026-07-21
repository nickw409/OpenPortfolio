# Data ingestion — backend slice (Workstream 5)

Status: **ratified** (2026-07-21)

Scope: the server-side half of [WORKSTREAMS.md §5 Data ingestion](../WORKSTREAMS.md).
Manual transaction entry, CSV import, account management, duplicate detection,
validation, edit/soft-delete with audit trail, and bulk operations — all as
Hono routes + a `services/` layer, tested via service and HTTP tests. **Every
UI item in WS5 is deferred to WS4** (React frontend), which is not started; the
routes here return the JSON those screens will render.

Broker API integration remains out of scope for v1.0 (WORKSTREAMS §13).

## Context

The financial engine (WS3, [specs/2026-05-18-financial-engine-slice-1.md](2026-05-18-financial-engine-slice-1.md))
is complete and pure — it consumes `Tx[]` shapes but does no I/O. WS2 stood up
the Hono skeleton (boot, health, error envelope, logging) and **deliberately
deferred** the `/accounts` and `/transactions` route groups to this workstream.
The schema ([src/backend/db/schema.ts](../../src/backend/db/schema.ts)) already
has every table this slice needs — `accounts`, `securities`, `transactions`,
`tags`, `transaction_tags`, `audit_log` — with soft-delete timestamps. This
slice is what finally *writes* transactions into the DB, so the engine can run
against real data.

There is no `services/` directory and no feature routes yet. This slice creates
both.

## Design

### Module layout

```
src/shared/schemas/
  transaction.ts      # Zod: create/edit input, TxType enum, boundary rules
  account.ts          # Zod: account input, TaxTreatment + CostBasisMethod enums
  tag.ts              # Zod: tag input + bulk re-tag payload
  csv-import.ts       # Zod: preview request, commit request

src/backend/services/
  audit.service.ts        # writeAudit({entity_type, entity_id, action, before, after})
  accounts.service.ts     # create / list / rename / archive (soft-delete)
  securities.service.ts   # resolveSecurity(symbol, …) find-or-create, symbol-first
  transactions.service.ts # canonical write path: create / edit / softDelete / bulk
  dedup.ts                # dedupKey(fields) + findDuplicates(db, …)
  history.ts              # loadTxHistory(db, account_id, security_id) -> Tx[]
  csv/
    parse.ts              # parseCsv(text) via csv-parse/sync
    presets.ts            # Fidelity / Schwab / Vanguard / IBKR maps + type normalizers
    mapping.ts            # applyMapping(rows, mapping) -> CanonicalRow[]
    import.service.ts     # previewImport / commitImport

src/backend/routes/
  accounts.ts     # /api/v1/accounts
  transactions.ts # /api/v1/transactions (+ bulk)
  tags.ts         # /api/v1/tags
  import.ts       # /api/v1/import/csv/{preview,commit}
```

Route groups are wired into [src/backend/index.ts](../../src/backend/index.ts)
next to the existing `health` group, behind the same `bootGate` middleware.

**The core idea:** `transactions.service.ts` is the *single* canonical write
path. Manual entry calls it with one row; CSV import calls the exact same
validators per row. There is never a second implementation of "sell can't
exceed holdings" or duplicate detection to drift out of sync.

### Canonical write path — `transactions.service.ts`

`createTransaction(input) -> { transaction, warnings }`:

1. **Zod boundary validation** (shared schema). `transaction_type ∈ TxType`;
   quantity positive for share-bearing types; `price_cents ≥ 0` when present and
   positive for buy/sell; `transaction_date ≤ now` (no future dates);
   `amount_cents` present and integer-cents via `MoneySchema`.
2. **Security resolution** via `securities.service.resolveSecurity` for any row
   that carries a symbol (find-or-create, symbol-first — see Decisions).
   Purely-cash events not tied to a security — `deposit`, `withdrawal`,
   `interest`, and account-level `fee` — carry `security_id = null`.
3. **Duplicate check.** Compute `dedupKey` over
   `(transaction_date, security_id, quantity, price_cents, account_id)`; query
   non-deleted rows for matches. Matches become **non-blocking warnings** in the
   response — never a rejection.
4. **Engine validation (hard reject).** Runs only for **lot-affecting** types
   (`buy`, `sell`, `split`, `transfer_in`, `transfer_out`) — the only ones that
   change the share stream. Load the full `(account, security)` transaction
   history via `history.ts`, splice the new row in date order, run `computeLots`
   with the account's `cost_basis_method`. If any sell would go negative the
   engine throws; translate to `ingestion.sell_exceeds_holdings`. Non-lot events
   (`dividend`, `interest`, `fee`, `deposit`, `withdrawal`) skip this step.
5. **Insert + audit.** In one `better-sqlite3` transaction: insert the row and
   write an `audit_log` insert row (`before = null`, `after = row`).

`editTransaction(id, patch)`: load the existing non-deleted row (before
snapshot), apply the patch, re-run steps 1–4 **with the edited row in place of
the old version**, then update in place (bump `updated_at`) and write an
`audit_log` update row (before/after).

`softDeleteTransaction(id)`: set `deleted_at`, write an `audit_log` delete row.
**Also re-runs step 4** — deleting a buy can strand a later sell.

**Full-stream revalidation.** Because a backdated or deleted buy/sell changes
the whole lot stream, step 4 revalidates the *entire* `(account, security)`
history, not just the touched row. This is O(history) per write — an accepted
cost for a local single-user app; see Decisions.

Bulk operations:
- `bulkSoftDelete(ids)` — each id revalidated; all-or-nothing in one DB
  transaction; audit row per id.
- `bulkRetag(ids, { add: tagId[], remove: tagId[] })` — mutates
  `transaction_tags`, audit row per change. No engine impact (tags don't affect
  lots).

### Security resolution — `securities.service.ts`

`resolveSecurity(symbol, { exchange?, asset_class? })`: look up an existing
security by `symbol` (ignoring exchange when none supplied); if none, insert a
minimal row (`exchange = 'UNKNOWN'`, `asset_class = 'equity'` default, editable
later). Ingestion never blocks on a missing security; WS6 (price data) or the
user enriches metadata afterward.

### Duplicate detection — `dedup.ts`

`dedupKey({ transaction_date, security_id, quantity, price_cents, account_id })`
returns a stable, field-order-insensitive string (canonical join, date reduced
to its calendar day). `findDuplicates(db, key | fields)` queries non-deleted
`transactions` for matches. Computed on the fly — **no stored hash column, no
migration** (see Decisions). Warnings only; identical rows *within* one CSV file
also flag each other.

### CSV pipeline — `services/csv/`

`parse.ts` wraps `csv-parse/sync` (new dependency) → `{ headers, rows }`, with
correct RFC-4180 quoting/embedded-newline handling.

`presets.ts` defines `BROKER_PRESETS` for Fidelity, Schwab, Vanguard, IBKR:
each maps that broker's known export headers to canonical fields
(`transaction_type`, `transaction_date`, `symbol`, `quantity`, `price`,
`amount`, `fee`, `notes`) and normalizes the broker's type vocabulary
(e.g. `"YOU BOUGHT"` → `buy`). Best-effort; the user can override the mapping.

`import.service.ts`:

- `previewImport(text, { broker | mapping, account_id })` — parse → resolve
  mapping (broker preset **or** user-supplied) → `applyMapping` → run write-path
  steps 1–4 for each row in **dry-run** (no inserts) → return per-row
  `{ status: 'ok' | 'warn' | 'error', errors, warnings, resolvedSecurity,
  isNewSecurity, isDuplicate }` plus a summary and the mapping used. **Zero DB
  writes.**
- `commitImport(text, mapping, account_id, acceptedRowIndexes)` — re-validate
  the accepted rows (guards against a stale preview). If **any** accepted row is
  `error`, reject the whole commit (`ingestion.commit_has_errors`). Otherwise
  insert every accepted row + its audit row inside **one transaction that rolls
  back entirely** on any failure. Return `{ inserted, createdSecurities,
  warnings }`.

### Account management — `accounts.service.ts`

`create` / `list` / `rename` / `archive` (soft-delete). `tax_treatment ∈
{ taxable, tax_deferred, tax_free }`, `cost_basis_method ∈ { fifo, lifo,
specific }` (default `fifo`) — both validated at the Zod boundary. Archive sets
`deleted_at` + audit row.

### Error taxonomy

Extend the existing namespaced `{ code, message, context }` envelope
([src/shared/errors.ts](../../src/shared/errors.ts)) with an `ingestion.*`
namespace, mapped to HTTP status by the existing error handler:

| Code | HTTP |
|------|------|
| `ingestion.sell_exceeds_holdings` | 409 |
| `ingestion.future_date` | 422 |
| `ingestion.invalid_quantity` / `ingestion.invalid_price` | 422 |
| `ingestion.account_not_found` / `ingestion.security_not_found` | 404 |
| `ingestion.csv_parse_failed` / `ingestion.csv_mapping_incomplete` | 400 |
| `ingestion.commit_has_errors` | 422 |

Duplicates are **warnings, never errors** — they ride in the response body, not
the error envelope.

### Testing

In-memory SQLite (`:memory:` + migrations) per service. Required cases:

- `transactions.service`: sell-exceeds hard reject; **backdated insert that
  invalidates a later sell**; dividend/cash event skips the engine; dedup
  warning is non-blocking; audit rows written on insert/edit/delete; edit
  before/after snapshots; soft-delete revalidation strands-a-sell case.
- `securities.service`: find existing by symbol; auto-create with placeholders.
- `csv/parse`: quoted fields, embedded commas, embedded newlines.
- `csv/presets`: each broker preset maps a representative sample file.
- `csv/import`: preview writes nothing; commit all-or-nothing rollback on a
  seeded failure; within-file duplicates flagged; a single `error` row blocks
  the whole commit.
- Routes: `app.request()` HTTP tests per group, mirroring
  [health.test.ts](../../src/backend/routes/health.test.ts).
- Property test (fast-check): `dedupKey` stable and field-order-insensitive.

Coverage target: 80% on `src/backend/routes/` and `src/backend/services/` per
the WORKSTREAMS invariant; services should land higher.

## Decisions and rationale

### D1 — Backend-first slice; all UI deferred to WS4

**Chosen:** build the entire ingestion backend now; defer every form/preview/UI
item to WS4.

- **A (chosen):** backend-first. Unblocks the engine end-to-end with real data,
  keeps WS5 cleanly separated from the not-started WS4, and lets us test the
  hard logic (validation, dedupe, CSV) via service/HTTP tests without a browser.
- **B — full-stack thin slice:** stand up a minimal WS4 shell first, build
  manual-entry + accounts end-to-end, defer CSV. *Rejected:* mixes two
  workstreams and front-loads UI scaffolding before the data layer is proven.
- **C — CSV-only slice:** *Rejected:* leaves manual entry and account CRUD (both
  small and needed to exercise CSV anyway) stranded in a later slice.

### D2 — Engine-backed hard reject for "sell can't exceed holdings"

**Chosen:** run `computeLots` over the affected history on every buy/sell
mutation and reject if any sell goes negative.

- **A (chosen):** engine-backed hard reject. The engine is the single source of
  truth for lots and already handles splits correctly; reusing it means the
  validation can never disagree with the position math. Cost: ingestion now
  depends on the engine, and a backdated/deleted row forces re-validation of
  downstream rows.
- **B — engine-backed warn-only:** same check, non-blocking. *Rejected:* silent
  negative holdings corrupt every downstream return/allocation; a financial
  tracker should refuse impossible states, not warn.
- **C — cheap signed-sum check:** no engine. *Rejected:* wrong across splits,
  which is exactly the case the engine exists to handle.

### D3 — Full-stream revalidation over just-the-touched-row

Because a backdated buy or a deleted buy changes the lot stream for the *whole*
`(account, security)` history, validation re-runs `computeLots` over the entire
stream, not just the new row. O(history) per write is an accepted cost for a
local single-user app; there is no concurrency and histories are small. Revisit
only if a real portfolio makes writes noticeably slow.

### D4 — Duplicate detection: warn + allow, computed on the fly

**Chosen:** compute the dedup key at insert/preview time, query existing rows,
flag matches as warnings, allow commit on user confirmation. No stored column.

- **A (chosen):** on-the-fly, warn-and-allow. Genuine same-day identical trades
  exist (dollar-cost averaging, partial fills), so a match is a *signal*, not an
  error. No schema change keeps the slice smaller.
- **B — stored `dedup_hash` column + index:** faster lookups at scale.
  *Rejected for now:* premature for single-user local data; adds a migration and
  a maintenance burden. Revisit if lookup latency ever shows up.
- **C — hard block duplicates:** *Rejected:* wrong — it forbids legitimate
  identical trades.

### D5 — CSV commit is all-or-nothing

**Chosen:** preview surfaces every error/warning; commit inserts all accepted
rows in one transaction and rolls back entirely on any failure; a single
`error` row among the accepted set blocks the whole commit.

- **A (chosen):** all-or-nothing. A half-imported statement is worse than a
  clearly-failed one — the user re-runs after fixing, rather than hunting for
  which rows silently landed.
- **B — partial commit with skip list:** *Rejected:* leaves the ledger in a
  partial state that's hard to reason about and audit.

### D6 — Edit is in-place update + audit row

**Chosen:** edits mutate the existing row and write an `audit_log` update row;
soft-delete sets `deleted_at` + audit row.

- **A (chosen):** in-place + audit. Matches the `audit_log` design, which
  already models `insert`/`update`/`delete` with before/after JSON. The engine
  sees one coherent history.
- **B — supersede (immutable rows; edit = soft-delete + insert):** *Rejected:*
  diverges from the audit_log's `update` action and multiplies the rows the
  engine must reconcile for no gain over the audit trail we already have.

### D7 — Security resolution: find-or-create, symbol-first

**Chosen:** resolve by symbol; auto-create a minimal `securities` row
(`exchange='UNKNOWN'`, `asset_class='equity'`) when none exists.

- **A (chosen):** ingestion never blocks on a missing security; CSVs rarely
  carry an exchange, so symbol-first matching is what real data needs. Metadata
  gets enriched by WS6 or the user later.
- **B — require pre-existing security:** *Rejected:* forces a securities-CRUD
  detour and heavy friction before any import can run.
- **C — find-or-create + explicit CSV resolution step:** the preview *does*
  surface new-vs-matched symbols (via `isNewSecurity`), but the confirm/edit UI
  is WS4; the backend does not block on it.

### D8 — Shared validation core, thin CSV adapter (with `csv-parse`)

**Chosen:** one canonical write path used by both manual entry and CSV;
`csv-parse/sync` for parsing.

- **A (chosen):** shared core keeps a single implementation of every rule.
  `csv-parse` is battle-tested and handles RFC-4180 edge cases (quoted fields,
  embedded newlines) we'd otherwise re-test by hand. Added as a **deliberate new
  runtime dependency**, flagged in its own commit per repo policy.
- **B — hand-rolled parser:** zero deps but re-owns a solved, footgun-prone
  problem. *Rejected:* the edge cases aren't worth re-litigating.
- **C — separate manual and CSV write paths:** *Rejected:* two implementations
  of sell-validation and dedupe that *will* drift.

## Out of scope (this slice)

- All UI: manual entry form, CSV column-mapping UI, preview table, bulk-select
  controls — WS4. The routes here return the JSON those screens render.
- Live price data / staleness — WS6.
- Broker API auto-import — permanently out of v1.0 (WORKSTREAMS §13).

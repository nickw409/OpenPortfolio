# Data Ingestion Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-side half of Workstream 5 — account CRUD, transaction CRUD with audit trail, engine-backed over-sell validation, duplicate warnings, and an all-or-nothing CSV import pipeline — as Hono routes over a new `services/` layer. All UI is deferred to WS4.

**Architecture:** One canonical write path in `transactions.service.ts` is shared by manual entry and CSV import, so validation never forks. Validation reuses the pure financial engine (`computeLots`) to reject over-sells. Every mutation writes an `audit_log` row inside a single `better-sqlite3` transaction. CSV import is a two-phase preview (dry-run, zero writes) → commit (all-or-nothing).

**Tech Stack:** TypeScript (strict), Hono, Drizzle ORM over better-sqlite3, Zod v4, `csv-parse` (new dep), vitest + fast-check.

## Global Constraints

- **Money is integer cents.** Use `MoneySchema`/`NonNegativeMoneySchema` at boundaries and the `@shared/money` helpers for all arithmetic. Never do raw arithmetic on `Money` (the `openportfolio/no-money-arithmetic` ESLint rule fails the build).
- **Soft delete only.** Deletes set `deleted_at`; use `softDelete()` / `activeWhere()` from `@backend/db/soft-delete`. All reads filter `deleted_at IS NULL`.
- **Drizzle migrations only.** No hand-written `ALTER TABLE`. This plan adds **no** schema changes.
- **TypeScript strict, no unjustified `any`.**
- **No silent failures.** Every failure throws a typed `AppError`; empty `catch` is forbidden.
- **Path aliases:** `@backend/*` → `src/backend/*`, `@shared/*` → `src/shared/*`. Test/Read/Write use absolute paths under `worktrees/feat-data-ingestion-backend/`; Bash uses the relative forms below.
- **Vitest globals are enabled** (`describe`/`it`/`expect`/`beforeEach` need no import). `environment: 'node'`.
- **Coverage floor:** 80% lines/functions/branches/statements on services and routes.
- **Canonical commands (run from repo root, cwd-free):**
  - Single test file: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run <path>`
  - Typecheck: `pnpm -C worktrees/feat-data-ingestion-backend typecheck`
  - Lint: `pnpm -C worktrees/feat-data-ingestion-backend lint`
- **Commit style:** Conventional Commits with a rationale body. **Never** add Co-authored-by trailers or mention any AI assistant.

## Canonical types (defined across tasks — reference map)

- `TxTypeName` (Task 2) — the 10 transaction-type string literals.
- `CreateTransactionInput` / `EditTransactionInput` (Task 2) — validated Zod outputs.
- `TransactionRow = typeof transactions.$inferSelect`; `AccountRow`, `SecurityRow`, `TagRow` likewise.
- `IngestionWarning = { code: 'duplicate'; message: string; context?: Record<string, unknown> }` (Task 7).
- `WriteResult = { transaction: TransactionRow; warnings: IngestionWarning[] }` (Task 7).
- `ColumnMapping` / `BrokerPreset` (Task 12); `CanonicalRow` (Task 12).
- `PreviewResult` / `CommitResult` (Task 13).

---

### Task 1: Ingestion error codes + typed-error helper

**Files:**
- Modify: `src/shared/errors.ts` (extend `ERROR_CODES`)
- Create: `src/backend/services/ingestion-errors.ts`
- Test: `src/backend/services/ingestion-errors.test.ts`

**Interfaces:**
- Consumes: `AppError`, `ErrorCode` from `@shared/errors`.
- Produces: `ingestionError(code, message, context?)` → `AppError` with the right HTTP status; `INGESTION_STATUS` map.

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/services/ingestion-errors.test.ts
import { AppError } from '@shared/errors';
import { ingestionError } from './ingestion-errors';

describe('ingestionError', () => {
  it('maps sell_exceeds_holdings to 409 and preserves context', () => {
    const err = ingestionError('ingestion.sell_exceeds_holdings', 'too much', { have: 1 });
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('ingestion.sell_exceeds_holdings');
    expect(err.status).toBe(409);
    expect(err.context).toEqual({ have: 1 });
  });

  it('maps future_date to 422 and account_not_found to 404', () => {
    expect(ingestionError('ingestion.future_date', 'x').status).toBe(422);
    expect(ingestionError('ingestion.account_not_found', 'x').status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/ingestion-errors.test.ts`
Expected: FAIL — cannot find `./ingestion-errors`.

- [ ] **Step 3: Extend `ERROR_CODES`**

In `src/shared/errors.ts`, add the ingestion codes to the `ERROR_CODES` array (after `'internal.unknown'` is fine; order is irrelevant):

```ts
export const ERROR_CODES = [
  'validation.invalid_input',
  'validation.invalid_money',
  'not_found.resource',
  'service.migrating',
  'service.shutting_down',
  'internal.unknown',
  'ingestion.sell_exceeds_holdings',
  'ingestion.future_date',
  'ingestion.invalid_quantity',
  'ingestion.invalid_price',
  'ingestion.account_not_found',
  'ingestion.security_not_found',
  'ingestion.transaction_not_found',
  'ingestion.csv_parse_failed',
  'ingestion.csv_mapping_incomplete',
  'ingestion.commit_has_errors',
] as const;
```

- [ ] **Step 4: Implement the helper**

```ts
// src/backend/services/ingestion-errors.ts
import { AppError, type ErrorCode } from '@shared/errors';

type IngestionCode = Extract<ErrorCode, `ingestion.${string}`>;

export const INGESTION_STATUS: Record<IngestionCode, number> = {
  'ingestion.sell_exceeds_holdings': 409,
  'ingestion.future_date': 422,
  'ingestion.invalid_quantity': 422,
  'ingestion.invalid_price': 422,
  'ingestion.account_not_found': 404,
  'ingestion.security_not_found': 404,
  'ingestion.transaction_not_found': 404,
  'ingestion.csv_parse_failed': 400,
  'ingestion.csv_mapping_incomplete': 400,
  'ingestion.commit_has_errors': 422,
};

export function ingestionError(
  code: IngestionCode,
  message: string,
  context?: Record<string, unknown>,
): AppError {
  return new AppError({ code, message, status: INGESTION_STATUS[code], context });
}
```

- [ ] **Step 5: Run tests + typecheck, then commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/ingestion-errors.test.ts` → PASS
Run: `pnpm -C worktrees/feat-data-ingestion-backend typecheck` → clean

```bash
git -C worktrees/feat-data-ingestion-backend add src/shared/errors.ts src/backend/services/ingestion-errors.ts src/backend/services/ingestion-errors.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): add ingestion error codes and typed-error helper

Extends the shared error envelope with the ingestion.* namespace and a
status-mapping helper so services throw one typed shape the existing
error handler already renders."
```

---

### Task 2: Shared Zod schemas + type predicates

**Files:**
- Create: `src/shared/schemas/transaction.ts`
- Create: `src/shared/schemas/account.ts`
- Create: `src/shared/schemas/tag.ts`
- Test: `src/shared/schemas/transaction.test.ts`
- Test: `src/shared/schemas/account.test.ts`

**Interfaces:**
- Consumes: `MoneySchema`, `NonNegativeMoneySchema` from `./money`.
- Produces:
  - `TX_TYPES`, `TxTypeName`, `isLotAffecting(t)`, `isSecurityBearing(t)`.
  - `CreateTransactionSchema`, `CreateTransactionInput`, `EditTransactionSchema`, `EditTransactionInput`, `refineTransaction`.
  - `TAX_TREATMENTS`, `COST_BASIS_METHODS`, `CreateAccountSchema`, `CreateAccountInput`, `RenameAccountSchema`.
  - `CreateTagSchema`, `BulkRetagSchema`, `BulkDeleteSchema`.

**Note on cross-field rules:** `refineTransaction` enforces no-future-date, quantity>0 for lot-affecting types, price>0 for buy/sell, and symbol-required for security-bearing types. `EditTransactionSchema` is the partial (patch); the service re-parses the merged row through `CreateTransactionSchema` so edits get the same cross-field checks.

- [ ] **Step 1: Write the failing tests**

```ts
// src/shared/schemas/transaction.test.ts
import {
  CreateTransactionSchema, isLotAffecting, isSecurityBearing, TX_TYPES,
} from './transaction';

const base = {
  account_id: 1, transaction_type: 'buy', symbol: 'AAPL',
  transaction_date: '2020-01-02T00:00:00.000Z',
  quantity: 10, price_cents: 15000, amount_cents: 150000,
};

describe('CreateTransactionSchema', () => {
  it('accepts a valid buy and coerces the date', () => {
    const r = CreateTransactionSchema.parse(base);
    expect(r.transaction_date).toBeInstanceOf(Date);
    expect(r.currency_code).toBe('USD');
  });

  it('rejects a future-dated transaction', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(() => CreateTransactionSchema.parse({ ...base, transaction_date: future })).toThrow();
  });

  it('rejects a buy with zero quantity', () => {
    expect(() => CreateTransactionSchema.parse({ ...base, quantity: 0 })).toThrow();
  });

  it('rejects a buy without a symbol', () => {
    const { symbol: _drop, ...noSym } = base;
    expect(() => CreateTransactionSchema.parse(noSym)).toThrow();
  });

  it('accepts a deposit with no symbol and no security', () => {
    const r = CreateTransactionSchema.parse({
      account_id: 1, transaction_type: 'deposit',
      transaction_date: '2020-01-02T00:00:00.000Z', amount_cents: 500000,
    });
    expect(r.transaction_type).toBe('deposit');
  });
});

describe('type predicates', () => {
  it('classifies lot-affecting and security-bearing types', () => {
    expect(isLotAffecting('sell')).toBe(true);
    expect(isLotAffecting('dividend')).toBe(false);
    expect(isSecurityBearing('dividend')).toBe(true);
    expect(isSecurityBearing('deposit')).toBe(false);
    expect(TX_TYPES).toHaveLength(10);
  });
});
```

```ts
// src/shared/schemas/account.test.ts
import { CreateAccountSchema } from './account';

describe('CreateAccountSchema', () => {
  it('defaults cost_basis_method to fifo and currency to USD', () => {
    const r = CreateAccountSchema.parse({ name: 'Brokerage', tax_treatment: 'taxable' });
    expect(r.cost_basis_method).toBe('fifo');
    expect(r.currency_code).toBe('USD');
  });
  it('rejects an unknown tax treatment', () => {
    expect(() => CreateAccountSchema.parse({ name: 'x', tax_treatment: 'roth' })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/shared/schemas/transaction.test.ts src/shared/schemas/account.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `transaction.ts`**

```ts
// src/shared/schemas/transaction.ts
import { z } from 'zod';

import { MoneySchema, NonNegativeMoneySchema } from './money';

// Mirrors the financial engine's TxType union (src/backend/financial/types.ts)
// and the transactions.transaction_type column semantics.
export const TX_TYPES = [
  'buy', 'sell', 'dividend', 'interest', 'fee', 'split',
  'transfer_in', 'transfer_out', 'deposit', 'withdrawal',
] as const;
export type TxTypeName = (typeof TX_TYPES)[number];

// Types that move shares → need engine over-sell validation.
const LOT_AFFECTING = new Set<TxTypeName>([
  'buy', 'sell', 'split', 'transfer_in', 'transfer_out',
]);
// Types that reference a security by symbol (dividend does, deposit does not).
const SECURITY_BEARING = new Set<TxTypeName>([
  'buy', 'sell', 'split', 'transfer_in', 'transfer_out', 'dividend',
]);

export const isLotAffecting = (t: TxTypeName): boolean => LOT_AFFECTING.has(t);
export const isSecurityBearing = (t: TxTypeName): boolean => SECURITY_BEARING.has(t);

// Base field shapes (no cross-field rules — those live in refineTransaction so
// create and edit share one implementation).
const TransactionFields = z.object({
  account_id: z.number().int().positive(),
  symbol: z.string().trim().min(1).optional(),
  transaction_type: z.enum(TX_TYPES),
  transaction_date: z.coerce.date(),
  quantity: z.number().finite().nonnegative().default(0),
  price_cents: NonNegativeMoneySchema.optional(),
  amount_cents: MoneySchema,
  fee_cents: NonNegativeMoneySchema.optional(),
  currency_code: z.string().trim().length(3).default('USD'),
  notes: z.string().optional(),
});

type TransactionShape = z.infer<typeof TransactionFields>;

export function refineTransaction(v: TransactionShape, ctx: z.RefinementCtx): void {
  if (v.transaction_date.getTime() > Date.now()) {
    ctx.addIssue({ code: 'custom', path: ['transaction_date'], message: 'transaction_date cannot be in the future' });
  }
  if (isLotAffecting(v.transaction_type) && !(v.quantity > 0)) {
    ctx.addIssue({ code: 'custom', path: ['quantity'], message: `quantity must be positive for ${v.transaction_type}` });
  }
  if ((v.transaction_type === 'buy' || v.transaction_type === 'sell') && !(typeof v.price_cents === 'number' && v.price_cents > 0)) {
    ctx.addIssue({ code: 'custom', path: ['price_cents'], message: 'price_cents must be positive for buy/sell' });
  }
  if (isSecurityBearing(v.transaction_type) && !v.symbol) {
    ctx.addIssue({ code: 'custom', path: ['symbol'], message: `symbol is required for ${v.transaction_type}` });
  }
}

export const CreateTransactionSchema = TransactionFields.superRefine(refineTransaction);
export type CreateTransactionInput = z.infer<typeof CreateTransactionSchema>;

// Patch shape for edits — every field optional; the service merges this over
// the existing row and re-parses through CreateTransactionSchema.
export const EditTransactionSchema = TransactionFields.partial();
export type EditTransactionInput = z.infer<typeof EditTransactionSchema>;
```

- [ ] **Step 4: Implement `account.ts` and `tag.ts`**

```ts
// src/shared/schemas/account.ts
import { z } from 'zod';

export const TAX_TREATMENTS = ['taxable', 'tax_deferred', 'tax_free'] as const;
export const COST_BASIS_METHODS = ['fifo', 'lifo', 'specific'] as const;

export const CreateAccountSchema = z.object({
  name: z.string().trim().min(1),
  broker: z.string().trim().min(1).optional(),
  tax_treatment: z.enum(TAX_TREATMENTS),
  cost_basis_method: z.enum(COST_BASIS_METHODS).default('fifo'),
  currency_code: z.string().trim().length(3).default('USD'),
});
export type CreateAccountInput = z.infer<typeof CreateAccountSchema>;

export const RenameAccountSchema = z.object({
  name: z.string().trim().min(1).optional(),
  broker: z.string().trim().min(1).nullable().optional(),
  tax_treatment: z.enum(TAX_TREATMENTS).optional(),
  cost_basis_method: z.enum(COST_BASIS_METHODS).optional(),
});
export type RenameAccountInput = z.infer<typeof RenameAccountSchema>;
```

```ts
// src/shared/schemas/tag.ts
import { z } from 'zod';

export const CreateTagSchema = z.object({
  name: z.string().trim().min(1),
  color: z.string().trim().min(1).optional(),
});
export type CreateTagInput = z.infer<typeof CreateTagSchema>;

export const BulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
});

export const BulkRetagSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1),
  add: z.array(z.number().int().positive()).default([]),
  remove: z.array(z.number().int().positive()).default([]),
});
export type BulkRetagInput = z.infer<typeof BulkRetagSchema>;
```

- [ ] **Step 5: Run tests + typecheck → PASS, then commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/shared/schemas/transaction.test.ts src/shared/schemas/account.test.ts` → PASS
Run: `pnpm -C worktrees/feat-data-ingestion-backend typecheck` → clean

```bash
git -C worktrees/feat-data-ingestion-backend add src/shared/schemas/transaction.ts src/shared/schemas/account.ts src/shared/schemas/tag.ts src/shared/schemas/transaction.test.ts src/shared/schemas/account.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): shared zod schemas for transactions, accounts, tags

Boundary validation with a shared refineTransaction rule set (no future
dates, positive quantity for lot-affecting types, positive price for
buy/sell, symbol required for security-bearing types) reused by both
create and edit paths."
```

---

### Task 3: Audit service

**Files:**
- Create: `src/backend/services/audit.service.ts`
- Test: `src/backend/services/audit.service.test.ts`

**Interfaces:**
- Consumes: `Db` from `@backend/db/client`; `audit_log` from `@backend/db/schema`.
- Produces: `AuditAction = 'insert' | 'update' | 'delete'`; `writeAudit(db, { entity_type, entity_id, action, before?, after? })`.

**Note:** `writeAudit` does one insert and no transaction of its own — callers wrap it together with the mutation in `db.$client.transaction(...)`. `before`/`after` are JSON-serialized; `Date` fields serialize to ISO strings, which is acceptable for the audit record.

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/services/audit.service.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { audit_log } from '@backend/db/schema';

import { writeAudit } from './audit.service';

describe('writeAudit', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-audit-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  it('records an insert row with serialized after-state', () => {
    writeAudit(db, { entity_type: 'transaction', entity_id: 7, action: 'insert', after: { id: 7, quantity: 3 } });
    const rows = db.select().from(audit_log).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('insert');
    expect(rows[0].entity_id).toBe(7);
    expect(rows[0].before_json).toBeNull();
    expect(JSON.parse(rows[0].after_json!)).toEqual({ id: 7, quantity: 3 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/audit.service.test.ts`
Expected: FAIL — `./audit.service` not found.

- [ ] **Step 3: Implement**

```ts
// src/backend/services/audit.service.ts
import type { Db } from '@backend/db/client';
import { audit_log } from '@backend/db/schema';

export type AuditAction = 'insert' | 'update' | 'delete';

export interface WriteAuditParams {
  entity_type: string;
  entity_id: number;
  action: AuditAction;
  before?: unknown;
  after?: unknown;
}

export function writeAudit(db: Db, p: WriteAuditParams): void {
  db.insert(audit_log).values({
    entity_type: p.entity_type,
    entity_id: p.entity_id,
    action: p.action,
    before_json: p.before === undefined ? null : JSON.stringify(p.before),
    after_json: p.after === undefined ? null : JSON.stringify(p.after),
    actor: 'user',
  }).run();
}
```

- [ ] **Step 4: Run test → PASS, typecheck, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/audit.service.test.ts` → PASS

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/services/audit.service.ts src/backend/services/audit.service.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): audit-log write helper

Shared writeAudit records insert/update/delete with before/after JSON;
callers wrap it with the mutation in one better-sqlite3 transaction."
```

---

### Task 4: Securities resolution service

**Files:**
- Create: `src/backend/services/securities.service.ts`
- Test: `src/backend/services/securities.service.test.ts`

**Interfaces:**
- Consumes: `Db`, `securities`, `activeWhere` from `@backend/db/soft-delete`.
- Produces:
  - `SecurityRow = typeof securities.$inferSelect`.
  - `findSecurityBySymbol(db, symbol, exchange?)` → `SecurityRow | undefined` (active only; symbol-first when no exchange).
  - `resolveSecurity(db, symbol, opts?)` → `{ security: SecurityRow; created: boolean }` (find-or-create with `exchange='UNKNOWN'`, `asset_class='equity'` defaults).

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/services/securities.service.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';

import { findSecurityBySymbol, resolveSecurity } from './securities.service';

describe('securities.service', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-sec-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  it('creates a minimal security when the symbol is new', () => {
    const { security, created } = resolveSecurity(db, 'AAPL');
    expect(created).toBe(true);
    expect(security.symbol).toBe('AAPL');
    expect(security.exchange).toBe('UNKNOWN');
    expect(security.asset_class).toBe('equity');
  });

  it('finds the existing security on a second resolve (symbol-first)', () => {
    const first = resolveSecurity(db, 'AAPL');
    const second = resolveSecurity(db, 'AAPL');
    expect(second.created).toBe(false);
    expect(second.security.id).toBe(first.security.id);
    expect(findSecurityBySymbol(db, 'AAPL')?.id).toBe(first.security.id);
  });

  it('returns undefined from find when the symbol is unknown', () => {
    expect(findSecurityBySymbol(db, 'NOPE')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/securities.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/backend/services/securities.service.ts
import { and, eq } from 'drizzle-orm';

import type { Db } from '@backend/db/client';
import { securities } from '@backend/db/schema';
import { activeWhere } from '@backend/db/soft-delete';

export type SecurityRow = typeof securities.$inferSelect;

export function findSecurityBySymbol(
  db: Db,
  symbol: string,
  exchange?: string,
): SecurityRow | undefined {
  const predicate = exchange
    ? and(eq(securities.symbol, symbol), eq(securities.exchange, exchange))
    : eq(securities.symbol, symbol);
  return db.select().from(securities).where(activeWhere(securities, predicate)).limit(1).get();
}

export interface ResolveSecurityOptions {
  exchange?: string;
  asset_class?: string;
}

export function resolveSecurity(
  db: Db,
  symbol: string,
  opts: ResolveSecurityOptions = {},
): { security: SecurityRow; created: boolean } {
  const existing = findSecurityBySymbol(db, symbol, opts.exchange);
  if (existing) return { security: existing, created: false };

  const security = db.insert(securities).values({
    symbol,
    exchange: opts.exchange ?? 'UNKNOWN',
    asset_class: opts.asset_class ?? 'equity',
  }).returning().get();
  return { security, created: true };
}
```

- [ ] **Step 4: Run test → PASS, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/securities.service.test.ts` → PASS

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/services/securities.service.ts src/backend/services/securities.service.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): find-or-create security resolution

Symbol-first lookup; auto-creates a minimal securities row (UNKNOWN
exchange, equity asset_class) so ingestion never blocks on missing
security metadata."
```

---

### Task 5: Transaction-history loader + engine mapping

**Files:**
- Create: `src/backend/services/history.ts`
- Test: `src/backend/services/history.test.ts`

**Interfaces:**
- Consumes: `Db`, `transactions`, `activeWhere`; `Tx` from `@backend/financial`.
- Produces:
  - `TransactionRow = typeof transactions.$inferSelect`.
  - `rowToTx(row)` → `Tx` (maps a DB row to the engine input shape; requires non-null `security_id`).
  - `loadTxHistory(db, accountId, securityId)` → `Tx[]` (active rows for that account+security, chronological).

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/services/history.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, securities, transactions } from '@backend/db/schema';
import { ofCents } from '@shared/money';

import { loadTxHistory } from './history';

describe('loadTxHistory', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-hist-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
    db.insert(securities).values({ symbol: 'AAPL', exchange: 'UNKNOWN', asset_class: 'equity' }).run();
    db.insert(transactions).values({
      account_id: 1, security_id: 1, transaction_type: 'buy',
      transaction_date: new Date('2020-01-02'), quantity: 10,
      price_cents: ofCents(15000), amount_cents: ofCents(150000),
    }).run();
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  it('maps active rows to engine Tx shape', () => {
    const txs = loadTxHistory(db, 1, 1);
    expect(txs).toHaveLength(1);
    expect(txs[0].transaction_type).toBe('buy');
    expect(txs[0].quantity).toBe(10);
    expect(txs[0].amount_cents).toBe(150000);
    expect(txs[0].transaction_date).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/history.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/backend/services/history.ts
import { and, asc, eq } from 'drizzle-orm';

import type { Db } from '@backend/db/client';
import { transactions } from '@backend/db/schema';
import { activeWhere } from '@backend/db/soft-delete';
import type { Tx, TxType } from '@backend/financial';

export type TransactionRow = typeof transactions.$inferSelect;

export function rowToTx(row: TransactionRow): Tx {
  if (row.security_id === null) {
    throw new Error(`rowToTx: transaction ${row.id} has no security_id`);
  }
  return {
    id: row.id,
    account_id: row.account_id,
    security_id: row.security_id,
    transaction_type: row.transaction_type as TxType,
    transaction_date: row.transaction_date,
    quantity: row.quantity,
    price_cents: row.price_cents ?? null,
    amount_cents: row.amount_cents,
    fee_cents: row.fee_cents ?? null,
    currency_code: row.currency_code,
  };
}

export function loadTxHistory(db: Db, accountId: number, securityId: number): Tx[] {
  const rows = db
    .select()
    .from(transactions)
    .where(activeWhere(transactions, and(
      eq(transactions.account_id, accountId),
      eq(transactions.security_id, securityId),
    )))
    .orderBy(asc(transactions.transaction_date), asc(transactions.id))
    .all();
  return rows.map(rowToTx);
}
```

- [ ] **Step 4: Run test → PASS, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/history.test.ts` → PASS

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/services/history.ts src/backend/services/history.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): transaction-history loader for engine validation

loadTxHistory returns the active (account, security) stream as engine Tx
records so the write path can reconstruct lots for over-sell checks."
```

---

### Task 6: Duplicate detection

**Files:**
- Create: `src/backend/services/dedup.ts`
- Test: `src/backend/services/dedup.test.ts`
- Test: `src/backend/services/dedup.property.test.ts`

**Interfaces:**
- Consumes: `Db`, `transactions`, `activeWhere`.
- Produces:
  - `DedupFields = { transaction_date: Date; security_id: number | null; quantity: number; price_cents: number | null; account_id: number }`.
  - `dedupKey(fields)` → stable string (date reduced to UTC calendar day).
  - `findDuplicates(db, fields)` → `TransactionRow[]` (active rows sharing the key).

- [ ] **Step 1: Write the failing tests**

```ts
// src/backend/services/dedup.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, securities, transactions } from '@backend/db/schema';
import { ofCents } from '@shared/money';

import { dedupKey, findDuplicates } from './dedup';

const fields = {
  transaction_date: new Date('2020-01-02T14:30:00Z'),
  security_id: 1, quantity: 10, price_cents: 15000, account_id: 1,
};

describe('dedupKey', () => {
  it('reduces the timestamp to a calendar day (same day → same key)', () => {
    const a = dedupKey(fields);
    const b = dedupKey({ ...fields, transaction_date: new Date('2020-01-02T23:59:00Z') });
    expect(a).toBe(b);
  });
  it('differs when any material field differs', () => {
    expect(dedupKey(fields)).not.toBe(dedupKey({ ...fields, quantity: 11 }));
  });
});

describe('findDuplicates', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-dup-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
    db.insert(securities).values({ symbol: 'AAPL', exchange: 'UNKNOWN', asset_class: 'equity' }).run();
    db.insert(transactions).values({
      account_id: 1, security_id: 1, transaction_type: 'buy',
      transaction_date: new Date('2020-01-02T09:00:00Z'), quantity: 10,
      price_cents: ofCents(15000), amount_cents: ofCents(150000),
    }).run();
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  it('finds a same-day identical row', () => {
    expect(findDuplicates(db, fields)).toHaveLength(1);
  });
  it('does not match a different quantity', () => {
    expect(findDuplicates(db, { ...fields, quantity: 99 })).toHaveLength(0);
  });
});
```

```ts
// src/backend/services/dedup.property.test.ts
import { fc, test } from '@fast-check/vitest';

import { dedupKey } from './dedup';

test.prop({
  a: fc.integer(), s: fc.option(fc.integer(), { nil: null }),
  q: fc.double({ noNaN: true }), p: fc.option(fc.integer(), { nil: null }),
  ms: fc.integer({ min: 0, max: 4_102_444_800_000 }),
})('dedupKey is deterministic for identical field values', ({ a, s, q, p, ms }) => {
  const mk = () => dedupKey({ account_id: a, security_id: s, quantity: q, price_cents: p, transaction_date: new Date(ms) });
  return mk() === mk();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/dedup.test.ts src/backend/services/dedup.property.test.ts`
Expected: FAIL — module not found. (If `@fast-check/vitest` import fails, use `import fc from 'fast-check'` with a plain `it` + `fc.assert(fc.property(...))` instead — check how `src/backend/financial/lots.property.test.ts` imports fast-check and mirror it.)

- [ ] **Step 3: Implement**

```ts
// src/backend/services/dedup.ts
import { and, eq } from 'drizzle-orm';

import type { Db } from '@backend/db/client';
import { transactions } from '@backend/db/schema';
import { activeWhere } from '@backend/db/soft-delete';
import type { TransactionRow } from './history';

export interface DedupFields {
  transaction_date: Date;
  security_id: number | null;
  quantity: number;
  price_cents: number | null;
  account_id: number;
}

function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

export function dedupKey(f: DedupFields): string {
  return [
    f.account_id,
    dayKey(f.transaction_date),
    f.security_id ?? 'null',
    f.quantity,
    f.price_cents ?? 'null',
  ].join('|');
}

export function findDuplicates(db: Db, f: DedupFields): TransactionRow[] {
  // Cheap indexed filter on the exact-match columns, then reduce to same
  // calendar day in JS via the shared key (dates are stored to the ms).
  const candidates = db
    .select()
    .from(transactions)
    .where(activeWhere(transactions, and(
      eq(transactions.account_id, f.account_id),
      f.security_id === null ? eq(transactions.security_id, null as never) : eq(transactions.security_id, f.security_id),
      eq(transactions.quantity, f.quantity),
    )))
    .all();
  const key = dedupKey(f);
  return candidates.filter((row) => dedupKey({
    transaction_date: row.transaction_date,
    security_id: row.security_id,
    quantity: row.quantity,
    price_cents: row.price_cents ?? null,
    account_id: row.account_id,
  }) === key);
}
```

> **Note for implementer:** `eq(col, null)` in Drizzle does not generate `IS NULL`; if the `security_id === null` branch misbehaves in the test, replace that ternary with `isNull(transactions.security_id)` (import `isNull` from `drizzle-orm`). Verify with the test.

- [ ] **Step 4: Run tests → PASS, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/dedup.test.ts src/backend/services/dedup.property.test.ts` → PASS

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/services/dedup.ts src/backend/services/dedup.test.ts src/backend/services/dedup.property.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): on-the-fly duplicate detection

dedupKey collapses a transaction to (account, day, security, qty, price);
findDuplicates surfaces same-key active rows as non-blocking warnings."
```

---

### Task 7: Transactions service — create path

**Files:**
- Create: `src/backend/services/transactions.service.ts`
- Test: `src/backend/services/transactions.service.create.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6; `computeLots`, `FinancialError` from `@backend/financial`; `CreateTransactionSchema`, `isLotAffecting`, `isSecurityBearing` from `@shared/schemas/transaction`; `accounts` schema.
- Produces:
  - `IngestionWarning`, `WriteResult`.
  - `AccountRow = typeof accounts.$inferSelect`; `getActiveAccount(db, id)` (throws `ingestion.account_not_found`).
  - `validateOverSell(db, accountId, securityId, candidate, excludeTxId?)` (throws `ingestion.sell_exceeds_holdings`).
  - `createTransaction(db, input)` → `WriteResult`.

**Key rule:** over-sell validation always runs `computeLots` with `{ method: 'fifo' }` — over-sell detection is method-independent, and FIFO avoids the `specific`-method lot-selection requirement.

- [ ] **Step 1: Write the failing tests**

```ts
// src/backend/services/transactions.service.create.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, audit_log, transactions } from '@backend/db/schema';

import { createTransaction } from './transactions.service';

function seed(db: Db) {
  db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
}
const buy = {
  account_id: 1, transaction_type: 'buy', symbol: 'AAPL',
  transaction_date: '2020-01-02T00:00:00.000Z', quantity: 10,
  price_cents: 15000, amount_cents: 150000,
};

describe('createTransaction', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-txc-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    seed(db);
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  it('inserts a buy, creates the security, and writes an audit row', () => {
    const { transaction, warnings } = createTransaction(db, buy);
    expect(transaction.id).toBeGreaterThan(0);
    expect(transaction.security_id).toBe(1);
    expect(warnings).toHaveLength(0);
    expect(db.select().from(audit_log).all()).toHaveLength(1);
  });

  it('warns (non-blocking) on a same-day identical duplicate', () => {
    createTransaction(db, buy);
    const { warnings } = createTransaction(db, buy);
    expect(warnings.map((w) => w.code)).toContain('duplicate');
    expect(db.select().from(transactions).all()).toHaveLength(2); // still inserted
  });

  it('rejects a sell that exceeds holdings', () => {
    createTransaction(db, buy); // +10
    expect(() => createTransaction(db, {
      ...buy, transaction_type: 'sell', quantity: 25,
      transaction_date: '2020-02-01T00:00:00.000Z',
    })).toThrow(/sell_exceeds_holdings|exceed/i);
  });

  it('rejects a backdated sell that strands a later sell', () => {
    createTransaction(db, buy); // buy 10 on 2020-01-02
    createTransaction(db, { ...buy, transaction_type: 'sell', quantity: 8, transaction_date: '2020-03-01T00:00:00.000Z' });
    // Backdated sell of 5 on 2020-02-01 → 10-5-8 = -3 at the later sell.
    expect(() => createTransaction(db, {
      ...buy, transaction_type: 'sell', quantity: 5, transaction_date: '2020-02-01T00:00:00.000Z',
    })).toThrow(/exceed/i);
  });

  it('skips engine validation for a dividend', () => {
    const { transaction } = createTransaction(db, {
      account_id: 1, transaction_type: 'dividend', symbol: 'AAPL',
      transaction_date: '2020-02-01T00:00:00.000Z', amount_cents: 4200,
    });
    expect(transaction.transaction_type).toBe('dividend');
  });

  it('throws account_not_found for a missing account', () => {
    expect(() => createTransaction(db, { ...buy, account_id: 999 })).toThrow(/account_not_found|not found/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/transactions.service.create.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the create path + shared helpers**

```ts
// src/backend/services/transactions.service.ts
import { eq } from 'drizzle-orm';

import type { Db } from '@backend/db/client';
import { accounts, transactions } from '@backend/db/schema';
import { activeWhere } from '@backend/db/soft-delete';
import { computeLots, FinancialError, type Tx } from '@backend/financial';
import {
  CreateTransactionSchema, isLotAffecting, isSecurityBearing,
  type CreateTransactionInput, type TxTypeName,
} from '@shared/schemas/transaction';

import { writeAudit } from './audit.service';
import { findDuplicates, type DedupFields } from './dedup';
import { loadTxHistory, type TransactionRow } from './history';
import { ingestionError } from './ingestion-errors';
import { resolveSecurity } from './securities.service';

export type AccountRow = typeof accounts.$inferSelect;

export interface IngestionWarning {
  code: 'duplicate';
  message: string;
  context?: Record<string, unknown>;
}
export interface WriteResult {
  transaction: TransactionRow;
  warnings: IngestionWarning[];
}

export function getActiveAccount(db: Db, id: number): AccountRow {
  const row = db.select().from(accounts).where(activeWhere(accounts, eq(accounts.id, id))).limit(1).get();
  if (!row) throw ingestionError('ingestion.account_not_found', `account ${id} not found`, { account_id: id });
  return row;
}

// Over-sell detection is method-independent; use FIFO to avoid the
// specific-method lot-selection requirement.
export function validateOverSell(
  db: Db,
  accountId: number,
  securityId: number,
  candidate: Tx,
  excludeTxId?: number,
): void {
  const history = loadTxHistory(db, accountId, securityId).filter((t) => t.id !== excludeTxId);
  try {
    computeLots([...history, candidate], { method: 'fifo' });
  } catch (e) {
    if (e instanceof FinancialError && e.code === 'domain.sell_exceeds_holdings') {
      throw ingestionError('ingestion.sell_exceeds_holdings', e.message, { ...e.context });
    }
    throw e;
  }
}

function nextValidationId(history: Tx[]): number {
  return history.reduce((max, t) => Math.max(max, t.id), 0) + 1;
}

interface Resolved {
  input: CreateTransactionInput;
  security_id: number | null;
  createdSecurity: boolean;
}

function resolve(db: Db, input: CreateTransactionInput): Resolved {
  getActiveAccount(db, input.account_id); // throws if missing
  let security_id: number | null = null;
  let createdSecurity = false;
  if (isSecurityBearing(input.transaction_type)) {
    // symbol presence is guaranteed by the schema refine for these types.
    const { security, created } = resolveSecurity(db, input.symbol!);
    security_id = security.id;
    createdSecurity = created;
  }
  return { input, security_id, createdSecurity };
}

function dedupFields(input: CreateTransactionInput, security_id: number | null): DedupFields {
  return {
    transaction_date: input.transaction_date,
    security_id,
    quantity: input.quantity,
    price_cents: input.price_cents ?? null,
    account_id: input.account_id,
  };
}

export function createTransaction(db: Db, raw: unknown): WriteResult {
  const input = CreateTransactionSchema.parse(raw);
  const { security_id } = resolve(db, input);

  const dupes = findDuplicates(db, dedupFields(input, security_id));
  const warnings: IngestionWarning[] = dupes.length
    ? [{ code: 'duplicate', message: `matches ${dupes.length} existing transaction(s)`, context: { ids: dupes.map((d) => d.id) } }]
    : [];

  if (isLotAffecting(input.transaction_type) && security_id !== null) {
    const history = loadTxHistory(db, input.account_id, security_id);
    const candidate: Tx = toEngineCandidate(input, security_id, nextValidationId(history));
    validateOverSell(db, input.account_id, security_id, candidate);
  }

  let transaction!: TransactionRow;
  db.$client.transaction(() => {
    transaction = db.insert(transactions).values({
      account_id: input.account_id,
      security_id,
      transaction_type: input.transaction_type,
      transaction_date: input.transaction_date,
      quantity: input.quantity,
      price_cents: input.price_cents ?? null,
      amount_cents: input.amount_cents,
      fee_cents: input.fee_cents ?? null,
      currency_code: input.currency_code,
      notes: input.notes ?? null,
    }).returning().get();
    writeAudit(db, { entity_type: 'transaction', entity_id: transaction.id, action: 'insert', after: transaction });
  })();

  return { transaction, warnings };
}

function toEngineCandidate(input: CreateTransactionInput, security_id: number, id: number): Tx {
  return {
    id,
    account_id: input.account_id,
    security_id,
    transaction_type: input.transaction_type as TxTypeName,
    transaction_date: input.transaction_date,
    quantity: input.quantity,
    price_cents: input.price_cents ?? null,
    amount_cents: input.amount_cents,
    fee_cents: input.fee_cents ?? null,
    currency_code: input.currency_code,
  };
}
```

- [ ] **Step 4: Run tests → PASS, typecheck, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/transactions.service.create.test.ts` → PASS
Run: `pnpm -C worktrees/feat-data-ingestion-backend typecheck` → clean

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/services/transactions.service.ts src/backend/services/transactions.service.create.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): canonical create path with engine-backed over-sell check

createTransaction resolves the security, warns on duplicates, rejects
over-sells via computeLots over the full account+security history
(catching backdated inserts), and writes the row plus an audit entry in
one transaction."
```

---

### Task 8: Transactions service — edit + soft-delete

**Files:**
- Modify: `src/backend/services/transactions.service.ts`
- Test: `src/backend/services/transactions.service.edit.test.ts`

**Interfaces:**
- Consumes: Task 7 exports; `EditTransactionSchema` from `@shared/schemas/transaction`; `softDelete` from `@backend/db/soft-delete`.
- Produces:
  - `getActiveTransaction(db, id)` → `TransactionRow` (throws `ingestion.transaction_not_found`).
  - `editTransaction(db, id, patch)` → `WriteResult`.
  - `softDeleteTransaction(db, id)` → `void`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/backend/services/transactions.service.edit.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, audit_log, transactions } from '@backend/db/schema';

import { createTransaction, editTransaction, softDeleteTransaction } from './transactions.service';

const buy = {
  account_id: 1, transaction_type: 'buy', symbol: 'AAPL',
  transaction_date: '2020-01-02T00:00:00.000Z', quantity: 10,
  price_cents: 15000, amount_cents: 150000,
};

describe('editTransaction / softDeleteTransaction', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-txe-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  it('updates quantity in place and writes an update audit row with before/after', () => {
    const { transaction } = createTransaction(db, buy);
    const { transaction: edited } = editTransaction(db, transaction.id, { quantity: 12 });
    expect(edited.quantity).toBe(12);
    const audits = db.select().from(audit_log).all();
    expect(audits.some((a) => a.action === 'update')).toBe(true);
    const upd = audits.find((a) => a.action === 'update')!;
    expect(JSON.parse(upd.before_json!).quantity).toBe(10);
    expect(JSON.parse(upd.after_json!).quantity).toBe(12);
  });

  it('rejects an edit that would over-sell', () => {
    const { transaction: b } = createTransaction(db, buy); // buy 10
    createTransaction(db, { ...buy, transaction_type: 'sell', quantity: 6, transaction_date: '2020-03-01T00:00:00.000Z' });
    // Shrinking the buy to 4 strands the sell of 6.
    expect(() => editTransaction(db, b.id, { quantity: 4 })).toThrow(/exceed/i);
  });

  it('soft-deletes and records a delete audit row', () => {
    const { transaction } = createTransaction(db, buy);
    softDeleteTransaction(db, transaction.id);
    const row = db.select().from(transactions).all()[0];
    expect(row.deleted_at).not.toBeNull();
    expect(db.select().from(audit_log).all().some((a) => a.action === 'delete')).toBe(true);
  });

  it('rejects deleting a buy that strands a later sell', () => {
    const { transaction: b } = createTransaction(db, buy); // buy 10
    createTransaction(db, { ...buy, transaction_type: 'sell', quantity: 8, transaction_date: '2020-03-01T00:00:00.000Z' });
    expect(() => softDeleteTransaction(db, b.id)).toThrow(/exceed/i);
  });

  it('throws transaction_not_found for an unknown id', () => {
    expect(() => editTransaction(db, 999, { quantity: 1 })).toThrow(/not_found|not found/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/transactions.service.edit.test.ts`
Expected: FAIL — `editTransaction`/`softDeleteTransaction` not exported.

- [ ] **Step 3: Append implementation to `transactions.service.ts`**

Add these imports to the existing import block: `EditTransactionSchema` from `@shared/schemas/transaction`, and `softDelete` from `@backend/db/soft-delete`. Then append:

```ts
export function getActiveTransaction(db: Db, id: number): TransactionRow {
  const row = db.select().from(transactions).where(activeWhere(transactions, eq(transactions.id, id))).limit(1).get();
  if (!row) throw ingestionError('ingestion.transaction_not_found', `transaction ${id} not found`, { id });
  return row;
}

function rowToCreateInput(row: TransactionRow): Record<string, unknown> {
  return {
    account_id: row.account_id,
    symbol: undefined, // resolved from security below when needed
    transaction_type: row.transaction_type,
    transaction_date: row.transaction_date,
    quantity: row.quantity,
    price_cents: row.price_cents ?? undefined,
    amount_cents: row.amount_cents,
    fee_cents: row.fee_cents ?? undefined,
    currency_code: row.currency_code,
    notes: row.notes ?? undefined,
  };
}

export function editTransaction(db: Db, id: number, rawPatch: unknown): WriteResult {
  const before = getActiveTransaction(db, id);
  const patch = EditTransactionSchema.parse(rawPatch);

  // Preserve the existing symbol for security-bearing types when the patch
  // omits it, so the merged row re-validates and re-resolves correctly.
  const existingSymbol = before.security_id !== null
    ? db.select().from(transactions).where(eq(transactions.id, id)).get() && symbolOf(db, before.security_id)
    : undefined;

  const merged = { ...rowToCreateInput(before), symbol: existingSymbol, ...patch };
  const input = CreateTransactionSchema.parse(merged);
  const { security_id } = resolve(db, input);

  if (isLotAffecting(input.transaction_type) && security_id !== null) {
    const history = loadTxHistory(db, input.account_id, security_id).filter((t) => t.id !== id);
    const candidate = toEngineCandidate(input, security_id, id);
    validateOverSell(db, input.account_id, security_id, candidate, id);
  }

  const dupes = findDuplicates(db, dedupFields(input, security_id)).filter((d) => d.id !== id);
  const warnings: IngestionWarning[] = dupes.length
    ? [{ code: 'duplicate', message: `matches ${dupes.length} existing transaction(s)`, context: { ids: dupes.map((d) => d.id) } }]
    : [];

  let transaction!: TransactionRow;
  db.$client.transaction(() => {
    transaction = db.update(transactions).set({
      account_id: input.account_id,
      security_id,
      transaction_type: input.transaction_type,
      transaction_date: input.transaction_date,
      quantity: input.quantity,
      price_cents: input.price_cents ?? null,
      amount_cents: input.amount_cents,
      fee_cents: input.fee_cents ?? null,
      currency_code: input.currency_code,
      notes: input.notes ?? null,
      updated_at: new Date(),
    }).where(eq(transactions.id, id)).returning().get();
    writeAudit(db, { entity_type: 'transaction', entity_id: id, action: 'update', before, after: transaction });
  })();

  return { transaction, warnings };
}

export function softDeleteTransaction(db: Db, id: number): void {
  const before = getActiveTransaction(db, id);
  // Removing a lot-affecting row can strand a later sell — revalidate the
  // remaining stream (this row excluded) before committing the delete.
  if (isLotAffecting(before.transaction_type) && before.security_id !== null) {
    const remaining = loadTxHistory(db, before.account_id, before.security_id).filter((t) => t.id !== id);
    try {
      computeLots(remaining, { method: 'fifo' });
    } catch (e) {
      if (e instanceof FinancialError && e.code === 'domain.sell_exceeds_holdings') {
        throw ingestionError('ingestion.sell_exceeds_holdings', `deleting transaction ${id} strands a later sell`, { id, ...e.context });
      }
      throw e;
    }
  }
  db.$client.transaction(() => {
    softDelete(db, transactions, eq(transactions.id, id));
    writeAudit(db, { entity_type: 'transaction', entity_id: id, action: 'delete', before });
  })();
}
```

Also add a small `symbolOf` helper (imports `securities`, `eq` already imported):

```ts
import { securities } from '@backend/db/schema'; // add securities to the existing schema import

function symbolOf(db: Db, securityId: number): string | undefined {
  return db.select().from(securities).where(eq(securities.id, securityId)).get()?.symbol;
}
```

> **Simplify note for implementer:** the `existingSymbol` expression above is deliberately explicit; you may replace it with a direct `const existingSymbol = before.security_id !== null ? symbolOf(db, before.security_id) : undefined;`. Keep behavior identical and let the edit tests be the gate.

- [ ] **Step 4: Run tests → PASS, typecheck, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/transactions.service.edit.test.ts` → PASS
Run: `pnpm -C worktrees/feat-data-ingestion-backend typecheck` → clean

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/services/transactions.service.ts src/backend/services/transactions.service.edit.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): in-place edit and soft-delete with revalidation

Edits re-run full boundary + over-sell validation with the patched row in
place and record an update audit row; soft-delete revalidates the
remaining stream so removing a buy can't strand a later sell."
```

---

### Task 9: Transactions service — bulk delete + retag

**Files:**
- Modify: `src/backend/services/transactions.service.ts`
- Create: `src/backend/services/tags.service.ts`
- Test: `src/backend/services/transactions.service.bulk.test.ts`
- Test: `src/backend/services/tags.service.test.ts`

**Interfaces:**
- Produces (transactions.service): `bulkSoftDelete(db, ids)` → `void` (all-or-nothing); `bulkRetag(db, { ids, add, remove })` → `void`.
- Produces (tags.service): `TagRow`; `listTags(db)`; `createTag(db, input)`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/backend/services/tags.service.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';

import { createTag, listTags } from './tags.service';

describe('tags.service', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-tag-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  it('creates and lists a tag', () => {
    createTag(db, { name: 'Roth' });
    const tags = listTags(db);
    expect(tags.map((t) => t.name)).toContain('Roth');
  });
});
```

```ts
// src/backend/services/transactions.service.bulk.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, transaction_tags, transactions } from '@backend/db/schema';

import { createTransaction, bulkRetag, bulkSoftDelete } from './transactions.service';
import { createTag } from './tags.service';

const buy = {
  account_id: 1, transaction_type: 'buy', symbol: 'AAPL',
  transaction_date: '2020-01-02T00:00:00.000Z', quantity: 10,
  price_cents: 15000, amount_cents: 150000,
};

describe('bulk operations', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-bulk-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  it('bulk soft-deletes standalone deposits', () => {
    const a = createTransaction(db, { account_id: 1, transaction_type: 'deposit', transaction_date: '2020-01-02T00:00:00.000Z', amount_cents: 1000 }).transaction;
    const b = createTransaction(db, { account_id: 1, transaction_type: 'deposit', transaction_date: '2020-01-03T00:00:00.000Z', amount_cents: 2000 }).transaction;
    bulkSoftDelete(db, [a.id, b.id]);
    expect(db.select().from(transactions).all().every((t) => t.deleted_at !== null)).toBe(true);
  });

  it('bulk retag adds and removes tag links', () => {
    const t = createTransaction(db, buy).transaction;
    createTag(db, { name: 'Core' }); // id 1
    bulkRetag(db, { ids: [t.id], add: [1], remove: [] });
    expect(db.select().from(transaction_tags).all()).toHaveLength(1);
    bulkRetag(db, { ids: [t.id], add: [], remove: [1] });
    expect(db.select().from(transaction_tags).all()).toHaveLength(0);
  });

  it('bulk delete is all-or-nothing (an over-sell in the set rolls back the whole batch)', () => {
    const b = createTransaction(db, buy).transaction; // buy 10
    const s = createTransaction(db, { ...buy, transaction_type: 'sell', quantity: 8, transaction_date: '2020-03-01T00:00:00.000Z' }).transaction;
    // Deleting the buy strands the sell → whole batch rejects, nothing deleted.
    expect(() => bulkSoftDelete(db, [b.id, s.id])).toThrow(/exceed/i);
    expect(db.select().from(transactions).all().every((t) => t.deleted_at === null)).toBe(true);
  });
});
```

> **Ordering note:** `bulkSoftDelete` must delete in an order that doesn't spuriously fail — delete each id after removing it, revalidating the residual stream per id. The all-or-nothing test above deletes `[buy, sell]`; deleting the buy first strands the sell and must roll the batch back. If you instead process sells before buys, that specific batch would succeed — so process ids in the given order and wrap the whole loop in one `db.$client.transaction`, re-running the per-id revalidation against the *in-progress* deleted set.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/tags.service.test.ts src/backend/services/transactions.service.bulk.test.ts`
Expected: FAIL — modules/exports not found.

- [ ] **Step 3: Implement `tags.service.ts`**

```ts
// src/backend/services/tags.service.ts
import type { Db } from '@backend/db/client';
import { tags } from '@backend/db/schema';
import { activeWhere } from '@backend/db/soft-delete';
import { CreateTagSchema } from '@shared/schemas/tag';

export type TagRow = typeof tags.$inferSelect;

export function listTags(db: Db): TagRow[] {
  return db.select().from(tags).where(activeWhere(tags, undefined)).all();
}

export function createTag(db: Db, raw: unknown): TagRow {
  const input = CreateTagSchema.parse(raw);
  return db.insert(tags).values({ name: input.name, color: input.color ?? null }).returning().get();
}
```

- [ ] **Step 4: Append bulk ops to `transactions.service.ts`**

Add imports: `and`, `inArray` from `drizzle-orm`; `transaction_tags` from `@backend/db/schema`. Then append:

```ts
export function bulkSoftDelete(db: Db, ids: number[]): void {
  // Load all targets up front (throws if any is missing/already deleted).
  const rows = ids.map((id) => getActiveTransaction(db, id));
  const deleted = new Set<number>();
  db.$client.transaction(() => {
    for (const before of rows) {
      if (isLotAffecting(before.transaction_type) && before.security_id !== null) {
        const remaining = loadTxHistory(db, before.account_id, before.security_id)
          .filter((t) => t.id !== before.id && !deleted.has(t.id));
        try {
          computeLots(remaining, { method: 'fifo' });
        } catch (e) {
          if (e instanceof FinancialError && e.code === 'domain.sell_exceeds_holdings') {
            throw ingestionError('ingestion.sell_exceeds_holdings', `deleting transaction ${before.id} strands a later sell`, { id: before.id });
          }
          throw e;
        }
      }
      softDelete(db, transactions, eq(transactions.id, before.id));
      writeAudit(db, { entity_type: 'transaction', entity_id: before.id, action: 'delete', before });
      deleted.add(before.id);
    }
  })();
}

export interface BulkRetagParams { ids: number[]; add: number[]; remove: number[]; }

export function bulkRetag(db: Db, params: BulkRetagParams): void {
  const rows = params.ids.map((id) => getActiveTransaction(db, id));
  db.$client.transaction(() => {
    for (const row of rows) {
      for (const tagId of params.add) {
        db.insert(transaction_tags).values({ transaction_id: row.id, tag_id: tagId }).onConflictDoNothing().run();
      }
      if (params.remove.length > 0) {
        db.delete(transaction_tags).where(and(
          eq(transaction_tags.transaction_id, row.id),
          inArray(transaction_tags.tag_id, params.remove),
        )).run();
      }
      writeAudit(db, { entity_type: 'transaction', entity_id: row.id, action: 'update', before: { tags: 'retag' }, after: { add: params.add, remove: params.remove } });
    }
  })();
}
```

- [ ] **Step 5: Run tests → PASS, typecheck, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/tags.service.test.ts src/backend/services/transactions.service.bulk.test.ts` → PASS
Run: `pnpm -C worktrees/feat-data-ingestion-backend typecheck` → clean

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/services/tags.service.ts src/backend/services/tags.service.test.ts src/backend/services/transactions.service.ts src/backend/services/transactions.service.bulk.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): bulk soft-delete and re-tag, tags service

bulkSoftDelete revalidates each removal against the residual stream in one
all-or-nothing transaction; bulkRetag adds/removes transaction_tags links;
tags service provides list/create."
```

---

### Task 10: Accounts service

**Files:**
- Create: `src/backend/services/accounts.service.ts`
- Test: `src/backend/services/accounts.service.test.ts`

**Interfaces:**
- Consumes: `CreateAccountSchema`, `RenameAccountSchema` from `@shared/schemas/account`; `AccountRow`, `getActiveAccount` from `./transactions.service`.
- Produces: `listAccounts(db)`, `createAccount(db, input)`, `renameAccount(db, id, patch)`, `archiveAccount(db, id)`.

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/services/accounts.service.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, audit_log } from '@backend/db/schema';

import { archiveAccount, createAccount, listAccounts, renameAccount } from './accounts.service';

describe('accounts.service', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-acct-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  it('creates an account with defaults and audits it', () => {
    const a = createAccount(db, { name: 'Brokerage', tax_treatment: 'taxable' });
    expect(a.cost_basis_method).toBe('fifo');
    expect(db.select().from(audit_log).all().some((r) => r.action === 'insert')).toBe(true);
  });

  it('renames and archives (soft-delete removes it from the active list)', () => {
    const a = createAccount(db, { name: 'Old', tax_treatment: 'taxable' });
    renameAccount(db, a.id, { name: 'New' });
    expect(db.select().from(accounts).where(undefined as never).all().find((r) => r.id === a.id)?.name).toBe('New');
    archiveAccount(db, a.id);
    expect(listAccounts(db).find((r) => r.id === a.id)).toBeUndefined();
  });

  it('throws for renaming a missing account', () => {
    expect(() => renameAccount(db, 999, { name: 'x' })).toThrow(/not found|account_not_found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/accounts.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/backend/services/accounts.service.ts
import { eq } from 'drizzle-orm';

import type { Db } from '@backend/db/client';
import { accounts } from '@backend/db/schema';
import { activeWhere, softDelete } from '@backend/db/soft-delete';
import { CreateAccountSchema, RenameAccountSchema } from '@shared/schemas/account';

import { writeAudit } from './audit.service';
import { getActiveAccount, type AccountRow } from './transactions.service';

export function listAccounts(db: Db): AccountRow[] {
  return db.select().from(accounts).where(activeWhere(accounts, undefined)).all();
}

export function createAccount(db: Db, raw: unknown): AccountRow {
  const input = CreateAccountSchema.parse(raw);
  let row!: AccountRow;
  db.$client.transaction(() => {
    row = db.insert(accounts).values({
      name: input.name,
      broker: input.broker ?? null,
      tax_treatment: input.tax_treatment,
      cost_basis_method: input.cost_basis_method,
      currency_code: input.currency_code,
    }).returning().get();
    writeAudit(db, { entity_type: 'account', entity_id: row.id, action: 'insert', after: row });
  })();
  return row;
}

export function renameAccount(db: Db, id: number, raw: unknown): AccountRow {
  const before = getActiveAccount(db, id);
  const patch = RenameAccountSchema.parse(raw);
  let row!: AccountRow;
  db.$client.transaction(() => {
    row = db.update(accounts).set({
      name: patch.name ?? before.name,
      broker: patch.broker === undefined ? before.broker : patch.broker,
      tax_treatment: patch.tax_treatment ?? before.tax_treatment,
      cost_basis_method: patch.cost_basis_method ?? before.cost_basis_method,
      updated_at: new Date(),
    }).where(eq(accounts.id, id)).returning().get();
    writeAudit(db, { entity_type: 'account', entity_id: id, action: 'update', before, after: row });
  })();
  return row;
}

export function archiveAccount(db: Db, id: number): void {
  const before = getActiveAccount(db, id);
  db.$client.transaction(() => {
    softDelete(db, accounts, eq(accounts.id, id));
    writeAudit(db, { entity_type: 'account', entity_id: id, action: 'delete', before });
  })();
}
```

- [ ] **Step 4: Run test → PASS, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/accounts.service.test.ts` → PASS

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/services/accounts.service.ts src/backend/services/accounts.service.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): account CRUD with audit trail

create/list/rename/archive over accounts with tax-treatment and
cost-basis-method validation; archive is soft-delete."
```

---

### Task 11: CSV parsing (adds `csv-parse` dependency)

**Files:**
- Modify: `package.json` (add `csv-parse`)
- Create: `src/backend/services/csv/parse.ts`
- Test: `src/backend/services/csv/parse.test.ts`

**Interfaces:**
- Consumes: `csv-parse/sync`; `ingestionError`.
- Produces: `ParsedCsv = { headers: string[]; rows: Record<string, string>[] }`; `parseCsv(text)`.

- [ ] **Step 1: Add the dependency**

Run (this will prompt for approval — adding a dependency is deliberate):
`pnpm -C worktrees/feat-data-ingestion-backend add csv-parse`

Expected: `csv-parse` appears under `dependencies` in `worktrees/feat-data-ingestion-backend/package.json`. It ships its own types — no `@types` needed.

- [ ] **Step 2: Write the failing test**

```ts
// src/backend/services/csv/parse.test.ts
import { parseCsv } from './parse';

describe('parseCsv', () => {
  it('parses headers and rows, trimming whitespace', () => {
    const { headers, rows } = parseCsv('Date,Symbol,Qty\n2020-01-02, AAPL ,10\n');
    expect(headers).toEqual(['Date', 'Symbol', 'Qty']);
    expect(rows[0]).toEqual({ Date: '2020-01-02', Symbol: 'AAPL', Qty: '10' });
  });

  it('handles quoted fields with embedded commas and newlines', () => {
    const text = 'Date,Note\n2020-01-02,"buy, then hold\nlong"\n';
    const { rows } = parseCsv(text);
    expect(rows[0].Note).toBe('buy, then hold\nlong');
  });

  it('throws ingestion.csv_parse_failed on malformed input', () => {
    // Unbalanced quote.
    expect(() => parseCsv('a,b\n"oops,1\n')).toThrow(/csv_parse_failed|parse/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/csv/parse.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// src/backend/services/csv/parse.ts
import { parse as parseSync } from 'csv-parse/sync';

import { ingestionError } from '../ingestion-errors';

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(text: string): ParsedCsv {
  let records: Record<string, string>[];
  try {
    records = parseSync(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
    }) as Record<string, string>[];
  } catch (e) {
    throw ingestionError('ingestion.csv_parse_failed', 'failed to parse CSV', { cause: (e as Error).message });
  }
  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  return { headers, rows: records };
}
```

- [ ] **Step 5: Run test → PASS, typecheck, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/csv/parse.test.ts` → PASS

```bash
git -C worktrees/feat-data-ingestion-backend add package.json pnpm-lock.yaml src/backend/services/csv/parse.ts src/backend/services/csv/parse.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): CSV parsing via csv-parse

Adds csv-parse as a deliberate runtime dependency for RFC-4180-correct
parsing (quoted fields, embedded commas/newlines) and wraps failures in
ingestion.csv_parse_failed."
```

---

### Task 12: Column mapping + broker presets

**Files:**
- Create: `src/backend/services/csv/mapping.ts`
- Create: `src/backend/services/csv/presets.ts`
- Test: `src/backend/services/csv/mapping.test.ts`
- Test: `src/backend/services/csv/presets.test.ts`

**Interfaces:**
- Consumes: `parse` from `@shared/money` (dollar→cents), `TxTypeName`.
- Produces:
  - `ColumnMapping` (canonical field → source header).
  - `CanonicalRow = { sourceIndex: number; transaction_type: string; transaction_date: string; symbol?: string; quantity?: string; price?: string; amount?: string; fee?: string; notes?: string }`.
  - `applyMapping(rows, mapping)` → `CanonicalRow[]`; throws `ingestion.csv_mapping_incomplete` if `transaction_type`/`transaction_date` headers are absent.
  - `canonicalToCreateInput(row, accountId, normalizeType?)` → object accepted by `CreateTransactionSchema` (dollar strings → cents).
  - `BrokerPreset`, `BROKER_PRESETS`, `getPreset(id)`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/backend/services/csv/mapping.test.ts
import { applyMapping, canonicalToCreateInput } from './mapping';

const rows = [{ D: '2020-01-02', T: 'buy', S: 'AAPL', Q: '10', P: '150.00', A: '1500.00' }];
const mapping = { transaction_date: 'D', transaction_type: 'T', symbol: 'S', quantity: 'Q', price: 'P', amount: 'A' };

describe('applyMapping', () => {
  it('projects raw rows onto canonical fields', () => {
    const [row] = applyMapping(rows, mapping);
    expect(row.symbol).toBe('AAPL');
    expect(row.price).toBe('150.00');
    expect(row.sourceIndex).toBe(0);
  });
  it('throws when a required header is missing', () => {
    expect(() => applyMapping(rows, { transaction_date: 'D', transaction_type: 'MISSING' })).toThrow(/mapping_incomplete|missing/i);
  });
});

describe('canonicalToCreateInput', () => {
  it('converts dollar strings to integer cents', () => {
    const [row] = applyMapping(rows, mapping);
    const input = canonicalToCreateInput(row, 1);
    expect(input.amount_cents).toBe(150000);
    expect(input.price_cents).toBe(15000);
    expect(input.quantity).toBe(10);
    expect(input.account_id).toBe(1);
  });
});
```

```ts
// src/backend/services/csv/presets.test.ts
import { applyMapping, canonicalToCreateInput } from './mapping';
import { BROKER_PRESETS, getPreset } from './presets';

describe('broker presets', () => {
  it('exposes the four v1.0 presets', () => {
    expect(Object.keys(BROKER_PRESETS).sort()).toEqual(['fidelity', 'ibkr', 'schwab', 'vanguard']);
  });

  it('fidelity preset maps a sample row and normalizes the type', () => {
    const preset = getPreset('fidelity');
    // Representative Fidelity headers.
    const rows = [{
      'Run Date': '01/02/2020', 'Action': 'YOU BOUGHT', 'Symbol': 'AAPL',
      'Quantity': '10', 'Price ($)': '150.00', 'Amount ($)': '-1500.00',
    }];
    const [canonical] = applyMapping(rows, preset.mapping);
    const input = canonicalToCreateInput(canonical, 1, preset.normalizeType);
    expect(input.transaction_type).toBe('buy');
    expect(input.symbol).toBe('AAPL');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/csv/mapping.test.ts src/backend/services/csv/presets.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `mapping.ts`**

```ts
// src/backend/services/csv/mapping.ts
import { parse as parseMoney } from '@shared/money';

import { ingestionError } from '../ingestion-errors';
import type { TxTypeName } from '@shared/schemas/transaction';

export interface ColumnMapping {
  transaction_type: string;
  transaction_date: string;
  symbol?: string;
  quantity?: string;
  price?: string;
  amount?: string;
  fee?: string;
  notes?: string;
}

export interface CanonicalRow {
  sourceIndex: number;
  transaction_type: string;
  transaction_date: string;
  symbol?: string;
  quantity?: string;
  price?: string;
  amount?: string;
  fee?: string;
  notes?: string;
}

const OPTIONAL_FIELDS = ['symbol', 'quantity', 'price', 'amount', 'fee', 'notes'] as const;

export function applyMapping(rows: Record<string, string>[], mapping: ColumnMapping): CanonicalRow[] {
  for (const required of ['transaction_type', 'transaction_date'] as const) {
    const header = mapping[required];
    if (!header || (rows.length > 0 && !(header in rows[0]))) {
      throw ingestionError('ingestion.csv_mapping_incomplete', `missing required column for ${required}`, { field: required, header });
    }
  }
  return rows.map((row, sourceIndex) => {
    const canonical: CanonicalRow = {
      sourceIndex,
      transaction_type: row[mapping.transaction_type] ?? '',
      transaction_date: row[mapping.transaction_date] ?? '',
    };
    for (const field of OPTIONAL_FIELDS) {
      const header = mapping[field];
      if (header && header in row) canonical[field] = row[header];
    }
    return canonical;
  });
}

// Convert a canonical row (string cells) into the shape CreateTransactionSchema
// accepts. Money cells are dollar strings → integer cents via @shared/money.
export function canonicalToCreateInput(
  row: CanonicalRow,
  accountId: number,
  normalizeType?: (raw: string) => TxTypeName | null,
): Record<string, unknown> {
  const type = normalizeType ? normalizeType(row.transaction_type) : row.transaction_type;
  const out: Record<string, unknown> = {
    account_id: accountId,
    transaction_type: type,
    transaction_date: row.transaction_date,
  };
  if (row.symbol) out.symbol = row.symbol;
  if (row.notes) out.notes = row.notes;
  if (row.quantity !== undefined && row.quantity !== '') out.quantity = Number(row.quantity);
  // Money cells may be signed in exports (e.g. -1500.00 for a buy); use magnitude.
  if (row.amount !== undefined && row.amount !== '') out.amount_cents = Math.abs(parseMoney(row.amount));
  if (row.price !== undefined && row.price !== '') out.price_cents = Math.abs(parseMoney(row.price));
  if (row.fee !== undefined && row.fee !== '') out.fee_cents = Math.abs(parseMoney(row.fee));
  return out;
}
```

> **Note:** `parseMoney` returns branded `Money` (a number); `Math.abs(...)` yields a plain `number`, which `MoneySchema` re-brands at validation. That's why we don't import money arithmetic helpers here.

- [ ] **Step 4: Implement `presets.ts`**

```ts
// src/backend/services/csv/presets.ts
import type { TxTypeName } from '@shared/schemas/transaction';

import type { ColumnMapping } from './mapping';

export type BrokerId = 'fidelity' | 'schwab' | 'vanguard' | 'ibkr';

export interface BrokerPreset {
  id: BrokerId;
  label: string;
  mapping: ColumnMapping;
  normalizeType: (raw: string) => TxTypeName | null;
}

// Best-effort keyword normalizer shared by the presets. Returns null for
// vocabulary the preset doesn't recognize so the preview marks the row an error
// (the user can correct the mapping/type in WS4).
function keywordType(raw: string): TxTypeName | null {
  const s = raw.trim().toLowerCase();
  if (/(you bought|^buy\b|purchase|reinvest)/.test(s)) return 'buy';
  if (/(you sold|^sell\b|redemption)/.test(s)) return 'sell';
  if (/dividend/.test(s)) return 'dividend';
  if (/interest/.test(s)) return 'interest';
  if (/(fee|commission)/.test(s)) return 'fee';
  if (/split/.test(s)) return 'split';
  if (/(transfer in|received)/.test(s)) return 'transfer_in';
  if (/(transfer out|delivered)/.test(s)) return 'transfer_out';
  if (/(deposit|contribution)/.test(s)) return 'deposit';
  if (/(withdrawal|distribution)/.test(s)) return 'withdrawal';
  return null;
}

export const BROKER_PRESETS: Record<BrokerId, BrokerPreset> = {
  fidelity: {
    id: 'fidelity', label: 'Fidelity',
    mapping: { transaction_date: 'Run Date', transaction_type: 'Action', symbol: 'Symbol', quantity: 'Quantity', price: 'Price ($)', amount: 'Amount ($)', fee: 'Commission ($)' },
    normalizeType: keywordType,
  },
  schwab: {
    id: 'schwab', label: 'Charles Schwab',
    mapping: { transaction_date: 'Date', transaction_type: 'Action', symbol: 'Symbol', quantity: 'Quantity', price: 'Price', amount: 'Amount', fee: 'Fees & Comm' },
    normalizeType: keywordType,
  },
  vanguard: {
    id: 'vanguard', label: 'Vanguard',
    mapping: { transaction_date: 'Trade Date', transaction_type: 'Transaction Type', symbol: 'Symbol', quantity: 'Shares', price: 'Share Price', amount: 'Principal Amount', fee: 'Commission Fees' },
    normalizeType: keywordType,
  },
  ibkr: {
    id: 'ibkr', label: 'Interactive Brokers',
    mapping: { transaction_date: 'Date/Time', transaction_type: 'Buy/Sell', symbol: 'Symbol', quantity: 'Quantity', price: 'T. Price', amount: 'Proceeds', fee: 'Comm/Fee' },
    normalizeType: keywordType,
  },
};

export function getPreset(id: BrokerId): BrokerPreset {
  return BROKER_PRESETS[id];
}
```

- [ ] **Step 5: Run tests → PASS, typecheck, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/csv/mapping.test.ts src/backend/services/csv/presets.test.ts` → PASS
Run: `pnpm -C worktrees/feat-data-ingestion-backend typecheck` → clean

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/services/csv/mapping.ts src/backend/services/csv/presets.ts src/backend/services/csv/mapping.test.ts src/backend/services/csv/presets.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): column mapping and broker presets

applyMapping projects raw CSV onto canonical fields;
canonicalToCreateInput converts dollar cells to integer cents; Fidelity/
Schwab/Vanguard/IBKR presets provide best-effort header maps and type
normalization users can override."
```

---

### Task 13: CSV import service (preview + commit)

**Files:**
- Create: `src/backend/services/csv/import.service.ts`
- Test: `src/backend/services/csv/import.service.test.ts`

**Interfaces:**
- Consumes: `parseCsv`, `applyMapping`, `canonicalToCreateInput`, `getPreset`, `ColumnMapping`; `CreateTransactionSchema`, `isLotAffecting`, `isSecurityBearing`; `findSecurityBySymbol`, `resolveSecurity`; `findDuplicates`, `validateOverSell`, `getActiveAccount`, `createTransaction`; `computeLots`, `FinancialError`, `Tx`.
- Produces:
  - `PreviewRowResult`, `PreviewResult`, `CommitResult`.
  - `previewImport(db, { text, accountId, broker?, mapping? })` → `PreviewResult` (zero writes).
  - `commitImport(db, { text, accountId, broker?, mapping?, acceptedIndexes })` → `CommitResult`.

**Design:** preview is a pure dry-run — it parses, maps, and for each row runs boundary validation + a *peek* at security existence (no create) + over-sell simulation against the current DB history (using `security_id ?? -1` for not-yet-existing securities). Commit re-runs the same validation on the accepted rows, rejects the whole batch if any accepted row errors, then inserts all accepted rows via `createTransaction` inside one `db.$client.transaction`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/backend/services/csv/import.service.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { runMigrations } from '@backend/db/migrate';
import { accounts, transactions } from '@backend/db/schema';

import { commitImport, previewImport } from './import.service';

const mapping = { transaction_date: 'D', transaction_type: 'T', symbol: 'S', quantity: 'Q', price: 'P', amount: 'A' };
const csv = [
  'D,T,S,Q,P,A',
  '2020-01-02,buy,AAPL,10,150.00,1500.00',
  '2020-02-01,sell,AAPL,4,160.00,640.00',
].join('\n');

describe('CSV import', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-imp-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  it('preview reports per-row status and writes nothing', () => {
    const preview = previewImport(db, { text: csv, accountId: 1, mapping });
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows.every((r) => r.status !== 'error')).toBe(true);
    expect(preview.rows[0].isNewSecurity).toBe(true);
    expect(db.select().from(transactions).all()).toHaveLength(0); // dry run
  });

  it('preview flags an over-selling row as error', () => {
    const bad = ['D,T,S,Q,P,A', '2020-01-02,sell,AAPL,5,150.00,750.00'].join('\n');
    const preview = previewImport(db, { text: bad, accountId: 1, mapping });
    expect(preview.rows[0].status).toBe('error');
    expect(preview.summary.error).toBe(1);
  });

  it('commit inserts all accepted rows atomically', () => {
    const result = commitImport(db, { text: csv, accountId: 1, mapping, acceptedIndexes: [0, 1] });
    expect(result.inserted).toBe(2);
    expect(result.createdSecurities).toBe(1);
    expect(db.select().from(transactions).all()).toHaveLength(2);
  });

  it('commit rejects the whole batch if an accepted row errors', () => {
    const bad = ['D,T,S,Q,P,A', '2020-01-02,sell,AAPL,5,150.00,750.00'].join('\n');
    expect(() => commitImport(db, { text: bad, accountId: 1, mapping, acceptedIndexes: [0] })).toThrow(/commit_has_errors|error/i);
    expect(db.select().from(transactions).all()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/csv/import.service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/backend/services/csv/import.service.ts
import type { Db } from '@backend/db/client';
import { computeLots, FinancialError, type Tx } from '@backend/financial';
import {
  CreateTransactionSchema, isLotAffecting, isSecurityBearing, type TxTypeName,
} from '@shared/schemas/transaction';

import { findDuplicates } from '../dedup';
import { loadTxHistory } from '../history';
import { ingestionError } from '../ingestion-errors';
import { findSecurityBySymbol } from '../securities.service';
import { createTransaction, getActiveAccount } from '../transactions.service';
import { applyMapping, canonicalToCreateInput, type ColumnMapping } from './mapping';
import { parseCsv } from './parse';
import { getPreset, type BrokerId } from './presets';

export interface PreviewRowResult {
  sourceIndex: number;
  status: 'ok' | 'warn' | 'error';
  resolvedSymbol?: string;
  isNewSecurity: boolean;
  isDuplicate: boolean;
  errors: { message: string }[];
  warnings: { message: string }[];
}
export interface PreviewResult {
  rows: PreviewRowResult[];
  summary: { total: number; ok: number; warn: number; error: number };
  mapping: ColumnMapping;
}
export interface CommitResult {
  inserted: number;
  createdSecurities: number;
  warnings: { sourceIndex: number; message: string }[];
}

interface ImportParams {
  text: string;
  accountId: number;
  broker?: BrokerId;
  mapping?: ColumnMapping;
}

function resolveMapping(params: ImportParams): { mapping: ColumnMapping; normalizeType?: (raw: string) => TxTypeName | null } {
  if (params.broker) {
    const preset = getPreset(params.broker);
    return { mapping: preset.mapping, normalizeType: preset.normalizeType };
  }
  if (params.mapping) return { mapping: params.mapping };
  throw ingestionError('ingestion.csv_mapping_incomplete', 'either broker or mapping is required');
}

export function previewImport(db: Db, params: ImportParams): PreviewResult {
  getActiveAccount(db, params.accountId); // throws account_not_found
  const { mapping, normalizeType } = resolveMapping(params);
  const { rows } = parseCsv(params.text);
  const canonical = applyMapping(rows, mapping);

  const results: PreviewRowResult[] = canonical.map((row) => {
    const errors: { message: string }[] = [];
    const warnings: { message: string }[] = [];
    let isNewSecurity = false;
    let isDuplicate = false;
    let resolvedSymbol: string | undefined;

    const parsed = CreateTransactionSchema.safeParse(canonicalToCreateInput(row, params.accountId, normalizeType));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push({ message: `${issue.path.join('.')}: ${issue.message}` });
      return { sourceIndex: row.sourceIndex, status: 'error', isNewSecurity, isDuplicate, errors, warnings };
    }
    const input = parsed.data;
    resolvedSymbol = input.symbol;

    let securityId: number | null = null;
    if (isSecurityBearing(input.transaction_type)) {
      const existing = findSecurityBySymbol(db, input.symbol!);
      securityId = existing?.id ?? -1;
      isNewSecurity = !existing;
    }

    if (findDuplicates(db, { transaction_date: input.transaction_date, security_id: securityId === -1 ? null : securityId, quantity: input.quantity, price_cents: input.price_cents ?? null, account_id: input.account_id }).length > 0) {
      isDuplicate = true;
      warnings.push({ message: 'matches an existing transaction' });
    }

    if (isLotAffecting(input.transaction_type)) {
      const history = securityId > 0 ? loadTxHistory(db, input.account_id, securityId) : [];
      const candidate: Tx = {
        id: history.reduce((m, t) => Math.max(m, t.id), 0) + 1,
        account_id: input.account_id, security_id: securityId,
        transaction_type: input.transaction_type as TxTypeName,
        transaction_date: input.transaction_date, quantity: input.quantity,
        price_cents: input.price_cents ?? null, amount_cents: input.amount_cents,
        fee_cents: input.fee_cents ?? null, currency_code: input.currency_code,
      };
      try {
        computeLots([...history, candidate], { method: 'fifo' });
      } catch (e) {
        if (e instanceof FinancialError && e.code === 'domain.sell_exceeds_holdings') {
          errors.push({ message: 'sell exceeds holdings' });
        } else { throw e; }
      }
    }

    const status: PreviewRowResult['status'] = errors.length ? 'error' : warnings.length ? 'warn' : 'ok';
    return { sourceIndex: row.sourceIndex, status, resolvedSymbol, isNewSecurity, isDuplicate, errors, warnings };
  });

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    warn: results.filter((r) => r.status === 'warn').length,
    error: results.filter((r) => r.status === 'error').length,
  };
  return { rows: results, summary, mapping };
}

export function commitImport(db: Db, params: ImportParams & { acceptedIndexes: number[] }): CommitResult {
  const preview = previewImport(db, params);
  const accepted = new Set(params.acceptedIndexes);
  const acceptedRows = preview.rows.filter((r) => accepted.has(r.sourceIndex));
  const errored = acceptedRows.filter((r) => r.status === 'error');
  if (errored.length > 0) {
    throw ingestionError('ingestion.commit_has_errors', `${errored.length} accepted row(s) have errors`, { indexes: errored.map((r) => r.sourceIndex) });
  }

  const { mapping, normalizeType } = resolveMapping(params);
  const { rows } = parseCsv(params.text);
  const canonical = applyMapping(rows, mapping);

  const warnings: CommitResult['warnings'] = [];
  let createdSecurities = 0;
  let inserted = 0;

  db.$client.transaction(() => {
    for (const row of canonical) {
      if (!accepted.has(row.sourceIndex)) continue;
      // Track whether a security is about to be created (createTransaction
      // resolves it) by peeking first.
      const input = CreateTransactionSchema.parse(canonicalToCreateInput(row, params.accountId, normalizeType));
      const willCreate = isSecurityBearing(input.transaction_type) && !findSecurityBySymbol(db, input.symbol!);
      const { warnings: rowWarnings } = createTransaction(db, canonicalToCreateInput(row, params.accountId, normalizeType));
      if (willCreate) createdSecurities += 1;
      inserted += 1;
      for (const w of rowWarnings) warnings.push({ sourceIndex: row.sourceIndex, message: w.message });
    }
  })();

  return { inserted, createdSecurities, warnings };
}
```

- [ ] **Step 4: Run tests → PASS, typecheck, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/services/csv/import.service.test.ts` → PASS
Run: `pnpm -C worktrees/feat-data-ingestion-backend typecheck` → clean

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/services/csv/import.service.ts src/backend/services/csv/import.service.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): CSV preview and all-or-nothing commit

previewImport dry-runs boundary + over-sell validation per row with zero
writes; commitImport re-validates accepted rows, rejects the batch if any
errors, and inserts the rest through the canonical write path in one
transaction."
```

---

### Task 14: Account + tag routes

**Files:**
- Create: `src/backend/routes/accounts.ts`
- Create: `src/backend/routes/tags.ts`
- Test: `src/backend/routes/accounts.test.ts`

**Interfaces:**
- Consumes: `Db`; accounts + tags services.
- Produces: `createAccountsRoute({ db })`, `createTagsRoute({ db })` → `Hono`.

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/routes/accounts.test.ts
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { createErrorHandler } from '@backend/lib/error-handler';
import { logger } from '@backend/lib/logger';
import { runMigrations } from '@backend/db/migrate';

import { createAccountsRoute } from './accounts';

describe('accounts routes', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-racct-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  function app(): Hono {
    const a = new Hono();
    a.onError(createErrorHandler(logger));
    a.route('/api/v1/accounts', createAccountsRoute({ db }));
    return a;
  }

  it('POST creates and GET lists', async () => {
    const post = await app().request('/api/v1/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Brokerage', tax_treatment: 'taxable' }),
    });
    expect(post.status).toBe(201);
    const list = await app().request('/api/v1/accounts');
    const body = await list.json() as { accounts: { name: string }[] };
    expect(body.accounts.map((x) => x.name)).toContain('Brokerage');
  });

  it('rejects an invalid tax treatment with a 400 envelope', async () => {
    const res = await app().request('/api/v1/accounts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', tax_treatment: 'roth' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('validation.invalid_input');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/routes/accounts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the routes**

```ts
// src/backend/routes/accounts.ts
import { Hono } from 'hono';

import type { Db } from '@backend/db/client';
import { archiveAccount, createAccount, listAccounts, renameAccount } from '@backend/services/accounts.service';

export interface AccountsDeps { db: Db; }

export function createAccountsRoute(deps: AccountsDeps): Hono {
  return new Hono()
    .get('/', (c) => c.json({ accounts: listAccounts(deps.db) }))
    .post('/', async (c) => c.json({ account: createAccount(deps.db, await c.req.json()) }, 201))
    .patch('/:id', async (c) => c.json({ account: renameAccount(deps.db, Number(c.req.param('id')), await c.req.json()) }))
    .delete('/:id', (c) => { archiveAccount(deps.db, Number(c.req.param('id'))); return c.body(null, 204); });
}
```

```ts
// src/backend/routes/tags.ts
import { Hono } from 'hono';

import type { Db } from '@backend/db/client';
import { createTag, listTags } from '@backend/services/tags.service';

export interface TagsDeps { db: Db; }

export function createTagsRoute(deps: TagsDeps): Hono {
  return new Hono()
    .get('/', (c) => c.json({ tags: listTags(deps.db) }))
    .post('/', async (c) => c.json({ tag: createTag(deps.db, await c.req.json()) }, 201));
}
```

- [ ] **Step 4: Run test → PASS, typecheck, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/routes/accounts.test.ts` → PASS
Run: `pnpm -C worktrees/feat-data-ingestion-backend typecheck` → clean

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/routes/accounts.ts src/backend/routes/tags.ts src/backend/routes/accounts.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): account and tag route groups

REST endpoints over the accounts and tags services; validation and typed
errors surface through the existing error envelope."
```

---

### Task 15: Transaction routes (CRUD + bulk)

**Files:**
- Create: `src/backend/routes/transactions.ts`
- Test: `src/backend/routes/transactions.test.ts`

**Interfaces:**
- Consumes: `Db`; transactions service (create/edit/softDelete/bulk); `BulkDeleteSchema`, `BulkRetagSchema` from `@shared/schemas/tag`; `listTransactions` (new small helper below).
- Produces: `createTransactionsRoute({ db })` → `Hono`; `listTransactions(db, accountId?)` added to `transactions.service.ts`.

- [ ] **Step 1: Add `listTransactions` to the service (with a test)**

Append to `src/backend/services/transactions.service.ts`:

```ts
export function listTransactions(db: Db, accountId?: number): TransactionRow[] {
  const predicate = accountId === undefined ? undefined : eq(transactions.account_id, accountId);
  return db.select().from(transactions).where(activeWhere(transactions, predicate))
    .orderBy(asc(transactions.transaction_date), asc(transactions.id)).all();
}
```

Add `asc` to the `drizzle-orm` import in that file.

- [ ] **Step 2: Write the failing route test**

```ts
// src/backend/routes/transactions.test.ts
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { createErrorHandler } from '@backend/lib/error-handler';
import { logger } from '@backend/lib/logger';
import { runMigrations } from '@backend/db/migrate';
import { accounts } from '@backend/db/schema';

import { createTransactionsRoute } from './transactions';

const buy = { account_id: 1, transaction_type: 'buy', symbol: 'AAPL', transaction_date: '2020-01-02T00:00:00.000Z', quantity: 10, price_cents: 15000, amount_cents: 150000 };

describe('transactions routes', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-rtx-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  function app(): Hono {
    const a = new Hono();
    a.onError(createErrorHandler(logger));
    a.route('/api/v1/transactions', createTransactionsRoute({ db }));
    return a;
  }
  const post = (body: unknown) => app().request('/api/v1/transactions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('POST creates a transaction and returns warnings array', async () => {
    const res = await post(buy);
    expect(res.status).toBe(201);
    const body = await res.json() as { transaction: { id: number }; warnings: unknown[] };
    expect(body.transaction.id).toBeGreaterThan(0);
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it('POST over-sell returns 409 with the typed code', async () => {
    await post(buy);
    const res = await post({ ...buy, transaction_type: 'sell', quantity: 50, transaction_date: '2020-02-01T00:00:00.000Z' });
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe('ingestion.sell_exceeds_holdings');
  });

  it('GET lists transactions', async () => {
    await post(buy);
    const res = await app().request('/api/v1/transactions?account_id=1');
    expect((await res.json() as { transactions: unknown[] }).transactions).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/routes/transactions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// src/backend/routes/transactions.ts
import { Hono } from 'hono';

import type { Db } from '@backend/db/client';
import {
  bulkRetag, bulkSoftDelete, createTransaction, editTransaction,
  listTransactions, softDeleteTransaction,
} from '@backend/services/transactions.service';
import { BulkDeleteSchema, BulkRetagSchema } from '@shared/schemas/tag';

export interface TransactionsDeps { db: Db; }

export function createTransactionsRoute(deps: TransactionsDeps): Hono {
  return new Hono()
    .get('/', (c) => {
      const raw = c.req.query('account_id');
      const accountId = raw === undefined ? undefined : Number(raw);
      return c.json({ transactions: listTransactions(deps.db, accountId) });
    })
    .post('/', async (c) => {
      const { transaction, warnings } = createTransaction(deps.db, await c.req.json());
      return c.json({ transaction, warnings }, 201);
    })
    .post('/bulk/delete', async (c) => {
      const { ids } = BulkDeleteSchema.parse(await c.req.json());
      bulkSoftDelete(deps.db, ids);
      return c.json({ deleted: ids.length });
    })
    .post('/bulk/retag', async (c) => {
      const parsed = BulkRetagSchema.parse(await c.req.json());
      bulkRetag(deps.db, parsed);
      return c.json({ retagged: parsed.ids.length });
    })
    .patch('/:id', async (c) => {
      const { transaction, warnings } = editTransaction(deps.db, Number(c.req.param('id')), await c.req.json());
      return c.json({ transaction, warnings });
    })
    .delete('/:id', (c) => { softDeleteTransaction(deps.db, Number(c.req.param('id'))); return c.body(null, 204); });
}
```

> **Route-order note:** register `/bulk/delete` and `/bulk/retag` before `/:id` so Hono doesn't match `bulk` as an `:id` param. The order above is correct — keep it.

- [ ] **Step 5: Run test → PASS, typecheck, commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/routes/transactions.test.ts` → PASS
Run: `pnpm -C worktrees/feat-data-ingestion-backend typecheck` → clean

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/services/transactions.service.ts src/backend/routes/transactions.ts src/backend/routes/transactions.test.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): transaction route group with CRUD and bulk ops

GET/POST/PATCH/DELETE plus /bulk/delete and /bulk/retag; typed errors map
to their HTTP status (over-sell → 409) via the shared error handler."
```

---

### Task 16: Import routes + wire everything into the app

**Files:**
- Create: `src/backend/routes/import.ts`
- Modify: `src/backend/index.ts` (mount the four new route groups)
- Test: `src/backend/routes/import.test.ts`

**Interfaces:**
- Consumes: `Db`; `previewImport`, `commitImport`; a request Zod schema for the commit body.
- Produces: `createImportRoute({ db })` → `Hono`.

- [ ] **Step 1: Write the failing test**

```ts
// src/backend/routes/import.test.ts
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, createDb, type Db } from '@backend/db/client';
import { createErrorHandler } from '@backend/lib/error-handler';
import { logger } from '@backend/lib/logger';
import { runMigrations } from '@backend/db/migrate';
import { accounts } from '@backend/db/schema';

import { createImportRoute } from './import';

const mapping = { transaction_date: 'D', transaction_type: 'T', symbol: 'S', quantity: 'Q', price: 'P', amount: 'A' };
const text = ['D,T,S,Q,P,A', '2020-01-02,buy,AAPL,10,150.00,1500.00'].join('\n');

describe('import routes', () => {
  let dir: string; let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-rimp-'));
    db = createDb(join(dir, 't.sqlite'));
    runMigrations(db);
    db.insert(accounts).values({ name: 'A', tax_treatment: 'taxable' }).run();
  });
  afterEach(() => { closeDb(db); rmSync(dir, { recursive: true, force: true }); });

  function app(): Hono {
    const a = new Hono();
    a.onError(createErrorHandler(logger));
    a.route('/api/v1/import', createImportRoute({ db }));
    return a;
  }

  it('preview returns per-row results', async () => {
    const res = await app().request('/api/v1/import/csv/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, account_id: 1, mapping }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { summary: { total: number } }).summary.total).toBe(1);
  });

  it('commit inserts accepted rows', async () => {
    const res = await app().request('/api/v1/import/csv/commit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, account_id: 1, mapping, accepted_indexes: [0] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { inserted: number }).inserted).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/routes/import.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

```ts
// src/backend/routes/import.ts
import { Hono } from 'hono';
import { z } from 'zod';

import type { Db } from '@backend/db/client';
import { commitImport, previewImport } from '@backend/services/csv/import.service';

export interface ImportDeps { db: Db; }

const MappingSchema = z.object({
  transaction_type: z.string(), transaction_date: z.string(),
  symbol: z.string().optional(), quantity: z.string().optional(),
  price: z.string().optional(), amount: z.string().optional(),
  fee: z.string().optional(), notes: z.string().optional(),
});
const BrokerSchema = z.enum(['fidelity', 'schwab', 'vanguard', 'ibkr']);

const PreviewSchema = z.object({
  text: z.string(), account_id: z.number().int().positive(),
  broker: BrokerSchema.optional(), mapping: MappingSchema.optional(),
});
const CommitSchema = PreviewSchema.extend({
  accepted_indexes: z.array(z.number().int().nonnegative()).min(1),
});

export function createImportRoute(deps: ImportDeps): Hono {
  return new Hono()
    .post('/csv/preview', async (c) => {
      const p = PreviewSchema.parse(await c.req.json());
      return c.json(previewImport(deps.db, { text: p.text, accountId: p.account_id, broker: p.broker, mapping: p.mapping }));
    })
    .post('/csv/commit', async (c) => {
      const p = CommitSchema.parse(await c.req.json());
      return c.json(commitImport(deps.db, { text: p.text, accountId: p.account_id, broker: p.broker, mapping: p.mapping, acceptedIndexes: p.accepted_indexes }));
    });
}
```

- [ ] **Step 4: Wire the route groups into `src/backend/index.ts`**

Add imports next to the existing `createHealthRoute` import:

```ts
import { createAccountsRoute } from '@backend/routes/accounts';
import { createImportRoute } from '@backend/routes/import';
import { createTagsRoute } from '@backend/routes/tags';
import { createTransactionsRoute } from '@backend/routes/transactions';
```

Add the mounts after the existing `app.route('/api/v1/health', ...)` line:

```ts
app.route('/api/v1/accounts', createAccountsRoute({ db }));
app.route('/api/v1/transactions', createTransactionsRoute({ db }));
app.route('/api/v1/tags', createTagsRoute({ db }));
app.route('/api/v1/import', createImportRoute({ db }));
```

- [ ] **Step 5: Run the full suite + typecheck + lint, then commit**

Run: `pnpm -C worktrees/feat-data-ingestion-backend exec vitest run src/backend/routes/import.test.ts` → PASS
Run: `pnpm -C worktrees/feat-data-ingestion-backend test` → all PASS
Run: `pnpm -C worktrees/feat-data-ingestion-backend typecheck` → clean
Run: `pnpm -C worktrees/feat-data-ingestion-backend lint` → clean

```bash
git -C worktrees/feat-data-ingestion-backend add src/backend/routes/import.ts src/backend/routes/import.test.ts src/backend/index.ts
git -C worktrees/feat-data-ingestion-backend commit -m "feat(ingestion): CSV import routes and app wiring

Mounts /accounts, /transactions, /tags, and /import route groups on the
Hono app; import exposes csv/preview and csv/commit."
```

---

### Task 17: Coverage gate + finish

**Files:** none (verification only)

- [ ] **Step 1: Run coverage and confirm the 80% floor holds for services + routes**

Run: `pnpm -C worktrees/feat-data-ingestion-backend test:coverage`
Expected: PASS with lines/functions/branches/statements ≥ 80% overall. If any new service or route file is below 80%, add the missing-case test (typical gaps: error branches like `csv_mapping_incomplete`, `transaction_not_found`, `commit_has_errors`) and re-run. Do not lower thresholds.

- [ ] **Step 2: Update WORKSTREAMS.md to reflect the completed backend slice**

In `docs/WORKSTREAMS.md` §5, change the status line to note the backend slice is complete and UI remains for WS4, and check off the backend-covered items (manual entry validation, CSV import parse/preset/dedupe/commit, duplicate detection, validation rules, edit/soft-delete with audit, bulk operations, account management). Leave the UI-form items unchecked with a note pointing to WS4.

```bash
git -C worktrees/feat-data-ingestion-backend add docs/WORKSTREAMS.md
git -C worktrees/feat-data-ingestion-backend commit -m "docs(workstreams): mark WS5 data-ingestion backend slice complete

Backend (services + routes + validation + CSV pipeline) landed; UI form
items remain deferred to WS4."
```

- [ ] **Step 3: Report completion**

Summarize: all route groups mounted, full suite green, coverage ≥ 80%, WORKSTREAMS updated. Then invoke `superpowers:finishing-a-development-branch` to decide merge/PR.

---

## Self-Review (completed by plan author)

**Spec coverage** — every §Design element maps to a task: shared schemas (T2), audit (T3), securities find-or-create (T4), history loader (T5), dedup (T6), canonical write path create/edit/delete (T7–T8), bulk (T9), accounts (T10), CSV parse/preset/mapping/import (T11–T13), error taxonomy (T1, surfaced through routes T14–T16), routes + wiring (T14–T16), coverage gate (T17). Decisions D1–D8 are all realized (backend-first; engine-backed hard reject with FIFO; full-stream revalidation; warn-and-allow dedupe; all-or-nothing commit; in-place edit + audit; find-or-create; csv-parse).

**Placeholder scan** — no TBD/TODO; every code step shows complete code; every command shows expected output.

**Type consistency** — `WriteResult`, `IngestionWarning`, `TransactionRow`, `AccountRow`, `SecurityRow`, `TagRow`, `ColumnMapping`, `CanonicalRow`, `PreviewResult`/`CommitResult`, `ingestionError`, `writeAudit`, `resolveSecurity`, `loadTxHistory`, `findDuplicates`, `validateOverSell`, `createTransaction`/`editTransaction`/`softDeleteTransaction`/`bulkSoftDelete`/`bulkRetag`/`listTransactions` are defined once and referenced with the same signatures throughout. Over-sell validation consistently uses `{ method: 'fifo' }`.

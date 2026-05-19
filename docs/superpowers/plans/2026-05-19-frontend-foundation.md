# Frontend foundation (WS4) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the React frontend's foundational primitives (TanStack Router + Query, Zustand, Tailwind v4, shadcn/ui, theme, app shell, Money formatting) and prove the full stack end-to-end with a read-only Accounts list page backed by a new `GET /api/v1/accounts` route.

**Architecture:** TanStack Router file-based routing under `src/frontend/routes/`, TanStack Query for server state, Zustand (with `persist`) for sidebar/theme client state, Tailwind v4 CSS-first config with `@theme` tokens, shadcn/ui primitives copied into `components/ui/`, route-level error boundaries reading the backend's `{ code, message, context }` error envelope. Backend gets one new route (`createAccountsRoute`) following the existing `createHealthRoute` pattern.

**Tech Stack:** React 18, TypeScript strict, Vite 5, Tailwind v4, TanStack Router/Query, Zustand, shadcn/ui, Hono, Drizzle (better-sqlite3), Vitest + Testing Library + jsdom.

**Spec:** [docs/specs/2026-05-19-frontend-foundation-design.md](../../specs/2026-05-19-frontend-foundation-design.md)

---

## Branch and worktree

All work happens on `feat/frontend-foundation`. Follow the [worktree convention in CLAUDE.md](../../../CLAUDE.md#worktrees) if isolating.

```bash
pnpm worktree feat/frontend-foundation
cd worktrees/feat-frontend-foundation
pnpm install
```

For inline (non-worktree) work:

```bash
git checkout -b feat/frontend-foundation
```

---

## File map

**Created:**

- `src/backend/routes/accounts.ts` — `createAccountsRoute(deps)` Hono factory
- `src/backend/routes/accounts.test.ts` — integration test against fixture DB
- `src/shared/schemas/account.ts` — Zod `AccountSchema`, `AccountsResponseSchema`
- `src/shared/schemas/account.test.ts` — schema unit tests
- `src/frontend/styles.css` — Tailwind v4 entry + `@theme` tokens
- `src/frontend/stores/ui-store.ts` — Zustand store (theme, sidebarCollapsed)
- `src/frontend/stores/ui-store.test.ts` — persist round-trip test
- `src/frontend/components/theme-provider.tsx` — applies `data-theme` to `<html>`
- `src/frontend/components/theme-provider.test.tsx` — system / light / dark switching
- `src/frontend/components/app-shell.tsx`
- `src/frontend/components/sidebar.tsx`
- `src/frontend/components/error-boundary.tsx`
- `src/frontend/components/ui/*` — shadcn-generated: button, card, table, select, skeleton
- `src/frontend/lib/api.ts` — `apiGet<T>`, `ApiError`
- `src/frontend/lib/query-client.ts` — shared `QueryClient`
- `src/frontend/lib/format.ts` — re-exports `format` as `formatMoney`; `formatDate`
- `src/frontend/lib/format.test.ts` — frontend re-export smoke test
- `src/frontend/lib/utils.ts` — shadcn's `cn()` helper
- `src/frontend/routes/__root.tsx` — root layout with AppShell + providers
- `src/frontend/routes/index.tsx` — redirect to `/dashboard`
- `src/frontend/routes/dashboard.tsx` — placeholder
- `src/frontend/routes/accounts.tsx` — vertical slice
- `src/frontend/routes/settings.tsx` — theme picker, DB path display
- `components.json` — shadcn config

**Modified:**

- `package.json` — new deps
- `vite.config.ts` — add `@tailwindcss/vite` and `@tanstack/router-plugin`
- `vitest.config.ts` — include `.tsx`, exclude `routeTree.gen.ts`
- `tsconfig.json` — add `@frontend/components/ui/*` is already covered by `@frontend/*`; only add `routeTree.gen.ts` to includes
- `src/frontend/main.tsx` — replace with router + providers wiring
- `src/frontend/App.tsx` — **deleted** (replaced by routes)
- `src/frontend/index.html` — add styles.css link
- `.gitignore` — add `routeTree.gen.ts`

---

## Task 1: Backend — shared Account Zod schema

**Files:**

- Create: `src/shared/schemas/account.ts`
- Test: `src/shared/schemas/account.test.ts`

The schema is the single source of truth for the wire shape — used by the backend to validate responses before sending and by the frontend to type the parsed JSON.

- [ ] **Step 1: Write the failing tests**

Write `src/shared/schemas/account.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { AccountSchema, AccountsResponseSchema } from './account';

describe('AccountSchema', () => {
  const valid = {
    id: 1,
    name: 'Brokerage',
    broker: 'Fidelity',
    taxTreatment: 'taxable',
    costBasisMethod: 'fifo',
    currencyCode: 'USD',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts a valid account', () => {
    expect(AccountSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a null broker', () => {
    expect(AccountSchema.safeParse({ ...valid, broker: null }).success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const { name: _name, ...rest } = valid;
    expect(AccountSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an unknown tax treatment', () => {
    expect(AccountSchema.safeParse({ ...valid, taxTreatment: 'crypto' }).success).toBe(false);
  });

  it('rejects an unknown cost basis method', () => {
    expect(AccountSchema.safeParse({ ...valid, costBasisMethod: 'hifo' }).success).toBe(false);
  });
});

describe('AccountsResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(AccountsResponseSchema.safeParse({ accounts: [] }).success).toBe(true);
  });

  it('rejects missing accounts key', () => {
    expect(AccountsResponseSchema.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
pnpm exec vitest run src/shared/schemas/account.test.ts
```

Expected: FAIL (`AccountSchema` not exported).

- [ ] **Step 3: Implement the schema**

Write `src/shared/schemas/account.ts`:

```ts
import { z } from 'zod';

export const TaxTreatmentSchema = z.enum(['taxable', 'tax_deferred', 'tax_free']);
export const CostBasisMethodSchema = z.enum(['fifo', 'lifo', 'specific']);

export const AccountSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  broker: z.string().nullable(),
  taxTreatment: TaxTreatmentSchema,
  costBasisMethod: CostBasisMethodSchema,
  currencyCode: z.string().length(3),
  createdAt: z.string().datetime(),
});

export type Account = z.infer<typeof AccountSchema>;

export const AccountsResponseSchema = z.object({
  accounts: z.array(AccountSchema),
});

export type AccountsResponse = z.infer<typeof AccountsResponseSchema>;
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
pnpm exec vitest run src/shared/schemas/account.test.ts
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/schemas/account.ts src/shared/schemas/account.test.ts
git commit -m "feat(shared): add Account Zod schema for /api/v1/accounts wire shape"
```

---

## Task 2: Backend — accounts route + integration test

**Files:**

- Create: `src/backend/routes/accounts.ts`
- Test: `src/backend/routes/accounts.test.ts`
- Modify: `src/backend/index.ts` (mount the route)

Follows the `createHealthRoute` pattern. Uses `activeFilter()` for soft-delete, maps snake_case DB columns → camelCase wire shape, validates with `AccountsResponseSchema` before sending (catches schema drift in tests, ignored in production).

- [ ] **Step 1: Write the failing integration test**

Write `src/backend/routes/accounts.test.ts`:

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '@backend/db/client';
import * as schema from '@backend/db/schema';
import { createAccountsRoute } from './accounts';

describe('GET /api/v1/accounts', () => {
  let db: Db;

  beforeEach(() => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    db = drizzle(sqlite, { schema }) as Db;
    migrate(db, { migrationsFolder: resolve(__dirname, '../../../migrations') });
  });

  afterEach(() => {
    db.$client.close();
  });

  it('returns an empty list when no accounts exist', async () => {
    const app = createAccountsRoute({ db });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ accounts: [] });
  });

  it('returns active accounts and excludes soft-deleted ones', async () => {
    const now = new Date();
    db.insert(schema.accounts)
      .values([
        {
          name: 'Active 1',
          broker: 'Fidelity',
          tax_treatment: 'taxable',
          cost_basis_method: 'fifo',
          currency_code: 'USD',
          created_at: now,
          updated_at: now,
          deleted_at: null,
        },
        {
          name: 'Active 2',
          broker: null,
          tax_treatment: 'tax_deferred',
          cost_basis_method: 'lifo',
          currency_code: 'USD',
          created_at: now,
          updated_at: now,
          deleted_at: null,
        },
        {
          name: 'Deleted',
          broker: 'Schwab',
          tax_treatment: 'taxable',
          cost_basis_method: 'fifo',
          currency_code: 'USD',
          created_at: now,
          updated_at: now,
          deleted_at: now,
        },
      ])
      .run();

    const app = createAccountsRoute({ db });
    const res = await app.request('/');
    const body = (await res.json()) as { accounts: Array<{ name: string; broker: string | null }> };
    expect(res.status).toBe(200);
    expect(body.accounts).toHaveLength(2);
    expect(body.accounts.map((a) => a.name).sort()).toEqual(['Active 1', 'Active 2']);
    expect(body.accounts.find((a) => a.name === 'Active 2')?.broker).toBeNull();
  });

  it('maps DB snake_case columns to camelCase wire shape', async () => {
    const now = new Date();
    db.insert(schema.accounts)
      .values({
        name: 'Test',
        broker: null,
        tax_treatment: 'taxable',
        cost_basis_method: 'fifo',
        currency_code: 'USD',
        created_at: now,
        updated_at: now,
        deleted_at: null,
      })
      .run();

    const app = createAccountsRoute({ db });
    const res = await app.request('/');
    const body = (await res.json()) as { accounts: Array<Record<string, unknown>> };
    const a = body.accounts[0];
    expect(a).toMatchObject({
      name: 'Test',
      broker: null,
      taxTreatment: 'taxable',
      costBasisMethod: 'fifo',
      currencyCode: 'USD',
    });
    expect(typeof a?.createdAt).toBe('string');
    // No snake_case leakage
    expect(a).not.toHaveProperty('tax_treatment');
    expect(a).not.toHaveProperty('cost_basis_method');
    expect(a).not.toHaveProperty('currency_code');
  });
});
```

- [ ] **Step 2: Run, verify it fails**

```bash
pnpm exec vitest run src/backend/routes/accounts.test.ts
```

Expected: FAIL (`createAccountsRoute` not exported).

- [ ] **Step 3: Implement the route**

Write `src/backend/routes/accounts.ts`:

```ts
import { Hono } from 'hono';

import type { Db } from '@backend/db/client';
import { accounts } from '@backend/db/schema';
import { activeFilter } from '@backend/db/soft-delete';

import { AccountsResponseSchema, type AccountsResponse } from '@shared/schemas/account';

export interface AccountsDeps {
  db: Db;
}

export function createAccountsRoute(deps: AccountsDeps): Hono {
  return new Hono().get('/', (c) => {
    const rows = deps.db.select().from(accounts).where(activeFilter(accounts)).all();
    const body: AccountsResponse = {
      accounts: rows.map((r) => ({
        id: r.id,
        name: r.name,
        broker: r.broker,
        taxTreatment: r.tax_treatment as AccountsResponse['accounts'][number]['taxTreatment'],
        costBasisMethod:
          r.cost_basis_method as AccountsResponse['accounts'][number]['costBasisMethod'],
        currencyCode: r.currency_code,
        createdAt: r.created_at.toISOString(),
      })),
    };
    // Throws on drift — exposes the bug in tests; in prod the error handler
    // converts the throw to a 500 envelope.
    AccountsResponseSchema.parse(body);
    return c.json(body);
  });
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
pnpm exec vitest run src/backend/routes/accounts.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Mount the route in `src/backend/index.ts`**

Add the import and `app.route` line:

```ts
import { createAccountsRoute } from '@backend/routes/accounts';
```

```ts
app.route('/api/v1/accounts', createAccountsRoute({ db }));
```

Place the route registration immediately after the existing `app.route('/api/v1/health', ...)` line.

- [ ] **Step 6: Manually verify against a running dev DB**

```bash
pnpm dev:backend &
sleep 2
curl -s http://127.0.0.1:8787/api/v1/accounts | head -c 200
kill %1
```

Expected: `{"accounts":[...]}` (may be `{"accounts":[]}` if no data exists; either is fine).

- [ ] **Step 7: Commit**

```bash
git add src/backend/routes/accounts.ts src/backend/routes/accounts.test.ts src/backend/index.ts
git commit -m "feat(backend): GET /api/v1/accounts route with soft-delete filtering"
```

---

## Task 3: Install frontend runtime dependencies

This is one batched `pnpm add` — fewer permission prompts. shadcn's Radix sub-deps come in per-component in Task 9; not installed here.

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Install runtime deps**

```bash
pnpm add \
  @tanstack/react-query \
  @tanstack/react-router \
  zustand \
  tailwindcss@^4 \
  @tailwindcss/vite \
  class-variance-authority \
  clsx \
  tailwind-merge \
  lucide-react
```

- [ ] **Step 2: Install dev deps**

```bash
pnpm add -D \
  @tanstack/react-query-devtools \
  @tanstack/router-devtools \
  @tanstack/router-plugin \
  @testing-library/react \
  @testing-library/jest-dom \
  @testing-library/user-event \
  jsdom
```

- [ ] **Step 3: Verify install succeeded**

```bash
pnpm typecheck
```

Expected: existing code still typechecks (no new code added yet).

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add TanStack Router/Query, Zustand, Tailwind v4, shadcn/testing deps"
```

---

## Task 4: Tailwind v4 wiring + theme tokens

**Files:**

- Create: `src/frontend/styles.css`
- Modify: `vite.config.ts`, `src/frontend/index.html`

- [ ] **Step 1: Write `src/frontend/styles.css`**

```css
@import 'tailwindcss';

@theme {
  --color-bg: oklch(98% 0.005 250);
  --color-fg: oklch(20% 0.01 250);
  --color-muted: oklch(60% 0.02 250);
  --color-accent: oklch(55% 0.18 250);
  --color-loss: oklch(58% 0.2 25);
  --color-gain: oklch(55% 0.16 145);
  --color-border: oklch(90% 0.01 250);
  --radius: 6px;
}

[data-theme='dark'] {
  --color-bg: oklch(18% 0.01 250);
  --color-fg: oklch(95% 0.005 250);
  --color-muted: oklch(60% 0.015 250);
  --color-border: oklch(30% 0.01 250);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --color-bg: oklch(18% 0.01 250);
    --color-fg: oklch(95% 0.005 250);
    --color-muted: oklch(60% 0.015 250);
    --color-border: oklch(30% 0.01 250);
  }
}

html,
body {
  background: var(--color-bg);
  color: var(--color-fg);
}

body {
  margin: 0;
  font-family:
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
}
```

- [ ] **Step 2: Add Tailwind to `vite.config.ts`**

Edit `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'src/frontend',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@frontend': path.resolve(__dirname, 'src/frontend'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    outDir: '../../dist/frontend',
    emptyOutDir: true,
  },
});
```

- [ ] **Step 3: Reference `styles.css` from `src/frontend/index.html`**

Replace `index.html` with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OpenPortfolio</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

(`styles.css` is imported from `main.tsx` in Task 13, not from HTML.)

- [ ] **Step 4: Smoke test — typecheck still passes**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/styles.css vite.config.ts src/frontend/index.html
git commit -m "feat(frontend): Tailwind v4 wiring with @theme tokens (light + dark)"
```

---

## Task 5: Vitest config for component tests

Add `.tsx` to the include glob, exclude the (soon-to-be-generated) `routeTree.gen.ts`, and add a setup file for `@testing-library/jest-dom`.

**Files:**

- Create: `tests/setup.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Write `tests/setup.ts`**

```ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 2: Edit `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@backend': path.resolve(__dirname, 'src/backend'),
      '@frontend': path.resolve(__dirname, 'src/frontend'),
      '@mcp': path.resolve(__dirname, 'src/mcp'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/routeTree.gen.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/frontend/main.tsx',
        'src/frontend/routes/__root.tsx',
        'src/frontend/routeTree.gen.ts',
        'src/electron/**',
        'src/**/index.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
```

Per-file environment overrides via `// @vitest-environment jsdom` pragmas at the top of component test files; we don't flip the global default because most tests are node-side.

- [ ] **Step 3: Run existing tests to verify nothing broke**

```bash
pnpm test
```

Expected: all existing tests still pass; setup file does not interfere with node-environment tests.

- [ ] **Step 4: Commit**

```bash
git add tests/setup.ts vitest.config.ts
git commit -m "test: support .tsx tests, add jest-dom matchers, exclude generated route tree"
```

---

## Task 6: Zustand UI store with persist

**Files:**

- Create: `src/frontend/stores/ui-store.ts`
- Test: `src/frontend/stores/ui-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { useUiStore } from './ui-store';

describe('useUiStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.persist.clearStorage();
    useUiStore.setState({ theme: 'system', sidebarCollapsed: false });
  });

  it('exposes a default theme of "system"', () => {
    expect(useUiStore.getState().theme).toBe('system');
  });

  it('exposes a default sidebarCollapsed of false', () => {
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('setTheme updates the theme', () => {
    useUiStore.getState().setTheme('dark');
    expect(useUiStore.getState().theme).toBe('dark');
  });

  it('toggleSidebar flips sidebarCollapsed', () => {
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it('persists state to localStorage', async () => {
    useUiStore.getState().setTheme('light');
    useUiStore.getState().toggleSidebar();
    // persist middleware writes synchronously after state change
    const raw = localStorage.getItem('openportfolio-ui-v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.state.theme).toBe('light');
    expect(parsed.state.sidebarCollapsed).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
pnpm exec vitest run src/frontend/stores/ui-store.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement the store**

```ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export type Theme = 'system' | 'light' | 'dark';

interface UiState {
  theme: Theme;
  sidebarCollapsed: boolean;
  setTheme: (t: Theme) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'system',
      sidebarCollapsed: false,
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    {
      name: 'openportfolio-ui-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ theme: state.theme, sidebarCollapsed: state.sidebarCollapsed }),
    },
  ),
);
```

- [ ] **Step 4: Run, verify pass**

```bash
pnpm exec vitest run src/frontend/stores/ui-store.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/stores/ui-store.ts src/frontend/stores/ui-store.test.ts
git commit -m "feat(frontend): Zustand UI store for theme and sidebar state with persist"
```

---

## Task 7: Theme provider

Applies `data-theme` to `<html>` based on `useUiStore.theme`. When theme is `'system'`, omits the attribute so the CSS `@media (prefers-color-scheme: dark)` rule wins. Watches `prefers-color-scheme` changes so the app repaints live.

**Files:**

- Create: `src/frontend/components/theme-provider.tsx`
- Test: `src/frontend/components/theme-provider.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom

import { render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUiStore } from '@frontend/stores/ui-store';
import { ThemeProvider } from './theme-provider';

describe('ThemeProvider', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    useUiStore.setState({ theme: 'system', sidebarCollapsed: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits data-theme when theme is "system"', () => {
    render(<ThemeProvider />);
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('sets data-theme="light" when theme is "light"', () => {
    useUiStore.setState({ theme: 'light' });
    render(<ThemeProvider />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('sets data-theme="dark" when theme is "dark"', () => {
    useUiStore.setState({ theme: 'dark' });
    render(<ThemeProvider />);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('updates the attribute when theme changes', () => {
    render(<ThemeProvider />);
    act(() => useUiStore.setState({ theme: 'dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    act(() => useUiStore.setState({ theme: 'system' }));
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
pnpm exec vitest run src/frontend/components/theme-provider.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement the provider**

```tsx
import { useEffect } from 'react';

import { useUiStore } from '@frontend/stores/ui-store';

export function ThemeProvider(): null {
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  // Watch system preference so the live UI repaints when the OS theme
  // changes while the app is open. The CSS @media rule handles painting;
  // this effect just forces a re-render-friendly no-op state touch.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (): void => {
      // No state change needed — the CSS media query repaints automatically.
      // We keep the listener registered to keep this component's contract
      // observable in browsers' devtools, and as an explicit extension point.
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return null;
}
```

- [ ] **Step 4: Run, verify pass**

```bash
pnpm exec vitest run src/frontend/components/theme-provider.test.tsx
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/components/theme-provider.tsx src/frontend/components/theme-provider.test.tsx
git commit -m "feat(frontend): ThemeProvider applies data-theme from ui-store"
```

---

## Task 8: API client + ApiError

**Files:**

- Create: `src/frontend/lib/api.ts`
- Test: `src/frontend/lib/api.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiGet } from './api';

describe('apiGet', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns parsed JSON on 2xx', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const result = await apiGet<{ ok: boolean }>('/api/v1/test');
    expect(result).toEqual({ ok: true });
  });

  it('throws ApiError with parsed envelope on 4xx', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: 'not_found', message: 'no such thing', context: { id: 42 } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(apiGet('/api/v1/missing')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'not_found',
      message: 'no such thing',
      context: { id: 42 },
      status: 404,
    });
  });

  it('throws ApiError with synthetic envelope when body is not JSON', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('upstream is on fire', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const err = await apiGet('/api/v1/boom').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('network.unexpected_response');
    expect((err as ApiError).status).toBe(500);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
pnpm exec vitest run src/frontend/lib/api.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export interface ErrorEnvelope {
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly name = 'ApiError';
  readonly code: string;
  readonly status: number;
  readonly context?: Record<string, unknown>;

  constructor(envelope: ErrorEnvelope, status: number) {
    super(envelope.message);
    this.code = envelope.code;
    this.status = status;
    this.context = envelope.context;
  }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (res.ok) {
    return (await res.json()) as T;
  }
  let envelope: ErrorEnvelope;
  try {
    const body = (await res.json()) as Partial<ErrorEnvelope>;
    envelope = {
      code: body.code ?? 'network.unexpected_response',
      message: body.message ?? `Request failed with status ${res.status}`,
      context: body.context,
    };
  } catch {
    envelope = {
      code: 'network.unexpected_response',
      message: `Request failed with status ${res.status}`,
    };
  }
  throw new ApiError(envelope, res.status);
}
```

- [ ] **Step 4: Run, verify pass**

```bash
pnpm exec vitest run src/frontend/lib/api.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/lib/api.ts src/frontend/lib/api.test.ts
git commit -m "feat(frontend): typed apiGet wrapper with ApiError envelope parsing"
```

---

## Task 9: QueryClient + format re-export + cn util

These three are small enough to land together; no real logic in any of them.

**Files:**

- Create: `src/frontend/lib/query-client.ts`
- Create: `src/frontend/lib/format.ts`
- Create: `src/frontend/lib/format.test.ts`
- Create: `src/frontend/lib/utils.ts`

- [ ] **Step 1: Write `query-client.ts`**

```ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
```

- [ ] **Step 2: Write `format.ts`**

```ts
import { format } from '@shared/money';

export { format as formatMoney } from '@shared/money';

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

// Type-only re-export so callers don't need a separate import.
export type { Money } from '@shared/money';

// Keep `format` reachable for tests asserting the re-export resolves.
export const __reexports = { format };
```

- [ ] **Step 3: Write the smoke test `format.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

import { format as sharedFormat, ofCents } from '@shared/money';
import { formatMoney, __reexports } from './format';

describe('formatMoney re-export', () => {
  it('resolves to @shared/money.format', () => {
    expect(formatMoney).toBe(sharedFormat);
    expect(__reexports.format).toBe(sharedFormat);
  });

  it('produces the same output as @shared/money.format', () => {
    const m = ofCents(123_456);
    expect(formatMoney(m)).toBe(sharedFormat(m));
  });
});
```

- [ ] **Step 4: Write `utils.ts` (shadcn's `cn` helper)**

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 5: Run all four files' tests**

```bash
pnpm exec vitest run src/frontend/lib/format.test.ts
pnpm typecheck
```

Expected: format test PASS (2 tests); typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/lib/
git commit -m "feat(frontend): QueryClient, format re-export, cn() utility"
```

---

## Task 10: shadcn/ui init + base primitives

shadcn writes components into `src/frontend/components/ui/`. Run the CLI non-interactively by writing `components.json` first.

**Files:**

- Create: `components.json`
- Create: `src/frontend/components/ui/{button,card,table,select,skeleton}.tsx` (via CLI)

- [ ] **Step 1: Write `components.json` at the repo root**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/frontend/styles.css",
    "baseColor": "slate",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@frontend/components",
    "utils": "@frontend/lib/utils",
    "ui": "@frontend/components/ui",
    "lib": "@frontend/lib",
    "hooks": "@frontend/hooks"
  }
}
```

- [ ] **Step 2: Install the five base primitives**

```bash
pnpm dlx shadcn@latest add button card table select skeleton
```

Expected: writes `src/frontend/components/ui/{button,card,table,select,skeleton}.tsx`; adds `@radix-ui/react-*` deps to `package.json` as needed.

If the CLI prompts to overwrite `styles.css`, **decline** — our `@theme` block must be preserved. (The CLI may want to add its own CSS variables; if it does, port them into our `@theme` block manually rather than letting it overwrite.)

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components.json src/frontend/components/ui/ package.json pnpm-lock.yaml
git commit -m "feat(frontend): shadcn/ui init + button, card, table, select, skeleton"
```

---

## Task 11: TanStack Router setup with vite plugin

The router plugin watches `src/frontend/routes/` and generates `routeTree.gen.ts`. Add it to `.gitignore`.

**Files:**

- Modify: `vite.config.ts`, `.gitignore`
- Create: `src/frontend/routes/__root.tsx` (skeleton — full layout in Task 13)
- Create: `src/frontend/routes/index.tsx`
- Create: `src/frontend/routes/dashboard.tsx`
- Create: `src/frontend/routes/settings.tsx`
- Create: `src/frontend/routes/accounts.tsx` (skeleton — fleshed out in Task 14)

- [ ] **Step 1: Add the router plugin to `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'src/frontend',
  plugins: [
    TanStackRouterVite({
      routesDirectory: path.resolve(__dirname, 'src/frontend/routes'),
      generatedRouteTree: path.resolve(__dirname, 'src/frontend/routeTree.gen.ts'),
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@frontend': path.resolve(__dirname, 'src/frontend'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    outDir: '../../dist/frontend',
    emptyOutDir: true,
  },
});
```

Note: TanStackRouterVite must run **before** `react()`.

- [ ] **Step 2: Update `.gitignore`**

Append:

```
src/frontend/routeTree.gen.ts
```

- [ ] **Step 3: Write `src/frontend/routes/__root.tsx` (skeleton)**

```tsx
import { Outlet, createRootRoute } from '@tanstack/react-router';

import { ThemeProvider } from '@frontend/components/theme-provider';

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent(): JSX.Element {
  return (
    <>
      <ThemeProvider />
      <Outlet />
    </>
  );
}
```

- [ ] **Step 4: Write `src/frontend/routes/index.tsx`**

```tsx
import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/dashboard' });
  },
});
```

- [ ] **Step 5: Write `src/frontend/routes/dashboard.tsx`**

```tsx
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/dashboard')({
  component: DashboardPage,
});

function DashboardPage(): JSX.Element {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--color-muted)' }}>
        Dashboard tiles land in WS7.
      </p>
    </div>
  );
}
```

- [ ] **Step 6: Write `src/frontend/routes/settings.tsx`**

```tsx
import { createFileRoute } from '@tanstack/react-router';

import { useUiStore, type Theme } from '@frontend/stores/ui-store';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage(): JSX.Element {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Theme</h2>
        <div className="mt-2 flex gap-2">
          {(['system', 'light', 'dark'] as Theme[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTheme(t)}
              className="border px-3 py-1 text-sm"
              style={{
                borderColor: 'var(--color-border)',
                fontWeight: theme === t ? 600 : 400,
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Database path</h2>
        <p className="mt-2 text-sm font-mono" style={{ color: 'var(--color-muted)' }}>
          (revealed in WS11 Electron shell)
        </p>
      </section>
    </div>
  );
}
```

- [ ] **Step 7: Write `src/frontend/routes/accounts.tsx` (skeleton, fleshed out in Task 14)**

```tsx
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/accounts')({
  component: AccountsPage,
});

function AccountsPage(): JSX.Element {
  return <div className="p-6">Accounts placeholder</div>;
}
```

- [ ] **Step 8: Typecheck (the route plugin generates the tree on next vite run)**

```bash
pnpm typecheck
```

Expected: typecheck PASS. (`routeTree.gen.ts` is not yet present; tsconfig should still pass since nothing imports it yet.)

- [ ] **Step 9: Commit**

```bash
git add vite.config.ts .gitignore src/frontend/routes/
git commit -m "feat(frontend): TanStack Router skeleton with dashboard/settings/accounts routes"
```

---

## Task 12: Sidebar + AppShell

**Files:**

- Create: `src/frontend/components/sidebar.tsx`
- Create: `src/frontend/components/app-shell.tsx`

- [ ] **Step 1: Write `sidebar.tsx`**

```tsx
import { Link } from '@tanstack/react-router';
import { LayoutDashboard, Wallet, Settings as SettingsIcon, PanelLeft } from 'lucide-react';

import { useUiStore } from '@frontend/stores/ui-store';
import { cn } from '@frontend/lib/utils';

interface NavItem {
  to: '/dashboard' | '/accounts' | '/settings';
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/accounts', label: 'Accounts', icon: Wallet },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function Sidebar(): JSX.Element {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);

  return (
    <aside
      className={cn(
        'flex flex-col border-r transition-[width]',
        collapsed ? 'w-12' : 'w-56',
      )}
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div
        className="flex items-center justify-between border-b p-2"
        style={{ borderColor: 'var(--color-border)' }}
      >
        {!collapsed && <span className="font-semibold">OpenPortfolio</span>}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="ml-auto p-1"
        >
          <PanelLeft size={16} />
        </button>
      </div>
      <nav className="flex flex-col p-1">
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-sm"
            activeProps={{ style: { background: 'var(--color-border)' } }}
          >
            <Icon size={16} />
            {!collapsed && <span>{label}</span>}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
```

- [ ] **Step 2: Write `app-shell.tsx`**

```tsx
import type { ReactNode } from 'react';

import { Sidebar } from './sidebar';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps): JSX.Element {
  return (
    <div className="flex h-screen w-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto">{children}</main>
      {/* Right-hand AI drawer slot reserved for WS9 — empty in WS4. */}
    </div>
  );
}
```

- [ ] **Step 3: Wire AppShell into `__root.tsx`**

Replace `src/frontend/routes/__root.tsx`:

```tsx
import { Outlet, createRootRoute } from '@tanstack/react-router';

import { AppShell } from '@frontend/components/app-shell';
import { ThemeProvider } from '@frontend/components/theme-provider';

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent(): JSX.Element {
  return (
    <>
      <ThemeProvider />
      <AppShell>
        <Outlet />
      </AppShell>
    </>
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/components/sidebar.tsx src/frontend/components/app-shell.tsx src/frontend/routes/__root.tsx
git commit -m "feat(frontend): collapsible sidebar app shell with persistent collapsed state"
```

---

## Task 13: main.tsx wiring (router + query client + styles)

**Files:**

- Modify: `src/frontend/main.tsx`
- Delete: `src/frontend/App.tsx`

- [ ] **Step 1: Replace `src/frontend/main.tsx`**

```tsx
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import React from 'react';
import ReactDOM from 'react-dom/client';

import { queryClient } from '@frontend/lib/query-client';

import './styles.css';
import { routeTree } from './routeTree.gen';

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      {import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 2: Delete `src/frontend/App.tsx`**

```bash
rm src/frontend/App.tsx
```

- [ ] **Step 3: Run `pnpm dev:frontend` to trigger route tree generation**

```bash
timeout 6 pnpm dev:frontend || true
```

The vite plugin generates `src/frontend/routeTree.gen.ts` on first run, then the timeout kills the dev server. Expected: no errors logged before timeout; `routeTree.gen.ts` exists.

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS (the generated route tree now resolves the import in `main.tsx`).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/main.tsx
git rm src/frontend/App.tsx
git commit -m "feat(frontend): wire router + QueryClient providers in main.tsx"
```

---

## Task 14: Accounts page — vertical slice

This is the proof-of-stack. TanStack Query against the real backend route, skeleton during fetch, error boundary on failure, shadcn `<Table>` on success.

**Files:**

- Modify: `src/frontend/routes/accounts.tsx` (flesh out the skeleton)
- Create: `src/frontend/components/error-boundary.tsx`

- [ ] **Step 1: Write `error-boundary.tsx`**

```tsx
import type { ErrorComponentProps } from '@tanstack/react-router';

import { ApiError } from '@frontend/lib/api';

export function RouteErrorBoundary({ error, reset }: ErrorComponentProps): JSX.Element {
  const isApi = error instanceof ApiError;
  const code = isApi ? error.code : 'render.unhandled';
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--color-muted)' }}>
        <code>{code}</code>: {message}
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 border px-3 py-1 text-sm"
        style={{ borderColor: 'var(--color-border)' }}
      >
        Retry
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Replace `src/frontend/routes/accounts.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { RouteErrorBoundary } from '@frontend/components/error-boundary';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@frontend/components/ui/table';
import { Skeleton } from '@frontend/components/ui/skeleton';
import { apiGet } from '@frontend/lib/api';
import { formatDate } from '@frontend/lib/format';

import type { AccountsResponse } from '@shared/schemas/account';
import { AccountsResponseSchema } from '@shared/schemas/account';

export const Route = createFileRoute('/accounts')({
  component: AccountsPage,
  errorComponent: RouteErrorBoundary,
});

async function fetchAccounts(signal: AbortSignal): Promise<AccountsResponse> {
  const raw = await apiGet<unknown>('/api/v1/accounts', signal);
  return AccountsResponseSchema.parse(raw);
}

function AccountsPage(): JSX.Element {
  const { data, isPending, error } = useQuery({
    queryKey: ['accounts'],
    queryFn: ({ signal }) => fetchAccounts(signal),
  });

  if (error) throw error;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Accounts</h1>
      <div className="mt-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Broker</TableHead>
              <TableHead>Tax treatment</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead>Cost-basis method</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending
              ? Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {Array.from({ length: 6 }).map((__, j) => (
                      <TableCell key={`s-${i}-${j}`}>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : data!.accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{a.name}</TableCell>
                    <TableCell>{a.broker ?? '—'}</TableCell>
                    <TableCell>{a.taxTreatment}</TableCell>
                    <TableCell>{a.currencyCode}</TableCell>
                    <TableCell>{a.costBasisMethod}</TableCell>
                    <TableCell>{formatDate(a.createdAt)}</TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the full test suite to check nothing regressed**

```bash
pnpm test
```

Expected: PASS (all prior tests + the new ones from Tasks 1–9).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/routes/accounts.tsx src/frontend/components/error-boundary.tsx
git commit -m "feat(frontend): Accounts page renders /api/v1/accounts with skeleton + error boundary"
```

---

## Task 15: Manual acceptance verification

**Files:** none

This task is verification, not code. Run through the spec's acceptance checklist manually with a real dev server.

- [ ] **Step 1: Start both servers**

```bash
pnpm dev
```

Expected: backend listening on `127.0.0.1:8787`; frontend dev server at `http://localhost:5173`.

- [ ] **Step 2: Verify navigation**

Open `http://localhost:5173/` — should redirect to `/dashboard`. Click Dashboard / Accounts / Settings in the sidebar. Use browser back / forward — URL and active sidebar item should stay in sync.

- [ ] **Step 3: Verify the Accounts table**

Visit `/accounts`. If the DB has accounts, they render. If not, the table renders with empty body. Skeleton is briefly visible during fetch.

To test the error path, stop the backend (`Ctrl+C` on the backend half of `pnpm dev`) and reload `/accounts`. Expect the error boundary's user-readable message with retry button. Restart the backend and click Retry — table re-renders.

- [ ] **Step 4: Verify theme switching**

Visit `/settings`. Click Light → background goes light. Click Dark → background goes dark. Click System → background follows OS theme. Reload — selection persists.

Toggle your OS theme while the System option is active — the app should repaint without reload.

- [ ] **Step 5: Verify sidebar collapse persistence**

Click the panel-left icon to collapse the sidebar to icons. Reload. Sidebar stays collapsed.

- [ ] **Step 6: Run the green-bar checks**

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: all PASS.

- [ ] **Step 7: Verify no unjustified `any`**

```bash
grep -rn ': any' src/frontend src/shared/schemas src/backend/routes/accounts.ts || echo "OK: no bare any"
```

Expected: `OK: no bare any` (or only matches with adjacent `eslint-disable` comments explaining the use).

- [ ] **Step 8: Commit any small fixups discovered**

If anything failed and you had to fix it, commit those fixes with descriptive messages and re-run the checklist. Otherwise no commit needed.

- [ ] **Step 9: Update [docs/WORKSTREAMS.md](../../WORKSTREAMS.md)**

Move WS4 from "Not started" to "Complete" with a `Landed:` checklist mirroring the acceptance criteria. Move the in-progress checklist items into a `Landed:` block; note that the AI drawer slot, write paths, and tile dashboard remain deferred to WS9/WS5/WS7 respectively.

- [ ] **Step 10: Commit the workstream update**

```bash
git add docs/WORKSTREAMS.md
git commit -m "docs(workstreams): mark WS4 frontend foundation complete"
```

---

## Self-review checklist

After implementation, before requesting code review:

- **Spec coverage:** Every acceptance criterion in [the spec](../../specs/2026-05-19-frontend-foundation-design.md) maps to a task above. The five WS4-specific test obligations (formatMoney re-export smoke, theme-provider, ui-store persist, backend route integration, no Money UI display) all have tasks.
- **No placeholders:** Every code block above is complete code, not a stub.
- **Type consistency:** `Account` / `AccountsResponse` are defined once in `@shared/schemas/account` and re-used across Task 2 (backend) and Task 14 (frontend). `Theme` is exported from `@frontend/stores/ui-store` and consumed by settings.tsx and theme-provider.test.tsx.
- **Existing patterns followed:** `createAccountsRoute(deps)` mirrors `createHealthRoute(deps)`. `activeFilter()` is used instead of hand-rolled `deleted_at IS NULL`. Tests are colocated next to the file they cover.

If review surfaces issues, fix them inline and re-run `pnpm typecheck && pnpm lint && pnpm test` before pushing.

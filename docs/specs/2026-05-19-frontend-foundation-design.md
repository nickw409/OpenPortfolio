# Frontend foundation (WS4) — design

**Date:** 2026-05-19
**Workstream:** [WS4 — Frontend foundation (React)](../WORKSTREAMS.md#4-frontend-foundation-react)
**Status:** Approved (pending user review of this spec)

## Goal

Stand up the React frontend with all the primitives downstream workstreams need — routing, server-state and UI-state management, design system, theming, error boundaries, Money formatting — and validate the full stack end-to-end with one thin vertical slice: a read-only accounts list page that fetches real DB rows through a new `GET /api/v1/accounts` route.

The slice is the proof: foundation that hasn't rendered real data is foundation that hides bugs.

## Non-goals

The following are deliberately deferred and must not creep in:

- **Write paths on accounts** (create/edit/archive) — lands with WS5.
- **Dashboard tiles, dnd-kit, layout persistence** — WS7.
- **Money values rendered in the UI** — no positions, no totals, no balances. Accounts table has no money column. `formatMoney` is shipped and unit-tested but not exercised in WS4 UI. First UI consumer is WS3 slice 2 / WS7.
- **AI chat drawer content** — the shell renders the right-hand slot, but no drawer component. WS9.
- **Electron packaging** — `pnpm dev` is the only run target. WS11.
- **Playwright / E2E** — WS12.

## Decisions and rationale

### D1. Scope: foundation + one vertical slice (Accounts list)

Two interpretations were considered:

- **A. Pure foundation.** Primitives only, placeholder Dashboard/Settings pages.
- **B. Foundation + Accounts list vertical** (chosen).

**Why B.** Wires the full chain (TanStack Query → Hono → Drizzle → render) so the stack is proven before WS5/WS7 commit to it. The cost — a small `GET /api/v1/accounts` route pulled forward from WS5 — is trivial relative to the de-risking. The accounts table already exists from WS1; no schema work is needed.

### D2. Routing: TanStack Router

Alternatives:

- **A. TanStack Router** (chosen).
- **B. react-router v6+.**
- **C. No router** — conditional render via Zustand `currentView`.

**Why TanStack Router.** TypeScript-first with typed search params, which matters once the dashboard has bookmarkable state (`?as_of=...&account=...`, named layouts via `?layout=tax-planning`). Same author as TanStack Query, which is already committed in the spec. The bigger learning curve relative to react-router is paid down by the typing dividend; the bigger ecosystem of react-router is not load-bearing for a local-only app.

### D3. State management split: TanStack Query + Zustand from day one

TanStack Query for server state is non-negotiable per the workstream spec. The real question was whether Zustand is justified in WS4 when the only client state is sidebar-collapsed + theme.

**Decision: include Zustand now.** Both pieces of state need `localStorage` persistence; once you reach for `localStorage` you might as well establish the store pattern WS5/WS7 will use. The store stays small (~30 lines) and uses `zustand/middleware/persist` with a versioned `name`.

### D4. Styling: Tailwind v4 (CSS-first config) + shadcn/ui

Tailwind v4 is the workstream-spec'd version. v4's CSS-first config (`@theme { ... }` in `styles.css`) replaces `tailwind.config.ts`; the `@tailwindcss/vite` plugin replaces postcss config. shadcn/ui's CLI generates copy-paste components into `src/frontend/components/ui/` — we own the code.

**Initial shadcn component set:** `button`, `card`, `table`, `select`, `skeleton`. Add others only when a concrete feature needs them.

### D5. Theme resolution: data-theme attribute, system default

Three values: `'system' | 'light' | 'dark'`. Stored in `ui-store`, default `'system'`. The theme provider writes `data-theme` to `<html>`, omitting the attribute when the value is `'system'` so the `prefers-color-scheme` media query handles it. A `useEffect` listens for `prefers-color-scheme` changes so the app repaints live on OS theme switches.

### D6. Money formatter: reuse the existing `format()` in `src/shared/money.ts`

`src/shared/money.ts` already exports `format(m: Money, opts?: FormatOptions): string` using `Intl.NumberFormat` with configurable locale and currency code. No new code needed; `src/frontend/lib/format.ts` re-exports it for the frontend's convenience (and to colocate display-only helpers like `formatDate`).

Rejected: adding a wrapper library (`dinero.js`) — reintroduces float-money risk that the integer-cents `Money` type exists to prevent. The native `Intl.NumberFormat` path is already sufficient.

### D7. QueryClient defaults

`staleTime: 30_000`, `retry: 1`, `refetchOnWindowFocus: false`. This is a local desktop app, not a SaaS dashboard — aggressive refetching is noise. Per-query overrides as needed.

## Architecture

### Dependencies to add

**Runtime:**

- `@tanstack/react-query`, `@tanstack/react-query-devtools`
- `@tanstack/react-router`, `@tanstack/router-devtools`
- `zustand`
- `tailwindcss@4`, `@tailwindcss/vite`
- `class-variance-authority`, `clsx`, `tailwind-merge`
- `lucide-react`
- `@radix-ui/react-*` (per shadcn component installed)

**Dev:**

- `@tanstack/router-plugin` (vite plugin, generates the typed route tree)
- `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`

### File structure

```
src/frontend/
├── index.html
├── main.tsx                      # router + QueryClient providers, theme bootstrap
├── styles.css                    # tailwind v4 entry + @theme tokens
├── routes/
│   ├── __root.tsx                # AppShell layout (sidebar + main + drawer slot)
│   ├── index.tsx                 # / → redirect to /dashboard
│   ├── dashboard.tsx             # placeholder ("Dashboard — coming in WS7")
│   ├── accounts.tsx              # vertical slice
│   └── settings.tsx              # theme picker + db path display
├── components/
│   ├── app-shell.tsx             # sidebar + main + collapse toggle
│   ├── sidebar.tsx
│   ├── error-boundary.tsx
│   ├── theme-provider.tsx
│   └── ui/                       # shadcn-generated primitives
├── lib/
│   ├── query-client.ts
│   ├── api.ts                    # typed fetch wrapper over /api/v1/*
│   └── format.ts
└── stores/
    └── ui-store.ts               # Zustand: { sidebarCollapsed, theme }
```

`routeTree.gen.ts` is generated by the router plugin and gitignored. The current scaffold `src/frontend/App.tsx` is replaced — `main.tsx` becomes the entry that mounts the router.

`format()` (Money → display string) already lives in `src/shared/money.ts`. `src/frontend/lib/format.ts` re-exports it as `formatMoney` and adds display-only helpers (e.g., `formatDate`) that should not be reachable from backend code.

### App shell layout: D (collapsible sidebar)

Persistent left sidebar with labeled nav items by default; collapses to an icon rail via a toggle in the header. Sidebar collapsed state persists across reloads via `ui-store`. Right-hand area reserves the slot for the future AI chat drawer (WS9) but renders nothing there in WS4.

Routes in v1.0 nav: Dashboard, Accounts, Settings. Transactions appears in WS5.

### Theme tokens

`styles.css` defines tokens via Tailwind v4's `@theme` block:

```css
@import "tailwindcss";

@theme {
  --color-bg: oklch(98% 0.005 250);
  --color-fg: oklch(20% 0.01 250);
  --color-muted: oklch(60% 0.02 250);
  --color-accent: oklch(55% 0.18 250);
  --color-loss: oklch(58% 0.20 25);
  --color-gain: oklch(55% 0.16 145);
  --color-border: oklch(90% 0.01 250);
  --radius: 6px;
}

@media (prefers-color-scheme: dark) { :root { /* dark overrides */ } }
[data-theme="light"] { /* explicit light overrides */ }
[data-theme="dark"]  { /* explicit dark overrides */ }
```

`--color-loss` / `--color-gain` are defined now so WS7 inherits them; not used in WS4.

### Accounts vertical slice

**Backend (new):**

- `src/backend/routes/accounts.ts` mounted at `/api/v1/accounts`.
- `GET /api/v1/accounts` returns `{ accounts: Account[] }`.
- `Account = { id, name, broker, taxTreatment, costBasisMethod, currencyCode, createdAt }`. DB columns are snake_case; the route maps to camelCase at the boundary.
- Query uses `activeFilter()` from [src/backend/db/soft-delete.ts](../../src/backend/db/soft-delete.ts) — no hand-rolled `deleted_at IS NULL`.
- Shared Zod schema in `src/shared/schemas/account.ts`; response validated before send (catches schema drift).
- Integration test against a fixture DB (3 accounts, 1 soft-deleted) asserts the soft-deleted row is excluded.

**Frontend:**

- `routes/accounts.tsx` uses `useQuery({ queryKey: ['accounts'], queryFn: () => apiGet<AccountsResponse>('/api/v1/accounts') })`.
- Pending → shadcn `<Skeleton>` rows.
- Error → route-level error boundary renders the `code` / `message` from the API error envelope ([src/shared/errors.ts](../../src/shared/errors.ts)).
- Success → shadcn `<Table>` with columns: Name, Broker, Tax treatment, Currency, Cost-basis method, Created. Empty `broker` displays as `—`.
- No write paths, no row click handler, no filtering, no sort.

### API client and error handling

`lib/api.ts` exports `apiGet<T>(path, signal?)`:

- Throws `ApiError` (extends `Error` with `code`, `context`) on non-2xx; the body is parsed as the `{ code, message, context }` envelope.
- No retry logic — TanStack Query handles retries.
- Accepts an `AbortSignal` so TanStack Query can cancel in-flight requests on unmount.

Route-level error boundaries (`errorComponent` on each TanStack Router route) render a user-readable fallback that prints the envelope `message` and a "retry" button that invalidates the relevant query key. Render errors and bubbled query errors share the same boundary.

## Testing

WS4-specific. Coverage thresholds and CI gating are WS12 work.

- `formatMoney` re-export — one smoke test asserting the frontend re-export resolves to `@shared/money.format`. (The function itself is already covered in [src/shared/money.test.ts](../../src/shared/money.test.ts).)
- `theme-provider` — vitest + `@testing-library/react`. Asserts `data-theme` toggling for `'light' | 'dark' | 'system'` and the system-preference watcher.
- `ui-store` — `persist` middleware round-trips through a stubbed `localStorage`.
- Backend `accounts` route — vitest integration test against a fixture DB.

## Acceptance criteria

- [ ] `pnpm dev` starts both servers; nav between Dashboard / Accounts / Settings works with browser back/forward.
- [ ] Accounts table renders real DB rows; skeleton shows during fetch; error envelope renders user-readably when backend is down.
- [ ] Light / dark / system theme persists across reload; system mode follows OS theme changes live (without reload).
- [ ] Sidebar collapse state persists across reload.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all green.
- [ ] No `any` without an `eslint-disable` comment explaining why.

## Open questions

None — all design forks resolved during the brainstorming session on 2026-05-19.

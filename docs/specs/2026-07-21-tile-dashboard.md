# Tile-based dashboard — design spec

**Status:** Proposed  
**Date:** 2026-07-21  
**Workstream:** [docs/WORKSTREAMS.md](../WORKSTREAMS.md) §7 Tile-based dashboard  
**Depends on:** [Initial schema](2026-05-15-initial-schema-design.md) (layout + tile config tables), [Backend API design](2026-05-18-backend-api-design.md), WS3 financial engine, WS6 price/CPI data

## Context

Workstream 7 delivers the primary user surface of OpenPortfolio v1.0: a configurable dashboard of information tiles. The goal is to give users a coherent at-a-glance view of their portfolio (positions, allocation, returns, drawdown, dividends, etc.) while keeping the system extensible enough to add more tile types later without reworking the grid.

v1.0 scope is deliberately limited: the tile types listed in this spec and no user-defined custom tiles.

---

## T1. Layout storage model

The schema already provides `dashboard_layouts` and `tile_configs` (see initial schema spec §S5). Each layout is a named collection of tiles; one layout can be marked default. Tiles store their grid position and a JSON config blob.

- **A. Fixed grid with absolute coordinates** — each tile stores `x`, `y`, `w`, `h` in `position_json`. Fully flexible, but can produce overlaps or broken layouts if clients disagree on grid width.
- **B. Column-based list with order index** — tiles are a vertical list; no x/y. Simple, but can't render side-by-side charts.
- **C. CSS-grid area names** — position expressed as a named grid area string; layout is a known set of named templates.

**Decision: A with collision enforcement at save time.** A fixed grid matches dashboard UX expectations and lets us render side-by-side tiles. The backend validates that tiles do not overlap and fit inside a default 12-column grid. The config blob carries the height in grid rows (default 4, min 2, max 12).

Tile position schema:

```json
{
  "x": 0,
  "y": 0,
  "w": 6,
  "h": 4
}
```

Layout schema:

```json
{
  "name": "Overview",
  "is_default": true
}
```

Tile config schema:

```json
{
  "tile_type": "positions_table",
  "position_json": "{\"x\":0,\"y\":0,\"w\":12,\"h\":4}",
  "config_json": "{\"accounts\":[],\"asOf\":null}"
}
```

---

## T2. Tile registry

Each tile type is registered in a central registry that lives in the frontend code. The registry defines metadata and the config schema so the dashboard can render any registered tile generically.

- **A. Runtime object registry** — a module exports a `Map<string, TileDefinition>` populated at import time.
- **B. Central switch statement** — a `renderTile(type)` function has a hard-coded `switch`.
- **C. File-system convention** — each tile is a file under `src/frontend/tiles/<type>/`, and a build-time script generates the registry.

**Decision: A.** A runtime registry keeps the code discoverable and testable without a build plugin, while still allowing each tile to live in its own file. The registry is the single source of truth for tile metadata (name, description, default size, allowed sizes, config schema, component).

Registry entry shape:

```ts
export interface TileSize {
  w: number;
  h: number;
}

export interface TileDefinition<TConfig = unknown> {
  type: string;
  name: string;
  description: string;
  defaultSize: TileSize;
  allowedSizes: TileSize[];
  configSchema: z.ZodSchema<TConfig>;
  component: ComponentType<TileComponentProps<TConfig>>;
}
```

Tile components receive common props: `layoutId`, `tileId`, `config`, `onConfigChange`, `className`.

---

## T3. Drag-and-drop + resize

- **A. dnd-kit** — modern, accessible, unopinionated about layout; requires us to compute grid snapping.
- **B. react-grid-layout** — gives grid drag/resize out of the box, but heavier and less flexible for custom tile chrome.
- **C. Build a custom grid engine** — full control, but high effort and risk of subtle accessibility bugs.

**Decision: A with a small custom grid-snapper.** dnd-kit provides the accessible primitives and pointer-event handling; we implement the snap-to-grid math ourselves so tile positions stay integer-aligned. Resize uses native drag handles wired into the same dnd-kit sensors.

Grid constants:
- Columns: 12
- Default tile height rows: 4
- Min tile size: 2×2
- Max tile size: 12×12

The dashboard records tile positions only after a drag/resize ends (pointer up), not continuously, to avoid excessive re-renders and config churn.

---

## T4. First tile types

v1.0 ships with these tiles, in priority order:

1. **Positions table** — account-filterable table of holdings (symbol, quantity, cost basis, current price, unrealized P&L).
2. **Allocation chart** — donut or bar chart by asset class or account; config selects dimension.
3. **Returns timeline** — line chart of portfolio value over time, with optional CPI-real overlay.
4. **Drawdown summary** — max drawdown, current drawdown, peak/trough dates.
5. **Dividend calendar** — upcoming / past 12-month dividends by month.
6. **Transaction feed** — recent transactions with soft-delete actions.
7. **Real-vs-nominal comparison** — small card showing nominal vs real return for a selected range.
8. **Individual position card** — focused view for one security.

This spec covers the framework plus tiles 1–2. Additional tiles are added in follow-up tasks that register a new definition and backend query.

---

## T5. Backend API

Routes mounted at `/api/v1/dashboard`:

- `GET /api/v1/dashboard/layouts` — list layouts with tile count.
- `GET /api/v1/dashboard/layouts/:id` — full layout with tiles.
- `POST /api/v1/dashboard/layouts` — create layout.
- `PATCH /api/v1/dashboard/layouts/:id` — rename / set default.
- `DELETE /api/v1/dashboard/layouts/:id` — soft delete; refuses to delete the only remaining layout.
- `POST /api/v1/dashboard/layouts/:id/tiles` — add a tile.
- `PATCH /api/v1/dashboard/layouts/:id/tiles/:tile_id` — update position or config.
- `DELETE /api/v1/dashboard/layouts/:id/tiles/:tile_id` — soft delete tile.
- `POST /api/v1/dashboard/layouts/:id/reset` — restore default layout tiles.

Validation:
- `position_json` must be valid JSON and fit the 12-column grid without overlap.
- `config_json` must be valid JSON; the backend does not validate tile-specific config shape (the frontend does via the tile's `configSchema`).
- Soft-delete helpers from `src/backend/db/soft-delete.ts` are used for all destructive operations.

---

## T6. Frontend dashboard page

Because WS4 is still in a separate worktree, this workstream builds on the current `main` frontend scaffold (a single `App.tsx` rendered to `#root`) and replaces the scaffolding placeholder with a minimal dashboard shell.

Components:
- `DashboardLayout` — grid container using dnd-kit.
- `TileRenderer` — reads the registry and renders the matching tile component.
- `AddTileFlyout` — list of registered tile types; clicking adds with the default size at the next available grid position.
- `LayoutSwitcher` — tabs/buttons for named layouts with a quick switcher.
- `TileChrome` — header, drag handle, resize handle, settings drawer trigger.

Styling uses Tailwind v4 in the WS4 worktree; in this worktree we use plain CSS custom properties and inline styles so the branch does not depend on unmerged WS4 changes. When WS4 merges, we will adopt its token system.

---

## T7. Persistence flow

1. Dashboard page loads via TanStack Query (or raw fetch in this branch) the default layout.
2. User drags/resizes/adds/removes tiles.
3. Optimistic local state updates immediately; API calls debounce 500 ms.
4. On API success, server state is revalidated; on failure, the local change rolls back and a toast/warning shows.

---

## T8. Testing

- Backend route tests for CRUD and overlap validation.
- Registry test asserting every registered tile has a valid config schema and unique type.
- Grid-snap utility tests for collision detection and next-available-position.
- Tile component tests for positions table and allocation chart using mock data.

---

## Decisions and rationale

- **Fixed grid (A)** chosen over list or named-area approaches because dashboards need side-by-side charts; overlap validation at save time prevents silent broken layouts.
- **Runtime registry (A)** chosen over switch statements or file-system conventions because it balances type safety, discoverability, and build simplicity.
- **dnd-kit (A)** chosen over react-grid-layout because it is lighter, more accessible, and lets us own the grid math rather than fight a third-party layout engine.
- **Backend validates position shape, frontend validates tile config shape** keeps responsibilities clean: the backend knows nothing about individual tile internals.
- **Plain CSS in this branch, adopt WS4 tokens at merge** avoids depending on unmerged Tailwind v4 + shadcn setup while still producing usable UI.

---

## Out of scope (deliberately)

- User-defined custom tiles
- Real-time tile collaboration
- Dashboard templates shared between users
- Widgets that call AI features directly (AI guardrails framework is W8; tiles that display AI output come after it)
- Print / export dashboard layouts

(End of file)

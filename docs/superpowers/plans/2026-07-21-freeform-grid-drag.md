# Free-form Coordinate-Snap Tile Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sortable swap interaction on the dashboard grid with free-form x/y coordinate positioning that snaps to the 12-column grid and reflows displaced tiles directionally.

**Architecture:** All snapping and reflow logic lives in a pure, React-free module `dashboard/grid-snap.ts` (fully unit- and property-tested). `dashboard/grid.tsx` becomes thin dnd-kit wiring: `useDraggable` per tile, pointer + keyboard sensors, measure the container, and on drop call `grid-snap.ts` then dispatch the resulting multi-tile move to the existing `useLayout.reorder` (which hits the atomic reorder endpoint from ADR-0004). No backend change.

**Tech Stack:** React 18, TypeScript, @dnd-kit/core, @tanstack/react-query, vitest + @testing-library/react + fast-check.

**Design spec:** [docs/specs/2026-07-21-freeform-grid-drag.md](../../specs/2026-07-21-freeform-grid-drag.md)

## Global Constraints

- All Bash commands use cwd-free, relative-path forms against the worktree: `pnpm -C worktrees/feat-tile-dashboard exec vitest run <path>`. Read/Edit/Write use absolute paths under `worktrees/feat-tile-dashboard/`.
- Grid constants come from `src/frontend/dashboard/types.ts`: `GRID_COLUMNS = 12`, `ROW_HEIGHT_PX = 48`, `GAP_PX = 8`. `gridStyle()` applies `GAP_PX` padding on each side and `GAP_PX` between columns.
- `TilePosition`, `TileItem` are exported from `src/frontend/dashboard/types.ts`. `TileMove` (`{ tileId: number; position: TilePosition }`) is exported from `src/frontend/dashboard/use-layout.ts`; import it **type-only** (`import type { TileMove }`) so `grid-snap.ts` gains no runtime coupling to the hook.
- Money rule is irrelevant here (no money), but no floats leak into stored positions: all `x/y/w/h` are integers.
- After each task: `pnpm -C worktrees/feat-tile-dashboard exec eslint <files>` and `pnpm -C worktrees/feat-tile-dashboard format` must be clean before commit. Commits follow Conventional Commits; no AI/co-author trailers.
- Scope is **move only**. Do not add resize handles.

---

### Task 1: Grid metrics, pixel-to-cell snapping, and clamping

**Files:**
- Create: `src/frontend/dashboard/grid-snap.ts`
- Test: `src/frontend/dashboard/grid-snap.test.ts`

**Interfaces:**
- Consumes: `GRID_COLUMNS`, `ROW_HEIGHT_PX`, `GAP_PX`, `type TilePosition` from `./types`.
- Produces:
  - `interface GridMetrics { colStride: number; rowStride: number }`
  - `gridMetrics(containerWidth: number): GridMetrics`
  - `pixelDeltaToCells(deltaXpx: number, deltaYpx: number, metrics: GridMetrics): { dx: number; dy: number }`
  - `clampPosition(pos: TilePosition): TilePosition`

- [ ] **Step 1: Write the failing test**

Create `src/frontend/dashboard/grid-snap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { gridMetrics, pixelDeltaToCells, clampPosition } from './grid-snap';

describe('gridMetrics', () => {
  it('derives column and row strides from container width', () => {
    // width 800: usable = 800 - 2*8 - 11*8 = 696; colWidth = 58; colStride = 66.
    const m = gridMetrics(800);
    expect(m.colStride).toBeCloseTo(66);
    expect(m.rowStride).toBe(56); // ROW_HEIGHT_PX 48 + GAP_PX 8
  });
});

describe('pixelDeltaToCells', () => {
  const m = { colStride: 66, rowStride: 56 };
  it('rounds to the nearest whole cell', () => {
    expect(pixelDeltaToCells(132, 56, m)).toEqual({ dx: 2, dy: 1 });
    expect(pixelDeltaToCells(-66, 0, m)).toEqual({ dx: -1, dy: 0 });
  });
  it('rounds a half cell away from zero', () => {
    expect(pixelDeltaToCells(33, 28, m)).toEqual({ dx: 1, dy: 1 });
  });
});

describe('clampPosition', () => {
  it('pins x, y, and x+w inside the grid', () => {
    expect(clampPosition({ x: -3, y: -2, w: 4, h: 4 })).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    expect(clampPosition({ x: 11, y: 5, w: 4, h: 4 })).toEqual({ x: 8, y: 5, w: 4, h: 4 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-tile-dashboard exec vitest run src/frontend/dashboard/grid-snap.test.ts`
Expected: FAIL — cannot resolve `./grid-snap`.

- [ ] **Step 3: Write minimal implementation**

Create `src/frontend/dashboard/grid-snap.ts`:

```ts
import { GRID_COLUMNS, ROW_HEIGHT_PX, GAP_PX } from './types';
import type { TilePosition } from './types';

export interface GridMetrics {
  colStride: number;
  rowStride: number;
}

// gridStyle() lays out `GRID_COLUMNS` columns with `GAP_PX` padding on each side
// and `GAP_PX` between columns, so the width available to columns excludes two
// paddings and eleven gaps. One on-screen cell step is a column plus its gap.
export function gridMetrics(containerWidth: number): GridMetrics {
  const usable = containerWidth - 2 * GAP_PX - (GRID_COLUMNS - 1) * GAP_PX;
  const colWidth = usable / GRID_COLUMNS;
  return {
    colStride: colWidth + GAP_PX,
    rowStride: ROW_HEIGHT_PX + GAP_PX,
  };
}

export function pixelDeltaToCells(
  deltaXpx: number,
  deltaYpx: number,
  metrics: GridMetrics,
): { dx: number; dy: number } {
  return {
    dx: Math.round(deltaXpx / metrics.colStride),
    dy: Math.round(deltaYpx / metrics.rowStride),
  };
}

export function clampPosition(pos: TilePosition): TilePosition {
  const x = Math.min(Math.max(pos.x, 0), GRID_COLUMNS - pos.w);
  const y = Math.max(pos.y, 0);
  return { ...pos, x, y };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C worktrees/feat-tile-dashboard exec vitest run src/frontend/dashboard/grid-snap.test.ts`
Expected: PASS (3 describes, 5 assertions).

- [ ] **Step 5: Commit**

```bash
pnpm -C worktrees/feat-tile-dashboard format
git -C worktrees/feat-tile-dashboard add src/frontend/dashboard/grid-snap.ts src/frontend/dashboard/grid-snap.test.ts
git -C worktrees/feat-tile-dashboard commit -m "feat(dashboard): grid metrics and pixel-to-cell snapping"
```

---

### Task 2: Directional reflow — `resolveDrop`

**Files:**
- Modify: `src/frontend/dashboard/grid-snap.ts`
- Test: `src/frontend/dashboard/grid-snap.test.ts`

**Interfaces:**
- Consumes: `GRID_COLUMNS`, `type TilePosition`, `type TileItem` from `./types`; `type TileMove` from `./use-layout` (type-only).
- Produces: `resolveDrop(tiles: TileItem[], draggedId: number, dropPos: TilePosition): TileMove[]` — pins the dragged tile at `dropPos`, displaces every overlapping tile directionally (least-penetration axis, center-based direction, horizontal overflow wraps to next-row start), and returns the moves for every tile whose position changed (including the dragged tile). Always returns a valid, overlap-free, in-bounds arrangement.

- [ ] **Step 1: Write the failing test**

Append to `src/frontend/dashboard/grid-snap.test.ts`:

```ts
import type { TileItem } from './types';

import { resolveDrop } from './grid-snap';

function tile(id: number, x: number, y: number, w = 4, h = 4): TileItem {
  return { id, layout_id: 1, tile_type: 't', position: { x, y, w, h }, config: {} };
}

describe('resolveDrop', () => {
  it('returns no moves when the drop lands on empty space', () => {
    const tiles = [tile(1, 0, 0), tile(2, 6, 0)];
    // Move tile 1 straight down into an empty row.
    expect(resolveDrop(tiles, 1, { x: 0, y: 8, w: 4, h: 4 })).toEqual([
      { tileId: 1, position: { x: 0, y: 8, w: 4, h: 4 } },
    ]);
  });

  it('pushes the displaced tile right when dropped on its left side', () => {
    const tiles = [tile(1, 0, 4), tile(2, 4, 0)];
    const moves = resolveDrop(tiles, 1, { x: 2, y: 0, w: 4, h: 4 });
    expect(moves).toContainEqual({ tileId: 1, position: { x: 2, y: 0, w: 4, h: 4 } });
    expect(moves).toContainEqual({ tileId: 2, position: { x: 6, y: 0, w: 4, h: 4 } });
  });

  it('pushes the displaced tile down when dropped on top of it', () => {
    const tiles = [tile(1, 8, 0), tile(2, 0, 2)];
    const moves = resolveDrop(tiles, 1, { x: 0, y: 0, w: 4, h: 4 });
    expect(moves).toContainEqual({ tileId: 2, position: { x: 0, y: 4, w: 4, h: 4 } });
  });

  it('pushes the displaced tile up when dropped on its lower half and there is room', () => {
    const tiles = [tile(1, 0, 0), tile(2, 0, 4)];
    const moves = resolveDrop(tiles, 1, { x: 0, y: 6, w: 4, h: 4 });
    expect(moves).toContainEqual({ tileId: 2, position: { x: 0, y: 2, w: 4, h: 4 } });
  });

  it('cascades and carriage-returns to the next row on horizontal overflow', () => {
    const tiles = [tile(1, 0, 4), tile(2, 4, 0), tile(3, 8, 0)];
    const moves = resolveDrop(tiles, 1, { x: 2, y: 0, w: 4, h: 4 });
    expect(moves).toContainEqual({ tileId: 1, position: { x: 2, y: 0, w: 4, h: 4 } });
    expect(moves).toContainEqual({ tileId: 2, position: { x: 6, y: 0, w: 4, h: 4 } });
    // tile 3 cannot fit at x=10 (10+4 > 12), so it wraps to the next row start.
    expect(moves).toContainEqual({ tileId: 3, position: { x: 0, y: 4, w: 4, h: 4 } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-tile-dashboard exec vitest run src/frontend/dashboard/grid-snap.test.ts`
Expected: FAIL — `resolveDrop` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/frontend/dashboard/grid-snap.ts` (imports + functions):

```ts
// add TileItem to the existing type import from './types'
//   import type { TilePosition, TileItem } from './types';
import type { TileMove } from './use-layout';

function rectsOverlap(a: TilePosition, b: TilePosition): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function firstOverlap(
  pos: TilePosition,
  fixed: number[],
  positions: Map<number, TilePosition>,
): TilePosition | null {
  for (const id of fixed) {
    const f = positions.get(id)!;
    if (rectsOverlap(pos, f)) return f;
  }
  return null;
}

// Move tile `t` clear of the fixed tile `f`. Axis is chosen by least penetration
// (ties go vertical, which is always resolvable); direction by which side of `f`
// the tile's center sits on. A horizontal push that would leave the grid wraps
// to the start of the next row below `f`; an upward push past the top becomes a
// downward push.
function displace(t: TilePosition, f: TilePosition): TilePosition {
  const overlapX = Math.min(f.x + f.w, t.x + t.w) - Math.max(f.x, t.x);
  const overlapY = Math.min(f.y + f.h, t.y + t.h) - Math.max(f.y, t.y);
  if (overlapX < overlapY) {
    const pushRight = t.x + t.w / 2 >= f.x + f.w / 2;
    const nx = pushRight ? f.x + f.w : f.x - t.w;
    if (nx < 0 || nx + t.w > GRID_COLUMNS) {
      return { ...t, x: 0, y: f.y + f.h };
    }
    return { ...t, x: nx };
  }
  const pushDown = t.y + t.h / 2 >= f.y + f.h / 2;
  const ny = pushDown ? f.y + f.h : f.y - t.h;
  if (ny < 0) return { ...t, y: f.y + f.h };
  return { ...t, y: ny };
}

function bottomOf(fixed: number[], positions: Map<number, TilePosition>): number {
  let maxY = 0;
  for (const id of fixed) {
    const p = positions.get(id)!;
    maxY = Math.max(maxY, p.y + p.h);
  }
  return maxY;
}

export function resolveDrop(
  tiles: TileItem[],
  draggedId: number,
  dropPos: TilePosition,
): TileMove[] {
  const positions = new Map<number, TilePosition>();
  for (const t of tiles) positions.set(t.id, t.position);
  positions.set(draggedId, dropPos);

  const fixed: number[] = [draggedId];
  const others = tiles
    .filter((t) => t.id !== draggedId)
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);

  // Each displacement moves a tile strictly away from an obstacle and, on any
  // overflow, strictly downward; the safety net below guarantees termination
  // even if a pathological arrangement would otherwise loop.
  const maxIterations = tiles.length * 4 + 4;

  for (const t of others) {
    let pos = positions.get(t.id)!;
    let iterations = 0;
    for (;;) {
      const obstacle = firstOverlap(pos, fixed, positions);
      if (!obstacle) break;
      if (iterations++ >= maxIterations) {
        const x = Math.min(Math.max(pos.x, 0), GRID_COLUMNS - pos.w);
        pos = { ...pos, x, y: bottomOf(fixed, positions) };
        break;
      }
      pos = displace(pos, obstacle);
    }
    positions.set(t.id, pos);
    fixed.push(t.id);
  }

  const moves: TileMove[] = [];
  for (const t of tiles) {
    const next = positions.get(t.id)!;
    if (next.x !== t.position.x || next.y !== t.position.y) {
      moves.push({ tileId: t.id, position: next });
    }
  }
  return moves;
}
```

Also update the existing `import type { TilePosition } from './types';` line to `import type { TilePosition, TileItem } from './types';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C worktrees/feat-tile-dashboard exec vitest run src/frontend/dashboard/grid-snap.test.ts`
Expected: PASS (all `resolveDrop` cases + Task 1 cases).

- [ ] **Step 5: Commit**

```bash
pnpm -C worktrees/feat-tile-dashboard format
git -C worktrees/feat-tile-dashboard add src/frontend/dashboard/grid-snap.ts src/frontend/dashboard/grid-snap.test.ts
git -C worktrees/feat-tile-dashboard commit -m "feat(dashboard): directional reflow for tile drops

resolveDrop pins the dragged tile and displaces overlapping tiles by least-
penetration axis and center-based direction, wrapping to the next row on
horizontal overflow. Emits a multi-tile move set for the atomic reorder API."
```

---

### Task 3: `computeDropMoves` composition + reflow property test

**Files:**
- Modify: `src/frontend/dashboard/grid-snap.ts`
- Test: `src/frontend/dashboard/grid-snap.test.ts`

**Interfaces:**
- Consumes: `gridMetrics`, `pixelDeltaToCells`, `clampPosition`, `resolveDrop` (this module); `type TileItem`, `type TileMove`.
- Produces: `computeDropMoves(tiles: TileItem[], draggedId: number, deltaPx: { x: number; y: number }, containerWidth: number): TileMove[]` — the full drag-end pipeline (snap → clamp → reflow), returning `[]` when the container is unmeasured or the tile did not change cells. This is what `grid.tsx` calls, keeping the component free of math.

- [ ] **Step 1: Write the failing test**

Append to `src/frontend/dashboard/grid-snap.test.ts`:

```ts
import fc from 'fast-check';

import { computeDropMoves } from './grid-snap';
import { GRID_COLUMNS } from './types';

describe('computeDropMoves', () => {
  const tiles = [tile(1, 0, 0), tile(2, 6, 0)];

  it('returns [] when the container is not measured', () => {
    expect(computeDropMoves(tiles, 1, { x: 200, y: 0 }, 0)).toEqual([]);
  });

  it('returns [] when the drag does not cross a cell boundary', () => {
    // width 800 -> colStride ~66; a 10px nudge rounds to 0 cells.
    expect(computeDropMoves(tiles, 1, { x: 10, y: 5 }, 800)).toEqual([]);
  });

  it('snaps a pixel delta to a cell move', () => {
    // width 800 -> colStride ~66; 132px -> +2 columns. Lands on empty space.
    expect(computeDropMoves(tiles, 1, { x: 132, y: 0 }, 800)).toEqual([
      { tileId: 1, position: { x: 2, y: 0, w: 4, h: 4 } },
    ]);
  });
});

describe('resolveDrop invariants (property)', () => {
  it('always produces an overlap-free, in-bounds arrangement with the dragged tile at dropPos', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            w: fc.integer({ min: 2, max: 12 }),
            h: fc.integer({ min: 2, max: 4 }),
            x: fc.integer({ min: 0, max: 11 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.nat(1000),
        fc.integer({ min: -20, max: 20 }),
        fc.integer({ min: -20, max: 20 }),
        (specs, pick, dropDx, dropDy) => {
          const tiles: TileItem[] = specs.map((s, i) => ({
            id: i + 1,
            layout_id: 1,
            tile_type: 't',
            position: { x: Math.min(s.x, GRID_COLUMNS - s.w), y: i * 4, w: s.w, h: s.h },
            config: {},
          }));
          const dragged = tiles[pick % tiles.length]!;
          const dropPos = clampPosition({
            ...dragged.position,
            x: dragged.position.x + dropDx,
            y: dragged.position.y + dropDy,
          });
          const moves = resolveDrop(tiles, dragged.id, dropPos);

          const finalById = new Map(tiles.map((t) => [t.id, t.position]));
          for (const m of moves) finalById.set(m.tileId, m.position);
          const finals = [...finalById.values()];

          expect(finalById.get(dragged.id)).toEqual(dropPos);
          for (const p of finals) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x + p.w).toBeLessThanOrEqual(GRID_COLUMNS);
            expect(p.y).toBeGreaterThanOrEqual(0);
          }
          for (let i = 0; i < finals.length; i++) {
            for (let j = i + 1; j < finals.length; j++) {
              const a = finals[i]!;
              const b = finals[j]!;
              const overlap =
                a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
              expect(overlap).toBe(false);
            }
          }
        },
      ),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C worktrees/feat-tile-dashboard exec vitest run src/frontend/dashboard/grid-snap.test.ts`
Expected: FAIL — `computeDropMoves` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/frontend/dashboard/grid-snap.ts`:

```ts
export function computeDropMoves(
  tiles: TileItem[],
  draggedId: number,
  deltaPx: { x: number; y: number },
  containerWidth: number,
): TileMove[] {
  const dragged = tiles.find((t) => t.id === draggedId);
  if (!dragged || containerWidth <= 0) return [];
  const metrics = gridMetrics(containerWidth);
  const { dx, dy } = pixelDeltaToCells(deltaPx.x, deltaPx.y, metrics);
  if (dx === 0 && dy === 0) return [];
  const dropPos = clampPosition({
    ...dragged.position,
    x: dragged.position.x + dx,
    y: dragged.position.y + dy,
  });
  return resolveDrop(tiles, draggedId, dropPos);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C worktrees/feat-tile-dashboard exec vitest run src/frontend/dashboard/grid-snap.test.ts`
Expected: PASS (property test runs 100 cases by default).

- [ ] **Step 5: Commit**

```bash
pnpm -C worktrees/feat-tile-dashboard format
git -C worktrees/feat-tile-dashboard add src/frontend/dashboard/grid-snap.ts src/frontend/dashboard/grid-snap.test.ts
git -C worktrees/feat-tile-dashboard commit -m "feat(dashboard): compose drag-end pipeline and property-test reflow invariants"
```

---

### Task 4: Wire `grid.tsx` to free-form dragging

**Files:**
- Modify: `src/frontend/dashboard/grid.tsx`
- Test: `src/frontend/dashboard/grid.test.tsx`

**Interfaces:**
- Consumes: `computeDropMoves` from `./grid-snap`; `useLayout` (`{ layout, loading, error, reorder }`) from `./use-layout`; `useDraggable`, `KeyboardSensor`, `PointerSensor`, `useSensor`, `useSensors`, `DndContext`, `type DragStartEvent`, `type DragEndEvent`, `type KeyboardCoordinateGetter` from `@dnd-kit/core`; `CSS` from `@dnd-kit/utilities`.
- Produces: a `DashboardGrid` that positions tiles by grid coordinates and persists drops via `reorder`. Removes `computeSwap` and all `@dnd-kit/sortable` usage.

- [ ] **Step 1: Update the component test first (drop the removed export, keep the render test)**

Replace the contents of `src/frontend/dashboard/grid.test.tsx` with:

```tsx
// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchDefaultLayout } from '@frontend/dashboard/layout-api';
import { DashboardGrid } from '@frontend/dashboard/grid';
import type { LayoutItem } from '@frontend/dashboard/types';

vi.mock('@frontend/dashboard/layout-api', async () => {
  const actual = await vi.importActual<typeof import('@frontend/dashboard/layout-api')>(
    '@frontend/dashboard/layout-api',
  );
  return {
    ...actual,
    fetchDefaultLayout: vi.fn(),
  };
});

const mockedFetchDefaultLayout = vi.mocked(fetchDefaultLayout);

function renderGrid(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DashboardGrid />
    </QueryClientProvider>,
  );
}

describe('DashboardGrid', () => {
  beforeEach(() => {
    mockedFetchDefaultLayout.mockReset();
  });

  it('renders a skeleton while loading', () => {
    mockedFetchDefaultLayout.mockReturnValue(new Promise(() => {}));
    const { container } = renderGrid();
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(2);
  });

  it('renders tiles from the default layout', async () => {
    const layout: LayoutItem = {
      id: 1,
      name: 'Overview',
      is_default: true,
      tiles: [
        {
          id: 1,
          layout_id: 1,
          tile_type: 'positions_table',
          position: { x: 0, y: 0, w: 12, h: 4 },
          config: { accounts: [] },
        },
        {
          id: 2,
          layout_id: 1,
          tile_type: 'allocation_chart',
          position: { x: 0, y: 4, w: 6, h: 4 },
          config: { dimension: 'asset_class' },
        },
      ],
    };
    mockedFetchDefaultLayout.mockResolvedValue({ layout });

    renderGrid();
    const titles = await screen.findAllByTestId('tile-title');
    expect(titles.map((el) => el.textContent)).toEqual(['Positions table', 'Allocation chart']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C worktrees/feat-tile-dashboard exec vitest run src/frontend/dashboard/grid.test.tsx`
Expected: FAIL — the current `grid.tsx` still imports `@dnd-kit/sortable`; the test itself compiles, but after Step 3 the `computeSwap` import removal must be reflected. (If it PASSES here because `grid.tsx` is unchanged, that is fine — the meaningful check is Step 4.)

- [ ] **Step 3: Rewrite `grid.tsx`**

Replace the top of `src/frontend/dashboard/grid.tsx` — the imports, `DashboardGrid`, the removed `computeSwap`, and `SortableTile` — with the following. Keep `FallbackTile` and `DashboardSkeleton` unchanged.

```tsx
import React, { useCallback, useRef, useState } from 'react';
import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

import { Card, CardContent, CardHeader, CardTitle } from '@frontend/components/ui/card';
import { getTileDefinition } from '@frontend/tiles/registry';

import { computeDropMoves } from './grid-snap';
import { useLayout } from './use-layout';
import type { TileItem } from './types';
import { GRID_COLUMNS, GAP_PX, ROW_HEIGHT_PX, gridStyle, tileStyle } from './types';

export function DashboardGrid(): JSX.Element | null {
  const { layout, loading, error, reorder } = useLayout();
  const [activeId, setActiveId] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Keyboard drag advances one grid cell per arrow press. dnd-kit accumulates
  // these into `event.delta`, which the drop handler snaps back to whole cells.
  const keyboardCoordinateGetter = useCallback<KeyboardCoordinateGetter>((event, { currentCoordinates }) => {
    const width = containerRef.current?.getBoundingClientRect().width ?? 0;
    const usable = width - 2 * GAP_PX - (GRID_COLUMNS - 1) * GAP_PX;
    const colStride = usable / GRID_COLUMNS + GAP_PX;
    const rowStride = ROW_HEIGHT_PX + GAP_PX;
    switch (event.code) {
      case 'ArrowRight':
        return { ...currentCoordinates, x: currentCoordinates.x + colStride };
      case 'ArrowLeft':
        return { ...currentCoordinates, x: currentCoordinates.x - colStride };
      case 'ArrowDown':
        return { ...currentCoordinates, y: currentCoordinates.y + rowStride };
      case 'ArrowUp':
        return { ...currentCoordinates, y: currentCoordinates.y - rowStride };
      default:
        return undefined;
    }
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinateGetter }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(Number(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      if (!layout) return;
      const width = containerRef.current?.getBoundingClientRect().width ?? 0;
      const moves = computeDropMoves(layout.tiles, Number(event.active.id), event.delta, width);
      if (moves.length) reorder(moves);
    },
    [layout, reorder],
  );

  if (loading) return <DashboardSkeleton />;
  if (error) return <div className="p-6 text-destructive">Error loading dashboard: {error}</div>;
  if (!layout) return null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div ref={containerRef} style={gridStyle()}>
        {layout.tiles.map((tile) => (
          <DraggableTile key={tile.id} tile={tile} activeId={activeId} />
        ))}
      </div>
    </DndContext>
  );
}

interface DraggableTileProps {
  tile: TileItem;
  activeId: number | null;
}

function DraggableTile({ tile, activeId }: DraggableTileProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: String(tile.id),
  });

  const def = getTileDefinition(tile.tile_type);
  const Component = def?.component ?? FallbackTile;
  const name = def?.name ?? tile.tile_type;

  const style: React.CSSProperties = {
    ...tileStyle(tile.position),
    transform: CSS.Translate.toString(transform),
    opacity: isDragging || activeId === tile.id ? 0.5 : 1,
    zIndex: isDragging ? 10 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <Card className="h-full overflow-hidden">
        <CardHeader className="py-3">
          <CardTitle className="text-sm" data-testid="tile-title">
            {name}
          </CardTitle>
        </CardHeader>
        <CardContent className="h-full overflow-auto pb-3">
          <Component
            tileId={tile.id}
            layoutId={tile.layout_id}
            config={tile.config}
            onConfigChange={() => {}}
          />
        </CardContent>
      </Card>
    </div>
  );
}
```

Leave the existing `FallbackTile` and `DashboardSkeleton` functions in place below this.

- [ ] **Step 4: Run the dashboard tests and typecheck**

Run: `pnpm -C worktrees/feat-tile-dashboard exec vitest run src/frontend/dashboard`
Expected: PASS (grid-snap suite + grid render suite).

Run: `pnpm -C worktrees/feat-tile-dashboard typecheck`
Expected: no errors. (`computeSwap` and `@dnd-kit/sortable` are fully removed; if typecheck complains about an unused `moveTile` it is a pre-existing export and stays.)

- [ ] **Step 5: Commit**

```bash
pnpm -C worktrees/feat-tile-dashboard format
git -C worktrees/feat-tile-dashboard add src/frontend/dashboard/grid.tsx src/frontend/dashboard/grid.test.tsx
git -C worktrees/feat-tile-dashboard commit -m "feat(dashboard): free-form coordinate drag with directional reflow

Replace the sortable swap with useDraggable free positioning: drops snap to
the grid and reflow displaced tiles via computeDropMoves, persisted through
the atomic reorder endpoint. Arrow keys move a lifted tile one cell."
```

---

### Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole suite**

Run: `pnpm -C worktrees/feat-tile-dashboard test`
Expected: all files pass (existing 371 + new grid-snap cases).

- [ ] **Step 2: Lint and format check**

Run: `pnpm -C worktrees/feat-tile-dashboard lint`
Expected: clean.

Run: `pnpm -C worktrees/feat-tile-dashboard format:check`
Expected: "All matched files use Prettier code style!"

- [ ] **Step 3: Typecheck**

Run: `pnpm -C worktrees/feat-tile-dashboard typecheck`
Expected: no errors.

- [ ] **Step 4: Confirm clean tree**

Run: `git -C worktrees/feat-tile-dashboard status --short`
Expected: empty output (all work committed).

---

## Self-Review

**Spec coverage:**
- §Architecture units (grid-snap.ts pure, grid.tsx wiring, hook reused) → Tasks 1–4. ✓
- `gridMetrics`, `pixelDeltaToCells`, `clampPosition` → Task 1. ✓
- `resolveDrop` reflow rule (least-penetration axis, center direction, carriage-return, downward-safe) → Task 2. ✓
- Persistence via existing `reorder` / atomic endpoint → Task 4 `handleDragEnd`. ✓
- `useDraggable` swap-out + keyboard one-cell movement → Task 4. ✓
- Testing: pure unit tests (Task 1–2), property test (Task 3), component render test retained (Task 4). ✓
- Move-only scope; no resize → honored (no resize task). ✓
- Error handling (zero delta, unmeasured container, backend rollback) → Task 3 `computeDropMoves` guards + existing hook rollback. ✓

**Placeholder scan:** No TBD/TODO; every code and test step is complete. ✓

**Type consistency:** `GridMetrics`, `gridMetrics`, `pixelDeltaToCells`, `clampPosition`, `resolveDrop`, `computeDropMoves`, `TileMove { tileId, position }`, `TileItem`/`TilePosition` used identically across tasks; `useLayout` returns `{ layout, loading, error, reorder }` (matches the current hook). ✓

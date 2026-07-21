# Free-form coordinate-snap tile drag — design spec

**Status:** Accepted
**Date:** 2026-07-21
**Workstream:** WS7 Tile-based dashboard — implements [tile-dashboard spec §T3](2026-07-21-tile-dashboard.md) ("dnd-kit with a small custom grid-snapper").
**Depends on:** existing atomic reorder endpoint (`POST /api/v1/dashboard/layouts/:id/tiles/reorder`, [ADR-0003](../adr/0003-default-layout-and-atomic-tile-reorder.md)) and `useLayout` TanStack Query hook.

## Context

The dashboard grid currently renders tiles with dnd-kit's `useSortable` /
`SortableContext` / `rectSortingStrategy`, and a drop swaps two tiles'
positions. Sortable is a list-reordering primitive; §T3 calls instead for a
fixed 12-column coordinate grid where a tile can be dragged to any `x`/`y` and
snapped to integer grid cells. This spec replaces the swap interaction with
free-form coordinate positioning and a directional reflow of displaced tiles.

Grid constants (unchanged, from `dashboard/types.ts`): 12 columns,
`ROW_HEIGHT_PX = 48`, `GAP_PX = 8`, min tile 2×2, max 12×12, rows unbounded
below. Positions are recorded only on pointer-up (§T3), never mid-drag.

Scope: **move only**. Resize handles (changing `w`/`h`) are a deliberate
follow-up, not part of this pass.

## Architecture

Three units, each independently testable:

1. **`dashboard/grid-snap.ts`** — pure, React-free math and reflow. No dnd-kit,
   no DOM. This is where the logic and the tests live.
2. **`dashboard/grid.tsx`** — dnd-kit wiring: `useDraggable` per tile, sensors,
   measuring the container, calling into `grid-snap.ts` on drop, dispatching to
   the hook.
3. **`useLayout` hook** (existing) — `reorder(moves)` already applies an atomic
   multi-tile move optimistically and rolls back on failure. Reused as-is; no
   change.

### Unit 1 — `grid-snap.ts`

```ts
export interface GridMetrics {
  colStride: number; // px between adjacent column origins = colWidth + GAP_PX
  rowStride: number; // px between adjacent row origins = ROW_HEIGHT_PX + GAP_PX
}

// Column width is derived from the measured container width:
//   colWidth = (containerWidth - 2*GAP_PX - (COLUMNS-1)*GAP_PX) / COLUMNS
// (GAP_PX padding on each side, GAP_PX between the 12 columns).
export function gridMetrics(containerWidth: number): GridMetrics;

// Snap a pixel delta to a whole number of grid cells.
export function pixelDeltaToCells(
  deltaXpx: number,
  deltaYpx: number,
  metrics: GridMetrics,
): { dx: number; dy: number };

// Clamp a position into the grid: 0 <= x, x + w <= COLUMNS, y >= 0.
export function clampPosition(pos: TilePosition): TilePosition;

// Given all tiles, the dragged tile id, and its snapped+clamped drop position,
// return the moves (dragged + every displaced tile) needed to reach a valid,
// overlap-free, in-bounds arrangement. Pure. Always resolvable.
export function resolveDrop(
  tiles: TileItem[],
  draggedId: number,
  dropPos: TilePosition,
): TileMove[];
```

### The reflow rule (`resolveDrop`)

The dragged tile **D** is pinned at `dropPos`. Every other tile is considered
in a work queue; when a tile overlaps a *fixed* tile, it is displaced and
re-queued (cascade). Fixed set starts as `{D}` and grows as tiles settle.

For a tile **T** overlapping a fixed tile **F**:

1. **Choose axis by least penetration.** Compute
   `overlapX = min(F.x+F.w, T.x+T.w) - max(F.x, T.x)` and the analogous
   `overlapY`. Push along the axis with the *smaller* overlap (least travel).
   Ties resolve to the vertical axis (downward is always safe).
2. **Choose direction by centers.** Horizontal: if T's center-x ≥ F's center-x,
   push right (`T.x = F.x + F.w`); else push left (`T.x = F.x - T.w`). Vertical:
   below → `T.y = F.y + F.h`; above → `T.y = F.y - T.h`.
3. **Overflow fallback → carriage return.** If the chosen push is horizontal and
   would leave the grid (`T.x < 0` or `T.x + T.w > COLUMNS`), discard it and
   wrap T to the start of the next row: `T = { x: 0, y: F.y + F.h, w, h }`.
   Likewise an upward push that would give `T.y < 0` becomes a downward push.

Each displacement moves T strictly away from F, and every fallback moves T
strictly downward. Because rows are unbounded below, the cascade always
terminates in an overlap-free, in-bounds arrangement.

### Unit 2 — `grid.tsx` wiring

- Replace `useSortable` with `useDraggable`; the tile div gets the drag
  `transform` while active. The grid container holds a `ref` used to measure
  width for `gridMetrics`.
- `PointerSensor` (unchanged, 8px activation) + `KeyboardSensor` with a custom
  coordinate-getter that advances one `colStride`/`rowStride` per arrow key so a
  lifted tile moves exactly one cell per press; space lifts and drops.
- `onDragEnd(event)`:
  1. `const { dx, dy } = pixelDeltaToCells(event.delta.x, event.delta.y, metrics)`
  2. `const dropPos = clampPosition({ ...dragged.position, x: x+dx, y: y+dy })`
  3. `const moves = resolveDrop(layout.tiles, draggedId, dropPos)`
  4. `if (moves.length) reorder(moves)`
- `onDragCancel` and end reset `activeId` (as today).

## Data flow

```
pointer/keyboard drag
  -> dnd-kit reports event.delta (px)
  -> pixelDeltaToCells + clampPosition  => dropPos (grid cells)
  -> resolveDrop(tiles, draggedId, dropPos)  => TileMove[]
  -> useLayout.reorder(moves)
       -> optimistic setQueryData (applyMoves)
       -> POST /layouts/:id/tiles/reorder  (backend validates whole arrangement)
       -> onSuccess: replace with server layout | onError: rollback
```

`resolveDrop` guarantees a valid arrangement, so the backend 400 path is a
defensive rollback, not an expected flow.

## Error handling

- Drop with zero net cell delta (`dx == dy == 0`) and no resulting displacement
  → `resolveDrop` returns `[]`, no request fired.
- Container not yet measured (width 0) → treat as no-op drop (guard before
  computing metrics).
- Backend rejects the reorder (unexpected) → optimistic rollback already wired
  in the hook; the tile animates back.

## Testing

- **`grid-snap.test.ts`** (pure, fast):
  - `pixelDeltaToCells`: rounds to nearest cell at various widths; half-cell
    rounds up.
  - `clampPosition`: pins x, x+w≤12, y≥0.
  - `resolveDrop` cases: push-right, push-left, push-up, push-down chosen by
    penetration + centers; cascade through a third tile; horizontal-overflow
    carriage-return to next row start; no-op when nothing overlaps.
  - **Property test (fast-check):** for a random set of non-overlapping tiles
    and a random dragged tile + drop position, `resolveDrop`'s resulting
    arrangement is overlap-free, every tile in-bounds (`x≥0`, `x+w≤12`, `y≥0`),
    and the dragged tile is exactly at `dropPos`.
- **`grid.test.tsx`**: existing render test stays; add a test that a simulated
  drag end calls `reorder` with the moves from `resolveDrop` (spy the hook /
  layout-api).

## Decisions and rationale

- **`useDraggable` over `useSortable`** — sortable models a reorderable list;
  a fixed x/y grid needs raw pixel deltas and our own snapping, exactly as §T3
  decided.
- **Pure `resolveDrop` returning moves, fed to the atomic reorder endpoint** —
  a reflow is inherently a multi-tile change; the existing whole-arrangement
  validator (ADR-0003) is the right sink, so no backend work and the frontend
  logic stays a testable pure function.
- **Directional push with downward-safe fallback** — chosen over snap-back
  (less magnetic) and over uniform push-down (ignores where the user aimed).
  Least-penetration axis + center-based direction matches the user's mental
  model; carriage-return-to-next-row on horizontal overflow keeps displaced
  tiles visible and guarantees termination.
- **Move-only this pass** — resize is a separable interaction; deferring keeps
  the change reviewable.

## Out of scope

- Tile **resize** (w/h handles) — follow-up.
- Multi-tile / marquee selection and group drag.
- Animated reflow choreography beyond dnd-kit's default transform transitions.
- Collision *preview* while dragging (positions commit on drop only, per §T3).

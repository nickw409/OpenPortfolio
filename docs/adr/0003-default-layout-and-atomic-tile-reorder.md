# ADR-0003: Default-layout fetch and atomic tile reorder

- **Status:** Accepted
- **Date:** 2026-07-21
- **Trigger:** Wiring the WS7 dashboard grid (spec `docs/specs/2026-07-21-tile-dashboard.md`) to the backend during drag-and-drop implementation.
- **Commit(s):** _this branch_ — `feat(dashboard): default-layout endpoint and atomic tile reorder`
- **Related:** [ADR-0001](0001-worktree-convention-and-permission-model.md), tile-dashboard spec §T3/§T5/§T7

## Context

The frontend `useLayout` hook loaded the dashboard via `fetchDefaultLayout()`,
which called `GET /api/v1/dashboard/layouts` and expected `{ layout }`. But that
route returns `{ layouts: [...] }` — a list with tile counts and no tiles (spec
§T5). There was no endpoint for "the default layout with its tiles", and no
default layout is created on a fresh database, so the read path was broken.

Separately, the grid's drag interaction swaps two tiles' grid positions. The
only write path was `PATCH /layouts/:id/tiles/:tile_id`, which validates the
moved tile against **all other tiles** (`validateNoOverlap`,
`dashboard-service.ts`). A swap issued as two independent PATCHes moves tile A
onto tile B's still-occupied cell first, so the first request fails with a 400
overlap error. Per-tile validation cannot express "this arrangement is valid as
a whole".

## Alternatives considered

Default-layout fetch:

- **A)** Frontend lists layouts, picks `is_default`, then fetches by id — rejected: two round trips and duplicates "find default" logic client-side; still needs a seeded default to show anything.
- **B)** Add `GET /layouts/default` returning the default layout with tiles, auto-seeding an Overview default on first access — chosen.

Swap persistence:

- **A)** Keep two independent PATCHes — rejected: transient overlap 400s (see Context).
- **B)** Relax per-tile overlap validation — rejected: weakens the invariant that stored layouts never overlap.
- **C)** Add an atomic reorder endpoint that validates the final arrangement as a whole and commits all moves in one transaction — chosen.

## Decision

`GET /api/v1/dashboard/layouts/default` returns `{ layout }` for the layout
flagged `is_default`. `DashboardService.getDefaultLayout()` returns it, or lazily
seeds one (`createLayout('Overview', true)` + `resetLayout` to install the
default tiles) inside a transaction when none exists. The route is registered
**before** `/layouts/:id` so the literal `default` segment is not parsed as a
numeric id.

`POST /api/v1/dashboard/layouts/:id/tiles/reorder` takes
`{ moves: [{ tile_id, position_json }] }`. `DashboardService.reorderTiles()`
builds the final arrangement (current tiles with the moves applied), runs
`validateNoOverlap` on the whole set, then applies every move in a single
`db.transaction`. A swap is one call with two moves; overlap and out-of-bounds
are rejected as a unit, and the frontend rolls its optimistic update back on the
resulting 400. `updateTile` remains for single-tile moves to empty cells.

## Consequences

- The dashboard renders on a fresh DB without a seed migration; the first
  `GET /layouts/default` creates the Overview layout as a side effect.
- Swaps (and any future multi-tile arrangement change) have a correct write
  path; the "no stored overlap" invariant is preserved.
- Auto-seeding on a read is a deliberate write-on-GET; acceptable for a
  single-user local-first app, and idempotent (only fires when no default
  exists).

## Verification

`src/backend/routes/dashboard.test.ts`:

- `GET /layouts/default` auto-seeds Overview with `[positions_table, allocation_chart]` and is idempotent (a second call does not create a second layout).
- `GET /layouts/default` returns the flagged default when one already exists.
- `POST .../tiles/reorder` swaps two tiles; a reorder that would overlap returns 400 and leaves positions unchanged.

On the frontend, `src/frontend/dashboard/use-layout.test.tsx` covers the
`reorder` consumer of this endpoint (mapped payload, optimistic update, and
rollback on failure); the reorder move sets it sends are produced and tested in
`src/frontend/dashboard/grid-snap.test.ts` (see the free-form drag work in
[../specs/2026-07-21-freeform-grid-drag.md](../specs/2026-07-21-freeform-grid-drag.md)).

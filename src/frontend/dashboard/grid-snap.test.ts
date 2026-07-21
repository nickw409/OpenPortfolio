import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type { TileItem } from './types';
import {
  gridMetrics,
  pixelDeltaToCells,
  clampPosition,
  resolveDrop,
  computeDropMoves,
} from './grid-snap';
import { GRID_COLUMNS } from './types';

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

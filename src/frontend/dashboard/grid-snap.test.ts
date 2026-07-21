import { describe, expect, it } from 'vitest';

import type { TileItem } from './types';
import { gridMetrics, pixelDeltaToCells, clampPosition, resolveDrop } from './grid-snap';

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

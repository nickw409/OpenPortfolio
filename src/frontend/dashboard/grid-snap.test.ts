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

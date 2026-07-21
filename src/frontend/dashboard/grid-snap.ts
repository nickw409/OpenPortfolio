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

import { GRID_COLUMNS, ROW_HEIGHT_PX, GAP_PX } from './types';
import type { TilePosition, TileItem } from './types';
import type { TileMove } from './use-layout';

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

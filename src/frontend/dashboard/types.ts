export interface TilePosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileItem {
  id: number;
  layout_id: number;
  tile_type: string;
  position: TilePosition;
  config: unknown;
}

export interface LayoutItem {
  id: number;
  name: string;
  is_default: boolean;
  tiles: TileItem[];
}

export const GRID_COLUMNS = 12;
export const ROW_HEIGHT_PX = 48;
export const GAP_PX = 8;

export function gridStyle(): React.CSSProperties {
  return {
    position: 'relative',
    width: '100%',
    minHeight: '100%',
    display: 'grid',
    gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`,
    gap: GAP_PX,
    padding: GAP_PX,
  };
}

export function tileStyle(position: TilePosition): React.CSSProperties {
  return {
    gridColumn: `${position.x + 1} / span ${position.w}`,
    gridRow: `${position.y + 1} / span ${position.h}`,
    minHeight: position.h * ROW_HEIGHT_PX,
  };
}

export function nextAvailablePosition(
  existing: TilePosition[],
  width: number,
  height: number,
): TilePosition {
  const w = Math.min(Math.max(width, 2), GRID_COLUMNS);
  const h = Math.max(height, 2);
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x <= GRID_COLUMNS - w; x++) {
      const candidate = { x, y, w, h };
      const overlaps = existing.some(
        (p) =>
          x < p.x + p.w &&
          x + w > p.x &&
          y < p.y + p.h &&
          y + h > p.y,
      );
      if (!overlaps) return candidate;
    }
  }
  const maxY = existing.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  return { x: 0, y: maxY, w, h };
}

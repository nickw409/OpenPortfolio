import { z } from 'zod';

import { dashboard_layouts, tile_configs } from '@backend/db/schema';
import type { Db } from '@backend/db/client';
import { activeFilter, softDelete } from '@backend/db/soft-delete';
import { and, eq, isNull, ne } from 'drizzle-orm';

// Backend service for dashboard layouts and tile configs. Validation is
// limited to JSON shape, grid constraints, and non-overlapping tiles;
// tile-specific config interpretation belongs to the frontend registry.

export interface DashboardServiceDeps {
  db: Db;
}

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
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface LayoutItem {
  id: number;
  name: string;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  tiles: TileItem[];
}

const MAX_COLUMNS = 12;
const MIN_SIZE = 2;
const MAX_SIZE = 12;

const PositionSchema = z.object({
  x: z.number().int().min(0).max(MAX_COLUMNS - MIN_SIZE),
  y: z.number().int().min(0),
  w: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
  h: z.number().int().min(MIN_SIZE).max(MAX_SIZE),
});

export class DashboardError extends Error {
  override readonly name = 'DashboardError';
  readonly code: 'validation.invalid_input' | 'not_found.resource' | 'conflict.invalid_state';
  readonly status: number;

  constructor(
    code: 'validation.invalid_input' | 'not_found.resource' | 'conflict.invalid_state',
    message: string,
    status: number,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }

  toEnvelope() {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new DashboardError('validation.invalid_input', `${field} is not valid JSON`, 400);
  }
}

export function parsePosition(value: string): TilePosition {
  const parsed = parseJson(value, 'position_json');
  const result = PositionSchema.safeParse(parsed);
  if (!result.success) {
    throw new DashboardError(
      'validation.invalid_input',
      `position_json invalid: ${result.error.issues.map((i) => i.message).join(', ')}`,
      400,
    );
  }
  return result.data;
}

export function parseConfig(value: string): unknown {
  return parseJson(value, 'config_json');
}

export function validateNoOverlap(tiles: { id: number; position: TilePosition }[]): void {
  for (let i = 0; i < tiles.length; i++) {
    const a = tiles[i]!;
    if (a.position.x + a.position.w > MAX_COLUMNS) {
      throw new DashboardError(
        'validation.invalid_input',
        `Tile ${a.id} exceeds ${MAX_COLUMNS} columns`,
        400,
      );
    }
    for (let j = i + 1; j < tiles.length; j++) {
      const b = tiles[j]!;
      const overlap =
        a.position.x < b.position.x + b.position.w &&
        a.position.x + a.position.w > b.position.x &&
        a.position.y < b.position.y + b.position.h &&
        a.position.y + a.position.h > b.position.y;
      if (overlap) {
        throw new DashboardError(
          'validation.invalid_input',
          `Tiles ${a.id} and ${b.id} overlap`,
          400,
        );
      }
    }
  }
}

export function nextAvailablePosition(
  existing: TilePosition[],
  width: number,
  height: number,
): TilePosition {
  const w = Math.min(Math.max(width, MIN_SIZE), MAX_COLUMNS);
  const h = Math.min(Math.max(height, MIN_SIZE), MAX_SIZE);
  if (w > MAX_COLUMNS) {
    throw new DashboardError(
      'validation.invalid_input',
      `Requested width ${w} exceeds ${MAX_COLUMNS} columns`,
      400,
    );
  }

  // Try placements row by row.
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x <= MAX_COLUMNS - w; x++) {
      const candidate = { x, y, w, h };
      const candidateTiles = existing.map((pos, index) => ({ id: index, position: pos }));
      try {
        validateNoOverlap([...candidateTiles, { id: -1, position: candidate }]);
        return candidate;
      } catch {
        // continue trying
      }
    }
  }
  // Fallback: place far below existing tiles.
  const maxY = existing.reduce((max, p) => Math.max(max, p.y + p.h), 0);
  return { x: 0, y: maxY, w, h };
}

function toTileItem(row: typeof tile_configs.$inferSelect): TileItem {
  return {
    id: row.id,
    layout_id: row.layout_id,
    tile_type: row.tile_type,
    position: parsePosition(row.position_json),
    config: parseConfig(row.config_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

export class DashboardService {
  constructor(private readonly deps: DashboardServiceDeps) {}

  listLayouts(): Omit<LayoutItem, 'tiles'>[] {
    const rows = this.deps.db
      .select({
        id: dashboard_layouts.id,
        name: dashboard_layouts.name,
        is_default: dashboard_layouts.is_default,
        created_at: dashboard_layouts.created_at,
        updated_at: dashboard_layouts.updated_at,
        deleted_at: dashboard_layouts.deleted_at,
      })
      .from(dashboard_layouts)
      .where(activeFilter(dashboard_layouts))
      .orderBy(dashboard_layouts.id)
      .all();
    return rows;
  }

  getLayout(id: number): LayoutItem {
    const layout = this.deps.db
      .select()
      .from(dashboard_layouts)
      .where(and(eq(dashboard_layouts.id, id), activeFilter(dashboard_layouts)))
      .get();
    if (!layout) {
      throw new DashboardError('not_found.resource', `Layout ${id} not found`, 404);
    }

    const tiles = this.deps.db
      .select()
      .from(tile_configs)
      .where(and(eq(tile_configs.layout_id, id), activeFilter(tile_configs)))
      .orderBy(tile_configs.id)
      .all();

    validateNoOverlap(tiles.map((t) => ({ id: t.id, position: parsePosition(t.position_json) })));

    return {
      ...layout,
      tiles: tiles.map(toTileItem),
    };
  }

  createLayout(name: string, isDefault: boolean): LayoutItem {
    const now = new Date();
    const values: typeof dashboard_layouts.$inferInsert = {
      name,
      is_default: isDefault,
      created_at: now,
      updated_at: now,
    };
    const id = this.deps.db.insert(dashboard_layouts).values(values).returning({ id: dashboard_layouts.id }).get().id;
    if (isDefault) {
      this.clearOtherDefaults(id);
    }
    return this.getLayout(id);
  }

  updateLayout(id: number, patch: { name?: string; is_default?: boolean }): LayoutItem {
    const updates: Partial<typeof dashboard_layouts.$inferInsert> = { updated_at: new Date() };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.is_default !== undefined) updates.is_default = patch.is_default;
    this.deps.db.update(dashboard_layouts).set(updates).where(eq(dashboard_layouts.id, id)).run();
    if (patch.is_default) {
      this.clearOtherDefaults(id);
    }
    return this.getLayout(id);
  }

  deleteLayout(id: number): void {
    const count = this.deps.db
      .select({ count: dashboard_layouts.id })
      .from(dashboard_layouts)
      .where(activeFilter(dashboard_layouts))
      .all().length;
    if (count <= 1) {
      throw new DashboardError(
        'conflict.invalid_state',
        'Cannot delete the only remaining layout',
        409,
      );
    }
    const changes = softDelete(this.deps.db, dashboard_layouts, eq(dashboard_layouts.id, id));
    if (changes === 0) {
      throw new DashboardError('not_found.resource', `Layout ${id} not found`, 404);
    }
  }

  addTile(
    layoutId: number,
    tileType: string,
    position: TilePosition,
    config: unknown,
  ): TileItem {
    this.getLayout(layoutId); // validates layout exists and current tiles don't overlap
    const now = new Date();
    validateNoOverlap([
      { id: -1, position },
      ...this.getTilePositions(layoutId),
    ]);
    const inserted = this.deps.db
      .insert(tile_configs)
      .values({
        layout_id: layoutId,
        tile_type: tileType,
        position_json: JSON.stringify(position),
        config_json: JSON.stringify(config ?? {}),
        created_at: now,
        updated_at: now,
      })
      .returning()
      .get();
    return toTileItem(inserted);
  }

  updateTile(
    layoutId: number,
    tileId: number,
    patch: { position?: TilePosition; config?: unknown },
  ): TileItem {
    this.getLayout(layoutId);
    const current = this.deps.db
      .select()
      .from(tile_configs)
      .where(and(eq(tile_configs.id, tileId), activeFilter(tile_configs)))
      .get();
    if (!current) {
      throw new DashboardError('not_found.resource', `Tile ${tileId} not found`, 404);
    }

    if (patch.position) {
      const others = this.getTilePositions(layoutId).filter((_, index) => {
        const rowAtIndex = this.getTileRowByIndex(layoutId, index);
        return rowAtIndex?.id !== tileId;
      });
      validateNoOverlap([{ id: tileId, position: patch.position }, ...others]);
    }

    const updates: Partial<typeof tile_configs.$inferInsert> = { updated_at: new Date() };
    if (patch.position !== undefined) updates.position_json = JSON.stringify(patch.position);
    if (patch.config !== undefined) updates.config_json = JSON.stringify(patch.config);
    this.deps.db.update(tile_configs).set(updates).where(eq(tile_configs.id, tileId)).run();

    const updated = this.deps.db
      .select()
      .from(tile_configs)
      .where(eq(tile_configs.id, tileId))
      .get();
    if (!updated) {
      throw new DashboardError('not_found.resource', `Tile ${tileId} not found after update`, 404);
    }
    return toTileItem(updated);
  }

  deleteTile(layoutId: number, tileId: number): void {
    this.getLayout(layoutId);
    const changes = softDelete(this.deps.db, tile_configs, eq(tile_configs.id, tileId));
    if (changes === 0) {
      throw new DashboardError('not_found.resource', `Tile ${tileId} not found`, 404);
    }
  }

  resetLayout(id: number): LayoutItem {
    this.deleteLayoutTiles(id);
    const defaultTiles = defaultLayoutTiles();
    const now = new Date();
    for (const tile of defaultTiles) {
      this.deps.db
        .insert(tile_configs)
        .values({
          layout_id: id,
          tile_type: tile.tile_type,
          position_json: JSON.stringify(tile.position),
          config_json: JSON.stringify(tile.config),
          created_at: now,
          updated_at: now,
        })
        .run();
    }
    return this.getLayout(id);
  }

  private getTilePositions(layoutId: number): { id: number; position: TilePosition }[] {
    const rows = this.deps.db
      .select()
      .from(tile_configs)
      .where(and(eq(tile_configs.layout_id, layoutId), activeFilter(tile_configs)))
      .orderBy(tile_configs.id)
      .all();
    return rows.map((r) => ({ id: r.id, position: parsePosition(r.position_json) }));
  }

  private getTileRowByIndex(layoutId: number, index: number): { id: number } | undefined {
    const rows = this.deps.db
      .select({ id: tile_configs.id })
      .from(tile_configs)
      .where(and(eq(tile_configs.layout_id, layoutId), activeFilter(tile_configs)))
      .orderBy(tile_configs.id)
      .all();
    return rows[index];
  }

  private clearOtherDefaults(exceptId: number): void {
    this.deps.db
      .update(dashboard_layouts)
      .set({ is_default: false, updated_at: new Date() })
      .where(
        and(
          eq(dashboard_layouts.is_default, true),
          activeFilter(dashboard_layouts),
          isNull(dashboard_layouts.deleted_at),
          // Don't clear the row we just set as default.
          ne(dashboard_layouts.id, exceptId),
        ),
      )
      .run();
  }

  private deleteLayoutTiles(layoutId: number): void {
    const now = new Date();
    this.deps.db
      .update(tile_configs)
      .set({ deleted_at: now, updated_at: now })
      .where(and(eq(tile_configs.layout_id, layoutId), activeFilter(tile_configs)))
      .run();
  }
}

export function defaultLayoutTiles(): { tile_type: string; position: TilePosition; config: unknown }[] {
  return [
    {
      tile_type: 'positions_table',
      position: { x: 0, y: 0, w: 12, h: 4 },
      config: { accounts: [] },
    },
    {
      tile_type: 'allocation_chart',
      position: { x: 0, y: 4, w: 6, h: 4 },
      config: { dimension: 'asset_class' },
    },
  ];
}

export function defaultLayoutName(): string {
  return 'Overview';
}

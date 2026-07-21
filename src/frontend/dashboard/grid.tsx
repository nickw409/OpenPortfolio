import React, { useState, useCallback } from 'react';
import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Card, CardContent, CardHeader, CardTitle } from '@frontend/components/ui/card';
import { getTileDefinition } from '@frontend/tiles/registry';

import { useLayout, type TileMove } from './use-layout';
import type { TileItem } from './types';
import { GRID_COLUMNS, gridStyle, tileStyle } from './types';

export function DashboardGrid(): JSX.Element | null {
  const { layout, loading, error, reorder } = useLayout();
  const [activeId, setActiveId] = useState<number | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(Number(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      if (!layout) return;
      const { active, over } = event;
      if (!over) return;
      // Dragging a tile onto another swaps their grid positions. The two moves
      // are sent as one atomic reorder so the backend validates the resulting
      // arrangement as a whole rather than rejecting the transient overlap.
      const moves = computeSwap(layout.tiles, Number(active.id), Number(over.id));
      if (moves) reorder(moves);
    },
    [layout, reorder],
  );

  if (loading) return <DashboardSkeleton />;
  if (error) return <div className="p-6 text-destructive">Error loading dashboard: {error}</div>;
  if (!layout) return null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <SortableContext items={layout.tiles.map((t) => String(t.id))} strategy={rectSortingStrategy}>
        <div style={gridStyle()}>
          {layout.tiles.map((tile) => (
            <SortableTile key={tile.id} tile={tile} activeId={activeId} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// Compute the position swap for dragging `activeId` onto `overId`. Returns the
// two moves, or null when the drag is a no-op or references a missing tile.
// Exported so the swap logic can be unit-tested without simulating pointer input.
export function computeSwap(
  tiles: TileItem[],
  activeId: number,
  overId: number,
): TileMove[] | null {
  if (activeId === overId) return null;
  const source = tiles.find((t) => t.id === activeId);
  const target = tiles.find((t) => t.id === overId);
  if (!source || !target) return null;
  return [
    { tileId: source.id, position: target.position },
    { tileId: target.id, position: source.position },
  ];
}

interface SortableTileProps {
  tile: TileItem;
  activeId: number | null;
}

function SortableTile({ tile, activeId }: SortableTileProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(tile.id),
  });

  const def = getTileDefinition(tile.tile_type);
  const Component = def?.component ?? FallbackTile;
  const name = def?.name ?? tile.tile_type;

  const style: React.CSSProperties = {
    ...tileStyle(tile.position),
    transform: CSS.Transform.toString(transform),
    transition,
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

function FallbackTile({ tileId }: { tileId: number }): JSX.Element {
  return <div className="text-muted-foreground text-sm">Unknown tile {tileId}</div>;
}

function DashboardSkeleton(): JSX.Element {
  return (
    <div style={gridStyle()}>
      {Array.from({ length: 2 }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-lg bg-muted"
          style={{
            gridColumn: `1 / span ${GRID_COLUMNS}`,
            gridRow: `${i * 4 + 1} / span 4`,
            minHeight: 192,
          }}
        />
      ))}
    </div>
  );
}

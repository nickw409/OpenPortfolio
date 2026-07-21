import React, { useCallback, useRef, useState } from 'react';
import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

import { Card, CardContent, CardHeader, CardTitle } from '@frontend/components/ui/card';
import { getTileDefinition } from '@frontend/tiles/registry';

import { computeDropMoves, keyboardCellStep } from './grid-snap';
import { useLayout } from './use-layout';
import type { TileItem } from './types';
import { GRID_COLUMNS, gridStyle, tileStyle } from './types';

export function DashboardGrid(): JSX.Element | null {
  const { layout, loading, error, reorder } = useLayout();
  const [activeId, setActiveId] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Keyboard drag advances one grid cell per arrow press. dnd-kit accumulates
  // these into `event.delta`, which the drop handler snaps back to whole cells.
  const keyboardCoordinateGetter = useCallback<KeyboardCoordinateGetter>(
    (event, { currentCoordinates }) => {
      const width = containerRef.current?.getBoundingClientRect().width ?? 0;
      return keyboardCellStep(event.code, currentCoordinates, width);
    },
    [],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinateGetter }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(Number(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      if (!layout) return;
      const width = containerRef.current?.getBoundingClientRect().width ?? 0;
      const moves = computeDropMoves(layout.tiles, Number(event.active.id), event.delta, width);
      if (moves.length) reorder(moves);
    },
    [layout, reorder],
  );

  if (loading) return <DashboardSkeleton />;
  if (error) return <div className="p-6 text-destructive">Error loading dashboard: {error}</div>;
  if (!layout) return null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div ref={containerRef} style={gridStyle()}>
        {layout.tiles.map((tile) => (
          <DraggableTile key={tile.id} tile={tile} activeId={activeId} />
        ))}
      </div>
    </DndContext>
  );
}

interface DraggableTileProps {
  tile: TileItem;
  activeId: number | null;
}

function DraggableTile({ tile, activeId }: DraggableTileProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: String(tile.id),
  });

  const def = getTileDefinition(tile.tile_type);
  const Component = def?.component ?? FallbackTile;
  const name = def?.name ?? tile.tile_type;

  const style: React.CSSProperties = {
    ...tileStyle(tile.position),
    transform: CSS.Translate.toString(transform),
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

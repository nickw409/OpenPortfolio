import { useEffect, useState, useCallback } from 'react';

import { fetchDefaultLayout, resetLayout, updateTile } from './layout-api';
import type { LayoutItem, TileItem, TilePosition } from './types';

export interface UseLayoutResult {
  layout: LayoutItem | null;
  loading: boolean;
  error: string | null;
  moveTile: (tileId: number, position: TilePosition) => void;
  resetToDefault: () => Promise<void>;
}

export function useLayout(): UseLayoutResult {
  const [layout, setLayout] = useState<LayoutItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchDefaultLayout(controller.signal)
      .then(({ layout }) => {
        setLayout(layout);
        setError(null);
      })
      .catch((err: unknown) => {
        if ((err as Error).name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const moveTile = useCallback(
    async (tileId: number, position: TilePosition) => {
      if (!layout) return;
      const previous = layout.tiles.find((t) => t.id === tileId);
      if (!previous) return;

      const updatedTiles = layout.tiles.map((t) => (t.id === tileId ? { ...t, position } : t));
      setLayout({ ...layout, tiles: updatedTiles });

      try {
        await updateTile(layout.id, tileId, { position_json: JSON.stringify(position) });
      } catch (err) {
        // Rollback on failure.
        setLayout({ ...layout, tiles: layout.tiles });
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [layout],
  );

  const resetToDefault = useCallback(async () => {
    if (!layout) return;
    try {
      const { layout: reset } = await resetLayout(layout.id);
      setLayout(reset);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [layout]);

  return { layout, loading, error, moveTile, resetToDefault };
}

export function sortTilesForDisplay(tiles: TileItem[]): TileItem[] {
  // Render larger tiles first so smaller tiles can fill gaps in the visual grid.
  return [...tiles].sort((a, b) => b.position.w * b.position.h - a.position.w * a.position.h);
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { apiGet } from '@frontend/lib/api';

import { fetchDefaultLayout, reorderTiles, resetLayout, updateTile } from './layout-api';
import type { LayoutItem, TilePosition } from './types';

const LAYOUT_QUERY_KEY = 'dashboard-layout';

export interface TileMove {
  tileId: number;
  position: TilePosition;
}

export interface UseLayoutResult {
  layout: LayoutItem | null;
  loading: boolean;
  error: string | null;
  moveTile: (tileId: number, position: TilePosition) => void;
  reorder: (moves: TileMove[]) => void;
  resetToDefault: () => Promise<void>;
}

function applyMoves(layout: LayoutItem, moves: TileMove[]): LayoutItem {
  const byId = new Map(moves.map((m) => [m.tileId, m.position]));
  return {
    ...layout,
    tiles: layout.tiles.map((t) => (byId.has(t.id) ? { ...t, position: byId.get(t.id)! } : t)),
  };
}

function toLayoutItem(layout: LayoutItem): LayoutItem {
  return {
    ...layout,
    tiles: layout.tiles.map((t) => ({
      ...t,
      position: typeof t.position === 'string' ? JSON.parse(t.position) : t.position,
      config: typeof t.config === 'string' ? JSON.parse(t.config) : t.config,
    })),
  };
}

export function useLayout(): UseLayoutResult {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: [LAYOUT_QUERY_KEY],
    queryFn: ({ signal }) => fetchDefaultLayout(signal).then((r) => toLayoutItem(r.layout)),
  });

  const moveMutation = useMutation({
    mutationFn: async ({
      layoutId,
      tileId,
      position,
    }: {
      layoutId: number;
      tileId: number;
      position: TilePosition;
    }) => {
      await updateTile(layoutId, tileId, { position_json: JSON.stringify(position) });
    },
    onMutate: async ({ tileId, position }) => {
      await queryClient.cancelQueries({ queryKey: [LAYOUT_QUERY_KEY] });
      const previous = queryClient.getQueryData<LayoutItem>([LAYOUT_QUERY_KEY]);
      if (previous) {
        const updated = {
          ...previous,
          tiles: previous.tiles.map((t) => (t.id === tileId ? { ...t, position } : t)),
        };
        queryClient.setQueryData([LAYOUT_QUERY_KEY], updated);
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData([LAYOUT_QUERY_KEY], context.previous);
      }
    },
  });

  const reorderMutation = useMutation({
    mutationFn: ({ layoutId, moves }: { layoutId: number; moves: TileMove[] }) =>
      reorderTiles(layoutId, moves).then((r) => r.layout),
    onMutate: async ({ moves }) => {
      await queryClient.cancelQueries({ queryKey: [LAYOUT_QUERY_KEY] });
      const previous = queryClient.getQueryData<LayoutItem>([LAYOUT_QUERY_KEY]);
      if (previous) {
        queryClient.setQueryData([LAYOUT_QUERY_KEY], applyMoves(previous, moves));
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData([LAYOUT_QUERY_KEY], context.previous);
      }
    },
    onSuccess: (layout) => {
      queryClient.setQueryData([LAYOUT_QUERY_KEY], toLayoutItem(layout));
    },
  });

  const resetMutation = useMutation({
    mutationFn: ({ layoutId }: { layoutId: number }) => resetLayout(layoutId).then((r) => r.layout),
    onSuccess: (layout) => {
      queryClient.setQueryData([LAYOUT_QUERY_KEY], toLayoutItem(layout));
    },
  });

  const moveTile = useCallback(
    (tileId: number, position: TilePosition) => {
      if (!data) return;
      moveMutation.mutate({ layoutId: data.id, tileId, position });
    },
    [data, moveMutation],
  );

  const reorder = useCallback(
    (moves: TileMove[]) => {
      if (!data || moves.length === 0) return;
      reorderMutation.mutate({ layoutId: data.id, moves });
    },
    [data, reorderMutation],
  );

  const resetToDefault = useCallback(async () => {
    if (!data) return;
    await resetMutation.mutateAsync({ layoutId: data.id });
  }, [data, resetMutation]);

  return {
    layout: data ?? null,
    loading: isLoading,
    error: error instanceof Error ? error.message : null,
    moveTile,
    reorder,
    resetToDefault,
  };
}

export function useDashboardLayouts() {
  return useQuery({
    queryKey: ['dashboard-layouts'],
    queryFn: ({ signal }) => apiGet<{ layouts: LayoutItem[] }>('/api/v1/dashboard/layouts', signal),
  });
}

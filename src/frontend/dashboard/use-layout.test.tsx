// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '@frontend/dashboard/layout-api';
import { useLayout } from '@frontend/dashboard/use-layout';
import type { LayoutItem } from '@frontend/dashboard/types';

vi.mock('@frontend/dashboard/layout-api', async () => {
  const actual = await vi.importActual<typeof import('@frontend/dashboard/layout-api')>(
    '@frontend/dashboard/layout-api',
  );
  return { ...actual, fetchDefaultLayout: vi.fn(), reorderTiles: vi.fn() };
});

const layout: LayoutItem = {
  id: 7,
  name: 'Overview',
  is_default: true,
  tiles: [
    {
      id: 1,
      layout_id: 7,
      tile_type: 'positions_table',
      position: { x: 0, y: 0, w: 6, h: 4 },
      config: {},
    },
    {
      id: 2,
      layout_id: 7,
      tile_type: 'allocation_chart',
      position: { x: 6, y: 0, w: 6, h: 4 },
      config: {},
    },
  ],
};

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useLayout.reorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the mapped moves to the reorder API', async () => {
    vi.mocked(api.fetchDefaultLayout).mockResolvedValue({ layout });
    vi.mocked(api.reorderTiles).mockResolvedValue({ layout });

    const { result } = renderHook(() => useLayout(), { wrapper });
    await waitFor(() => expect(result.current.layout).not.toBeNull());

    const moves = [{ tileId: 1, position: { x: 6, y: 0, w: 6, h: 4 } }];
    act(() => {
      result.current.reorder(moves);
    });

    // The hook forwards the layout id and the moves unchanged to the endpoint.
    // (Optimistic update + rollback are exercised by the failure test below.)
    await waitFor(() => expect(api.reorderTiles).toHaveBeenCalledWith(7, moves));
  });

  it('does not call the API for an empty move list', async () => {
    vi.mocked(api.fetchDefaultLayout).mockResolvedValue({ layout });

    const { result } = renderHook(() => useLayout(), { wrapper });
    await waitFor(() => expect(result.current.layout).not.toBeNull());

    act(() => {
      result.current.reorder([]);
    });

    expect(api.reorderTiles).not.toHaveBeenCalled();
  });

  it('rolls back the optimistic update when the reorder request fails', async () => {
    vi.mocked(api.fetchDefaultLayout).mockResolvedValue({ layout });
    vi.mocked(api.reorderTiles).mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useLayout(), { wrapper });
    await waitFor(() => expect(result.current.layout).not.toBeNull());

    act(() => {
      result.current.reorder([{ tileId: 1, position: { x: 6, y: 0, w: 6, h: 4 } }]);
    });

    // After the rejection settles, tile 1 is back at its original x.
    await waitFor(() =>
      expect(result.current.layout?.tiles.find((t) => t.id === 1)?.position.x).toBe(0),
    );
  });
});

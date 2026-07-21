// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchDefaultLayout } from '@frontend/dashboard/layout-api';
import { DashboardGrid, computeSwap } from '@frontend/dashboard/grid';
import type { LayoutItem, TileItem } from '@frontend/dashboard/types';

vi.mock('@frontend/dashboard/layout-api', async () => {
  const actual = await vi.importActual<typeof import('@frontend/dashboard/layout-api')>(
    '@frontend/dashboard/layout-api',
  );
  return {
    ...actual,
    fetchDefaultLayout: vi.fn(),
  };
});

const mockedFetchDefaultLayout = vi.mocked(fetchDefaultLayout);

function renderGrid(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DashboardGrid />
    </QueryClientProvider>,
  );
}

describe('DashboardGrid', () => {
  beforeEach(() => {
    mockedFetchDefaultLayout.mockReset();
  });

  it('renders a skeleton while loading', () => {
    mockedFetchDefaultLayout.mockReturnValue(new Promise(() => {}));
    const { container } = renderGrid();
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(2);
  });

  it('renders tiles from the default layout', async () => {
    const layout: LayoutItem = {
      id: 1,
      name: 'Overview',
      is_default: true,
      tiles: [
        {
          id: 1,
          layout_id: 1,
          tile_type: 'positions_table',
          position: { x: 0, y: 0, w: 12, h: 4 },
          config: { accounts: [] },
        },
        {
          id: 2,
          layout_id: 1,
          tile_type: 'allocation_chart',
          position: { x: 0, y: 4, w: 6, h: 4 },
          config: { dimension: 'asset_class' },
        },
      ],
    };
    mockedFetchDefaultLayout.mockResolvedValue({ layout });

    renderGrid();
    const titles = await screen.findAllByTestId('tile-title');
    expect(titles.map((el) => el.textContent)).toEqual(['Positions table', 'Allocation chart']);
  });
});

describe('computeSwap', () => {
  const tiles: TileItem[] = [
    { id: 1, layout_id: 1, tile_type: 'a', position: { x: 0, y: 0, w: 6, h: 4 }, config: {} },
    { id: 2, layout_id: 1, tile_type: 'b', position: { x: 6, y: 0, w: 6, h: 4 }, config: {} },
  ];

  it('returns the two swapped positions', () => {
    expect(computeSwap(tiles, 1, 2)).toEqual([
      { tileId: 1, position: { x: 6, y: 0, w: 6, h: 4 } },
      { tileId: 2, position: { x: 0, y: 0, w: 6, h: 4 } },
    ]);
  });

  it('returns null when dropped on itself', () => {
    expect(computeSwap(tiles, 1, 1)).toBeNull();
  });

  it('returns null when a tile is missing', () => {
    expect(computeSwap(tiles, 1, 99)).toBeNull();
  });
});

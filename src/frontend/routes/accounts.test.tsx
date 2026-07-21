// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiGet, ApiError } from '@frontend/lib/api';
import type { AccountsResponse } from '@shared/schemas/account';

import { AccountsPage } from './accounts';

vi.mock('@frontend/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@frontend/lib/api')>('@frontend/lib/api');
  return {
    ...actual,
    apiGet: vi.fn(),
  };
});

const mockedApiGet = vi.mocked(apiGet);

function renderPage(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AccountsPage />
    </QueryClientProvider>,
  );
}

/** Minimal boundary to prove AccountsPage's `if (error) throw error` reaches a boundary. */
class TestErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  override state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally swallowed — this boundary exists only to observe the throw.
  }

  override render(): ReactNode {
    if (this.state.hasError) return <div data-testid="caught">caught</div>;
    return this.props.children;
  }
}

describe('AccountsPage', () => {
  beforeEach(() => {
    mockedApiGet.mockReset();
  });

  it('renders skeleton rows while pending', () => {
    mockedApiGet.mockReturnValue(new Promise(() => {}));

    const { container } = renderPage();

    // 1 header row + 3 skeleton rows
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(18);
  });

  it('renders account rows on success, with null broker shown as em dash', async () => {
    const createdAt = '2024-01-15T00:00:00.000Z';
    const response: AccountsResponse = {
      accounts: [
        {
          id: 1,
          name: 'Brokerage',
          broker: 'Fidelity',
          taxTreatment: 'taxable',
          costBasisMethod: 'fifo',
          currencyCode: 'USD',
          createdAt,
        },
        {
          id: 2,
          name: 'Manual Holdings',
          broker: null,
          taxTreatment: 'tax_free',
          costBasisMethod: 'specific',
          currencyCode: 'USD',
          createdAt,
        },
      ],
    };
    mockedApiGet.mockResolvedValue(response);

    renderPage();

    expect(await screen.findByText('Brokerage')).toBeInTheDocument();
    expect(screen.getByText('Manual Holdings')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getAllByText(new Date(createdAt).toLocaleDateString())).toHaveLength(2);
  });

  it('propagates a fetch error to the nearest error boundary', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedApiGet.mockRejectedValue(
      new ApiError({ code: 'accounts.fetch_failed', message: 'boom' }, 500),
    );

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TestErrorBoundary>
          <AccountsPage />
        </TestErrorBoundary>
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('caught')).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });
});

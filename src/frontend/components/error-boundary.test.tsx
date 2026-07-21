// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ErrorComponentProps } from '@tanstack/react-router';

import { ApiError } from '@frontend/lib/api';
import { RouteErrorBoundary } from './error-boundary';

describe('RouteErrorBoundary', () => {
  it('renders the ApiError code and message', () => {
    const error = new ApiError(
      { code: 'accounts.not_found', message: 'Account could not be found' },
      404,
    );
    render(
      <RouteErrorBoundary {...({ error, reset: vi.fn() } as unknown as ErrorComponentProps)} />,
    );

    expect(screen.getByText('accounts.not_found')).toBeInTheDocument();
    expect(screen.getByText(/Account could not be found/)).toBeInTheDocument();
  });

  it('renders "render.unhandled" and the message for a plain Error', () => {
    const error = new Error('boom');
    render(
      <RouteErrorBoundary {...({ error, reset: vi.fn() } as unknown as ErrorComponentProps)} />,
    );

    expect(screen.getByText('render.unhandled')).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it('calls reset when the Retry button is clicked', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    const error = new Error('boom');
    render(<RouteErrorBoundary {...({ error, reset } as unknown as ErrorComponentProps)} />);

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(reset).toHaveBeenCalledTimes(1);
  });
});

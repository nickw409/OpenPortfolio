import type { ErrorComponentProps } from '@tanstack/react-router';

import { ApiError } from '@frontend/lib/api';

export function RouteErrorBoundary({ error, reset }: ErrorComponentProps): JSX.Element {
  const isApi = error instanceof ApiError;
  const code = isApi ? error.code : 'render.unhandled';
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--op-muted)' }}>
        <code>{code}</code>: {message}
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 border px-3 py-1 text-sm"
        style={{ borderColor: 'var(--op-border)' }}
      >
        Retry
      </button>
    </div>
  );
}

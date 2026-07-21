import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/dashboard')({
  component: DashboardPage,
});

function DashboardPage(): JSX.Element {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-sm" style={{ color: 'var(--op-muted)' }}>
        Dashboard tiles land in WS7.
      </p>
    </div>
  );
}

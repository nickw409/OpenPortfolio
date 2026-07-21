import { createFileRoute } from '@tanstack/react-router';

import { DashboardGrid } from '@frontend/dashboard/grid';

export const Route = createFileRoute('/dashboard')({
  component: DashboardPage,
});

function DashboardPage(): JSX.Element {
  return (
    <div className="h-full p-6">
      <DashboardGrid />
    </div>
  );
}

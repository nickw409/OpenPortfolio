import { Outlet, createRootRoute } from '@tanstack/react-router';

import { ThemeProvider } from '@frontend/components/theme-provider';

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent(): JSX.Element {
  return (
    <>
      <ThemeProvider />
      <Outlet />
    </>
  );
}

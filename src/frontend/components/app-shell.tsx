import type { ReactNode } from 'react';

import { Sidebar } from './sidebar';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps): JSX.Element {
  return (
    <div className="flex h-screen w-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto">{children}</main>
      {/* Right-hand AI drawer slot reserved for WS9 — empty in WS4. */}
    </div>
  );
}

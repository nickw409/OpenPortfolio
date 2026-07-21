import { Link } from '@tanstack/react-router';
import { LayoutDashboard, Wallet, Settings as SettingsIcon, PanelLeft } from 'lucide-react';

import { useUiStore } from '@frontend/stores/ui-store';
import { cn } from '@frontend/lib/utils';

interface NavItem {
  to: '/dashboard' | '/accounts' | '/settings';
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/accounts', label: 'Accounts', icon: Wallet },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

export function Sidebar(): JSX.Element {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);

  return (
    <aside
      className={cn('flex flex-col border-r transition-[width]', collapsed ? 'w-12' : 'w-56')}
      style={{ borderColor: 'var(--op-border)' }}
    >
      <div
        className="flex items-center justify-between border-b p-2"
        style={{ borderColor: 'var(--op-border)' }}
      >
        {!collapsed && <span className="font-semibold">OpenPortfolio</span>}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="ml-auto p-1"
        >
          <PanelLeft size={16} />
        </button>
      </div>
      <nav className="flex flex-col p-1">
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-sm"
            activeProps={{ style: { background: 'var(--op-border)' } }}
          >
            <Icon size={16} />
            {!collapsed && <span>{label}</span>}
          </Link>
        ))}
      </nav>
    </aside>
  );
}

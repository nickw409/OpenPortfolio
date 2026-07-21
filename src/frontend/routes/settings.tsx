import { createFileRoute } from '@tanstack/react-router';

import { useUiStore, type Theme } from '@frontend/stores/ui-store';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function SettingsPage(): JSX.Element {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Theme</h2>
        <div className="mt-2 flex gap-2">
          {(['system', 'light', 'dark'] as Theme[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTheme(t)}
              className="border px-3 py-1 text-sm"
              style={{
                borderColor: 'var(--op-border)',
                fontWeight: theme === t ? 600 : 400,
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="text-lg font-medium">Database path</h2>
        <p className="mt-2 text-sm font-mono" style={{ color: 'var(--op-muted)' }}>
          (revealed in WS11 Electron shell)
        </p>
      </section>
    </div>
  );
}

import { useEffect } from 'react';

import { useUiStore } from '@frontend/stores/ui-store';

export function ThemeProvider(): null {
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      // Omit the attribute so the CSS `@media (prefers-color-scheme: dark)`
      // rule wins and the OS theme is followed live, with zero JS involved.
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  return null;
}

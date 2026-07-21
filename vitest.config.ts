import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@backend': path.resolve(__dirname, 'src/backend'),
      '@frontend': path.resolve(__dirname, 'src/frontend'),
      '@mcp': path.resolve(__dirname, 'src/mcp'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/routeTree.gen.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/frontend/main.tsx',
        'src/frontend/routes/__root.tsx',
        'src/frontend/routeTree.gen.ts',
        'src/electron/**',
        'src/**/index.ts',
      ],
      // Per WORKSTREAMS.md invariants:
      //   95%+ on financial calculation modules
      //   90%+ on shared utilities
      //   80%+ on services and routes
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});

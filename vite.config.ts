import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'src/frontend',
  plugins: [
    // Router plugin must run before react() so the generated route tree is
    // available to the React refresh transform.
    tanstackRouter({
      target: 'react',
      routesDirectory: path.resolve(__dirname, 'src/frontend/routes'),
      generatedRouteTree: path.resolve(__dirname, 'src/frontend/routeTree.gen.ts'),
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@frontend': path.resolve(__dirname, 'src/frontend'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    outDir: '../../dist/frontend',
    emptyOutDir: true,
  },
});

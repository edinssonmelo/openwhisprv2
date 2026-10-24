import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Landing page sub-app. Reuses the repo root node_modules (react, vite, plugin-react).
// Dev:   npm run landing:dev
// Build: npm run landing:build  -> outputs to landing/dist
export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4321,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
});

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Playground for the built package. Resolve imports to `dist/` so the demo
 * exercises the same entry points and stylesheet as a consuming app.
 * Run `pnpm demo` to build and serve, or `pnpm dev` to rebuild while editing.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      // Mirror the package's own `exports` map so the subpath import in the
      // demo (`react-corruption/styles.css`) resolves the same way it will for
      // a real consumer.
      'react-corruption/styles.css': fileURLToPath(
        new URL('../dist/styles.css', import.meta.url),
      ),
      'react-corruption/core': fileURLToPath(new URL('../dist/core.js', import.meta.url)),
      'react-corruption': fileURLToPath(new URL('../dist/index.js', import.meta.url)),
    },
  },
  server: {
    port: 5180,
    strictPort: true,
  },
});

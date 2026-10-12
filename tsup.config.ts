import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * Build config.
 *
 * Emits BOTH module formats because consumers are split: Vite/Next/Rollup
 * want ESM, while Jest, older Node tooling and anything still on `require()`
 * need CJS. Shipping one format strands half the ecosystem.
 *
 * `dts: true` generates the .d.ts from source, so the published types can
 * never drift from the implementation the way hand-written ones do.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/core.ts'],
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  dts: true,
  // No source maps in the published package: they were ~60% of the tarball and
  // consumers debug against their own bundler's output, not ours.
  sourcemap: false,
  clean: true,
  // React is a peer dependency — bundling it would give the consumer a second
  // copy of React, which breaks hooks with the "invalid hook call" error.
  external: ['react', 'react-dom'],
  treeshake: true,
  target: 'es2020',
  // The CSS is hand-written and framework-agnostic, so it is copied verbatim
  // rather than run through a bundler that would only rewrite it.
  onSuccess: async () => {
    mkdirSync('dist', { recursive: true });
    copyFileSync('src/styles.css', 'dist/styles.css');
    console.log('[tsup] copied src/styles.css -> dist/styles.css');
  },
});

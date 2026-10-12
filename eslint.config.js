import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The source carries `eslint-disable-next-line react-hooks/exhaustive-deps`
    // comments where effect deps are deliberately narrow (the engine is
    // reconfigured imperatively rather than torn down on every option change).
    // Without the plugin registered those comments are themselves errors.
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        performance: 'readonly',
        Image: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        XMLSerializer: 'readonly',
        console: 'readonly',
        getComputedStyle: 'readonly',
        HTMLElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        CanvasRenderingContext2D: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      // The engine deliberately uses non-null assertions on GL/canvas handles
      // that are checked once at init; flagging each use adds noise, not safety.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `const { alpha: _ignored, ...rest } = options` is the idiomatic way to
      // DROP a key. Allow a leading-underscore name to be intentionally unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Node scripts, not browser code. `demo/verify.mjs` drives a real browser
    // from Node, and the demo's vite config is Node too.
    files: ['scripts/**/*.mjs', 'demo/**/*.mjs', '*.config.ts', '*.config.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
